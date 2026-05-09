// Lightweight mock for `getSupabaseServiceRoleClient()` route-level
// tests. Lets a test stage the response for each
// `(table, operation)` round-trip the route is expected to make,
// without standing up a real PostgREST server.
//
// Usage:
//
//   import {
//     installSupabaseMock,
//     stageSupabaseResponse,
//   } from "../../test-helpers/supabase-mock";
//
//   const supabaseMock = installSupabaseMock();
//   beforeEach(() => supabaseMock.reset());
//
//   stageSupabaseResponse("patients", "select", {
//     data: { id, status: "active", phone_e164: "+1...", … },
//   });
//   stageSupabaseResponse("conversations", "insert", {
//     data: { id: CONVERSATION_ID },
//   });
//
// Operation lock-in: the first verb we see on the table builder
// (`select` / `insert` / `update` / `upsert` / `delete`) determines
// the staged-response key. A subsequent `.select(...)` after `.insert`
// or `.update` (the PostgREST RETURNING shape) does NOT reclassify
// the call — the builder still resolves out of the `insert` /
// `update` queue. This matches how the `@workspace/resupply-db`
// helpers actually compose query chains.
//
// Terminators (`.maybeSingle()`, `.single()`, `await builder`,
// `.then()`) all resolve to the same staged `{ data, error }` envelope
// PostgREST returns, so route code that destructures `{ data, error }`
// just works. `count`/`status` are returned as `undefined`/`200` if a
// caller reaches for them; tests can override by passing them in the
// stage object.

import { vi } from "vitest";

export type SupabaseOp = "select" | "insert" | "update" | "upsert" | "delete";

export interface StagedSupabaseResponse {
  data?: unknown;
  error?: unknown;
  count?: number | null;
  status?: number;
  statusText?: string;
}

const queues = new Map<string, StagedSupabaseResponse[]>();

function key(table: string, op: SupabaseOp): string {
  return `${table}.${op}`;
}

/**
 * Stage one `{ data, error }` envelope to be returned the next time
 * the route issues `(op)` against `(table)`. Multiple stages on the
 * same key form a FIFO queue.
 */
export function stageSupabaseResponse(
  table: string,
  op: SupabaseOp,
  result: StagedSupabaseResponse,
): void {
  const list = queues.get(key(table, op)) ?? [];
  list.push(result);
  queues.set(key(table, op), list);
}

function popResponse(
  table: string,
  op: SupabaseOp,
): StagedSupabaseResponse {
  const k = key(table, op);
  const list = queues.get(k);
  if (!list || list.length === 0) {
    // Unstaged calls return an empty success envelope. The PostgREST
    // shape for a select-many is `{ data: [] }`; for a maybeSingle it
    // is `{ data: null }`. We pick `null` here because the helpers
    // overwhelmingly call `maybeSingle()` and `null` is the right
    // semantic default ("no row matched"). Tests that need an empty
    // array stage `{ data: [] }` explicitly.
    return { data: null, error: null };
  }
  return list.shift()!;
}

interface TableBuilder {
  // Verb methods — the first one called locks the op type.
  select: (...args: unknown[]) => TableBuilder;
  insert: (...args: unknown[]) => TableBuilder;
  update: (...args: unknown[]) => TableBuilder;
  upsert: (...args: unknown[]) => TableBuilder;
  delete: (...args: unknown[]) => TableBuilder;
  // Filter/order/limit chain — all no-ops that return the builder.
  eq: (...args: unknown[]) => TableBuilder;
  neq: (...args: unknown[]) => TableBuilder;
  in: (...args: unknown[]) => TableBuilder;
  lt: (...args: unknown[]) => TableBuilder;
  lte: (...args: unknown[]) => TableBuilder;
  gt: (...args: unknown[]) => TableBuilder;
  gte: (...args: unknown[]) => TableBuilder;
  not: (...args: unknown[]) => TableBuilder;
  is: (...args: unknown[]) => TableBuilder;
  filter: (...args: unknown[]) => TableBuilder;
  order: (...args: unknown[]) => TableBuilder;
  limit: (...args: unknown[]) => TableBuilder;
  range: (...args: unknown[]) => TableBuilder;
  // Terminators — return the staged envelope.
  maybeSingle: () => Promise<StagedSupabaseResponse>;
  single: () => Promise<StagedSupabaseResponse>;
  then: <TResult1 = unknown, TResult2 = never>(
    onfulfilled?:
      | ((value: StagedSupabaseResponse) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null,
  ) => Promise<TResult1 | TResult2>;
}

function makeTableBuilder(table: string): TableBuilder {
  let op: SupabaseOp | null = null;
  const setOp = (next: SupabaseOp): void => {
    // Verb methods called more than once on the same builder
    // shouldn't happen in our codebase, but we lock in the FIRST verb
    // because PostgREST's RETURNING shape is `insert(...).select(...)`
    // — the trailing `.select(...)` is decoration, not a new query.
    if (op === null || (op === "select" && next !== "select")) {
      op = next;
    }
  };

  const finalize = (): Promise<StagedSupabaseResponse> => {
    return Promise.resolve(popResponse(table, op ?? "select"));
  };

  const builder: TableBuilder = {
    select: () => {
      setOp("select");
      return builder;
    },
    insert: () => {
      setOp("insert");
      return builder;
    },
    update: () => {
      setOp("update");
      return builder;
    },
    upsert: () => {
      setOp("upsert");
      return builder;
    },
    delete: () => {
      setOp("delete");
      return builder;
    },
    eq: () => builder,
    neq: () => builder,
    in: () => builder,
    lt: () => builder,
    lte: () => builder,
    gt: () => builder,
    gte: () => builder,
    not: () => builder,
    is: () => builder,
    filter: () => builder,
    order: () => builder,
    limit: () => builder,
    range: () => builder,
    maybeSingle: () => finalize(),
    single: () => finalize(),
    then: (onfulfilled, onrejected) => finalize().then(onfulfilled, onrejected),
  };
  return builder;
}

export interface SupabaseMockHandle {
  /** Reset all staged responses. Call from `beforeEach`. */
  reset(): void;
  /** Stage a response. Equivalent to calling `stageSupabaseResponse`. */
  stage(
    table: string,
    op: SupabaseOp,
    result: StagedSupabaseResponse,
  ): void;
}

/**
 * Wire a `vi.mock("@workspace/resupply-db", ...)` factory that returns
 * a stub `getSupabaseServiceRoleClient()`. Other named exports of
 * resupply-db are passed through unchanged via `vi.importActual`.
 *
 * Returns a handle for resetting staged responses and staging more
 * inline. The returned handle is also installed on the function's
 * own state so tests can call `stageSupabaseResponse(...)` standalone.
 *
 * IMPORTANT: this must run before any code that imports the route
 * under test. In a vitest file, that means it must be hoisted via
 * `vi.mock`. Call this function from the top level of the test file.
 */
export function installSupabaseMock(): SupabaseMockHandle {
  vi.mock("@workspace/resupply-db", async () => {
    const actual = await vi.importActual<
      typeof import("@workspace/resupply-db")
    >("@workspace/resupply-db");
    return {
      ...actual,
      getSupabaseServiceRoleClient: () => ({
        schema: () => ({
          from: (table: string) => makeTableBuilder(table),
        }),
      }),
      // Best-effort projection upserts — the route tests don't
      // exercise projection refresh assertions, so we no-op the
      // helper rather than route through the mock builder. Tests
      // that care can override on a per-test basis.
      tryUpsertPatientLatestMessageSb: vi.fn(async () => true),
    };
  });

  return {
    reset() {
      queues.clear();
    },
    stage(table, op, result) {
      stageSupabaseResponse(table, op, result);
    },
  };
}
