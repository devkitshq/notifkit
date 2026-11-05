import { and, eq, inArray } from "drizzle-orm";
import { suppressions } from "@/db/schema.js";
import type { Db } from "@/db/index.js";
import { ContactRepository, TemplateRepository, UserRepository } from "@/repositories/index.js";
import { normaliseTarget } from "@/shared/index.js";

export type BlockReason =
  "suppressed" | "recipient_not_found" | "user_opted_out" | "channel_disabled" | "contact_inactive";

/** The fields of a parked `notification.dispatched` payload the gate reads. */
interface ParkedTask {
  taskId: string;
  projectId: string;
  recipientId: string;
  channel: string;
  templateId?: string;
  destination?: string;
}

/**
 * Re-checks parked sends at release: an unsubscribe, bounce or removed address
 * since parking must still stop them. Reads Postgres, not the caches, and
 * throws on a failed lookup so the batch is held rather than sent unchecked.
 */
export async function findBlockedAtRelease(
  db: Db,
  tasks: ParkedTask[],
): Promise<Map<string, BlockReason>> {
  const blocked = new Map<string, BlockReason>();

  const byProject = new Map<string, ParkedTask[]>();
  for (const t of tasks) {
    if (!t?.projectId || !t.recipientId) continue;
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId)!.push(t);
  }

  for (const [projectId, group] of byProject) {
    const recipientIds = [...new Set(group.map((t) => t.recipientId))];
    const templateIds = [...new Set(group.map((t) => t.templateId).filter(Boolean))] as string[];
    const targets = [
      ...new Set(group.map((t) => t.destination && normaliseTarget(t.destination)).filter(Boolean)),
    ] as string[];

    const templateRepo = new TemplateRepository(db);
    const [suppressedRows, users, contactsByUser, templates] = await Promise.all([
      targets.length > 0
        ? db
            .select({ channel: suppressions.channel, target: suppressions.target })
            .from(suppressions)
            .where(
              and(eq(suppressions.projectId, projectId), inArray(suppressions.target, targets)),
            )
        : [],
      new UserRepository(db).findRecordsByIds(projectId, recipientIds),
      new ContactRepository(db).findActiveByUserIds(projectId, recipientIds),
      Promise.all(templateIds.map((id) => templateRepo.findById(projectId, id))),
    ]);

    const suppressed = new Set(
      (suppressedRows as { channel: string; target: string }[]).map(
        (r) => `${r.channel}:${normaliseTarget(r.target)}`,
      ),
    );
    const userById = new Map(users.map((u) => [u.userId, u]));
    const topicsByTemplate = new Map<string, string[]>();
    templateIds.forEach((id, i) => topicsByTemplate.set(id, templates[i]?.topics ?? []));

    for (const t of group) {
      const topics = t.templateId ? (topicsByTemplate.get(t.templateId) ?? []) : [];
      const reason = decide(t, topics, suppressed, userById.get(t.recipientId), contactsByUser);
      if (reason) blocked.set(t.taskId, reason);
    }
  }

  return blocked;
}

function decide(
  t: ParkedTask,
  topics: string[],
  suppressed: Set<string>,
  user:
    | { preferences: { topics?: Record<string, boolean>; channels?: Record<string, boolean> } }
    | undefined,
  contactsByUser: Map<string, { channel: string; target: string; preferences?: any }[]>,
): BlockReason | undefined {
  // First and for every priority, as in the engine.
  if (t.destination && suppressed.has(`${t.channel}:${normaliseTarget(t.destination)}`)) {
    return "suppressed";
  }
  if (!user) return "recipient_not_found";
  if (topics.some((topic) => user.preferences.topics?.[topic] === false)) return "user_opted_out";
  if (user.preferences.channels?.[t.channel] === false) return "channel_disabled";

  if (t.destination) {
    const contact = (contactsByUser.get(t.recipientId) ?? []).find(
      (c) => c.channel === t.channel && c.target === t.destination,
    );
    if (!contact) return "contact_inactive";
    if (topics.some((topic) => contact.preferences?.topics?.[topic] === false)) {
      return "user_opted_out";
    }
  }
  return undefined;
}
