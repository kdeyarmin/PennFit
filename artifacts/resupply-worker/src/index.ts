import {
  PgcryptoNotInstalledError,
  assertPgcryptoEnabled,
  getDbPool,
  setProjectionLogger,
} from "@workspace/resupply-db";
import PgBoss from "pg-boss";
import { logger } from "./logger.js";
import { registerReminderJobs } from "./jobs/reminders.js";
import { registerPrescriptionAttachmentSweepJob } from "./jobs/prescription-attachment-sweep.js";

// Mirror the API server's wiring (see api/src/index.ts) so projection
// failures from worker-side message sends (the bulk of outbound SMS
// + email reminder traffic) flow through the worker's structured
// logger instead of falling back to console.warn.
setProjectionLogger({
  warn(obj, msg) {
    logger.warn(obj, msg ?? "patient_latest_message: refresh failed");
  },
});

// The resupply worker hosts pg-boss against the same Postgres instance the
// api uses (see ADR 002). Phase 0 only proves the wiring — we boot
// pg-boss, log "ready", and stay alive. Real job handlers register here
// in Phase 2+.

// Sleep briefly before exit so pino's transport worker can flush the
// fatal line. Without this, a bare `process.exit(1)` immediately after
// `logger.fatal(...)` can drop the line we most need to see — the
// reason the process died. Mirrors the API process's flushLogsAndExit.
async function flushLogsAndExit(code: number): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(code);
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for the resupply worker.");
  }

  // Preflight: any future job handler that touches encrypted PHI
  // requires pgcrypto. Refuse to start pg-boss if the extension is
  // missing — much clearer than a job blowing up partway through
  // execution. The check goes through the shared resupply-db pool,
  // not pg-boss's internal pool, since pg-boss has not booted yet.
  try {
    await assertPgcryptoEnabled(getDbPool());
  } catch (err) {
    if (err instanceof PgcryptoNotInstalledError) {
      logger.fatal({ err: { message: err.message } }, err.message);
    } else {
      logger.fatal(
        { err },
        "fatal: resupply-worker could not run pgcrypto preflight",
      );
    }
    await flushLogsAndExit(1);
  }

  const boss = new PgBoss({
    connectionString: databaseUrl,
    // Use a dedicated schema so pg-boss tables never collide with our
    // application tables.
    schema: "pgboss_resupply",
  });

  boss.on("error", (err) => {
    logger.error({ err }, "pg-boss error");
  });

  await boss.start();

  // Register reminder jobs + hourly scan schedule. The handlers
  // tolerate a partially-configured messaging surface (they log+exit
  // 0 instead of failing the job) so a half-configured deploy doesn't
  // fill the pg-boss retry queue with permanent failures. See
  // jobs/reminders.ts for the full rationale.
  try {
    await registerReminderJobs(boss);
  } catch (err) {
    logger.fatal({ err }, "fatal: failed to register reminder jobs");
    await flushLogsAndExit(1);
  }

  // Register the weekly PHI-attachment sweep. Mirrors the same
  // fail-fast contract: if the registration itself throws (queue
  // creation or schedule call), we treat it as a config error and
  // refuse to start the worker. The handler ITSELF tolerates an
  // empty bucket / empty DB at runtime so a quiet week doesn't
  // generate a spurious failure (see jobs/prescription-attachment-sweep.ts).
  try {
    await registerPrescriptionAttachmentSweepJob(boss);
  } catch (err) {
    logger.fatal(
      { err },
      "fatal: failed to register prescription attachment sweep",
    );
    await flushLogsAndExit(1);
  }

  logger.info(
    "resupply-worker ready (pg-boss started, reminders + attachment-sweep scheduled)",
  );

  // Keep the process alive.

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down resupply-worker");
    try {
      await boss.stop({ graceful: true, timeout: 10_000 });
    } catch (err) {
      logger.error({ err }, "error stopping pg-boss");
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
}

main().catch((err) => {
  // Use the same flush helper as the in-main preflight path so the
  // fatal line isn't dropped by pino's transport worker buffer.
  // Without an awaited delay before exit, this terminal log can
  // vanish, leaving admins with a process that died for no
  // visible reason.
  logger.fatal({ err }, "fatal: resupply-worker failed to start");
  void flushLogsAndExit(1);
});
