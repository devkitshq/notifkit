import { randomUUID } from "node:crypto";

export function generateId(): string {
  return randomUUID();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }
}

export class ValidationError extends AppError {
  readonly fields?: Record<string, string[]>;

  constructor(message: string, fields?: Record<string, string[]>, options?: ErrorOptions) {
    super(message, "VALIDATION_ERROR", options);
    this.name = "ValidationError";
    this.fields = fields;
  }
}

export * from "./events.js";
export * from "./cache.js";
export * from "./utils.js";
export * from "./semaphore.js";
export * from "./batch-processor.js";
export * from "./cache.js";
export * from "./circuit-breaker.js";
export * from "./dataloader.js";
export { type WorkerOptions } from "@/workers/index.js";
