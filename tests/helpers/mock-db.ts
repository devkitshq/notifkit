import { vi } from "vitest";

/**
 * A recording stand-in for the drizzle client.
 *
 * The handlers build real query chains against the real schema — `and`, `eq`,
 * and `sql` are not mocked — so what needs faking is only the terminal await.
 * Every builder method returns the same thenable, which resolves to the next
 * queued result set, and each mutation is recorded with the table object it was
 * aimed at so a test can assert `toBe(suppressions)` rather than matching a
 * stringified name.
 */

export interface RecordedInsert {
  table: unknown;
  values: any;
  /** Which conflict clause the chain ended with, if any. */
  conflict?: "nothing" | "update";
  /** The `set` of an `onConflictDoUpdate`. */
  set?: any;
}

export interface RecordedSelect {
  table: unknown;
  /** Method names called on the chain, in order, e.g. `["where", "limit"]`. */
  chain: string[];
  /** Argument the chain's `limit()` received, when it had one. */
  limit?: unknown;
}

export interface MockDb {
  db: any;
  selects: RecordedSelect[];
  inserts: RecordedInsert[];
  deletes: { table: unknown }[];
  /** Rows the next unconsumed select resolves to. Queue in call order. */
  queueSelect(rows: any[]): void;
  /** Rows the next insert's `returning()` resolves to. Queue in call order. */
  queueInsert(rows: any[]): void;
  /** Rows the next update's `returning()` resolves to. Queue in call order. */
  queueUpdate(rows: any[]): void;
  /** Rows the next delete's `returning()` resolves to. Queue in call order. */
  queueDelete(rows: any[]): void;
  /** Make every subsequent terminal await reject. */
  failWith(error: Error): void;
}

export function createMockDb(): MockDb {
  const selectQueue: any[][] = [];
  const insertQueue: any[][] = [];
  const updateQueue: any[][] = [];
  const deleteQueue: any[][] = [];
  const selects: RecordedSelect[] = [];
  const inserts: RecordedInsert[] = [];
  const deletes: { table: unknown }[] = [];
  let failure: Error | null = null;

  /**
   * A chain that is also a promise. `then` is what `await` reaches for, so it
   * has to resolve rather than record — everything else records and returns
   * itself, which is how one object stands in for the whole builder.
   */
  function chain(resolve: () => unknown, record: (method: string, args: unknown[]) => void): any {
    const proxy: any = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "then") {
            return (onFulfilled: any, onRejected: any) =>
              (failure ? Promise.reject(failure) : Promise.resolve(resolve())).then(
                onFulfilled,
                onRejected,
              );
          }
          if (prop === "catch") {
            return (onRejected: any) =>
              (failure ? Promise.reject(failure) : Promise.resolve(resolve())).catch(onRejected);
          }
          if (prop === "finally") {
            return (onFinally: any) =>
              (failure ? Promise.reject(failure) : Promise.resolve(resolve())).finally(onFinally);
          }
          // Vitest and node internals probe these; answering with a function
          // would make the object look callable in ways that break printing.
          if (prop === Symbol.toStringTag || prop === "constructor" || prop === "$$typeof") {
            return undefined;
          }
          return (...args: unknown[]) => {
            record(String(prop), args);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }

  const db = {
    select: vi.fn(() => {
      const record: RecordedSelect = { table: undefined, chain: [] };
      return chain(
        () => selectQueue.shift() ?? [],
        (method, args) => {
          if (method === "from") {
            record.table = args[0];
            selects.push(record);
            return;
          }
          record.chain.push(method);
          if (method === "limit") record.limit = args[0];
        },
      );
    }),

    insert: vi.fn((table: unknown) => {
      const record: RecordedInsert = { table, values: undefined };
      inserts.push(record);
      return chain(
        () => insertQueue.shift() ?? [],
        (method, args) => {
          if (method === "values") record.values = args[0];
          if (method === "onConflictDoNothing") record.conflict = "nothing";
          if (method === "onConflictDoUpdate") {
            record.conflict = "update";
            record.set = (args[0] as any)?.set;
          }
        },
      );
    }),

    delete: vi.fn((table: unknown) => {
      deletes.push({ table });
      // Deletes are usually awaited for their side effect, but a handler that
      // needs to know whether anything matched ends the chain with returning().
      return chain(
        () => deleteQueue.shift() ?? [],
        () => {},
      );
    }),

    update: vi.fn(() =>
      chain(
        () => updateQueue.shift() ?? [],
        () => {},
      ),
    ),

    transaction: vi.fn(async (cb: any) => cb(db)),
  };

  return {
    db,
    selects,
    inserts,
    deletes,
    queueSelect(rows: any[]) {
      selectQueue.push(rows);
    },
    queueInsert(rows: any[]) {
      insertQueue.push(rows);
    },
    queueUpdate(rows: any[]) {
      updateQueue.push(rows);
    },
    queueDelete(rows: any[]) {
      deleteQueue.push(rows);
    },
    failWith(error: Error) {
      failure = error;
    },
  };
}
