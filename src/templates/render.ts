export function escapeHtml(unsafe: string): string {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Strip CR/LF so an interpolated value cannot inject extra headers. */
export function escapeHeader(unsafe: string): string {
  return String(unsafe)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

export function interpolate(
  tmpl: string,
  variables: Record<string, unknown>,
  sanitize = true,
): string {
  return tmpl
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k: string) => {
      return String(variables[k] ?? "");
    })
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const val = String(variables[k] ?? "");
      return sanitize ? escapeHtml(val) : val;
    });
}

/**
 * How an interpolated value must be escaped, decided by the field it lands in.
 *
 *   html   — rendered as markup, so values are HTML-escaped
 *   header — single-line headers (subject, from, …), so CR/LF are stripped
 *   text   — plain text body, no escaping needed
 */
export type EscapeMode = "html" | "header" | "text";

const HTML_FIELDS = new Set(["html", "htmlbody", "bodyhtml", "htmlcontent"]);
const HEADER_FIELDS = new Set([
  "subject",
  "title",
  "from",
  "replyto",
  "cc",
  "bcc",
  "preheader",
  "preview",
]);

function escapeModeFor(key: string, inherited: EscapeMode): EscapeMode {
  const k = key.toLowerCase().replace(/[-_]/g, "");
  if (HTML_FIELDS.has(k)) return "html";
  if (HEADER_FIELDS.has(k)) return "header";
  return inherited;
}

function applyEscape(value: string, mode: EscapeMode): string {
  if (mode === "html") return escapeHtml(value);
  if (mode === "header") return escapeHeader(value);
  return value;
}

/**
 * Interpolate `{{var}}` placeholders in a single leaf string.
 *
 * `{{{var}}}` (triple braces) interpolates raw unescaped values.
 * `{{var}}` (double braces) applies contextual escaping to the substituted value.
 */
function interpolateLeaf(
  tmpl: string,
  variables: Record<string, unknown>,
  mode: EscapeMode,
): string {
  return tmpl
    .replace(/\{\{\{(\w+)\}\}\}/g, (_, k: string) => {
      const raw = variables[k];
      if (raw === undefined || raw === null) return "";
      return typeof raw === "string" ? raw : JSON.stringify(raw);
    })
    .replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
      const raw = variables[k];
      if (raw === undefined || raw === null) return "";
      return applyEscape(typeof raw === "string" ? raw : JSON.stringify(raw), mode);
    });
}

/**
 * Walk a template content tree and interpolate every leaf string in place.
 *
 * Values are substituted into the already-parsed structure. Interpolating into
 * serialised JSON and re-parsing (the previous approach) let a value containing
 * a quote either break JSON.parse outright or forge sibling fields such as
 * `htmlBody`.
 */
function renderNode(node: unknown, variables: Record<string, unknown>, mode: EscapeMode): unknown {
  if (typeof node === "string") return interpolateLeaf(node, variables, mode);
  if (Array.isArray(node)) return node.map((item) => renderNode(item, variables, mode));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = renderNode(value, variables, escapeModeFor(key, mode));
    }
    return out;
  }
  return node;
}

export function renderWithTemplate(
  dbTemplate: { content?: any } | null | undefined,
  templateVariables: Record<string, unknown>,
): { content: Record<string, unknown> } {
  const vars = templateVariables ?? {};

  if (dbTemplate) {
    const content = (dbTemplate.content ?? {}) as Record<string, unknown>;
    return { content: renderNode(content, vars, "text") as Record<string, unknown> };
  }

  return {
    content: {
      subject: "Notification",
      body: JSON.stringify(vars, null, 2),
    },
  };
}
