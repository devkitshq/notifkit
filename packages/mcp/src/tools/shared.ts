import { NotifkitApiError } from "../client.js";

export const CHANNELS = [
  "email",
  "sms",
  "push",
  "webhook",
  "in-app",
  "telegram",
  "discord",
  "whatsapp",
  "slack",
] as const;
// The server accepts contacts on every channel, in-app included.
export const CONTACT_CHANNELS = CHANNELS;
export const PRIORITIES = ["low", "normal", "high", "critical"] as const;

interface ToolResult {
  // The SDK's tool-result type carries an index signature for protocol
  // extensions; without one here an interface is not assignable to it.
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Render any handler return value as the text payload MCP clients expect. */
function ok(value: unknown): ToolResult {
  const text =
    value === undefined
      ? "Done."
      : typeof value === "string"
        ? value
        : JSON.stringify(value, null, 2);
  return { content: [{ type: "text", text }] };
}

function fail(error: unknown): ToolResult {
  const text =
    error instanceof NotifkitApiError
      ? `notifkit API error (HTTP ${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap a handler so a failed request is reported to the model instead of killing the server. */
export function handler<T>(fn: (args: T) => Promise<unknown>) {
  return async (args: T): Promise<ToolResult> => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return fail(error);
    }
  };
}

function escapeHtml(unsafe: string): string {
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeHeader(unsafe: string): string {
  return String(unsafe)
    .replace(/[\r\n]+/g, " ")
    .trim();
}

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

// Placeholders follow the server's renderer (src/templates/render.ts) so a
// preview shows what will be sent: `{{{path}}}` (group 1) or `{{path}}`
// (group 2), a path being a name or a dotted path (`user.name`), with optional
// whitespace inside the braces.
const PLACEHOLDER = /\{\{\{\s*(\w+(?:\.\w+)*)\s*\}\}\}|\{\{\s*(\w+(?:\.\w+)*)\s*\}\}/g;

/** The value at a dotted path, reading own properties only; undefined when missing. */
export function valueAt(variables: Record<string, unknown>, path: string): unknown {
  let value: unknown = variables;
  for (const segment of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function lookup(variables: Record<string, unknown>, path: string): string {
  const value = valueAt(variables, path);
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function applyEscape(value: string, mode: EscapeMode): string {
  if (mode === "html") return escapeHtml(value);
  if (mode === "header") return escapeHeader(value);
  return value;
}

// One pass, so an inserted value is never scanned for placeholders again.
function interpolateValue(
  tmpl: string,
  variables: Record<string, unknown>,
  mode: EscapeMode,
): string {
  return tmpl.replace(
    PLACEHOLDER,
    (_, rawPath: string | undefined, escapedPath: string | undefined) =>
      rawPath !== undefined
        ? lookup(variables, rawPath)
        : applyEscape(lookup(variables, escapedPath ?? ""), mode),
  );
}

/** Every placeholder path used in the strings of a content tree, once each, in order. */
export function placeholderPaths(node: unknown): string[] {
  const paths = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      for (const match of value.matchAll(PLACEHOLDER)) paths.add(match[1] ?? match[2] ?? "");
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  visit(node);
  return [...paths];
}

export function renderContentNode(
  node: unknown,
  variables: Record<string, unknown>,
  mode: EscapeMode,
): unknown {
  if (typeof node === "string") return interpolateValue(node, variables, mode);
  if (Array.isArray(node)) return node.map((item) => renderContentNode(item, variables, mode));
  if (node && typeof node === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      out[key] = renderContentNode(value, variables, escapeModeFor(key, mode));
    }
    return out;
  }
  return node;
}
