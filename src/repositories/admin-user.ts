import { eq, or, sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@/index.js";
import { adminUsers } from "@/db/schema.js";

export interface AdminUserRecord {
  id: string;
  email: string;
  username: string | null;
  passwordHash: string;
  role: string;
  createdAt: Date;
  updatedAt: Date;
}

export class AdminUserRepository {
  constructor(private readonly db: Db) {}

  async findByEmailOrUsername(identifier: string): Promise<AdminUserRecord | null> {
    const normalized = identifier.trim().toLowerCase();
    const rows = await this.db
      .select()
      .from(adminUsers)
      .where(or(eq(adminUsers.email, normalized), eq(adminUsers.username, identifier.trim())))
      .limit(1);
    return (rows[0] as AdminUserRecord) ?? null;
  }

  async findById(id: string): Promise<AdminUserRecord | null> {
    const rows = await this.db.select().from(adminUsers).where(eq(adminUsers.id, id)).limit(1);
    return (rows[0] as AdminUserRecord) ?? null;
  }

  async create(data: {
    email: string;
    username?: string | null;
    passwordHash: string;
    role?: string;
  }): Promise<AdminUserRecord> {
    const rows = await this.db
      .insert(adminUsers)
      .values({
        email: data.email.trim().toLowerCase(),
        username: data.username ? data.username.trim() : null,
        passwordHash: data.passwordHash,
        role: data.role || "admin",
      })
      .returning();
    return rows[0] as AdminUserRecord;
  }

  /** @deprecated Unused; removed in the next minor version. */
  async updatePassword(id: string, passwordHash: string): Promise<boolean> {
    const rows = await this.db
      .update(adminUsers)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(adminUsers.id, id))
      .returning();
    return rows.length > 0;
  }

  /** @deprecated Unused; removed in the next minor version. */
  async list(): Promise<Omit<AdminUserRecord, "passwordHash">[]> {
    const rows = await this.db
      .select({
        id: adminUsers.id,
        email: adminUsers.email,
        username: adminUsers.username,
        role: adminUsers.role,
        createdAt: adminUsers.createdAt,
        updatedAt: adminUsers.updatedAt,
      })
      .from(adminUsers)
      .orderBy(adminUsers.createdAt);
    return rows as Omit<AdminUserRecord, "passwordHash">[];
  }

  async count(): Promise<number> {
    const rows = await this.db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(adminUsers);
    return rows[0]?.count ?? 0;
  }
}
