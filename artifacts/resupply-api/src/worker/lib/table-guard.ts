import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";

// Self-healing table-existence guard for scheduled worker jobs.
//
// Background: the production DB was provisioned with only a subset of the
// repo's schema (see docs/db-schema-drift-2026-05-29.md), so several cron
// jobs SELECT from tables that don't exist and log an error every tick.
// Rather than gate each behind a bespoke env flag, we skip registering a job
// whose backing tables are absent — and `unschedule` any cron a prior deploy
// persisted in pg-boss so it stops firing into a missing table. Once the
// tables are created (a future reconciliation), the next worker boot registers
// the job normally with no further action. Environments that DO have the
// tables (the feature is provisioned) are unaffected.
//
// Fail-open: if the existence probe itself errors (transient DB blip), we
// register the job anyway — a flaky probe must never silently disable a job
// whose table actually exists.

const tableExistsCache = new Map<string, boolean>();

async function missingResupplyTables(tables: string[]): Promise<string[]> {
  try {
    // Dynamic import mirrors the sanctioned legacy-pg pattern used by
    // worker/jobs/bulk-campaign-tick.ts — getDbPool is the only approved
    // raw-pg accessor (architecture rule 7).
    const { getDbPool } = await import("@workspace/resupply-db");
    const pool = getDbPool();
    const missing: string[] = [];
    for (const table of tables) {
      const qualified = `resupply.${table}`;
      let exists = tableExistsCache.get(qualified);
      if (exists === undefined) {
        const result = await pool.query<{ ok: boolean }>(
          "select to_regclass($1) is not null as ok",
          [qualified],
        );
        exists = Boolean(result.rows[0]?.ok);
        tableExistsCache.set(qualified, exists);
      }
      if (!exists) missing.push(table);
    }
    return missing;
  } catch (err) {
    logger.warn(
      {
        event: "table_guard_check_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "table-existence guard probe failed; registering job anyway (fail-open)",
    );
    return [];
  }
}

/**
 * Register a scheduled worker job only if every `resupply.*` table it needs
 * exists in this database. When any required table is missing, the job is NOT
 * registered and any previously-scheduled cron for `queueName` is unscheduled,
 * so it stops enqueuing ticks that would just error (and won't pile up a
 * backlog that floods on a later re-enable).
 *
 * @param boss          pg-boss instance
 * @param queueName     the job's pg-boss queue name (for unschedule + logs)
 * @param requiredTables resupply table names (without the schema prefix)
 * @param registerFn    the job's own register function
 */
export async function registerIfProvisioned(
  boss: PgBoss,
  queueName: string,
  requiredTables: string[],
  registerFn: (boss: PgBoss) => Promise<void>,
): Promise<void> {
  const missing = await missingResupplyTables(requiredTables);
  if (missing.length === 0) {
    await registerFn(boss);
    return;
  }
  if (typeof boss.unschedule === "function") {
    await boss.unschedule(queueName).catch(() => undefined);
  }
  logger.info(
    { event: "job_skipped_missing_tables", queue: queueName, missing },
    `${queueName}: not registered (missing resupply tables: ${missing.join(", ")}); cleared any stale cron`,
  );
}
