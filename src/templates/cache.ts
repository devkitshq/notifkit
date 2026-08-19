import { LRUCache } from "@/shared/index.js";
import type { TemplateRepository } from "@/repositories/index.js";

export class TemplateCache {
  private cache = new LRUCache<string, any>(1000, 5 * 60 * 1000);

  constructor(private readonly templateRepo: TemplateRepository) {}

  async getCachedTemplate(projectId: string, id: string) {
    const key = `${projectId}:${id}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const dbTemplate = await this.templateRepo.findById(projectId, id);
    if (dbTemplate) {
      this.cache.set(key, dbTemplate);
    }
    return dbTemplate;
  }

  invalidate(projectId: string, id: string) {
    this.cache.delete(`${projectId}:${id}`);
  }

  invalidateKey(key: string) {
    this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }
}
