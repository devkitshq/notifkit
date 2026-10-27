import type { IncomingMessage, ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import type { ZodError } from "zod";

export async function readRawBody(req: IncomingMessage): Promise<string> {
  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024; // 5MB limit
    req.on("data", (chunk: Buffer) => {
      totalLength += chunk.length;
      if (totalLength > MAX_PAYLOAD_SIZE) {
        req.destroy();
        reject(new HttpError(413, "payload_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
  return raw;
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    // Decode chunk by chunk: avoids the Buffer.concat + toString() copy that
    // readRawBody pays. readRawBody is kept for webhook callers that need raw
    // bytes for HMAC verification. The limit counts bytes as they arrive;
    // counting decoded characters let multibyte text through at up to three
    // times the limit. StringDecoder keeps a character split across two
    // chunks intact.
    const decoder = new StringDecoder("utf8");
    let body = "";
    let totalLength = 0;
    const MAX_PAYLOAD_SIZE = 5 * 1024 * 1024;
    req.on("data", (chunk: string | Buffer) => {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totalLength += bytes.length;
      if (totalLength > MAX_PAYLOAD_SIZE) {
        if (typeof req.destroy === "function") req.destroy();
        reject(new HttpError(413, "payload_too_large"));
        return;
      }
      body += decoder.write(bytes);
    });
    req.on("end", () => {
      body += decoder.end();
      const trimmed = body.trim();
      if (!trimmed) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as unknown);
      } catch {
        reject(new HttpError(400, "malformed_json"));
      }
    });
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204).end();
}

/** Turn a Zod error into a 400 response with field-level issues. */
export function sendValidationError(res: ServerResponse, error: ZodError): void {
  sendJson(res, 400, {
    error: "validation_error",
    issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
  });
}

/** A thrown HttpError short-circuits a handler with a specific status/body. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
