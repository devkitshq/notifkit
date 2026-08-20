import { eq, and, sql as drizzleSql, inArray, desc } from "drizzle-orm";
import type { Db } from "@/index.js";
import type { Preferences, ContactChannel } from "@/contracts/index.js";
import {
  users,
  userSegments,
  userContacts,
  userChannelPreferences,
  userTopicPreferences,
  contactTopicPreferences,
  quietHours,
  templates,
  projects,
  workflowInstances,
  workflowSteps,
  workflowWaiters,
  workflowDefinitions,
  projectApiKeys,
  suppressions,
  messageLogs,
} from "@/db/schema.js";

// ─── Domain types ───────────────────────────────────────────────────────────

export interface UserProfile {
  userId: string; // Maps to externalId
  language?: string;
  timezone?: string;
  email?: string | null;
}

export interface UserRecord extends UserProfile {
  segments: string[];
  preferences: Preferences;
}

export interface UserContact {
  id: string; // uuid
  userId: string; // externalId
  channel: ContactChannel;
  target: string;
  preferences: Preferences;
  active: boolean;
}

export interface TemplateRecord {
  id: string;
  channel: string;
  topics: string[];
  content: unknown;
  /** Template-level AI prompts, merged with per-request ones by the engine. */
  aiPrompts?: Record<string, string> | null;
}

export type DevicePlatform = "fcm" | "apns" | "web";

export interface DeviceToken {
  id: string;
  userId: string;
  deviceToken: string;
  platform: DevicePlatform;
  active: boolean;
}

export interface NotificationPreference {
  userId: string;
  eventType: string;
  optedIn: boolean;
}

// ─── UserRepository ─────────────────────────────────────────────────────────

export class UserRepository {
  constructor(private readonly db: Db) {}

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
      language: attrs.language,
      timezone: attrs.timezone,
      email: attrs.email,
    };
  }

  async findRecordById(projectId: string, userId: string): Promise<UserRecord | null> {
    const userRows = await this.db
      .select()
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    if (!userRows[0]) return null;

    const userRow = userRows[0];
    const internalId = userRow.id;
    const attrs = userRow.attributes as any;

    const [segmentRows, topicRows, channelRows, qhRows] = await Promise.all([
      this.db.select().from(userSegments).where(eq(userSegments.userId, internalId)),
      this.db
        .select()
        .from(userTopicPreferences)
        .where(eq(userTopicPreferences.userId, internalId)),
      this.db
        .select()
        .from(userChannelPreferences)
        .where(eq(userChannelPreferences.userId, internalId)),
      this.db.select().from(quietHours).where(eq(quietHours.userId, internalId)),
    ]);

    const segments = segmentRows.map((r) => r.segment);

    const topics: Record<string, boolean> = {};
    for (const r of topicRows) {
      topics[r.topic] = r.enabled;
    }

    const channels: Record<string, boolean> = {};
    for (const r of channelRows) {
      channels[r.channel] = r.enabled;
    }

    const quietHoursList = qhRows.map((r) => ({
      start: r.startTime.slice(0, 5),
      end: r.endTime.slice(0, 5),
    }));

    return {
      userId: userRow.externalId,
      language: attrs.language,
      timezone: attrs.timezone,
      email: attrs.email,
      segments,
      preferences: {
        channels,
        topics,
        quietHours: quietHoursList.length > 0 ? quietHoursList : undefined,
      },
    };
  }

  async findRecordsByIds(projectId: string, userIds: string[]): Promise<UserRecord[]> {
    if (userIds.length === 0) return [];

    const usersRows = await this.db
      .select()
      .from(users)
      .where(and(inArray(users.externalId, userIds), eq(users.projectId, projectId)));

    if (usersRows.length === 0) return [];

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

    const userRecords: UserRecord[] = [];

    for (const userRow of usersRows) {
      const attrs = userRow.attributes as any;
      const internalId = userRow.id;

      userRecords.push({
        userId: userRow.externalId,
        language: attrs.language,
        timezone: attrs.timezone,
        email: attrs.email,
        segments: segmentsByUserId.get(internalId) || [],
        preferences: {
          channels: channelsByUserId.get(internalId) || {},
          topics: topicsByUserId.get(internalId) || {},
          quietHours: qhByUserId.get(internalId),
        },
      });
    }

    return userRecords;
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

    let attempts = 0;
    while (attempts < 3) {
      try {
        await this.db.transaction(async (tx) => {
          await tx
            .insert(users)
            .values(
              usersList.map((u) => ({
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
                attributes: drizzleSql`excluded.attributes`,
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

            if (u.preferences?.quietHours && u.preferences.quietHours.length > 0) {
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

          const usersWithQuietHours = usersList.filter(
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
      email: patch.email ?? existing.email,
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

    return true;
  }

  async delete(projectId: string, userId: string): Promise<boolean> {
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

    if (cursor) {
      const cursorDate = new Date(parseInt(cursor, 10));
      if (!isNaN(cursorDate.getTime())) {
        conditions.push(drizzleSql`${users.createdAt} < ${cursorDate.toISOString()}`);
      }
    }

    if (filters?.language) {
      conditions.push(drizzleSql`(${users.attributes}->>'language') = ${filters.language}`);
    }

    if (filters?.timezone) {
      conditions.push(drizzleSql`(${users.attributes}->>'timezone') = ${filters.timezone}`);
    }

    if (filters?.search) {
      const term = `%${filters.search.trim()}%`;
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
      .orderBy(desc(users.createdAt))
      .limit(limit);

    const items = rows.map((r) => {
      const attrs = r.attributes as any;
      return {
        userId: r.externalId,
        language: attrs.language,
        timezone: attrs.timezone,
        email: attrs.email,
        createdAt: r.createdAt.getTime(),
      };
    });

    const nextCursor =
      items.length === limit ? items[items.length - 1]!.createdAt.toString() : null;
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

// ─── PreferenceRepository ────────────────────────────────────────────────────

export class PreferenceRepository {
  constructor(private readonly db: Db) {}

  async isOptedIn(projectId: string, userId: string, eventType: string): Promise<boolean> {
    const prefs = await this.findByUserId(projectId, userId);
    const pref = prefs.find((p) => p.eventType === eventType);
    return pref ? pref.optedIn : true;
  }

  async findByUserId(projectId: string, userId: string): Promise<NotificationPreference[]> {
    const internalUserIdRows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.externalId, userId), eq(users.projectId, projectId)));
    const internalId = internalUserIdRows[0]?.id;
    if (!internalId) return [];

    const rows = await this.db
      .select()
      .from(userTopicPreferences)
      .where(eq(userTopicPreferences.userId, internalId));

    return rows.map((r) => ({
      userId,
      eventType: r.topic,
      optedIn: r.enabled,
    }));
  }
}

// ─── ContactRepository ───────────────────────────────────────────────────────

export class ContactRepository {
  constructor(private readonly db: Db) {}

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
          inArray(users.externalId, userIds),
          eq(userContacts.enabled, true),
        ),
      );

    for (const row of rows) {
      const contacts = byUser.get(row.userId) ?? [];
      contacts.push({
        id: row.id,
        userId: row.userId,
        channel: row.channel as ContactChannel,
        target: row.target,
        preferences: {},
        active: row.enabled,
      });
      byUser.set(row.userId, contacts);
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

    const validContacts = contactsList.filter((c) => idMap.has(c.userId));
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

// ─── TemplateRepository ──────────────────────────────────────────────────────

export class TemplateRepository {
  constructor(private readonly db: Db) {}

  async findById(projectId: string, id: string): Promise<TemplateRecord | null> {
    const rows = await this.db
      .select()
      .from(templates)
      .where(and(eq(templates.id, id), eq(templates.projectId, projectId)))
      .limit(1);
    if (!rows[0]) return null;
    return {
      id: rows[0].id,
      channel: rows[0].channel,
      content: rows[0].content,
      topics: (rows[0].topics ?? []) as string[],
      aiPrompts: rows[0].aiPrompts as Record<string, string> | null,
    };
  }

  async list(projectId: string): Promise<TemplateRecord[]> {
    const rows = await this.db.select().from(templates).where(eq(templates.projectId, projectId));
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      content: r.content,
      topics: (r.topics ?? []) as string[],
      aiPrompts: r.aiPrompts as Record<string, string> | null,
    }));
  }

  async upsertMany(projectId: string, templateList: any[]): Promise<number> {
    if (templateList.length === 0) return 0;

    const values = templateList.map((t) => ({
      projectId,
      id: t.id,
      channel: t.channel as any,
      topics: t.topics ?? [],
      content: t.content,
      aiPrompts: t.aiPrompts,
    }));

    await this.db
      .insert(templates)
      .values(values)
      .onConflictDoUpdate({
        target: [templates.projectId, templates.id],
        set: {
          channel: drizzleSql`excluded.channel`,
          topics: drizzleSql`excluded.topics`,
          content: drizzleSql`excluded.content`,
          aiPrompts: drizzleSql`excluded.ai_prompts`,
          updatedAt: new Date(),
        },
      });

    return templateList.length;
  }

  async delete(projectId: string, id: string): Promise<boolean> {
    const result = await this.db
      .delete(templates)
      .where(and(eq(templates.id, id), eq(templates.projectId, projectId)))
      .returning();
    return result.length > 0;
  }
}

// ─── ProjectRepository ───────────────────────────────────────────────────────

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<any[]> {
    return this.db
      .select({
        id: projects.id,
        name: projects.name,
        rateLimitRpm: projects.rateLimitRpm,
        throttleLimit: projects.throttleLimit,
        throttleWindowHours: projects.throttleWindowHours,
        createdAt: projects.createdAt,
      })
      .from(projects)
      .orderBy(desc(projects.createdAt));
  }

  async delete(id: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const userRows = await tx.select({ id: users.id }).from(users).where(eq(users.projectId, id));
      const userIds = userRows.map((u) => u.id);
      if (userIds.length > 0) {
        await tx.delete(userContacts).where(inArray(userContacts.userId, userIds));
        await tx.delete(userSegments).where(inArray(userSegments.userId, userIds));
        await tx.delete(userTopicPreferences).where(inArray(userTopicPreferences.userId, userIds));
        await tx
          .delete(userChannelPreferences)
          .where(inArray(userChannelPreferences.userId, userIds));
        await tx.delete(quietHours).where(inArray(quietHours.userId, userIds));
        await tx.delete(users).where(eq(users.projectId, id));
      }
      await tx.delete(suppressions).where(eq(suppressions.projectId, id));
      await tx.delete(messageLogs).where(eq(messageLogs.projectId, id));
      await tx.delete(workflowInstances).where(eq(workflowInstances.projectId, id));

      const result = await tx.delete(projects).where(eq(projects.id, id)).returning();
      return result.length > 0;
    });
  }

  /**
   * Throttle overrides only. Kept narrow because the engine calls this once per
   * notification (behind a cache) and has no use for the rest of the row.
   */
  async findThrottleSettings(
    id: string,
  ): Promise<{ throttleLimit: number | null; throttleWindowHours: number | null } | null> {
    const rows = await this.db
      .select({
        throttleLimit: projects.throttleLimit,
        throttleWindowHours: projects.throttleWindowHours,
      })
      .from(projects)
      .where(eq(projects.id, id))
      .limit(1);

    return rows[0] ?? null;
  }

  async updateSettings(
    id: string,
    settings: {
      rateLimitRpm?: number | null;
      throttleLimit?: number | null;
      throttleWindowHours?: number | null;
    },
  ): Promise<boolean> {
    const result = await this.db
      .update(projects)
      .set(settings)
      .where(eq(projects.id, id))
      .returning();
    return result.length > 0;
  }

  async createApiKey(
    projectId: string,
    keyHash: string,
    role: "admin" | "read_only" = "admin",
  ): Promise<{ id: string }> {
    const result = await this.db
      .insert(projectApiKeys)
      .values({ projectId, keyHash, role })
      .returning();
    return { id: result[0]!.id };
  }

  async listApiKeys(projectId: string): Promise<any[]> {
    return this.db
      .select({
        id: projectApiKeys.id,
        role: projectApiKeys.role,
        createdAt: projectApiKeys.createdAt,
      })
      .from(projectApiKeys)
      .where(eq(projectApiKeys.projectId, projectId))
      .orderBy(desc(projectApiKeys.createdAt));
  }

  async deleteApiKey(projectId: string, keyId: string): Promise<boolean> {
    const result = await this.db
      .delete(projectApiKeys)
      .where(and(eq(projectApiKeys.id, keyId), eq(projectApiKeys.projectId, projectId)))
      .returning();
    return result.length > 0;
  }
}

// ─── WorkflowRepository ──────────────────────────────────────────────────────

export class WorkflowRepository {
  constructor(private readonly db: Db) {}

  async listDefinitions(projectId: string): Promise<any[]> {
    return this.db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.projectId, projectId))
      .orderBy(desc(workflowDefinitions.createdAt));
  }

  async getInstance(projectId: string, instanceId: string): Promise<any | null> {
    const instances = await this.db
      .select()
      .from(workflowInstances)
      .where(and(eq(workflowInstances.id, instanceId), eq(workflowInstances.projectId, projectId)))
      .limit(1);
    if (!instances[0]) return null;

    const steps = await this.db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.instanceId, instanceId))
      .orderBy(workflowSteps.createdAt);
    const waiters = await this.db
      .select()
      .from(workflowWaiters)
      .where(eq(workflowWaiters.instanceId, instanceId));

    return {
      ...instances[0],
      steps,
      waiters,
    };
  }

  async cancelInstance(projectId: string, instanceId: string): Promise<boolean> {
    return await this.db.transaction(async (tx) => {
      const result = await tx
        .update(workflowInstances)
        .set({ status: "canceled" as any })
        .where(
          and(
            eq(workflowInstances.id, instanceId),
            eq(workflowInstances.projectId, projectId),
            inArray(workflowInstances.status, ["pending", "running"]),
          ),
        )
        .returning();
      if (result.length === 0) return false;
      await tx.delete(workflowWaiters).where(eq(workflowWaiters.instanceId, instanceId));
      return true;
    });
  }
}

// ─── SegmentRepository ───────────────────────────────────────────────────────

export class SegmentRepository {
  constructor(private readonly db: Db) {}

  async listSegments(projectId: string): Promise<string[]> {
    const rows = await this.db.execute(drizzleSql`
      SELECT DISTINCT s.segment
      FROM user_segments s
      JOIN users u ON u.id = s.user_id
      WHERE u.project_id = ${projectId}
    `);
    return (rows as any[]).map((r) => r.segment);
  }
}
