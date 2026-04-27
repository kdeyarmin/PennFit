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
