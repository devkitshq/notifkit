import { sql as drizzleSql } from "drizzle-orm";
import type { Db } from "@/index.js";

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
