import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import { setProjectionLogger } from "@workspace/resupply-db";

import { assertRequiredEnv } from "./lib/env-check";

// Fail fast on a misconfigured deploy. Runs before any other
// side-effecting import so a missing var surfaces as a single clear
// startup error listing every missing required variable, rather
// than a confusing mid-request throw deep in a route handler.
assertRequiredEnv();

import app from "./app";
import { logger } from "./lib/logger";
import { getPendingSessions } from "./lib/voice/pending-sessions";
import { handleVoiceWsConnection } from "./lib/voice/ws-handler";
import { readVoiceConfigOrNull } from "./lib/voice/voice-config";
import { startWorker, stopWorker } from "./worker/index.js";

// Route resupply-db's projection-failure log path through the
// API server's structured pino logger. This eliminates the silent-
// failure mode for callsites that don't explicitly thread req.log
// (worker reminder jobs, voice transcript callbacks). Mirrors the
// `setPoolErrorLogger` pattern already used for pg pool errors —
// resupply-db itself stays dependency-free; the boundary owner
// supplies the sink at boot.
setProjectionLogger({
  warn(obj, msg) {
    logger.warn(obj, msg ?? "patient_latest_message: refresh failed");
  },
});

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

// Why http.createServer(app) instead of app.listen():
//   The voice path needs a WebSocket upgrade on
//   /resupply-api/voice/stream alongside the regular Express HTTP
//   routes. Express 5's `app.listen()` returns the underlying HTTP
//   server, but constructing it explicitly here makes the intent
//   obvious and lets the WS handshake share the same port + TLS
//   termination Replit's reverse proxy already terminates for us.
//
// Path strategy:
//   - The WS server is created with `noServer: true`. We attach an
//     `upgrade` listener that ONLY accepts the voice-stream path and
//     destroys the socket for everything else. That avoids a class of
//     bug where a stray client could open a long-lived WS to an
//     unrelated path and pin a connection slot.
//   - We deliberately do NOT validate Twilio's signature on the WS
//     upgrade itself: Twilio's Media Streams protocol does not sign
//     WS handshakes (only the preceding TwiML POST). Our gate is the
//     short-TTL pending-session map populated by /voice/place-call —
//     a leaked conversationId can ride exactly one upgrade attempt
//     before claim() returns null.

const httpServer = createServer(app);

const wss = new WebSocketServer({ noServer: true });

const VOICE_WS_PATH = "/resupply-api/voice/stream";

httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head) => {
  const url = safeParseUpgradeUrl(req);
  if (!url || url.pathname !== VOICE_WS_PATH) {
    // Reject unknown upgrade paths immediately. We use destroy()
    // rather than 404+close because Twilio (the only legitimate
    // client) will only ever target the exact voice-stream path; any
    // other upgrade is by definition unwanted.
    socket.destroy();
    return;
  }

  const config = readVoiceConfigOrNull();
  if (!config) {
    rejectUpgrade(socket, 503, "voice-not-configured");
    return;
  }

  const conversationId = url.searchParams.get("conversationId");
  if (!conversationId) {
    rejectUpgrade(socket, 400, "missing-conversation-id");
    return;
  }

  const pending = getPendingSessions().claim(conversationId);
  if (!pending) {
    // No matching pending session, or it expired. Could be a leaked
    // URL, a TTL'd entry, or Twilio retrying after a successful
    // upgrade — all three resolve identically: refuse the upgrade.
    rejectUpgrade(socket, 401, "no-pending-session");
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
    void handleVoiceWsConnection(ws, pending).catch((err) => {
      logger.error(
        {
          err: serializeErr(err),
          conversationId: pending.conversationId,
        },
        "voice ws handler crashed",
      );
      try {
        ws.close(1011, "internal-error");
      } catch {
        /* already closed */
      }
    });
  });
});

function safeParseUpgradeUrl(req: IncomingMessage): URL | null {
  const url = req.url;
  if (!url) return null;
  const host = req.headers.host;
  if (!host) return null;
  // The scheme value is irrelevant for WHATWG URL parsing of the path
  // and search params; we just need a base.
  try {
    return new URL(url, `http://${host}`);
  } catch {
    return null;
  }
}

function rejectUpgrade(socket: Socket, code: number, reason: string): void {
  try {
    socket.write(
      `HTTP/1.1 ${code} ${reason}\r\n` +
        "Connection: close\r\n" +
        "Content-Length: 0\r\n" +
        "\r\n",
    );
  } catch {
    /* fallthrough to destroy */
  }
  socket.destroy();
}

function serializeErr(err: unknown): { name: string; message?: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { name: "unknown" };
}

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

// Process-level error traps. Without these, an unhandled promise
// rejection in a fire-and-forget caller (a void-prefixed
// req.log.warn(...) or an audit-write that races a request close)
// would either silently exit the process (Node 15+ default) or
// surface only as a generic Node warning. We log structured context
// + flush logs + exit so the orchestrator restarts us cleanly.
process.on("uncaughtException", (err) => {
  logger.fatal(
    { err: { name: err.name, message: err.message, stack: err.stack } },
    "uncaughtException — exiting",
  );
  void flushLogsAndExit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal(
    {
      err:
        reason instanceof Error
          ? { name: reason.name, message: reason.message, stack: reason.stack }
          : { name: "non_error_rejection", value: String(reason) },
    },
    "unhandledRejection — exiting",
  );
  void flushLogsAndExit(1);
});

// Graceful shutdown: drain HTTP, close the WS server, stop the
// in-process pg-boss worker, exit. Without this, SIGTERM kills
// in-flight requests mid-flight (the orchestrator's deploy-rollover
// signal). The 25-second cap is below typical orchestrator grace
// periods (30s on Replit, K8s default) so we always abort cleanly
// before the kernel SIGKILLs us — better to drop a stuck connection
// than have the kernel interrupt a half-written DB transaction.
//
// Application DB connections are managed by the Supabase client
// (HTTP via PostgREST — no pool to drain). pg-boss owns its own
// node-postgres pool and closes it as part of `boss.stop()`.
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn({ signal }, "second shutdown signal — exiting immediately");
    await flushLogsAndExit(0);
  }
  shuttingDown = true;
  logger.info({ signal }, "shutdown: draining in-flight requests");

  const httpClosed = new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  wss.close();

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 25_000));
  await Promise.race([httpClosed, timeout]);

  // Stop pg-boss — owns its own node-postgres pool and drains any
  // in-flight job handlers gracefully on `boss.stop()`.
  try {
    await stopWorker();
  } catch (err) {
    logger.warn({ err: serializeErr(err) }, "shutdown: worker stop errored");
  }

  logger.info({ signal }, "shutdown: complete");
  await flushLogsAndExit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

async function start(): Promise<void> {
  // Start pg-boss + register job handlers BEFORE accepting traffic.
  // The /readyz check probes the `pgboss_resupply.version` table, so
  // this ordering guarantees readyz can flip green as soon as the
  // listener is up — no race between traffic and queue bootstrap.
  // If pg-boss boot fails (bad DATABASE_URL, schema permissions),
  // the throw bubbles to start()'s caller below, which logs fatal
  // and exits 1 — the orchestrator then sees a never-ready container
  // and marks the deploy failed instead of half-promoting it.
  await startWorker();

  httpServer.listen(port, () => {
    const voiceConfigured = readVoiceConfigOrNull() !== null;
    logger.info(
      {
        port,
        voice_configured: voiceConfigured,
        voice_ws_path: VOICE_WS_PATH,
      },
      "resupply-api listening",
    );
  });
  httpServer.on("error", (err) => {
    logger.error({ err }, "Error listening on port");
    void flushLogsAndExit(1);
  });
}

start().catch((err) => {
  logger.fatal(
    { err: serializeErr(err) },
    "fatal: resupply-api failed to start",
  );
  void flushLogsAndExit(1);
});
