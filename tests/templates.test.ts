import { describe, it, expect } from "vitest";
import { templateRegistry, renderTemplate, type TemplateContext } from "@/templates/index.js";

describe("TemplateRegistry", () => {
  it("should register and use custom renderers", () => {
    const customRenderer = (ctx: TemplateContext) => ({
      content: { subject: "Custom", body: ctx.eventType },
    });
    templateRegistry.register("test.event", customRenderer);

    expect(templateRegistry.has("test.event")).toBe(true);
    expect(templateRegistry.registeredTypes()).toContain("test.event");

    const ctx: TemplateContext = {
      eventType: "test.event",
      templateVariables: {},
      locale: "en",
      timezone: "UTC",
      deeplinkScheme: "app://",
    };

    const result = renderTemplate(ctx);
    expect(result.content.subject).toBe("Custom");
    expect(result.content.body).toBe("test.event");
  });

  it("should fallback to default renderer when no custom renderer exists", () => {
    const ctx: TemplateContext = {
      eventType: "unknown.event",
      templateVariables: {
        subject: "Hello",
        message: "World",
      },
      locale: "en",
      timezone: "UTC",
      deeplinkScheme: "app://",
    };

    const result = renderTemplate(ctx);
    expect(result.content.subject).toBe("Hello");
    expect(result.content.body).toBe("World");
  });

  it("should use generic default when no vars provided", () => {
    const ctx: TemplateContext = {
      eventType: "empty.event",
      templateVariables: {},
      locale: "en",
      timezone: "UTC",
      deeplinkScheme: "app://",
    };

    const result = renderTemplate(ctx);
    expect(result.content.subject).toBeUndefined();
    expect(result.content.body).toBe("Notification: empty.event");
  });
});

import { renderWithTemplate } from "@/templates/render.js";

describe("renderWithTemplate Edge Cases", () => {
  it("interpolates falsy values (false, 0) as string literals instead of blank strings", () => {
    const template = {
      content: {
        body: "Count: {{count}}, Active: {{active}}, NullVal: {{nullVal}}, UndefVal: {{undefVal}}",
      },
    };

    const variables = {
      count: 0,
      active: false,
      nullVal: null,
      undefVal: undefined,
    };

    const rendered = renderWithTemplate(template, variables);
    expect((rendered.content as any).body).toBe("Count: 0, Active: false, NullVal: , UndefVal: ");
  });

  it("applies HTML escaping to HTML fields while preserving text fields", () => {
    const template = {
      content: {
        htmlBody: "Hello, {{name}} & welcome to {{company}}!",
        textBody: "Hello, {{name}} & welcome to {{company}}!",
      },
    };

    const variables = {
      name: "<script>alert('xss')</script>",
      company: 'Acme "Best" & Co.',
    };

    const rendered = renderWithTemplate(template, variables);
    expect((rendered.content as any).htmlBody).toBe(
      "Hello, &lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt; & welcome to Acme &quot;Best&quot; &amp; Co.!",
    );
    expect((rendered.content as any).textBody).toBe(
      "Hello, <script>alert('xss')</script> & welcome to Acme \"Best\" & Co.!",
    );
  });

  it("strips CRLF from header fields to prevent email header injection", () => {
    const template = {
      content: {
        subject: "Welcome {{user}} to Notifkit",
        from: "notifications+{{tenant}}@notifkit.internal",
      },
    };

    const variables = {
      user: "Alice\r\nBcc: victim@example.com",
      tenant: "corp\nInjection: dangerous",
    };

    const rendered = renderWithTemplate(template, variables);
    expect((rendered.content as any).subject).toBe(
      "Welcome Alice Bcc: victim@example.com to Notifkit",
    );
    expect((rendered.content as any).from).toBe(
      "notifications+corp Injection: dangerous@notifkit.internal",
    );
  });

  it("interpolates objects and arrays as JSON stringified values", () => {
    const template = {
      content: {
        body: "Payload: {{data}}, Items: {{items}}",
      },
    };

    const variables = {
      data: { score: 100, role: "admin" },
      items: [1, 2, 3],
    };

    const rendered = renderWithTemplate(template, variables);
    expect((rendered.content as any).body).toBe(
      'Payload: {"score":100,"role":"admin"}, Items: [1,2,3]',
    );
  });

  it("renders default fallback payload when dbTemplate is missing", () => {
    const rendered = renderWithTemplate(null, { orderId: "ord_123" });
    expect(rendered.content.subject).toBe("Notification");
    expect(rendered.content.body).toContain('"orderId": "ord_123"');
  });
});
