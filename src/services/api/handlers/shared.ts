import type { Logger } from "@/logger/index.js";
import type { RedisClient } from "@/redis/index.js";
import type { StreamProducer } from "@/queue/index.js";
import type {
  UserRepository,
  ContactRepository,
  TemplateRepository,
  ProjectRepository,
  WorkflowRepository,
  SegmentRepository,
  AdminUserRepository,
} from "@/repositories/index.js";
import type { Preferences, UserContactInput, ContactChannel } from "@/contracts/index.js";
import type { RouteContext } from "../router.js";
import type { LiveDeliveryEvents } from "../live-events.js";
import type { Db } from "@/db/index.js";

export interface Deps {
  logger: Logger;
  redis: RedisClient;
  producers: Record<string, StreamProducer>;
  userRepo: UserRepository;
  contactRepo: ContactRepository;
  templateRepo: TemplateRepository;
  projectRepo: ProjectRepository;
  workflowRepo: WorkflowRepository;
  segmentRepo: SegmentRepository;
  adminUserRepo?: AdminUserRepository;
  db: Db;
  /** Delivery outcomes for GET /v1/events/stream. */
  liveEvents: LiveDeliveryEvents;
}

// Inline user shape (email/phone/pushToken already normalised to string[] by Zod).
export interface InlineUserLike {
  id: string;
  language?: string;
  timezone?: string;
  contacts?: UserContactInput[];
  email?: string[];
  phone?: string[];
  pushToken?: string[];
  segments?: string[];
  preferences?: Preferences;
}

interface ResolvedContact {
  channel: ContactChannel;
  target: string;
  label?: string;
  isPrimary?: boolean;
  enabled?: boolean;
  preferences?: Preferences;
}

/** Map an inline or user input's contacts and legacy arrays into resolved contact records. */
export function contactsOf(user: InlineUserLike): ResolvedContact[] {
  const list: ResolvedContact[] = [];

  if (user.contacts && Array.isArray(user.contacts)) {
    for (const c of user.contacts) {
      list.push({
        channel: c.channel,
        target: c.target,
        label: c.label,
        isPrimary: c.isPrimary,
        enabled: c.enabled,
        preferences: c.preferences,
      });
    }
  }

  if (user.email) {
    for (const target of user.email) {
      list.push({ channel: "email", target });
    }
  }
  if (user.phone) {
    for (const target of user.phone) {
      list.push({ channel: "sms", target });
    }
  }
  if (user.pushToken) {
    for (const target of user.pushToken) {
      list.push({ channel: "push", target });
    }
  }

  return list;
}

/** Persist user records + their contacts in bulk. Shared by addUser and inline notify. */
export async function persistUsers(
  deps: Deps,
  users: InlineUserLike[],
  projectId: string,
): Promise<void> {
  const usersList = users.map((u) => {
    const primaryEmail = u.email?.[0] ?? u.contacts?.find((c) => c.channel === "email")?.target;

    // Omitted fields stay omitted: the upsert merges what is given into the
    // stored profile, so an inline `{ id, phone }` on notify must not reset the
    // user's timezone, language or email. Defaults are applied when read.
    return {
      userId: u.id,
      language: u.language,
      timezone: u.timezone,
      email: primaryEmail,
      segments: u.segments ?? [],
      preferences: u.preferences ?? {},
    };
  });

  const contactsList: any[] = [];
  for (const u of users) {
    for (const c of contactsOf(u)) {
      contactsList.push({
        userId: u.id,
        channel: c.channel,
        target: c.target,
        preferences: c.preferences ?? {},
      });
    }
  }

  await deps.db.transaction(async (tx) => {
    await deps.userRepo.withTx(tx as Db).upsertManyFull(projectId, usersList);
    await deps.contactRepo.withTx(tx as Db).upsertMany(projectId, contactsList);
  });
}

/**
 * A dead-letter entry, read the way StreamConsumer writes it: the original
 * event JSON under `data`, carrying a `dlq` block that records which stream it
 * failed on. Flat `payload`/`eventType` fields are accepted for entries written
 * by hand or by older versions.
 */
export interface DlqEntry {
  id: string;
  eventType: string;
  payload: any;
  projectId?: string;
  error: string;
  timestamp: string;
  /** The event as it was published, without its `dlq` block. */
  event: Record<string, any> | null;
  originalStream?: string;
  fields: Record<string, string>;
}

export function parseDlqEntry(id: string, rawFields: string[]): DlqEntry {
  const fields: Record<string, string> = {};
  for (let i = 0; i < rawFields.length; i += 2) {
    fields[rawFields[i]!] = rawFields[i + 1]!;
  }

  let parsed: Record<string, any> | null = null;
  if (fields.data) {
    try {
      parsed = JSON.parse(fields.data);
    } catch {
      parsed = null;
    }
  }
  const { dlq, ...event } = parsed ?? {};

  let payload: any = fields;
  if (parsed) {
    payload = event.payload;
  } else if (fields.payload) {
    try {
      payload = JSON.parse(fields.payload);
    } catch {
      payload = fields.payload;
    }
  }

  const ms = Number(id.split("-")[0]);
  return {
    id,
    eventType: event.type ?? fields.eventType ?? fields.event_type ?? "unknown",
    payload,
    projectId: payload?.projectId ?? payload?.project_id ?? fields.projectId,
    error: dlq?.reason ?? fields.error ?? fields.reason ?? "Dead letter payload",
    timestamp:
      dlq?.ackedAt ??
      fields.timestamp ??
      (Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString()),
    event: parsed ? event : null,
    originalStream: dlq?.originalStream,
    fields,
  };
}

/**
 * Ids that live in uuid columns. Anything else can match no row, and passing it
 * to Postgres fails the query outright — a 500 for what is simply not found.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string | undefined): v is string =>
  typeof v === "string" && UUID_RE.test(v);

/** Opaque position in the delivery log: a row's full-precision timestamp and id. */
export function encodeLogCursor(ts: string, id: string): string {
  return Buffer.from(JSON.stringify([ts, id])).toString("base64url");
}

export function decodeLogCursor(
  cursor: string | null | undefined,
): { ts: string; id: string } | null {
  if (!cursor) return null;
  // Cursors handed out before this format were a millisecond timestamp.
  if (/^\d+$/.test(cursor)) {
    return {
      ts: new Date(Number(cursor)).toISOString(),
      id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    };
  }
  try {
    const [ts, id] = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      typeof ts === "string" &&
      typeof id === "string" &&
      !Number.isNaN(Date.parse(ts)) &&
      /^[0-9a-f-]{36}$/i.test(id)
    ) {
      return { ts, id };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * A LIKE pattern matching `term` anywhere, with the term's own `%`, `_` and
 * `\` taken literally rather than as wildcards.
 */
export function contains(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

export function getQueryParam(ctx: RouteContext, key: string): string | undefined {
  if (!ctx.query) return undefined;
  if (typeof ctx.query.get === "function") {
    return ctx.query.get(key) ?? undefined;
  }
  return (ctx.query as any)[key] ?? undefined;
}

/**
 * Page size from `?limit=`, clamped to [1, max]. Missing or non-numeric
 * values fall back to `fallback`; `undefined` there means "no limit".
 */
export function parseLimit<F extends number | undefined>(
  ctx: RouteContext,
  fallback: F,
  max = 100,
): number | F {
  const n = parseInt(getQueryParam(ctx, "limit") ?? "", 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, 1), max);
}
