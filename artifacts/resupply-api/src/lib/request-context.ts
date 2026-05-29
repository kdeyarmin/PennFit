// Request-scoped context propagated via AsyncLocalStorage.
//
// Why this exists
// ---------------
// pino-http sets `req.id` and `req.log` on every incoming request, but
// helpers called from deep inside a route handler (a Supabase query, a
// Stripe SDK call, a logAudit() write) don't receive `req` and so can
// only emit log lines without the request-id correlator. That's the
// gap P3.7 closes.
//
// AsyncLocalStorage from node:async_hooks gives every callback that
// runs in the lexical scope of an enabled `als.run(store, fn)` access
// to the same `store` object — across `await` boundaries, in
// promise-chained continuations, in `setImmediate`/`setTimeout`
// callbacks. We open the scope ONCE per request (in the
// requestContextMiddleware below) and every subsequent log line +
// audit row + structured event in that request's lifetime can pick
// up the same request_id without any explicit threading.
//
// Boundaries
// ----------
// This module is API-process-only. Worker jobs run outside any HTTP
// request and therefore have no request context — `getRequestId()`
// returns null in that case. The audit-resolver registration in
// app.ts wires this in on boot; outside the API process the audit
// lib's resolver is unset and audit rows simply don't get a
// request_id field.

import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, Response } from "express";

/**
 * The shape of the per-request store. Kept deliberately small —
 * AsyncLocalStorage carries the cost of the bookkeeping on every
 * `await`, so we don't pile non-essential fields here. Add new
 * fields only when something genuinely needs to be readable from
 * arbitrary helper depth (a future correlation_id from an upstream
 * caller, the actor user-id, etc).
 */
export interface RequestContext {
  /**
   * The pino-http-generated request id (or whatever genReqId we set).
   * Used as the correlation key in log lines and audit rows.
   */
  requestId: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/**
 * Read the active request context. Returns null when called outside
 * any `runWithRequestContext` scope (worker jobs, top-level boot
 * code, tests not driving through Express).
 */
export function getRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/**
 * Convenience: read just the request id, or null. Most callers only
 * need this; building the full context via getRequestContext() is
 * for the rare consumer that wants more than one field.
 */
export function getRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/**
 * Run `fn` inside a request-context scope. Use directly when you
 * need to manually attach a request-id to a non-HTTP code path
 * (e.g. a worker job that was originally enqueued by an HTTP
 * request and that wants to keep the correlation chain).
 */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Express middleware: capture pino-http's `req.id` and bind every
 * downstream callback in this request's scope to a RequestContext
 * carrying that id.
 *
 * MUST be mounted AFTER pinoHttp (which sets req.id) and BEFORE any
 * route handler / business middleware that wants to be inside the
 * scope.
 */
export function requestContextMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  // pino-http sets req.id; if it's somehow absent (custom test app
  // not using pinoHttp), generate a sentinel so the scope is still
  // entered consistently. Using "anon" rather than a UUID makes the
  // sentinel obvious in logs.
  const reqId = (req as { id?: unknown }).id;
  const requestId =
    typeof reqId === "string" ? reqId : reqId != null ? String(reqId) : "anon";
  storage.run({ requestId }, () => next());
}
