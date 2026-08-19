import { describe, it, expect, vi } from "vitest";
import {
  AsyncSemaphore,
  BatchProcessor,
  CircuitBreaker,
  DataLoader,
  LRUCache,
  sleep,
} from "@/shared/index.js";

// The concurrency primitives every worker is built on. They were previously
// covered only incidentally, through the workers that use them, which left the
// failure paths — eviction, rejection, re-arming after a flush — unexercised.

describe("AsyncSemaphore", () => {
  it("admits up to max holders without blocking", async () => {
    const sem = new AsyncSemaphore(3);

    await sem.acquire();
    await sem.acquire();
    await sem.acquire();

    expect(sem.activeCount).toBe(3);
  });

  it("makes the (max + 1)th caller wait until a permit is released", async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire();

    let admitted = false;
    const waiter = sem.acquire().then(() => {
      admitted = true;
    });

    // A microtask turn is enough for a non-blocking acquire to have resolved.
    await Promise.resolve();
    expect(admitted).toBe(false);

    sem.release();
    await waiter;
    expect(admitted).toBe(true);
  });

  it("hands permits to waiters in FIFO order", async () => {
    const sem = new AsyncSemaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const waiters = [
      sem.acquire().then(() => order.push(1)),
      sem.acquire().then(() => order.push(2)),
      sem.acquire().then(() => order.push(3)),
    ];

    sem.release();
    sem.release();
    sem.release();
    await Promise.all(waiters);

    expect(order).toEqual([1, 2, 3]);
  });

  it("hands a permit straight to the next waiter rather than dropping the count", async () => {
    const sem = new AsyncSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    const waiter = sem.acquire();
    sem.release();
    await waiter;

    // The permit moved from one holder to the next, so occupancy is unchanged.
    expect(sem.activeCount).toBe(2);
  });

  it("caps real concurrency when many tasks contend for few permits", async () => {
    const sem = new AsyncSemaphore(2);
    let inFlight = 0;
    let peak = 0;

    const task = async () => {
      await sem.acquire();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(5);
      inFlight--;
      sem.release();
    };

    await Promise.all(Array.from({ length: 10 }, task));

    expect(peak).toBe(2);
    expect(inFlight).toBe(0);
  });

  it("ignores a release with nothing held, rather than banking a spare permit", async () => {
    // An unbalanced release is a caller bug, but letting the count go negative
    // turns it into over-admission much later, a long way from the cause.
    const sem = new AsyncSemaphore(1);
    await sem.acquire();
    sem.release();
    sem.release();

    expect(sem.activeCount).toBe(0);
  });

  it("still admits only max holders after an unbalanced release", async () => {
    const sem = new AsyncSemaphore(1);
    sem.release();
    sem.release();

    await sem.acquire();
    expect(sem.activeCount).toBe(1);

    let admitted = false;
    void sem.acquire().then(() => {
      admitted = true;
    });
    await Promise.resolve();

    expect(admitted).toBe(false);
  });
});

describe("LRUCache", () => {
  it("returns a stored value before its TTL elapses", () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    cache.set("a", 1);
    expect(cache.get("a")).toBe(1);
  });

  it("reports a missing key as undefined", () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    expect(cache.get("nope")).toBeUndefined();
  });

  it("evicts the oldest entry once maxSize is reached", () => {
    const cache = new LRUCache<string, number>(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("a read refreshes recency, so the read key survives the next eviction", () => {
    const cache = new LRUCache<string, number>(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);

    // Touching "a" makes "b" the oldest.
    expect(cache.get("a")).toBe(1);
    cache.set("c", 3);

    expect(cache.get("a")).toBe(1);
    expect(cache.get("b")).toBeUndefined();
  });

  it("overwriting a key replaces it instead of growing the cache", () => {
    const cache = new LRUCache<string, number>(2, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("a", 99);
    cache.set("c", 3);

    // "a" was rewritten, so "b" is the oldest and the one to go.
    expect(cache.get("a")).toBe(99);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBe(3);
  });

  it("drops an entry whose TTL has passed", async () => {
    const cache = new LRUCache<string, number>(10, 10);
    cache.set("a", 1);
    await sleep(25);

    expect(cache.get("a")).toBeUndefined();
  });

  it("honours a per-entry TTL over the default", async () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    cache.set("short", 1, 10);
    cache.set("long", 2);
    await sleep(25);

    expect(cache.get("short")).toBeUndefined();
    expect(cache.get("long")).toBe(2);
  });

  it("an expired entry frees its slot, so it does not count toward maxSize", async () => {
    const cache = new LRUCache<string, number>(2, 10);
    cache.set("a", 1);
    await sleep(25);
    expect(cache.get("a")).toBeUndefined();

    cache.set("b", 2);
    cache.set("c", 3);
    expect(cache.get("b")).toBe(2);
    expect(cache.get("c")).toBe(3);
  });

  it("delete removes a single key and clear empties the cache", () => {
    const cache = new LRUCache<string, number>(10, 60_000);
    cache.set("a", 1);
    cache.set("b", 2);

    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe(2);

    cache.clear();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("BatchProcessor", () => {
  it("flushes on maxSize without waiting out the timer", async () => {
    const flushFn = vi.fn(async (items: number[]) => items.map((i) => i * 2));
    // A 10s wait would dominate the test if the size trigger did not fire.
    const processor = new BatchProcessor<number, number>(3, 10_000, flushFn);

    const results = await Promise.all([processor.add(1), processor.add(2), processor.add(3)]);

    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn.mock.calls[0]![0]).toEqual([1, 2, 3]);
    expect(results).toEqual([2, 4, 6]);
  });

  it("flushes a partial batch once maxWaitMs elapses", async () => {
    const flushFn = vi.fn(async (items: number[]) => items.map((i) => i * 2));
    const processor = new BatchProcessor<number, number>(100, 20, flushFn);

    const results = await Promise.all([processor.add(1), processor.add(2)]);

    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(results).toEqual([2, 4]);
  });

  it("resolves each caller with the result at its own index", async () => {
    const processor = new BatchProcessor<string, string>(3, 50, async (items) =>
      items.map((s) => s.toUpperCase()),
    );

    const [a, b, c] = await Promise.all([
      processor.add("a"),
      processor.add("b"),
      processor.add("c"),
    ]);

    expect([a, b, c]).toEqual(["A", "B", "C"]);
  });

  it("rejects every caller in the batch when the flush fails", async () => {
    const boom = new Error("flush failed");
    const processor = new BatchProcessor<number, number>(2, 50, async () => {
      throw boom;
    });

    const first = processor.add(1);
    const second = processor.add(2);

    await expect(first).rejects.toThrow("flush failed");
    await expect(second).rejects.toThrow("flush failed");
  });

  it("a later batch still succeeds after an earlier one failed", async () => {
    let call = 0;
    const processor = new BatchProcessor<number, number>(1, 50, async (items) => {
      call++;
      if (call === 1) throw new Error("transient");
      return items.map((i) => i * 10);
    });

    await expect(processor.add(1)).rejects.toThrow("transient");
    // isFlushing must have been cleared by the finally block, or this hangs.
    await expect(processor.add(2)).resolves.toBe(20);
  });

  it("items added during an in-flight flush are picked up by the next one", async () => {
    const seen: number[][] = [];
    let releaseFirst: () => void = () => {};
    const firstFlush = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let call = 0;
    const processor = new BatchProcessor<number, number>(2, 20, async (items) => {
      seen.push(items);
      call++;
      if (call === 1) await firstFlush;
      return items.map((i) => i);
    });

    const inFirst = Promise.all([processor.add(1), processor.add(2)]);
    // Queued while the first flush is still awaiting.
    const inSecond = Promise.all([processor.add(3), processor.add(4)]);

    releaseFirst();
    await inFirst;
    await inSecond;

    expect(seen).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("an explicit flush of an empty buffer is a no-op", async () => {
    const flushFn = vi.fn(async (items: number[]) => items);
    const processor = new BatchProcessor<number, number>(5, 50, flushFn);

    await processor.flush();

    expect(flushFn).not.toHaveBeenCalled();
  });
});

describe("DataLoader", () => {
  it("coalesces same-tick loads into a single batch call", async () => {
    const batchFn = vi.fn(async (keys: number[]) => keys.map((k) => `v${k}`));
    const loader = new DataLoader<number, string>(batchFn);

    const results = await Promise.all([loader.load(1), loader.load(2), loader.load(3)]);

    expect(batchFn).toHaveBeenCalledTimes(1);
    expect(batchFn.mock.calls[0]![0]).toEqual([1, 2, 3]);
    expect(results).toEqual(["v1", "v2", "v3"]);
  });

  it("starts a fresh batch on the next tick", async () => {
    const batchFn = vi.fn(async (keys: number[]) => keys.map((k) => `v${k}`));
    const loader = new DataLoader<number, string>(batchFn);

    await loader.load(1);
    await loader.load(2);

    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("rejects every pending load when the batch function throws", async () => {
    // The engine's suppression lookup depends on this: a failed query must
    // surface as an error so the message is held, never as "nothing matched".
    const loader = new DataLoader<number, string>(async () => {
      throw new Error("db unreachable");
    });

    const first = loader.load(1);
    const second = loader.load(2);

    await expect(first).rejects.toThrow("db unreachable");
    await expect(second).rejects.toThrow("db unreachable");
  });

  it("rejects only the key whose slot holds an Error", async () => {
    const loader = new DataLoader<number, string>(async (keys) =>
      keys.map((k) => (k === 2 ? new Error("missing 2") : `v${k}`)),
    );

    const first = loader.load(1);
    const second = loader.load(2);

    await expect(first).resolves.toBe("v1");
    await expect(second).rejects.toThrow("missing 2");
  });

  it("recovers on the next batch after a failed one", async () => {
    let call = 0;
    const loader = new DataLoader<number, string>(async (keys) => {
      call++;
      if (call === 1) throw new Error("transient");
      return keys.map((k) => `v${k}`);
    });

    await expect(loader.load(1)).rejects.toThrow("transient");
    await expect(loader.load(1)).resolves.toBe("v1");
  });

  it("passes duplicate keys through as separate slots", async () => {
    // Deduplication, where it matters, is the batch function's job — the
    // engine's suppression loader collapses by project+channel itself.
    const batchFn = vi.fn(async (keys: string[]) => keys.map((k) => k.length));
    const loader = new DataLoader<string, number>(batchFn);

    const results = await Promise.all([loader.load("ab"), loader.load("ab")]);

    expect(batchFn.mock.calls[0]![0]).toEqual(["ab", "ab"]);
    expect(results).toEqual([2, 2]);
  });
});

describe("CircuitBreaker", () => {
  it("returns the action's result and stays closed while it succeeds", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });

    await expect(breaker.execute(async () => "ok")).resolves.toBe("ok");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("opens once failures reach the threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 50 });

    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(breaker.getState()).toBe("CLOSED");

    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(breaker.getState()).toBe("OPEN");
  });

  it("rejects without touching the dependency while open", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");

    const action = vi.fn(async () => "should not run");
    await expect(breaker.execute(action)).rejects.toThrow("Circuit breaker is OPEN");
    expect(action).not.toHaveBeenCalled();
  });

  it("a single success interrupts a run of failures below the threshold", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 50 });

    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await breaker.execute(async () => "ok");
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");

    // The counter reset, so this is failure 1 of 3 rather than 3 of 3.
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("probes again after the reset timeout and closes on success", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(breaker.getState()).toBe("OPEN");

    await sleep(35);
    await expect(breaker.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(breaker.getState()).toBe("CLOSED");
  });

  it("re-opens when the probe after the reset timeout also fails", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");

    await sleep(35);
    await expect(
      breaker.execute(async () => Promise.reject(new Error("still down"))),
    ).rejects.toThrow("still down");
    expect(breaker.getState()).toBe("OPEN");
  });

  it("sends one probe at a time, not the whole waiting crowd", async () => {
    // The first tick after the reset timeout must not throw every queued caller
    // at a dependency that is probably still down.
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await sleep(35);

    const action = vi.fn(async () => {
      await sleep(10);
      return "ok";
    });
    const results = await Promise.allSettled([
      breaker.execute(action),
      breaker.execute(action),
      breaker.execute(action),
    ]);

    expect(action).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(2);
  });

  it("reopens to everyone once the probe succeeds", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 20 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await sleep(35);

    await breaker.execute(async () => "probe ok");
    expect(breaker.getState()).toBe("CLOSED");

    const action = vi.fn(async () => "ok");
    await Promise.all([breaker.execute(action), breaker.execute(action), breaker.execute(action)]);

    expect(action).toHaveBeenCalledTimes(3);
  });

  it("keeps the circuit shut for a fresh timeout after a failed probe", async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 40 });
    await expect(breaker.execute(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await sleep(55);

    // The probe fails, which restarts the clock rather than leaving the circuit
    // open to the next caller immediately.
    await expect(
      breaker.execute(async () => Promise.reject(new Error("still down"))),
    ).rejects.toThrow("still down");

    const action = vi.fn(async () => "ok");
    await expect(breaker.execute(action)).rejects.toThrow("Circuit breaker is OPEN");
    expect(action).not.toHaveBeenCalled();
  });
});
