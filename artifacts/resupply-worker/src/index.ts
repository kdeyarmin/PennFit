import { assertRequiredEnv } from "./lib/env-check.js";

// Fail fast on a misconfigured deploy. Runs before any other
// side-effecting import so a missing var surfaces as a single clear
// startup error listing every missing required variable, rather
// than a confusing mid-job throw partway through execution.
assertRequiredEnv();

import { createServer, type Server } from "node:http";
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

// Internal-only HTTP healthz. Required so the production orchestrator
// has a real readiness signal to gate the deploy on. The endpoint is
// not user-facing (proxy slot is `/__resupply-worker-internal`); it
// returns 503 until pg-boss has finished bootstrapping its schema and
// every job handler has been registered, then flips to 200. Without
// this, an orchestrator can either (a) require no health probe — and
// route traffic before pg-boss is ready, breaking the API's /readyz
// for every request that races boot, or (b) treat the worker as
// permanently unhealthy and tear it down. Pure background processes
// don't fit cleanly into the artifact platform's web-service shape,
// so we accept this small HTTP surface as the minimum viable contract.
let workerReady = false;
let healthServer: Server | undefined;

function startHealthServer(): void {
  const portRaw = process.env.PORT;
  if (!portRaw) {
    // PORT is set by the artifact deploy lifecycle. In dev (running
    // via `pnpm run dev`) the artifact runtime sets it too. We only
    // hit this branch if someone runs the bundle by hand without the
    // env var, which is fine — the worker still functions, it just
    // can't be probed by an orchestrator. Log loudly and continue.
    logger.warn(
      "PORT env var not set; skipping internal healthz server. " +
        "The worker will still process jobs but cannot be probed.",
    );
    return;
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port) || port <= 0) {
    logger.warn({ portRaw }, "Invalid PORT value; skipping internal healthz");
    return;
  }
  healthServer = createServer((req, res) => {
    // Match both with and without trailing slash; tolerate query
    // strings (orchestrators sometimes append cache-busters).
    //
    // The shared reverse proxy mounts this worker at
    // `/__resupply-worker-internal` and does NOT rewrite the path
    // (see pnpm-workspace skill, "Proxy & service routing"). So the
    // production deploy probe — configured in artifact.toml as
    // `/__resupply-worker-internal/_internal/healthz` — arrives here
    // with the full prefixed path. Local smoke tests and direct
    // port probes use the bare `/_internal/healthz`. Accept both so
    // the same handler works for both deploy-time health checks and
    // ad hoc local debugging via `curl localhost:8085/...`.
    const url = req.url ?? "";
    const path = url.split("?")[0]?.replace(/\/$/, "") ?? "";
    const isHealthz =
      path === "/_internal/healthz" ||
      path === "/__resupply-worker-internal/_internal/healthz";
    if (isHealthz) {
      const status = workerReady ? 200 : 503;
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          status: workerReady ? "ready" : "starting",
          service: "resupply-worker",
        }),
      );
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
  healthServer.listen(port, () => {
    logger.info({ port }, "internal healthz listening");
  });
  healthServer.on("error", (err) => {
    logger.error({ err }, "internal healthz server error");
  });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL must be set for the resupply worker.");
  }

  // Bring the healthz endpoint online IMMEDIATELY so probes get a
  // structured 503 instead of connection-refused while pg-boss is
  // still bootstrapping. The deploy gate can then distinguish "still
  // starting" (retry) from "process crashed" (fail deploy).
  startHealthServer();

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

  // Flip the healthz response to 200 only after pg-boss has fully
  // bootstrapped AND every handler has registered. This is the
  // contract the API's /readyz check depends on: when worker reports
  // ready, the pgboss_resupply.version table exists, so the API can
  // safely accept traffic.
  workerReady = true;

  logger.info(
    "resupply-worker ready (pg-boss started, reminders + attachment-sweep scheduled, healthz now 200)",
  );

  // Keep the process alive.

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, "shutting down resupply-worker");
    workerReady = false;
    try {
      // Close healthz first so the orchestrator stops routing probes
      // to a process that's about to drop pg-boss connections.
      if (healthServer) {
        await new Promise<void>((resolve) =>
          healthServer!.close(() => resolve()),
        );
      }
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
