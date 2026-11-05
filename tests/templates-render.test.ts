import { describe, it, expect } from "vitest";
import { renderWithTemplate } from "@/templates/render.js";

describe("renderWithTemplate", () => {
  it("does not break when a variable contains a double quote", () => {
    const template = { content: { subject: "Hi {{name}}", text: "Welcome {{name}}" } };
    const out = renderWithTemplate(template, { name: 'John "JD" Smith' });

    expect(out.content.subject).toBe('Hi John "JD" Smith');
    expect(out.content.text).toBe('Welcome John "JD" Smith');
  });

  it("does not let a variable forge sibling template fields", () => {
    const template = { content: { subject: "Hi {{name}}", text: "hello" } };
    // Payload crafted to close the JSON string and inject htmlBody.
    const out = renderWithTemplate(template, {
      name: '","htmlBody":"<script>alert(1)</script>","x":"',
    });

    expect(out.content).not.toHaveProperty("htmlBody");
    expect(out.content).not.toHaveProperty("x");
    expect(Object.keys(out.content).sort()).toEqual(["subject", "text"]);
  });

  it("HTML-escapes values landing in html fields but not in text fields", () => {
    const template = { content: { html: "<p>{{bio}}</p>", text: "{{bio}}" } };
    const out = renderWithTemplate(template, { bio: "<script>x</script>" });

    expect(out.content.html).toBe("<p>&lt;script&gt;x&lt;/script&gt;</p>");
    expect(out.content.text).toBe("<script>x</script>");
  });

  it("strips CR/LF from header fields to prevent header injection", () => {
    const template = { content: { subject: "Order {{ref}}" } };
    const out = renderWithTemplate(template, { ref: "A1\r\nBcc: victim@example.com" });

    expect(out.content.subject).toBe("Order A1 Bcc: victim@example.com");
    expect(out.content.subject).not.toContain("\n");
  });

  it("interpolates nested objects and arrays", () => {
    const template = { content: { blocks: [{ title: "{{a}}" }], meta: { k: "{{b}}" } } };
    const out = renderWithTemplate(template, { a: "one", b: "two" });

    expect(out.content).toEqual({ blocks: [{ title: "one" }], meta: { k: "two" } });
  });
});
