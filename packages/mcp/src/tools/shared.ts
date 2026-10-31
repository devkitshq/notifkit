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

function interpolateValue(
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
      const val = typeof raw === "string" ? raw : JSON.stringify(raw);
      if (mode === "html") return escapeHtml(val);
      if (mode === "header") return escapeHeader(val);
      return val;
    });
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
