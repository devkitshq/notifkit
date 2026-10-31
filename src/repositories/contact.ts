import { eq, and, sql as drizzleSql, inArray } from "drizzle-orm";
import { LRUCache } from "@/shared/index.js";
import type { Db } from "@/index.js";
import type { Preferences, ContactChannel } from "@/contracts/index.js";
import { users, userContacts, contactTopicPreferences } from "@/db/schema.js";
import type { UserContact } from "./types.js";

export class ContactRepository {
  private readonly activeContactsCache = new LRUCache<string, UserContact[]>(5000, 30_000);

  constructor(private readonly db: Db) {}

  /** A repository that runs its queries inside `tx`. */
  withTx(tx: Db): ContactRepository {
    return new ContactRepository(tx);
  }

  async findByUserId(projectId: string, userId: string): Promise<UserContact[]> {
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return [];

    const rows = await this.db
      .select()
      .from(userContacts)
      .where(eq(userContacts.userId, internalId));
    if (rows.length === 0) return [];

    const topicRows = await this.db
      .select()
      .from(contactTopicPreferences)
      .where(
        inArray(
          contactTopicPreferences.contactId,
          rows.map((r) => r.id),
        ),
      );

    const topicsByContact = new Map<string, Record<string, boolean>>();
    for (const t of topicRows) {
      if (!topicsByContact.has(t.contactId)) topicsByContact.set(t.contactId, {});
      topicsByContact.get(t.contactId)![t.topic] = t.enabled;
    }

    return rows.map((r) => ({
      id: r.id,
      userId,
      channel: r.channel as ContactChannel,
      target: r.target,
      preferences: { topics: topicsByContact.get(r.id) ?? {} },
      active: r.enabled,
    }));
  }

  /** Resolve active addressable contacts for a batch without an N+1 query. */
  async findActiveByUserIds(
    projectId: string,
    userIds: string[],
  ): Promise<Map<string, UserContact[]>> {
    const byUser = new Map<string, UserContact[]>();
    if (userIds.length === 0) return byUser;

    const missingIds: string[] = [];
    for (const userId of userIds) {
      const cacheKey = `${projectId}:${userId}`;
      const cached = this.activeContactsCache.get(cacheKey);
      if (cached !== undefined) {
        if (cached.length > 0) {
          byUser.set(userId, cached);
        }
      } else {
        missingIds.push(userId);
      }
    }

    if (missingIds.length === 0) {
      return byUser;
    }

    const rows = await this.db
      .select({
        userId: users.externalId,
        id: userContacts.id,
        channel: userContacts.channel,
        target: userContacts.target,
        enabled: userContacts.enabled,
      })
      .from(users)
      .innerJoin(userContacts, eq(users.id, userContacts.userId))
      .where(
        and(
          eq(users.projectId, projectId),
          inArray(users.externalId, missingIds),
          eq(userContacts.enabled, true),
        ),
      );

    // Per-address topic opt-outs (a user who wants marketing at home but not at
    // work). Without them the pipeline cannot honour an opt-out it accepted.
    const topicsByContact = new Map<string, Record<string, boolean>>();
    if (rows.length > 0) {
      const topicRows = await this.db
        .select()
        .from(contactTopicPreferences)
        .where(
          inArray(
            contactTopicPreferences.contactId,
            rows.map((r) => r.id),
          ),
        );
      for (const t of topicRows) {
        if (!topicsByContact.has(t.contactId)) topicsByContact.set(t.contactId, {});
        topicsByContact.get(t.contactId)![t.topic] = t.enabled;
      }
    }

    const fetchedByUser = new Map<string, UserContact[]>();
    for (const id of missingIds) {
      fetchedByUser.set(id, []);
    }

    for (const row of rows) {
      const contacts = fetchedByUser.get(row.userId) ?? [];
      const topics = topicsByContact.get(row.id);
      contacts.push({
        id: row.id,
        userId: row.userId,
        channel: row.channel as ContactChannel,
        target: row.target,
        preferences: topics ? { topics } : {},
        active: row.enabled,
      });
      fetchedByUser.set(row.userId, contacts);
    }

    for (const id of missingIds) {
      const contacts = fetchedByUser.get(id) ?? [];
      this.activeContactsCache.set(`${projectId}:${id}`, contacts);
      if (contacts.length > 0) {
        byUser.set(id, contacts);
      }
    }

    return byUser;
  }

  async upsert(
    projectId: string,
    userId: string,
    channel: ContactChannel,
    target: string,
    preferences: Preferences = {},
  ): Promise<void> {
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return;

    const inserted = await this.db
      .insert(userContacts)
      .values({
        userId: internalId,
        channel: channel as any,
        target,
        enabled: true,
      })
      .onConflictDoUpdate({
        target: [userContacts.userId, userContacts.channel, userContacts.target],
        // Re-adding a contact re-enables it; this is also how a device token
        // deactivated by an invalid-token response comes back.
        set: { enabled: true },
      })
      .returning({ id: userContacts.id });

    const contactId = inserted[0]?.id;
    if (!contactId) return;

    // Contact-level topic preferences were previously accepted by the API and
    // silently discarded.
    const topics = Object.entries(preferences.topics ?? {});
    if (topics.length > 0) {
      await this.db
        .insert(contactTopicPreferences)
        .values(topics.map(([topic, enabled]) => ({ contactId, topic, enabled })))
        .onConflictDoUpdate({
          target: [contactTopicPreferences.contactId, contactTopicPreferences.topic],
          set: { enabled: drizzleSql`excluded.enabled` },
        });
    }
    this.activeContactsCache.delete(`${projectId}:${userId}`);
  }

  async upsertMany(
    projectId: string,
    contactsList: Array<{
      userId: string;
      channel: ContactChannel;
      target: string;
      preferences?: Preferences;
    }>,
  ): Promise<void> {
    if (contactsList.length === 0) return;

    const internalUserIdRows = await this.db
      .select({ id: users.id, externalId: users.externalId })
      .from(users)
      .where(
        and(
          inArray(
            users.externalId,
            contactsList.map((c) => c.userId),
          ),
          eq(users.projectId, projectId),
        ),
      );

    const idMap = new Map(internalUserIdRows.map((r) => [r.externalId, r.id]));

    // The same address can arrive twice — as `email` and again in `contacts`
    // — and ON CONFLICT DO UPDATE rejects a statement that touches one row
    // twice. Keep one entry per address, merging their topic preferences.
    const byAddress = new Map<string, (typeof contactsList)[number]>();
    for (const c of contactsList) {
      if (!idMap.has(c.userId)) continue;
      const key = `${c.userId}\u0000${c.channel}\u0000${c.target}`;
      const seen = byAddress.get(key);
      byAddress.set(
        key,
        seen
          ? {
              ...c,
              preferences: {
                ...seen.preferences,
                ...c.preferences,
                topics: { ...seen.preferences?.topics, ...c.preferences?.topics },
              },
            }
          : c,
      );
    }
    const validContacts = [...byAddress.values()];
    if (validContacts.length === 0) return;

    const inserted = await this.db
      .insert(userContacts)
      .values(
        validContacts.map((c) => ({
          userId: idMap.get(c.userId)!,
          channel: c.channel as any,
          target: c.target,
          enabled: true,
        })),
      )
      .onConflictDoUpdate({
        target: [userContacts.userId, userContacts.channel, userContacts.target],
        set: { enabled: true },
      })
      .returning({
        id: userContacts.id,
        userId: userContacts.userId,
        channel: userContacts.channel,
        target: userContacts.target,
      });

    const contactIdMap = new Map();
    for (const row of inserted) {
      contactIdMap.set(`${row.userId}:${row.channel}:${row.target}`, row.id);
    }

    const topicInserts: any[] = [];
    for (const c of validContacts) {
      const internalId = idMap.get(c.userId)!;
      const contactId = contactIdMap.get(`${internalId}:${c.channel}:${c.target}`);
      if (!contactId || !c.preferences?.topics) continue;

      for (const [topic, enabled] of Object.entries(c.preferences.topics)) {
        topicInserts.push({ contactId, topic, enabled });
      }
    }

    if (topicInserts.length > 0) {
      await this.db
        .insert(contactTopicPreferences)
        .values(topicInserts)
        .onConflictDoUpdate({
          target: [contactTopicPreferences.contactId, contactTopicPreferences.topic],
          set: { enabled: drizzleSql`excluded.enabled` },
        });
    }
    for (const c of validContacts) {
      this.activeContactsCache.delete(`${projectId}:${c.userId}`);
    }
  }

  /**
   * Mark a contact unusable without destroying it — used when a provider
   * reports an invalid push token. Deleting the row would lose the user's
   * device permanently on what is often a transient provider response.
   */
  async deactivate(
    projectId: string,
    userId: string,
    channel: ContactChannel,
    target: string,
  ): Promise<boolean> {
    this.activeContactsCache.delete(`${projectId}:${userId}`);
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return false;

    const result = await this.db
      .update(userContacts)
      .set({ enabled: false })
      .where(
        and(
          eq(userContacts.userId, internalId),
          eq(userContacts.channel, channel as any),
          eq(userContacts.target, target),
        ),
      )
      .returning();
    return result.length > 0;
  }

  async delete(
    projectId: string,
    userId: string,
    channel: ContactChannel,
    target: string,
  ): Promise<boolean> {
    this.activeContactsCache.delete(`${projectId}:${userId}`);
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return false;

    const result = await this.db
      .delete(userContacts)
      .where(
        and(
          eq(userContacts.userId, internalId),
          eq(userContacts.channel, channel as any),
          eq(userContacts.target, target),
        ),
      )
      .returning();
    return result.length > 0;
  }
}
