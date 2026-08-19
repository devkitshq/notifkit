import type { RenderedContent } from "@/contracts/index.js";
export * from "./render.js";
export * from "./cache.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface TemplateContext {
  eventType: string;
  templateVariables: Record<string, unknown>;
  locale: string;
  timezone: string;
  deeplinkScheme: string;
}

export type TemplateRenderer = (ctx: TemplateContext) => RenderedContent;

/** Coerce a template variable to a non-empty string, or undefined. */
function asText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ─── TemplateRegistry ────────────────────────────────────────────────────────
//
// Open registry — new event types register a renderer without touching this file.
// The default renderer falls back to the i18n translation table, so most event
// types work without a custom renderer.

class TemplateRegistry {
  private readonly renderers = new Map<string, TemplateRenderer>();

  /**
   * Register a custom renderer for an event type.
   * Overwrites any previous registration for the same type.
   */
  register(eventType: string, renderer: TemplateRenderer): void {
    this.renderers.set(eventType, renderer);
  }

  /** Render content for the given context, falling back to the i18n table. */
  render(ctx: TemplateContext): RenderedContent {
    const renderer = this.renderers.get(ctx.eventType);
    if (renderer) return renderer(ctx);
    return defaultRenderer(ctx);
  }

  has(eventType: string): boolean {
    return this.renderers.has(eventType);
  }

  registeredTypes(): string[] {
    return [...this.renderers.keys()];
  }
}

function defaultRenderer(ctx: TemplateContext): RenderedContent {
  const vars = ctx.templateVariables;

  // Fall back to any caller-supplied title/body in the payload, then to a generic label.
  const subject = asText(vars.subject ?? vars.title);
  const body = asText(vars.body ?? vars.message) ?? `Notification: ${ctx.eventType}`;

  return { content: { subject, body } };
}

export const templateRegistry = new TemplateRegistry();

export function renderTemplate(ctx: TemplateContext): RenderedContent {
  return templateRegistry.render(ctx);
}
