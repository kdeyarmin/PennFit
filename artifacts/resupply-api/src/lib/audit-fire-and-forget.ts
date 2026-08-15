// fireAndForgetAudit — the ONLY safe way to write an audit event without
// awaiting it.
//
// Why this exists
// ---------------
// `AuditWriter` (lib/resupply-auth/src/http/types.ts) is declared
// `(event) => Promise<void> | void`. The adapter `getAuthDeps()` builds today
// happens to be synchronous and swallows its own failure — but the CONTRACT
// permits an async writer, and any host (a different wiring, a test double, a
// future adapter that awaits the DB) may supply one.
//
// That makes the obvious fire-and-forget spellings unsafe:
//
//     deps.audit(event);        // floating promise — lint error
//     void deps.audit(event);   // lint SILENCED, rejection STILL unhandled
//
// The second is the trap. `void` discards the value; it does not attach a
// rejection handler. A rejected audit write therefore reaches
// `process.on("unhandledRejection")` in index.ts, which deliberately EXITS —
// so a failed audit row after an otherwise-successful tenant signup or account
// closure would restart the API for every user. (Caught in review on #1260;
// the first version of that fix used bare `void` and did not actually close
// the hole it claimed to.)
//
// This helper normalizes both shapes — a returned promise AND a synchronous
// throw — into a logged, swallowed failure. Audit is best-effort by design:
// the caller's real work has already committed, and losing the audit row is
// strictly better than losing the process.

import type { AuthDeps } from "@workspace/resupply-auth";

import { logger } from "./logger";

/** `(event) => Promise<void> | void` — see the file header. */
type AuditWriter = AuthDeps["audit"];
type AuditEvent = Parameters<AuditWriter>[0];

interface FireAndForgetLogger {
  warn?: (...args: unknown[]) => void;
}

/**
 * Write an audit event without awaiting it, with the rejection path handled.
 *
 * Returns `void` synchronously — safe to call from a request handler that is
 * about to respond. Never throws, never rejects, never leaves a floating
 * promise.
 *
 * @param audit The writer (typically `getAuthDeps().audit`).
 * @param event The audit event to record.
 * @param log Optional request-scoped logger; falls back to the module logger.
 */
export function fireAndForgetAudit(
  audit: AuditWriter,
  event: AuditEvent,
  log?: FireAndForgetLogger,
): void {
  const warn = (err: unknown) => {
    const fields = {
      event: "audit_write_failed",
      action: event.action,
      err: err instanceof Error ? err : new Error(String(err)),
    };
    const msg = "audit write failed (non-fatal — the action itself committed)";
    if (log?.warn) log.warn(fields, msg);
    else logger.warn(fields, msg);
  };
  try {
    // `Promise.resolve(...)` normalizes the `Promise<void> | void` union, so a
    // synchronous writer costs one already-resolved promise and an async one
    // gets a real rejection handler.
    void Promise.resolve(audit(event)).catch(warn);
  } catch (err) {
    // A writer that throws SYNCHRONOUSLY never produces a promise at all, so
    // the .catch above would not see it.
    warn(err);
  }
}
