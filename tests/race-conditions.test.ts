import { describe, it, expect, vi } from "vitest";
import { IdempotencyGuard } from "@/idempotency/index.js";
import { ProjectSettingsCache } from "@/rate-limiter/index.js";
import { AsyncSemaphore, BatchProcessor, CircuitBreaker, sleep } from "@/shared/index.js";

describe("Race Conditions & Concurrency Scenarios", () => {
  describe("IdempotencyGuard Concurrent Contention Race", () => {
    it("admits exactly 1 caller when 20 concurrent requests compete for the same key", async () => {
      // Simulate real in-memory Redis atomic SETNX behavior
      const storage = new Map<string, string>();
      const mockRedis = {
        set: vi.fn(async (key: string, val: string, _ex: string, _ttl: number, mode?: string) => {
          await sleep(Math.random() * 5); // Add jitter to simulate network latency
          if (mode === "NX") {
            if (storage.has(key)) return null;
            storage.set(key, val);
            return "OK";
          }
          storage.set(key, val);
          return "OK";
        }),
      };

      const guard = new IdempotencyGuard({ redis: mockRedis as any, keyPrefix: "race" });

      const results = await Promise.all(
        Array.from({ length: 20 }, () => guard.checkAndMark("same-event-id")),
      );

      const allowedCount = results.filter((res) => res === true).length;
      const blockedCount = results.filter((res) => res === false).length;

      expect(allowedCount).toBe(1);
      expect(blockedCount).toBe(19);
    });
  });

  describe("ProjectSettingsCache Stampede Race", () => {
    it("coalesces 25 concurrent queries for a cold project into exactly 1 database load", async () => {
      let dbQueries = 0;
      const load = vi.fn(async (_projectId: string) => {
        dbQueries++;
        await sleep(15); // Simulate DB query latency
        return { throttleLimit: 100, throttleWindowHours: 24 };
      });

      const cache = new ProjectSettingsCache(load);

      // 25 callers request the cold project at the exact same moment
      const results = await Promise.all(
        Array.from({ length: 25 }, () => cache.get("cold-project-id")),
      );

      expect(load).toHaveBeenCalledTimes(1);
      expect(dbQueries).toBe(1);
      for (const res of results) {
        expect(res).toEqual({ throttleLimit: 100, throttleWindowHours: 24 });
      }
    });

    it("does not poison subsequent callers if the in-flight stampede load rejects", async () => {
      let attempts = 0;
      const load = vi.fn(async (_projectId: string) => {
        attempts++;
        await sleep(10);
        if (attempts === 1) throw new Error("database_timeout");
        return { throttleLimit: 50, throttleWindowHours: 12 };
      });

      const cache = new ProjectSettingsCache(load);

      // First batch of 5 concurrent callers fails
      const firstBatch = Promise.allSettled(
        Array.from({ length: 5 }, () => cache.get("failing-project-id")),
      );

      const firstResults = await firstBatch;
      expect(firstResults.every((r) => r.status === "rejected")).toBe(true);

      // Second batch after failure should retry the loader and succeed
      const secondBatch = Promise.all(
        Array.from({ length: 5 }, () => cache.get("failing-project-id")),
      );

      const secondResults = await secondBatch;
      expect(secondResults.every((r) => r.throttleLimit === 50)).toBe(true);
      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("CircuitBreaker Half-Open Single-Flight Probe Race", () => {
    it("allows only 1 probe caller through when 20 callers hit an OPEN breaker after timeout", async () => {
      const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 25 });

      // Trip the breaker into OPEN
      await expect(
        breaker.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
      expect(breaker.getState()).toBe("OPEN");

      // Wait for reset timeout to elapse
      await sleep(35);

      let probeInvocations = 0;
      const action = vi.fn(async () => {
        probeInvocations++;
        await sleep(15);
        return "probe_success";
      });

      // 20 callers simultaneously attempt to execute
      const results = await Promise.allSettled(
        Array.from({ length: 20 }, () => breaker.execute(action)),
      );

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");

      // Exactly 1 caller acted as the probe
      expect(action).toHaveBeenCalledTimes(1);
      expect(probeInvocations).toBe(1);
      expect(fulfilled).toHaveLength(1);
      expect((fulfilled[0] as PromiseFulfilledResult<string>).value).toBe("probe_success");

      // The other 19 callers were fast-rejected with "Circuit breaker is OPEN"
      expect(rejected).toHaveLength(19);
      for (const rej of rejected) {
        expect((rej as PromiseRejectedResult).reason.message).toBe("Circuit breaker is OPEN");
      }

      // After probe succeeded, the circuit is closed again and subsequent calls succeed
      expect(breaker.getState()).toBe("CLOSED");
      await expect(breaker.execute(async () => "now_open_to_all")).resolves.toBe("now_open_to_all");
    });
  });

  describe("BatchProcessor High-Concurrency Stress", () => {
    it("handles 100 concurrent items correctly resolving each item to its mapped index", async () => {
      const processor = new BatchProcessor<number, string>(10, 50, async (batch) => {
        await sleep(5);
        return batch.map((item) => `item_${item * 2}`);
      });

      const promises = Array.from({ length: 100 }, (_, index) => processor.add(index));
      const results = await Promise.all(promises);

      expect(results).toHaveLength(100);
      for (let i = 0; i < 100; i++) {
        expect(results[i]).toBe(`item_${i * 2}`);
      }
    });
  });

  describe("AsyncSemaphore Contention & No Leak Race", () => {
    it("guarantees maximum concurrency bound and leaves 0 active count after 50 concurrent tasks", async () => {
      const maxConcurrency = 3;
      const sem = new AsyncSemaphore(maxConcurrency);
      let currentActive = 0;
      let peakActive = 0;

      const task = async (index: number) => {
        await sem.acquire();
        currentActive++;
        peakActive = Math.max(peakActive, currentActive);
        await sleep(Math.random() * 10 + 2);
        currentActive--;
        sem.release();
        return index;
      };

      const results = await Promise.all(Array.from({ length: 50 }, (_, i) => task(i)));

      expect(results).toHaveLength(50);
      expect(peakActive).toBeLessThanOrEqual(maxConcurrency);
      expect(currentActive).toBe(0);
      expect(sem.activeCount).toBe(0);
    });
  });
});
