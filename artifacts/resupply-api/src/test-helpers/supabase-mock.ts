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
  throws?: unknown;
}

const queues = new Map<string, StagedSupabaseResponse[]>();
const callCounts = new Map<string, number>();
// Per-(table, op) log of the payloads passed to write verbs
// (`.insert(payload)`, `.update(payload)`, `.upsert(payload)`,
// `.delete()` records `undefined`). Order is preserved so a test that
// makes N writes can read them off in order.
const writePayloads = new Map<string, unknown[]>();
// Per-(table, op) log of filter / order verbs and their args, captured
// across the chain (`.eq("col", val)`, `.ilike(...)`, `.gte(...)`, etc.).
// Lets a test assert "the route applied an `.ilike("action", "%x%")`
// filter on this select", which is the closest behavioural check
// available without inspecting raw SQL.
export interface CapturedFilterCall {
  verb: string;
  args: unknown[];
}
const filterCalls = new Map<string, CapturedFilterCall[]>();

// Separate FIFO queues for `supabase.schema(...).rpc(fnName, args)`
// calls. Keyed by function name. Counters and arg-payload lists are
// kept alongside so tests can assert "the route called fn X N times
// with args { ... }".
const rpcQueues = new Map<string, StagedSupabaseResponse[]>();
const rpcCallCounts = new Map<string, number>();
const rpcCallArgs = new Map<string, unknown[]>();

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
  like: (...args: unknown[]) => TableBuilder;
  ilike: (...args: unknown[]) => TableBuilder;
  match: (...args: unknown[]) => TableBuilder;
  contains: (...args: unknown[]) => TableBuilder;
  containedBy: (...args: unknown[]) => TableBuilder;
  textSearch: (...args: unknown[]) => TableBuilder;
  filter: (...args: unknown[]) => TableBuilder;
  or: (...args: unknown[]) => TableBuilder;
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

function bumpCallCount(table: string, op: SupabaseOp): void {
  const k = key(table, op);
  callCounts.set(k, (callCounts.get(k) ?? 0) + 1);
}

function makeTableBuilder(table: string): TableBuilder {
  let op: SupabaseOp | null = null;
  const setOp = (next: SupabaseOp): void => {
    // Verb methods called more than once on the same builder
    // shouldn't happen in our codebase, but we lock in the FIRST verb
    // because PostgREST's RETURNING shape is `insert(...).select(...)`
    // — the trailing `.select(...)` is decoration, not a new query.
    // The call-count side table is bumped at the FIRST verb that
    // pins an op (or, for verb-promotion `select -> insert/update/...`,
    // at the moment of promotion). This gives tests a per-(table, op)
    // counter equivalent to `expect(dbStub.update).toHaveBeenCalled(N)`
    // from the legacy Drizzle stub.
    if (op === null) {
      op = next;
      bumpCallCount(table, op);
    } else if (op === "select" && next !== "select") {
      // The leading `.select()` was decoration on a write — recategorize.
      // Subtract the prior `select` bump and add the actual op's bump.
      const selKey = key(table, "select");
      const prev = callCounts.get(selKey) ?? 0;
      if (prev > 0) callCounts.set(selKey, prev - 1);
      op = next;
      bumpCallCount(table, op);
    }
  };

  const finalize = (): Promise<StagedSupabaseResponse> => {
    const response = popResponse(table, op ?? "select");
    if (response.throws !== undefined) {
      return Promise.reject(response.throws);
    }
    return Promise.resolve(response);
  };

  const recordPayload = (writeOp: SupabaseOp, payload: unknown): void => {
    const k = key(table, writeOp);
    const list = writePayloads.get(k) ?? [];
    list.push(payload);
    writePayloads.set(k, list);
  };

  // Filter verbs are buffered until we know which op they belong to (a
  // chain like `.select(...).eq(...)` resolves on `.then()`/.maybeSingle();
  // a `.update(...).eq(...)` resolves the same way but under "update").
  // We commit on finalize against whatever the locked op turned out to be.
  const pendingFilters: CapturedFilterCall[] = [];
  const captureFilter =
    (verb: string) =>
    (...args: unknown[]) => {
      pendingFilters.push({ verb, args });
      return builder;
    };

  const finalizeWithFilters = (): Promise<StagedSupabaseResponse> => {
    if (op !== null && pendingFilters.length > 0) {
      const k = key(table, op);
      const existing = filterCalls.get(k) ?? [];
      existing.push(...pendingFilters);
      filterCalls.set(k, existing);
    }
    return finalize();
  };

  const builder: TableBuilder = {
    select: () => {
      setOp("select");
      return builder;
    },
    insert: (payload?: unknown) => {
      setOp("insert");
      recordPayload("insert", payload);
      return builder;
    },
    update: (payload?: unknown) => {
      setOp("update");
      recordPayload("update", payload);
      return builder;
    },
    upsert: (payload?: unknown) => {
      setOp("upsert");
      recordPayload("upsert", payload);
      return builder;
    },
    delete: () => {
      setOp("delete");
      recordPayload("delete", undefined);
      return builder;
    },
    eq: captureFilter("eq"),
    neq: captureFilter("neq"),
    in: captureFilter("in"),
    lt: captureFilter("lt"),
    lte: captureFilter("lte"),
    gt: captureFilter("gt"),
    gte: captureFilter("gte"),
    not: captureFilter("not"),
    is: captureFilter("is"),
    like: captureFilter("like"),
    ilike: captureFilter("ilike"),
    match: captureFilter("match"),
    contains: captureFilter("contains"),
    containedBy: captureFilter("containedBy"),
    textSearch: captureFilter("textSearch"),
    filter: captureFilter("filter"),
    or: captureFilter("or"),
    order: captureFilter("order"),
    limit: captureFilter("limit"),
    range: captureFilter("range"),
    maybeSingle: () => finalizeWithFilters(),
    single: () => finalizeWithFilters(),
    then: (onfulfilled, onrejected) =>
      finalizeWithFilters().then(onfulfilled, onrejected),
  };
  return builder;
}


// Keep this mock at module scope so Vitest hoists it within this helper
// module once the helper has been loaded. Tests must still import this file
// (or configure it in a Vitest setupFile) before importing any route/helper
// that imports `@workspace/resupply-db`. `installSupabaseMock()` only manages
// staged responses after the mock has been registered.
vi.mock("@workspace/resupply-db", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-db")
  >("@workspace/resupply-db");
  return {
    ...actual,
    getSupabaseServiceRoleClient: () => ({
      schema: () => ({
        from: (table: string) => makeTableBuilder(table),
        rpc: (fnName: string, args: unknown) => {
          const prev = rpcCallCounts.get(fnName) ?? 0;
          rpcCallCounts.set(fnName, prev + 1);
          const argList = rpcCallArgs.get(fnName) ?? [];
          argList.push(args);
          rpcCallArgs.set(fnName, argList);
          const queue = rpcQueues.get(fnName);
          if (!queue || queue.length === 0) {
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve(queue.shift()!);
        },
      }),
    }),
    // Best-effort projection upserts — the route tests don't
    // exercise projection refresh assertions, so we no-op the
    // helper rather than route through the mock builder. Tests
    // that care can override on a per-test basis.
    tryUpsertPatientLatestMessageSb: vi.fn(async () => true),
  };
});

/**
 * Stage one `{ data, error }` envelope for the next call to
 * `supabase.schema(...).rpc(fnName, ...)`. FIFO across multiple stages
 * on the same function name.
 */
export function stageSupabaseRpcResponse(
  fnName: string,
  result: StagedSupabaseResponse,
): void {
  const list = rpcQueues.get(fnName) ?? [];
  list.push(result);
  rpcQueues.set(fnName, list);
}

/** How many times the route invoked `.rpc(fnName, ...)` since the last reset. */
export function getSupabaseRpcCallCount(fnName: string): number {
  return rpcCallCounts.get(fnName) ?? 0;
}

/** Argument payloads passed to each `.rpc(fnName, args)` call since the last reset. */
export function getSupabaseRpcArgs(fnName: string): unknown[] {
  return rpcCallArgs.get(fnName) ?? [];
}

export interface SupabaseMockHandle {
  /** Reset all staged responses + call counts. Call from `beforeEach`. */
  reset(): void;
  /** Stage a response. Equivalent to calling `stageSupabaseResponse`. */
  stage(
    table: string,
    op: SupabaseOp,
    result: StagedSupabaseResponse,
  ): void;
  /**
   * How many times the route invoked `(table, op)` since the last
   * `reset()`. Useful for testing call-count invariants the legacy
   * Drizzle stub exposed via `expect(dbStub.update).toHaveBeenCalledTimes`.
   * The op is locked at the FIRST verb, so an `insert(...).select(...)`
   * RETURNING chain counts once under "insert", not twice.
   */
  callCount(table: string, op: SupabaseOp): number;
  /**
   * Payloads passed to each call of a write verb on this table since
   * the last `reset()`. Equivalent to capturing `vals` from
   * `dbStub.insert(vals)` / `dbStub.update(vals)` in the legacy
   * Drizzle stub. Returns `[]` if the table+op combination was never
   * exercised. `delete` records `undefined`.
   */
  writePayloads(table: string, op: SupabaseOp): unknown[];
  /**
   * Filter / order verbs (and their args) chained on the builder for
   * `(table, op)` since the last `reset()`. Useful for asserting "the
   * route applied an `.ilike("action", "%x%")` filter on this select"
   * without inspecting raw SQL. Returns `[]` if the chain never used
   * any filter/order verbs.
   */
  filterCalls(table: string, op: SupabaseOp): CapturedFilterCall[];
}

/**
 * Return a control handle for the module-scope
 * `vi.mock("@workspace/resupply-db", ...)` factory above, which stubs
 * `getSupabaseServiceRoleClient()`. Other named exports of resupply-db
 * are passed through unchanged via `vi.importActual`.
 *
 * Returns a handle for resetting staged responses and staging more
 * inline.
 *
 * IMPORTANT: because the mock is module-scoped (and hoisted by Vitest),
 * this function no longer needs to install the mock; call it to reset and
 * stage per-test responses.
 */
export function installSupabaseMock(): SupabaseMockHandle {
  const handle: SupabaseMockHandle = {
    reset() {
      queues.clear();
      callCounts.clear();
      writePayloads.clear();
      filterCalls.clear();
      rpcQueues.clear();
      rpcCallCounts.clear();
      rpcCallArgs.clear();
    },
    stage(table, op, result) {
      stageSupabaseResponse(table, op, result);
    },
    callCount(table, op) {
      return callCounts.get(key(table, op)) ?? 0;
    },
    writePayloads(table, op) {
      return writePayloads.get(key(table, op)) ?? [];
    },
    filterCalls(table, op) {
      return filterCalls.get(key(table, op)) ?? [];
    },
  };

  // Defensive default: every test file that calls `installSupabaseMock()`
  // starts from a clean staging/call-count state, even before its first
  // explicit `beforeEach(() => supabaseMock.reset())`.
  handle.reset();
  return handle;
}

/** Standalone alias for `installSupabaseMock().callCount(...)`. */
export function getSupabaseCallCount(
  table: string,
  op: SupabaseOp,
): number {
  return callCounts.get(key(table, op)) ?? 0;
}

/** Standalone alias for `installSupabaseMock().writePayloads(...)`. */
export function getSupabaseWritePayloads(
  table: string,
  op: SupabaseOp,
): unknown[] {
  return writePayloads.get(key(table, op)) ?? [];
}

/** Standalone alias for `installSupabaseMock().filterCalls(...)`. */
export function getSupabaseFilterCalls(
  table: string,
  op: SupabaseOp,
): CapturedFilterCall[] {
  return filterCalls.get(key(table, op)) ?? [];
}
