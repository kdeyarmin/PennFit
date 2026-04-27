import { Pool, type PoolConfig } from "pg";
import { logger } from "./logger";

// Singleton Postgres pool used by the API process. Right now its only
// caller is the /readyz handler — Phase 1 will land Drizzle in
// @workspace/resupply-db, at which point this file should be retired
// in favor of a shared pool exported from that package. Until then we
// keep the pool here to avoid stepping on Phase 1's in-flight work.
//
// Sizing: readiness probes are the only client today (every ~5-10s),
// so a pool of 2 is plenty. Bumping `max` later is the right knob if
// real handlers start using this pool before the resupply-db swap.

let pool: Pool | null = null;

export function getDbPool(): Pool {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for the resupply API.");
  }

  const config: PoolConfig = {
    connectionString: databaseUrl,
    max: 2,
    idleTimeoutMillis: 30_000,
    // Hard ceiling on how long a fresh connection attempt can wait.
    // Without this, a stalled DB will hang the readiness probe past
    // any reasonable deploy-gate timeout.
    connectionTimeoutMillis: 2_000,
  };

  pool = new Pool(config);

  // Pool-level errors fire on idle clients — they are recoverable
  // (the bad client is evicted), so we log and move on rather than
  // crashing the API.
  pool.on("error", (err) => {
    logger.error({ err }, "resupply-api db pool error");
  });

  return pool;
}

// Test-only helper. Exposes a way to reset the singleton between
// suites without exposing the variable itself. Not exported from the
// package's public surface.
export function __resetDbPoolForTests(): void {
  pool = null;
}
