import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "./logger";
import { isWorkerReady } from "../worker/index.js";

// What "ready" means for the resupply API:
//
//   db    — Supabase PostgREST is reachable AND accepting queries from
//           this process. Anything admin-facing fails if the DB is
//           down, so this is a hard requirement. We probe by issuing a
//           HEAD request against `resupply.feature_flags` through the
//           service-role client (`select("key", { head: true })`, no
//           count) — `feature_flags` is small and seeded by the
//           feature-flags migration, so the row scan is trivial and
//           a network / auth / schema regression surfaces here before
//           it hits a route handler. (We previously probed
//           `audit_log`; that table was retired with the audit-chain
//           cleanup and is no longer a valid target.)
//
//   queue — pg-boss has bootstrapped its schema. pg-boss boots
//           in-process at startup (see src/worker/index.ts; the
//           formerly-separate resupply-worker artifact was folded
//           into this process so a single deploy gates on a single
//           healthz). The worker exposes an `isWorkerReady()` flag
//           that flips true once `boss.start()` has returned and
//           every job handler has been registered — that's the same
//           "queue is ready" signal the schema probe used to give us,
//           with no DB round-trip required.
//
// The DB check is wrapped in a per-check timeout so a wedged dependency
// can't stall the readiness probe past the deploy gate's own timeout.

const CHECK_TIMEOUT_MS = 1_500;

export type CheckStatus = "ok" | "failed";

export interface ReadinessResult {
  status: "ready" | "not_ready";
  checks: {
    db: CheckStatus;
    queue: CheckStatus;
  };
  // Per-check failure reasons. Free-form strings categorize the
  // failure (e.g. "timeout", "connection_refused",
  // "schema_not_initialized"). NEVER include the full error message,
  // stack trace, or connection string — error.message from `pg` will
  // happily echo back DATABASE_URL fragments and we don't want those
  // surfacing to anyone who can hit /readyz.
  errors?: Partial<Record<"db" | "queue", string>>;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${CHECK_TIMEOUT_MS}ms`));
    }, CHECK_TIMEOUT_MS);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Categorize a thrown error into one of a small set of safe-to-expose
// labels. Anything we don't recognize collapses to "unavailable" so
// we never echo raw driver / PostgREST text back over the wire.
function categorize(err: unknown): string {
  if (err instanceof Error) {
    if (/timed out/i.test(err.message)) return "timeout";
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED") return "connection_refused";
    if (code === "ENOTFOUND") return "host_not_found";
    if (code === "ETIMEDOUT") return "timeout";
    // PostgREST surfaces Postgres SQLSTATE values on the error object
    // when the server reaches the database but the database itself is
    // unhealthy.
    if (code === "57P03") return "database_starting_up";
    if (code === "3D000") return "database_does_not_exist";
  }
  return "unavailable";
}

async function checkDb(): Promise<void> {
  // `head: true` makes PostgREST emit a HEAD with no row payload.
  // We probe `feature_flags` (a small, seeded reference table) so
  // the request exercises the same PostgREST + service-role-JWT
  // path every other query travels through without paying for a
  // row scan. We avoid `count: "exact"` for the same reason — a
  // bare `head + limit(1)` is enough to confirm the DB is responding
  // and the JWT still validates.
  // The supabase-js PostgrestBuilder is a PromiseLike, so we lift it
  // into a real Promise via Promise.resolve before composing with the
  // withTimeout race wrapper.
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await withTimeout(
    Promise.resolve(
      supabase
        .schema("resupply")
        .from("feature_flags")
        .select("key", { head: true })
        .limit(1),
    ),
    "db check",
  );
  if (error) throw error;
}

function checkQueue(): void {
  if (!isWorkerReady()) {
    throw Object.assign(new Error("pg-boss not ready"), {
      code: "WORKER_NOT_READY",
    });
  }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const [db, queue] = await Promise.allSettled([
    checkDb(),
    Promise.resolve().then(() => checkQueue()),
  ]);

  const checks: ReadinessResult["checks"] = {
    db: db.status === "fulfilled" ? "ok" : "failed",
    queue: queue.status === "fulfilled" ? "ok" : "failed",
  };

  const errors: NonNullable<ReadinessResult["errors"]> = {};
  if (db.status === "rejected") {
    errors.db = categorize(db.reason);
    // Log only the categorized failure mode — never the raw error.
    // Treat every log line as world-readable.
    logger.warn({ errCategory: errors.db }, "readiness: db check failed");
  }
  if (queue.status === "rejected") {
    if ((queue.reason as { code?: string })?.code === "WORKER_NOT_READY") {
      errors.queue = "schema_not_initialized";
    } else {
      errors.queue = categorize(queue.reason);
    }
    logger.warn({ errCategory: errors.queue }, "readiness: queue check failed");
  }

  const allOk = checks.db === "ok" && checks.queue === "ok";
  const result: ReadinessResult = {
    status: allOk ? "ready" : "not_ready",
    checks,
  };
  if (!allOk) result.errors = errors;
  return result;
}
