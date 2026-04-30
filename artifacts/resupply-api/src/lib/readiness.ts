import { getDbPool } from "@workspace/resupply-db";
import { logger } from "./logger";

// What "ready" means for the resupply API:
//
//   db    — Postgres is reachable AND accepting queries from this
//           process's connection pool. Anything admin-facing fails
//           if the DB is down, so this is a hard requirement.
//   queue — pg-boss has bootstrapped its schema. We don't start
//           pg-boss in the API process (the worker owns it — see
//           ADR 002), so we infer queue readiness from the existence
//           of the pg-boss `version` table in the dedicated
//           `pgboss_resupply` schema. If the worker hasn't booted
//           yet, the API has no way to enqueue work and shouldn't
//           accept traffic.
//
// Each check is wrapped in a per-check timeout so a wedged dependency
// can't stall the readiness probe past the deploy gate's own
// timeout. The aggregate check is bounded by the slowest individual
// check, never the sum.

const CHECK_TIMEOUT_MS = 1_500;
const PGBOSS_SCHEMA = "pgboss_resupply";

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
// we never echo raw driver text back over the wire.
function categorize(err: unknown): string {
  if (err instanceof Error) {
    if (/timed out/i.test(err.message)) return "timeout";
    // node-postgres wraps libpq errors with a `code` property for
    // Postgres SQLSTATE values. We don't surface the SQLSTATE
    // itself — we just bucket common dev-mode failures.
    const code = (err as { code?: string }).code;
    if (code === "ECONNREFUSED") return "connection_refused";
    if (code === "ENOTFOUND") return "host_not_found";
    if (code === "ETIMEDOUT") return "timeout";
    if (code === "57P03") return "database_starting_up";
    if (code === "3D000") return "database_does_not_exist";
  }
  return "unavailable";
}

async function checkDb(): Promise<void> {
  const pool = getDbPool();
  await withTimeout(pool.query("SELECT 1"), "db check");
}

async function checkQueue(): Promise<void> {
  const pool = getDbPool();
  // pg-boss creates its `version` table on `boss.start()`. If the row
  // count is zero, the worker has not finished bootstrapping yet
  // (or is down) — treat that as queue-unready rather than queue-ok.
  // We use a parameterized query so the schema name is bound, not
  // string-concatenated, even though it's a constant — habit.
  const result = await withTimeout(
    pool.query<{ exists: boolean }>(
      "SELECT EXISTS (" +
        "  SELECT 1 FROM information_schema.tables" +
        "  WHERE table_schema = $1 AND table_name = 'version'" +
        ") AS exists",
      [PGBOSS_SCHEMA],
    ),
    "queue check",
  );
  if (!result.rows[0]?.exists) {
    throw Object.assign(new Error("pg-boss schema not initialized"), {
      code: "SCHEMA_MISSING",
    });
  }
}

export async function checkReadiness(): Promise<ReadinessResult> {
  const [db, queue] = await Promise.allSettled([checkDb(), checkQueue()]);

  const checks: ReadinessResult["checks"] = {
    db: db.status === "fulfilled" ? "ok" : "failed",
    queue: queue.status === "fulfilled" ? "ok" : "failed",
  };

  const errors: NonNullable<ReadinessResult["errors"]> = {};
  if (db.status === "rejected") {
    errors.db = categorize(db.reason);
    // Log only the categorized failure mode — never the raw error.
    // node-postgres error.message routinely includes connection-string
    // fragments ("password authentication failed for user X on host
    // Y", "database X does not exist"). The HTTP body redaction is
    // already proven by the integration test; this keeps the
    // admin-readable log stream equally clean. Treat every log
    // line as world-readable.
    logger.warn(
      { errCategory: errors.db },
      "readiness: db check failed",
    );
  }
  if (queue.status === "rejected") {
    if ((queue.reason as { code?: string })?.code === "SCHEMA_MISSING") {
      errors.queue = "schema_not_initialized";
    } else {
      errors.queue = categorize(queue.reason);
    }
    logger.warn(
      { errCategory: errors.queue },
      "readiness: queue check failed",
    );
  }

  const allOk = checks.db === "ok" && checks.queue === "ok";
  const result: ReadinessResult = {
    status: allOk ? "ready" : "not_ready",
    checks,
  };
  if (!allOk) result.errors = errors;
  return result;
}
