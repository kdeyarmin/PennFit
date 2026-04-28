import {
  PgcryptoNotInstalledError,
  assertPgcryptoEnabled,
  getDbPool,
} from "@workspace/resupply-db";
import app from "./app";
import { logger } from "./lib/logger";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// Preflight: refuse to listen if pgcrypto is missing. Without the
// extension, any subsequent encrypted PHI write would fail at SQL
// time with a confusing "function pgp_sym_encrypt does not exist"
// error. Failing fast here turns that into a clear, actionable boot
// error and keeps a half-broken process out of the load balancer.
//
// Why we sleep before exit: pino with a transport (pino-pretty in
// dev, any worker-thread destination in prod) buffers log writes in
// a worker thread. A bare `process.exit(1)` immediately after
// `logger.fatal(...)` can drop the line we most need to see — the
// reason the process died. A short awaited timeout gives the
// transport a window to flush. We deliberately don't use
// `pino.final()` (the heavyweight pattern); the failure path is
// already terminal, and 250ms is well under any deploy-gate timeout.
async function flushLogsAndExit(code: number): Promise<never> {
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(code);
}

async function start(): Promise<void> {
  try {
    await assertPgcryptoEnabled(getDbPool());
  } catch (err) {
    if (err instanceof PgcryptoNotInstalledError) {
      logger.fatal({ err: { message: err.message } }, err.message);
    } else {
      logger.fatal(
        { err },
        "fatal: resupply-api could not run pgcrypto preflight",
      );
    }
    await flushLogsAndExit(1);
  }

  app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      void flushLogsAndExit(1);
      return;
    }
    logger.info({ port }, "resupply-api listening");
  });
}

void start();
