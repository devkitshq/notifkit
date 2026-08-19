import { describe, it, expect, vi, beforeEach } from "vitest";
import { TemplateCache } from "@/templates/cache.js";
import { interpolate, renderWithTemplate } from "@/templates/render.js";

describe("TemplateCache (src/templates/cache.ts)", () => {
  let mockTemplateRepo: any;
  let templateCache: TemplateCache;

  beforeEach(() => {
    mockTemplateRepo = {
      findById: vi.fn(),
    };
    templateCache = new TemplateCache(mockTemplateRepo);
  });

  it("fetches template from repository on cache miss and caches the result", async () => {
    const templateData = {
      id: "welcome-email",
      projectId: "proj-1",
      channel: "email",
      content: { subject: "Welcome!", body: "Hello {{name}}" },
    };
    mockTemplateRepo.findById.mockResolvedValueOnce(templateData);

    const first = await templateCache.getCachedTemplate("proj-1", "welcome-email");
    expect(first).toEqual(templateData);
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(1);

    // Second call should hit the in-memory cache without calling repo again
    const second = await templateCache.getCachedTemplate("proj-1", "welcome-email");
    expect(second).toEqual(templateData);
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(1);
  });

  it("returns null on repository miss and does not cache null", async () => {
    mockTemplateRepo.findById.mockResolvedValueOnce(null);

    const first = await templateCache.getCachedTemplate("proj-1", "non-existent");
    expect(first).toBeNull();
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(1);

    // If template is created later, subsequent call hits repo again
    mockTemplateRepo.findById.mockResolvedValueOnce({ id: "non-existent", content: {} });
    const second = await templateCache.getCachedTemplate("proj-1", "non-existent");
    expect(second).toEqual({ id: "non-existent", content: {} });
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(2);
  });

  it("invalidate removes a specific template from cache", async () => {
    const templateData = { id: "t1", content: { subject: "Old Subject" } };
    mockTemplateRepo.findById.mockResolvedValue(templateData);

    await templateCache.getCachedTemplate("proj-1", "t1");
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(1);

    templateCache.invalidate("proj-1", "t1");

    const updatedData = { id: "t1", content: { subject: "New Subject" } };
    mockTemplateRepo.findById.mockResolvedValueOnce(updatedData);

    const fresh = await templateCache.getCachedTemplate("proj-1", "t1");
    expect(fresh).toEqual(updatedData);
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(2);
  });

  it("invalidateKey removes cache entry by compound key", async () => {
    mockTemplateRepo.findById.mockResolvedValue({ id: "t2", content: {} });
    await templateCache.getCachedTemplate("proj-1", "t2");

    templateCache.invalidateKey("proj-1:t2");

    await templateCache.getCachedTemplate("proj-1", "t2");
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(2);
  });

  it("clear wipes all cached templates", async () => {
    mockTemplateRepo.findById.mockResolvedValue({ id: "t3", content: {} });
    await templateCache.getCachedTemplate("proj-1", "t3");
    await templateCache.getCachedTemplate("proj-2", "t4");

    templateCache.clear();

    await templateCache.getCachedTemplate("proj-1", "t3");
    await templateCache.getCachedTemplate("proj-2", "t4");
    expect(mockTemplateRepo.findById).toHaveBeenCalledTimes(4);
  });
});

describe("Template Rendering Utilities (src/templates/render.ts)", () => {
  describe("interpolate", () => {
    it("escapes HTML by default (sanitize = true)", () => {
      const tmpl = "Hello {{user}} & <b>welcome</b>";
      const vars = { user: "<script>alert(1)</script>" };

      const result = interpolate(tmpl, vars);
      expect(result).toBe("Hello &lt;script&gt;alert(1)&lt;/script&gt; & <b>welcome</b>");
    });

    it("leaves raw HTML unescaped when sanitize is false", () => {
      const tmpl = "Link: {{link}}";
      const vars = { link: '<a href="https://example.com">Click</a>' };

      const result = interpolate(tmpl, vars, false);
      expect(result).toBe('Link: <a href="https://example.com">Click</a>');
    });

    it("replaces missing variables with empty string", () => {
      const tmpl = "Hello {{first}} {{last}}!";
      const vars = { first: "Alice" };

      const result = interpolate(tmpl, vars);
      expect(result).toBe("Hello Alice !");
    });
  });

  describe("renderWithTemplate (deep nesting & edge cases)", () => {
    it("interpolates nested objects and arrays within template structures", () => {
      const template = {
        content: {
          title: "Order #{{orderId}} Confirmed",
          sections: [
            { header: "Customer", details: "Name: {{name}}" },
            { header: "Shipping", address: { city: "{{city}}", zip: "{{zip}}" } },
          ],
          tags: ["{{tag1}}", "{{tag2}}", "static-tag"],
        },
      };

      const vars = {
        orderId: 9876,
        name: "Bob",
        city: "San Francisco",
        zip: "94105",
        tag1: "vip",
        tag2: "express",
      };

      const rendered = renderWithTemplate(template, vars);
      expect(rendered.content).toEqual({
        title: "Order #9876 Confirmed",
        sections: [
          { header: "Customer", details: "Name: Bob" },
          { header: "Shipping", address: { city: "San Francisco", zip: "94105" } },
        ],
        tags: ["vip", "express", "static-tag"],
      });
    });

    it("renders fallback object when dbTemplate is undefined", () => {
      const rendered = renderWithTemplate(undefined, { msg: "alert" });
      expect(rendered.content.subject).toBe("Notification");
      expect(typeof rendered.content.body).toBe("string");
      expect(rendered.content.body).toContain('"msg": "alert"');
    });
  });
});
