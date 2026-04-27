import pg, { type Pool, type PoolConfig } from "pg";

const { Pool: PgPool } = pg;

// Single shared Postgres pool for every resupply package that needs to
// talk to Postgres (today: the API's /readyz handler; soon: all
// query helpers built on top of `@workspace/resupply-db`'s schema).
//
// Why one pool, not one per package:
//   - Each pool holds open TCP connections. Two pools against the same
//     DB doubles the connection count for no reason.
//   - There is exactly one place to tune timeouts, TLS settings, and
//     `max` size. ADR 003 calls this out explicitly.
//
// Sizing: this pool started life inside the API just for the readiness
// probe (every ~5-10s, max=2). As real query handlers move into
// `@workspace/resupply-db`, bump `max` here — that is the only knob.
//
// pg-boss intentionally keeps its own pool inside the worker process
// (see ADR 002) and is NOT consolidated here.

let pool: Pool | null = null;

// Optional `console.error`-style logger. The library deliberately
// stays free of any internal logging dependency (resupply-db must not
// pull in pino, the dashboard's logger, etc.), so the API/worker can
// pass their own logger if they want pool-level errors routed through
// their structured logging pipeline. Defaults to no-op so tests stay
// quiet.
type ErrorLogger = (err: unknown, msg: string) => void;
let errorLogger: ErrorLogger = () => {};

export function setPoolErrorLogger(fn: ErrorLogger): void {
  errorLogger = fn;
}

export function getDbPool(): Pool {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL must be set for @workspace/resupply-db (getDbPool).",
    );
  }

  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 30_000,
    // Hard ceiling on a fresh connection attempt. Without this, a
    // stalled DB will hang any caller (including the readiness probe)
    // past the deploy gate's own timeout.
    connectionTimeoutMillis: 2_000,
  };

  pool = new PgPool(config);

  // Pool-level errors fire on idle clients — recoverable (the bad
  // client is evicted), so we forward to the logger and move on
  // rather than crashing the process.
  pool.on("error", (err) => {
    errorLogger(err, "resupply-db pool error");
  });

  return pool;
}

// Test-only helper. Resets the singleton between suites without
// exposing the variable itself. Not part of the package's stable
// surface — hence the underscore prefix.
export function __resetDbPoolForTests(): void {
  pool = null;
}
