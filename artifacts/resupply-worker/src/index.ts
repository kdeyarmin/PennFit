import {
  PgcryptoNotInstalledError,
  assertPgcryptoEnabled,
  getDbPool,
} from "@workspace/resupply-db";
import PgBoss from "pg-boss";
import { logger } from "./logger.js";

// The resupply worker hosts pg-boss against the same Postgres instance the
// api uses (see ADR 002). Phase 0 only proves the wiring — we boot
// pg-boss, log "ready", and stay alive. Real job handlers register here
// in Phase 2+.

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
    process.exit(1);
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
  logger.info("resupply-worker ready (pg-boss started)");

  // Keep the process alive. Job handlers will be wired in Phase 2.

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
  logger.error({ err }, "fatal: resupply-worker failed to start");
  process.exit(1);
});
