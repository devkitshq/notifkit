import { LRUCache } from "@/shared/index.js";

/**
 * Throttle overrides stored on the project row. `null` on either field means
 * "no override" — fall back to the process-wide default.
 */
export interface ProjectThrottleSettings {
  throttleLimit: number | null;
  throttleWindowHours: number | null;
}

const NO_OVERRIDES: ProjectThrottleSettings = {
  throttleLimit: null,
  throttleWindowHours: null,
};

export interface ProjectSettingsCacheOptions {
  maxSize?: number;
  ttlMs?: number;
}

/**
 * Caches per-project throttle overrides for the engine.
 *
 * The throttle check runs once per notification, so an uncached lookup here
 * would put a Postgres round trip on the hot path. Projects with no overrides
 * are cached as well — the common case must not cost a query per message.
 *
 * The TTL bounds staleness on its own; `invalidate()` exists so a settings
 * change published over pub/sub applies immediately rather than at expiry.
 */
export class ProjectSettingsCache {
  private readonly cache: LRUCache<string, ProjectThrottleSettings>;
  /**
   * Lookups already on the wire, keyed by project.
   *
   * The cache only fills once a query has come back, so without this a cold
   * project at the start of a campaign puts one query per in-flight message on
   * Postgres before the first answer lands — exactly when the database is
   * busiest. Followers wait on the leader's promise instead.
   */
  private readonly inFlight = new Map<string, Promise<ProjectThrottleSettings>>();

  constructor(
    private readonly load: (projectId: string) => Promise<ProjectThrottleSettings | null>,
    { maxSize = 1000, ttlMs = 60_000 }: ProjectSettingsCacheOptions = {},
  ) {
    this.cache = new LRUCache<string, ProjectThrottleSettings>(maxSize, ttlMs);
  }

  /**
   * Throws whatever the loader throws. The caller decides whether a settings
   * lookup failure should drop the message or fall back to defaults.
   */
  async get(projectId: string): Promise<ProjectThrottleSettings> {
    const cached = this.cache.get(projectId);
    if (cached) return cached;

    const existing = this.inFlight.get(projectId);
    if (existing) return existing;

    // Assigned before any callback below can run, since `load` cannot settle
    // within this synchronous block.
    let pending!: Promise<ProjectThrottleSettings>;
    pending = this.load(projectId)
      .then((settings) => {
        const resolved = settings ?? NO_OVERRIDES;
        // Only cache while this is still the current lookup: an invalidate()
        // that landed while the query was on the wire means the answer in hand
        // already describes the old settings.
        if (this.inFlight.get(projectId) === pending) {
          this.cache.set(projectId, resolved);
        }
        return resolved;
      })
      .finally(() => {
        // Cleared on failure too, so one bad lookup does not pin every later
        // caller to the same rejection.
        if (this.inFlight.get(projectId) === pending) {
          this.inFlight.delete(projectId);
        }
      });

    this.inFlight.set(projectId, pending);
    return pending;
  }

  invalidate(projectId: string): void {
    this.cache.delete(projectId);
    // A lookup that started before the change would write a stale value on
    // arrival; dropping it here sends the next caller back to the database.
    this.inFlight.delete(projectId);
  }

  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }
}
