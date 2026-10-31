import { eq, and, sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@/index.js";
import { templates } from "@/db/schema.js";
import type { TemplateRecord } from "./types.js";

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
