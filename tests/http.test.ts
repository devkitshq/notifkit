import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { z } from "zod";
import {
  readRawBody,
  readJsonBody,
  sendJson,
  sendNoContent,
  sendValidationError,
  HttpError,
} from "@/services/api/http.js";

function createMockIncomingMessage(
  chunks: (string | Buffer)[] = [],
  options?: { emitError?: Error },
) {
  const req = new EventEmitter() as any;
  req.destroy = vi.fn();

  process.nextTick(() => {
    if (options?.emitError) {
      req.emit("error", options.emitError);
      return;
    }
    for (const chunk of chunks) {
      req.emit("data", typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    req.emit("end");
  });

  return req;
}

function createMockServerResponse() {
  const res = {
    statusCode: 200,
    headers: {} as Record<string, any>,
    body: "",
    writeHead: vi.fn((status: number, headers?: Record<string, any>) => {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
      return res;
    }),
    end: vi.fn((data?: string) => {
      if (data !== undefined) res.body = data;
      return res;
    }),
  } as any;
  return res;
}

describe("HTTP Helpers (src/services/api/http.ts)", () => {
  describe("readRawBody", () => {
    it("reads full payload string from incoming stream chunks", async () => {
      const req = createMockIncomingMessage(["Hello, ", "world!"]);
      const body = await readRawBody(req);
      expect(body).toBe("Hello, world!");
    });

    it("handles empty stream and resolves with empty string", async () => {
      const req = createMockIncomingMessage([]);
      const body = await readRawBody(req);
      expect(body).toBe("");
    });

    it("throws HttpError 413 payload_too_large and destroys request when payload exceeds 5MB", async () => {
      // 5MB is 5 * 1024 * 1024 bytes (5,242,880)
      const oversizedChunk = Buffer.alloc(5 * 1024 * 1024 + 1, "a");
      const req = createMockIncomingMessage([oversizedChunk]);

      await expect(readRawBody(req)).rejects.toMatchObject({
        status: 413,
        code: "payload_too_large",
      });
      expect(req.destroy).toHaveBeenCalled();
    });

    it("propagates stream error when request stream emits error", async () => {
      const streamErr = new Error("Connection reset by peer");
      const req = createMockIncomingMessage([], { emitError: streamErr });

      await expect(readRawBody(req)).rejects.toThrow("Connection reset by peer");
    });
  });

  describe("readJsonBody", () => {
    it("parses valid JSON object payload", async () => {
      const req = createMockIncomingMessage([JSON.stringify({ key: "value", number: 42 })]);
      const result = await readJsonBody(req);
      expect(result).toEqual({ key: "value", number: 42 });
    });

    it("returns undefined when body is empty or only whitespace", async () => {
      const req = createMockIncomingMessage(["   \n\t  "]);
      const result = await readJsonBody(req);
      expect(result).toBeUndefined();
    });

    it("throws HttpError 400 malformed_json when body is invalid JSON", async () => {
      const req = createMockIncomingMessage(["{ invalid json: true "]);
      await expect(readJsonBody(req)).rejects.toMatchObject({
        status: 400,
        code: "malformed_json",
      });
    });
  });

  describe("sendJson", () => {
    it("writes JSON header, Content-Length, and serialized body", () => {
      const res = createMockServerResponse();
      const payload = { success: true, count: 5 };
      sendJson(res, 200, payload);

      const jsonStr = JSON.stringify(payload);
      expect(res.writeHead).toHaveBeenCalledWith(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonStr),
      });
      expect(res.end).toHaveBeenCalledWith(jsonStr);
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(jsonStr);
    });

    it("handles utf-8 multibyte characters in Content-Length correctly", () => {
      const res = createMockServerResponse();
      const payload = { message: "🚀 Notification ✨" };
      sendJson(res, 201, payload);

      const jsonStr = JSON.stringify(payload);
      expect(res.writeHead).toHaveBeenCalledWith(201, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(jsonStr),
      });
      expect(Buffer.byteLength(jsonStr)).toBeGreaterThan(jsonStr.length);
    });
  });

  describe("sendNoContent", () => {
    it("writes 204 status and ends the response without body", () => {
      const res = createMockServerResponse();
      sendNoContent(res);

      expect(res.writeHead).toHaveBeenCalledWith(204);
      expect(res.end).toHaveBeenCalled();
      expect(res.body).toBe("");
    });
  });

  describe("sendValidationError", () => {
    it("transforms ZodError issues into a structured 400 validation error response", () => {
      const schema = z.object({
        user: z.object({
          email: z.string().email(),
          age: z.number().min(18),
        }),
      });

      const parseResult = schema.safeParse({
        user: {
          email: "invalid-email",
          age: 15,
        },
      });

      expect(parseResult.success).toBe(false);
      if (!parseResult.success) {
        const res = createMockServerResponse();
        sendValidationError(res, parseResult.error);

        expect(res.statusCode).toBe(400);
        const parsedBody = JSON.parse(res.body);
        expect(parsedBody.error).toBe("validation_error");
        expect(parsedBody.issues).toEqual([
          { path: "user.email", message: "Invalid email" },
          { path: "user.age", message: "Number must be greater than or equal to 18" },
        ]);
      }
    });
  });

  describe("HttpError", () => {
    it("sets status and code with default code message", () => {
      const err = new HttpError(404, "not_found");
      expect(err.status).toBe(404);
      expect(err.code).toBe("not_found");
      expect(err.message).toBe("not_found");
    });

    it("uses custom message when provided", () => {
      const err = new HttpError(403, "forbidden", "You do not have access to this resource");
      expect(err.status).toBe(403);
      expect(err.code).toBe("forbidden");
      expect(err.message).toBe("You do not have access to this resource");
    });
  });
});
