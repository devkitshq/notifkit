import { eq, and, sql as drizzleSql, inArray, desc } from "drizzle-orm";
import { LRUCache } from "@/shared/index.js";
import type { Db } from "@/index.js";
import type { Preferences, ContactChannel } from "@/contracts/index.js";
import {
  users,
  userSegments,
  userContacts,
  userChannelPreferences,
  userTopicPreferences,
  quietHours,
} from "@/db/schema.js";
import type { UserProfile, UserRecord } from "./types.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Applied when a profile is read, not when it is written: an upsert that
 * leaves a field out must keep the stored value rather than reset it.
 */
const DEFAULT_LANGUAGE = "en";
const DEFAULT_TIMEZONE = "UTC";

export class UserRepository {
  private readonly recordCache = new LRUCache<string, UserRecord>(5000, 30_000);

  constructor(private readonly db: Db) {}

  /** A repository that runs its queries inside `tx`. */
  withTx(tx: Db): UserRepository {
    return new UserRepository(tx);
  }

  async findById(projectId: string, userId: string): Promise<UserProfile | null> {
    const rows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)))
      .limit(1);

    if (!rows[0]) return null;
    const attrs = rows[0].attributes as any;
    return {
      userId: rows[0].externalId,
      language: attrs.language ?? DEFAULT_LANGUAGE,
      timezone: attrs.timezone ?? DEFAULT_TIMEZONE,
      email: attrs.email,
    };
  }

  async findRecordById(projectId: string, userId: string): Promise<UserRecord | null> {
    const cacheKey = `${projectId}:${userId}`;
    const cached = this.recordCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const records = await this.findRecordsByIds(projectId, [userId]);
    return records[0] ?? null;
  }

  async findRecordsByIds(projectId: string, userIds: string[]): Promise<UserRecord[]> {
    if (userIds.length === 0) return [];

    const results: UserRecord[] = [];
    const missingIds: string[] = [];

    for (const id of userIds) {
      const cacheKey = `${projectId}:${id}`;
      const cached = this.recordCache.get(cacheKey);
      if (cached !== undefined) {
        results.push(cached);
      } else {
        missingIds.push(id);
      }
    }

    if (missingIds.length === 0) {
      return results;
    }

    const usersRows = await this.db
      .select()
      .from(users)
      .where(and(inArray(users.externalId, missingIds), eq(users.projectId, projectId)));

    if (usersRows.length === 0) return results;

    const internalIds = usersRows.map((r) => r.id);

    const [segmentRows, topicRows, channelRows, qhRows] = await Promise.all([
      this.db.select().from(userSegments).where(inArray(userSegments.userId, internalIds)),
      this.db
        .select()
        .from(userTopicPreferences)
        .where(inArray(userTopicPreferences.userId, internalIds)),
      this.db
        .select()
        .from(userChannelPreferences)
        .where(inArray(userChannelPreferences.userId, internalIds)),
      this.db.select().from(quietHours).where(inArray(quietHours.userId, internalIds)),
    ]);

    const segmentsByUserId = new Map<string, string[]>();
    for (const r of segmentRows) {
      if (!segmentsByUserId.has(r.userId)) segmentsByUserId.set(r.userId, []);
      segmentsByUserId.get(r.userId)!.push(r.segment);
    }

    const topicsByUserId = new Map<string, Record<string, boolean>>();
    for (const r of topicRows) {
      if (!topicsByUserId.has(r.userId)) topicsByUserId.set(r.userId, {});
      topicsByUserId.get(r.userId)![r.topic] = r.enabled;
    }

    const channelsByUserId = new Map<string, Record<string, boolean>>();
    for (const r of channelRows) {
      if (!channelsByUserId.has(r.userId)) channelsByUserId.set(r.userId, {});
      channelsByUserId.get(r.userId)![r.channel] = r.enabled;
    }

    const qhByUserId = new Map<string, any[]>();
    for (const r of qhRows) {
      if (r.userId == null) continue;
      if (!qhByUserId.has(r.userId)) qhByUserId.set(r.userId, []);
      qhByUserId
        .get(r.userId)!
        .push({ start: r.startTime.slice(0, 5), end: r.endTime.slice(0, 5) });
    }

    for (const userRow of usersRows) {
      const attrs = userRow.attributes as any;
      const internalId = userRow.id;

      const record: UserRecord = {
        userId: userRow.externalId,
        language: attrs.language ?? DEFAULT_LANGUAGE,
        timezone: attrs.timezone ?? DEFAULT_TIMEZONE,
        email: attrs.email,
        segments: segmentsByUserId.get(internalId) || [],
        preferences: {
          channels: channelsByUserId.get(internalId) || {},
          topics: topicsByUserId.get(internalId) || {},
          quietHours: qhByUserId.get(internalId),
        },
      };

      this.recordCache.set(`${projectId}:${record.userId}`, record);
      results.push(record);
    }

    return results;
  }

  async upsertFull(
    projectId: string,
    user: {
      userId: string;
      language?: string;
      timezone?: string;
      email?: string | null;
      segments: string[];
      preferences: Preferences;
    },
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx
        .insert(users)
        .values({
          projectId,
          externalId: user.userId,
          attributes: {
            language: user.language,
            timezone: user.timezone,
            email: user.email,
          },
        })
        .onConflictDoUpdate({
          target: [users.projectId, users.externalId],
          set: {
            attributes: {
              language: user.language,
              timezone: user.timezone,
              email: user.email,
            },
            updatedAt: new Date(),
          },
        });

      const internalIdRows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.externalId, user.userId), eq(users.projectId, projectId)));
      const internalId = internalIdRows[0]?.id;
      if (!internalId) return;

      if (user.segments && user.segments.length > 0) {
        await tx
          .insert(userSegments)
          .values(user.segments.map((s) => ({ userId: internalId, segment: s })))
          .onConflictDoNothing();
      }

      if (user.preferences && user.preferences.topics) {
        const topicInserts = Object.entries(user.preferences.topics).map(([topic, enabled]) => ({
          userId: internalId,
          topic,
          enabled,
        }));
        if (topicInserts.length > 0) {
          await tx
            .insert(userTopicPreferences)
            .values(topicInserts)
            .onConflictDoUpdate({
              target: [userTopicPreferences.userId, userTopicPreferences.topic],
              set: { enabled: drizzleSql`excluded.enabled` },
            });
        }
      }

      if (user.preferences?.channels) {
        const channelInserts = Object.entries(user.preferences.channels).map(
          ([channel, enabled]) => ({
            userId: internalId,
            channel: channel as ContactChannel,
            enabled,
          }),
        );
        if (channelInserts.length > 0) {
          await tx
            .insert(userChannelPreferences)
            .values(channelInserts)
            .onConflictDoUpdate({
              target: [userChannelPreferences.userId, userChannelPreferences.channel],
              set: { enabled: drizzleSql`excluded.enabled` },
            });
        }
      }

      if (user.preferences?.quietHours !== undefined) {
        await tx.delete(quietHours).where(eq(quietHours.userId, internalId));
        if (user.preferences.quietHours.length > 0) {
          await tx.insert(quietHours).values(
            user.preferences.quietHours.map((window) => ({
              userId: internalId,
              startTime: window.start,
              endTime: window.end,
            })),
          );
        }
      }
    });
    this.recordCache.delete(`${projectId}:${user.userId}`);
  }

  async upsertManyFull(
    projectId: string,
    usersList: Array<{
      userId: string;
      language?: string;
      timezone?: string;
      email?: string | null;
      segments: string[];
      preferences: Preferences;
    }>,
  ): Promise<void> {
    if (usersList.length === 0) return;

    // ON CONFLICT DO UPDATE rejects the whole statement when two proposed rows
    // hit the same key, so an import naming one user twice failed outright.
    // The last occurrence wins, as it would had they been sent one by one.
    const uniqueUsers = [...new Map(usersList.map((u) => [u.userId, u])).values()];
    const winners = new Set(uniqueUsers);

    let attempts = 0;
    while (attempts < 3) {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values(
              uniqueUsers.map((u) => ({
                projectId,
                externalId: u.userId,
                attributes: {
                  language: u.language,
                  timezone: u.timezone,
                  email: u.email,
                },
              })),
            )
            .onConflictDoUpdate({
              target: [users.projectId, users.externalId],
              set: {
                // Merged, not replaced: a field the caller left out (absent
                // from the JSON) keeps its stored value.
                attributes: drizzleSql`${users.attributes} || excluded.attributes`,
                updatedAt: new Date(),
              },
            });

          const internalIdRows = await tx
            .select({ id: users.id, externalId: users.externalId })
            .from(users)
            .where(
              and(
                inArray(
                  users.externalId,
                  usersList.map((u) => u.userId),
                ),
                eq(users.projectId, projectId),
              ),
            );

          const idMap = new Map(internalIdRows.map((r) => [r.externalId, r.id]));

          const segmentInserts: any[] = [];
          const topicInserts: any[] = [];
          const channelInserts: any[] = [];
          const quietHoursInserts: any[] = [];

          for (const u of usersList) {
            const internalId = idMap.get(u.userId);
            if (!internalId) continue;

            if (u.segments && u.segments.length > 0) {
              for (const s of u.segments) {
                segmentInserts.push({ userId: internalId, segment: s });
              }
            }

            if (u.preferences?.topics) {
              for (const [topic, enabled] of Object.entries(u.preferences.topics)) {
                topicInserts.push({ userId: internalId, topic, enabled });
              }
            }

            if (u.preferences?.channels) {
              for (const [channel, enabled] of Object.entries(u.preferences.channels)) {
                channelInserts.push({
                  userId: internalId,
                  channel: channel as ContactChannel,
                  enabled,
                });
              }
            }

            // Quiet hours are replaced, not merged, so only the winning row counts.
            if (
              winners.has(u) &&
              u.preferences?.quietHours &&
              u.preferences.quietHours.length > 0
            ) {
              for (const window of u.preferences.quietHours) {
                quietHoursInserts.push({
                  userId: internalId,
                  startTime: window.start,
                  endTime: window.end,
                });
              }
            }
          }

          const segmentSet = new Set<string>();
          const dedupedSegmentInserts: any[] = [];
          for (const s of segmentInserts) {
            const key = `${s.userId}:${s.segment}`;
            if (!segmentSet.has(key)) {
              segmentSet.add(key);
              dedupedSegmentInserts.push(s);
            }
          }

          const topicMap = new Map<string, any>();
          for (const t of topicInserts) {
            topicMap.set(`${t.userId}:${t.topic}`, t);
          }
          const dedupedTopicInserts = Array.from(topicMap.values());

          const channelMap = new Map<string, any>();
          for (const c of channelInserts) {
            channelMap.set(`${c.userId}:${c.channel}`, c);
          }
          const dedupedChannelInserts = Array.from(channelMap.values());

          if (dedupedSegmentInserts.length > 0) {
            await tx.insert(userSegments).values(dedupedSegmentInserts).onConflictDoNothing();
          }

          if (dedupedTopicInserts.length > 0) {
            await tx
              .insert(userTopicPreferences)
              .values(dedupedTopicInserts)
              .onConflictDoUpdate({
                target: [userTopicPreferences.userId, userTopicPreferences.topic],
                set: { enabled: drizzleSql`excluded.enabled` },
              });
          }

          if (dedupedChannelInserts.length > 0) {
            await tx
              .insert(userChannelPreferences)
              .values(dedupedChannelInserts)
              .onConflictDoUpdate({
                target: [userChannelPreferences.userId, userChannelPreferences.channel],
                set: { enabled: drizzleSql`excluded.enabled` },
              });
          }

          const usersWithQuietHours = uniqueUsers.filter(
            (u) => u.preferences?.quietHours !== undefined,
          );
          const internalIdsToClearQuietHours = usersWithQuietHours
            .map((u) => idMap.get(u.userId))
            .filter(Boolean) as string[];

          if (internalIdsToClearQuietHours.length > 0) {
            await tx
              .delete(quietHours)
              .where(inArray(quietHours.userId, internalIdsToClearQuietHours));
          }
          if (quietHoursInserts.length > 0) {
            await tx.insert(quietHours).values(quietHoursInserts);
          }
        });
        for (const u of usersList) {
          this.recordCache.delete(`${projectId}:${u.userId}`);
        }
        return;
      } catch (err: any) {
        attempts++;
        if (attempts >= 3 || (err.code !== "40001" && err.code !== "40P01")) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, attempts) * 100));
      }
    }
  }

  async updatePartial(
    projectId: string,
    userId: string,
    patch: {
      language?: string;
      timezone?: string;
      email?: string | null;
      segments?: string[];
      preferences?: Preferences;
    },
  ): Promise<boolean> {
    const existing = await this.findById(projectId, userId);
    if (!existing) return false;

    const attrs = {
      language: patch.language ?? existing.language,
      timezone: patch.timezone ?? existing.timezone,
      // `null` clears the email; only an absent field keeps the old one.
      email: patch.email !== undefined ? patch.email : existing.email,
    };

    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ attributes: attrs, updatedAt: new Date() })
        .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));

      const internalIdRows = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
      const internalId = internalIdRows[0]?.id;
      if (!internalId) return;

      if (patch.segments) {
        await tx.delete(userSegments).where(eq(userSegments.userId, internalId));
        if (patch.segments.length > 0) {
          await tx
            .insert(userSegments)
            .values(patch.segments.map((s) => ({ userId: internalId, segment: s })))
            .onConflictDoNothing();
        }
      }

      if (patch.preferences && patch.preferences.topics) {
        const topicInserts = Object.entries(patch.preferences.topics).map(([topic, enabled]) => ({
          userId: internalId,
          topic,
          enabled,
        }));
        if (topicInserts.length > 0) {
          await tx
            .insert(userTopicPreferences)
            .values(topicInserts)
            .onConflictDoUpdate({
              target: [userTopicPreferences.userId, userTopicPreferences.topic],
              set: { enabled: drizzleSql`excluded.enabled` },
            });
        }
      }

      if (patch.preferences?.channels) {
        const channelInserts = Object.entries(patch.preferences.channels).map(
          ([channel, enabled]) => ({
            userId: internalId,
            channel: channel as ContactChannel,
            enabled,
          }),
        );
        if (channelInserts.length > 0) {
          await tx
            .insert(userChannelPreferences)
            .values(channelInserts)
            .onConflictDoUpdate({
              target: [userChannelPreferences.userId, userChannelPreferences.channel],
              set: { enabled: drizzleSql`excluded.enabled` },
            });
        }
      }

      if (patch.preferences?.quietHours !== undefined) {
        await tx.delete(quietHours).where(eq(quietHours.userId, internalId));
        if (patch.preferences.quietHours.length > 0) {
          await tx.insert(quietHours).values(
            patch.preferences.quietHours.map((window) => ({
              userId: internalId,
              startTime: window.start,
              endTime: window.end,
            })),
          );
        }
      }
    });

    this.recordCache.delete(`${projectId}:${userId}`);
    return true;
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
    this.recordCache.delete(`${projectId}:${userId}`);
    const result = await this.db
      .delete(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)))
      .returning();
    return result.length > 0;
  }

  async list(
    projectId: string,
    limit: number,
    cursor?: string,
    filters?: {
      search?: string;
      segment?: string;
      language?: string;
      timezone?: string;
      channel?: string;
    },
  ): Promise<{ users: UserProfile[]; nextCursor: string | null }> {
    const conditions = [eq(users.projectId, projectId)];

    // The cursor is the id of the last row returned. Paging on created_at
    // alone skipped rows: a bulk import writes every user in one transaction,
    // so they share one created_at, and the millisecond cursor could not tell
    // them apart. (created_at, id) is unique and ordered.
    if (cursor && UUID_RE.test(cursor)) {
      conditions.push(
        drizzleSql`(${users.createdAt}, ${users.id}) < (SELECT c.created_at, c.id FROM ${users} c WHERE c.id = ${cursor})`,
      );
    }

    if (filters?.language) {
      conditions.push(drizzleSql`(${users.attributes}->>'language') = ${filters.language}`);
    }

    if (filters?.timezone) {
      conditions.push(drizzleSql`(${users.attributes}->>'timezone') = ${filters.timezone}`);
    }

    if (filters?.search) {
      // `%`, `_` and `\` in the search are literal, not wildcards.
      const term = `%${filters.search.trim().replace(/[\\%_]/g, "\\$&")}%`;
      conditions.push(
        drizzleSql`(${users.externalId} ILIKE ${term} OR (${users.attributes}->>'email') ILIKE ${term})`,
      );
    }

    if (filters?.segment) {
      conditions.push(
        drizzleSql`EXISTS (SELECT 1 FROM ${userSegments} WHERE ${userSegments.userId} = ${users.id} AND ${userSegments.segment} = ${filters.segment})`,
      );
    }

    if (filters?.channel) {
      conditions.push(
        drizzleSql`EXISTS (SELECT 1 FROM ${userContacts} WHERE ${userContacts.userId} = ${users.id} AND ${userContacts.channel} = ${filters.channel})`,
      );
    }

    const rows = await this.db
      .select()
      .from(users)
      .where(and(...conditions))
      .orderBy(desc(users.createdAt), desc(users.id))
      .limit(limit);

    const items = rows.map((r) => {
      const attrs = r.attributes as any;
      return {
        userId: r.externalId,
        language: attrs.language ?? DEFAULT_LANGUAGE,
        timezone: attrs.timezone ?? DEFAULT_TIMEZONE,
        email: attrs.email,
        createdAt: r.createdAt.getTime(),
      };
    });

    const nextCursor = rows.length === limit ? rows[rows.length - 1]!.id : null;
    return { users: items, nextCursor };
  }

  async findUsersBySegment(projectId: string, segmentName: string): Promise<string[]> {
    const rows = await this.db
      .select({ externalId: users.externalId })
      .from(users)
      .innerJoin(userSegments, eq(users.id, userSegments.userId))
      .where(and(eq(userSegments.segment, segmentName), eq(users.projectId, projectId)));

    return rows.map((r) => r.externalId);
  }

  async findUsersByTopic(projectId: string, topicName: string): Promise<string[]> {
    const rows = await this.db
      .select({ externalId: users.externalId })
      .from(users)
      .innerJoin(userTopicPreferences, eq(users.id, userTopicPreferences.userId))
      .where(
        and(
          eq(userTopicPreferences.topic, topicName),
          eq(userTopicPreferences.enabled, true),
          eq(users.projectId, projectId),
        ),
      );

    return rows.map((r) => r.externalId);
  }
}
