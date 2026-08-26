// Validate required env vars FIRST — before any other side-effecting import.
// This must stay the literal first import: ES-module bodies run in
// import-source order (with esbuild preserving that in the prod bundle), so a
// dedicated first import is the only way to guarantee the aggregated env check
// runs before `./app`'s module-eval side effects (the CORS-or-throw IIFE,
// etc.). A bare `assertRequiredEnv()` statement lower down would run AFTER
// those hoisted imports and defeat the "one error listing every missing var"
// guarantee. See ./lib/assert-env-on-boot.ts.
import "./lib/assert-env-on-boot";

import { createServer, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { URL } from "node:url";

import { WebSocketServer, type WebSocket } from "ws";

import { setProjectionLogger } from "@workspace/resupply-db";

import app from "./app";
import { applyAppConfigOverlayToEnv } from "./lib/app-config/store";
import { hydrateCompanyInfoCache } from "./lib/company-info";
import { logger } from "./lib/logger";
import { getPendingSessions } from "./lib/voice/pending-sessions";
import {
  handleBreatheSalesWsConnection,
  handleVoiceDiagnosticWsConnection,
  handleVoiceWsConnection,
} from "./lib/voice/ws-handler";
import { handleVideoSignalConnection } from "./lib/video/signal-handler";
import { verifyVideoVisitToken } from "./lib/video/video-visit-token";
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
//   termination Railway's edge proxy already terminates for us.
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
// Telehealth video-visit signaling (SDP/ICE relay only — media is
// WebRTC peer-to-peer and never touches this process). Gated by an
// HMAC-signed token minted by the admin join endpoint (staff) or the
// patient's invite link; the connection handler re-checks the visit
// row so cancellation/revocation is honored immediately.
const VIDEO_WS_PATH = "/resupply-api/video/signal";

// Twilio connects to `${VOICE_WS_PATH}/<conversationId>` — the conversationId
// rides the URL PATH, not a query string, because Twilio Media Streams DROP
// query strings on the <Stream> url (their documented behavior). With the id
// in a query the upgrade handler saw nothing → 400 → Twilio error 31920 →
// the call died the instant it connected. The path segment is preserved.
function isVoiceStreamPath(pathname: string): boolean {
  return pathname === VOICE_WS_PATH || pathname.startsWith(`${VOICE_WS_PATH}/`);
}

function voiceStreamConversationIdFromPath(pathname: string): string | null {
  if (!pathname.startsWith(`${VOICE_WS_PATH}/`)) return null;
  const seg = pathname.slice(VOICE_WS_PATH.length + 1).split("/")[0] ?? "";
  if (!seg) return null;
  try {
    return decodeURIComponent(seg) || null;
  } catch {
    return seg;
  }
}

httpServer.on("upgrade", (req: IncomingMessage, socket: Socket, head) => {
  const url = safeParseUpgradeUrl(req);
  if (url?.pathname === VIDEO_WS_PATH) {
    let verified: ReturnType<typeof verifyVideoVisitToken>;
    try {
      verified = verifyVideoVisitToken(url.searchParams.get("token") ?? "");
    } catch {
      // RESUPPLY_LINK_HMAC_KEY unset — feature can't operate here.
      rejectUpgrade(socket, 503, "video-not-configured");
      return;
    }
    if (!verified.valid) {
      rejectUpgrade(socket, 401, "invalid-token");
      return;
    }
    const claims = verified;
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      void handleVideoSignalConnection(ws, claims).catch((err) => {
        logger.error(
          { err: serializeErr(err), visitId: claims.visitId },
          "video signal ws handler crashed",
        );
        try {
          ws.close(1011, "internal-error");
        } catch {
          /* already closed */
        }
      });
    });
    return;
  }
  if (!url || !isVoiceStreamPath(url.pathname)) {
    // Reject unknown upgrade paths immediately. We use destroy()
    // rather than 404+close because Twilio (the only legitimate
    // client) will only ever target the voice-stream path; any
    // other upgrade is by definition unwanted.
    socket.destroy();
    return;
  }

  const config = readVoiceConfigOrNull();
  if (!config) {
    rejectUpgrade(socket, 503, "voice-not-configured");
    return;
  }

  // Prefer the path segment (how Twilio connects); fall back to the legacy
  // ?conversationId= query for non-Twilio callers and existing tests.
  const conversationId =
    voiceStreamConversationIdFromPath(url.pathname) ??
    url.searchParams.get("conversationId");
  if (!conversationId) {
    rejectUpgrade(socket, 400, "missing-conversation-id");
    return;
  }

  // The pending-session lookup below is now async (a shared DB round-trip),
  // so there's a brief window before handleUpgrade adopts the socket. Guard
  // against a mid-handshake socket error (e.g. the caller hangs up) emitting
  // an unhandled 'error' that would crash the process via the global trap.
  socket.on("error", () => {
    /* best-effort; rejectUpgrade/handleUpgrade handle teardown */
  });

  // claim() is a shared (DB-backed) lookup so the session survives across
  // replicas — the webhook that registered it may have run on a different
  // instance than the one now serving this WS upgrade. Resolve it before
  // completing the handshake; the socket stays paused during the brief
  // round-trip.
  void getPendingSessions()
    .claim(conversationId)
    .then((pending) => {
      if (!pending) {
        // No matching pending session, or it expired. Could be a leaked
        // URL, a TTL'd entry, or Twilio retrying after a successful
        // upgrade — all three resolve identically: refuse the upgrade.
        rejectUpgrade(socket, 401, "no-pending-session");
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        // Route to the right bridge handler:
        //  - diagnostic ("connection test"): isolated, no-patient bridge so a
        //    test affordance never touches the production PHI path;
        //  - breathe_prospect: the CareMetric Breathe B2B platform SALES
        //    bridge (no patient, no conversations row — its own dispatcher);
        //  - otherwise: the production patient/shop voice path.
        const handle = pending.diagnostic
          ? handleVoiceDiagnosticWsConnection
          : pending.callerKind === "breathe_prospect"
            ? handleBreatheSalesWsConnection
            : handleVoiceWsConnection;
        void handle(ws, pending).catch((err) => {
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
    })
    .catch((err) => {
      logger.error(
        { err: serializeErr(err), conversationId },
        "voice ws pending-session claim failed",
      );
      rejectUpgrade(socket, 503, "pending-session-unavailable");
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

function serializeErr(err: unknown): {
  name: string;
  code?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
} {
  if (err instanceof Error) {
    const out: ReturnType<typeof serializeErr> = {
      name: err.name,
      message: err.message,
      stack: err.stack,
    };
    // `code` (EADDRINUSE, EAFNOSUPPORT, a pg SQLSTATE, …) is the one
    // diagnostic field the logger's redaction policy leaves visible —
    // `err.message` / `err.stack` come out as [Redacted] on `{ err }`
    // logs (see lib/logger.ts) — so without it a fatal boot failure
    // like a bind error is indistinguishable from any other Error in
    // production logs. Codes are fixed enum-like identifiers, never
    // PHI or connection-string fragments.
    const code = serializeErrCode(err);
    if (code !== undefined) out.code = code;
    if ("cause" in err && err.cause != null) {
      const cause = err.cause;
      if (cause instanceof Error) {
        const causeCode = serializeErrCode(cause);
        out.cause = {
          name: cause.name,
          ...(causeCode !== undefined ? { code: causeCode } : {}),
          message: cause.message,
          stack: cause.stack,
        };
      } else {
        out.cause = String(cause);
      }
    }
    return out;
  }
  return { name: "unknown", message: String(err) };
}

function serializeErrCode(err: Error): string | undefined {
  if (!("code" in err)) return undefined;
  const code = err.code;
  return typeof code === "string" || typeof code === "number"
    ? String(code)
    : undefined;
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
// signal). Both phases share a single deadline below typical
// orchestrator grace periods (30s on Railway, K8s default) so we
// always abort cleanly before the kernel SIGKILLs us — better to
// drop a stuck connection than have the kernel interrupt a
// half-written DB transaction OR a pg-boss job mid-flight.
//
// Previously the HTTP drain capped at 25s and stopWorker had a
// further 10s budget — worst-case ~35s would blow the 30s grace
// and SIGKILL pg-boss mid-job. The shared deadline below gives
// HTTP up to TOTAL_BUDGET_MS - WORKER_MIN_BUDGET_MS and lets the
// worker consume the remainder, so total wall time stays at
// TOTAL_BUDGET_MS regardless of which phase takes longer.
//
// Application DB connections are managed by the Supabase client
// (HTTP via PostgREST — no pool to drain). pg-boss owns its own
// node-postgres pool and closes it as part of `boss.stop()`.
const TOTAL_BUDGET_MS = 25_000;
const WORKER_MIN_BUDGET_MS = 5_000;
let shuttingDown = false;
// Handle for the background worker-start retry timer (see
// scheduleWorkerStart). Cleared on shutdown so a pending retry can't
// fire mid-drain or keep the process alive.
let workerRetryTimer: ReturnType<typeof setTimeout> | undefined;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    logger.warn({ signal }, "second shutdown signal — exiting immediately");
    await flushLogsAndExit(0);
  }
  shuttingDown = true;
  if (workerRetryTimer) {
    clearTimeout(workerRetryTimer);
    workerRetryTimer = undefined;
  }
  logger.info({ signal }, "shutdown: draining in-flight requests");
  const startedAt = Date.now();
  const deadline = startedAt + TOTAL_BUDGET_MS;

  const httpClosed = new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  wss.close();

  // Give HTTP at most TOTAL_BUDGET - WORKER_MIN_BUDGET so pg-boss
  // always has the time it needs to drain in-flight handlers.
  const httpDeadlineMs = TOTAL_BUDGET_MS - WORKER_MIN_BUDGET_MS;
  const httpTimeout = new Promise<void>((resolve) =>
    setTimeout(resolve, httpDeadlineMs),
  );
  const httpClosedInTime = await Promise.race([
    httpClosed.then(() => true),
    httpTimeout.then(() => false),
  ]);
  const httpDrainMs = Date.now() - startedAt;

  // Stop pg-boss — owns its own node-postgres pool and drains any
  // in-flight job handlers gracefully on `boss.stop()`. Pass it the
  // remaining time budget so the total wall clock stays inside
  // TOTAL_BUDGET_MS.
  const remainingMs = Math.max(1_000, deadline - Date.now());
  const workerStopStartedAt = Date.now();
  try {
    await stopWorker(remainingMs);
  } catch (err) {
    logger.warn({ err: serializeErr(err) }, "shutdown: worker stop errored");
  }

  // Phase timings let ops verify the budget isn't running hot against the
  // orchestrator's grace period (30s on Railway): a recurring
  // httpClosedInTime=false, or totalMs creeping toward TOTAL_BUDGET_MS,
  // means in-flight work is being cut off on every deploy rollover and the
  // budgets need retuning.
  logger.info(
    {
      signal,
      httpDrainMs,
      httpClosedInTime,
      workerStopMs: Date.now() - workerStopStartedAt,
      totalMs: Date.now() - startedAt,
      budgetMs: TOTAL_BUDGET_MS,
    },
    "shutdown: complete",
  );
  await flushLogsAndExit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// How long to wait for a single pg-boss start attempt before giving
// up on it. pg-boss.start() connects to Postgres, runs schema
// migrations, and acquires an advisory lock — any of which can hang
// indefinitely if the DB is unreachable or the lock is held by a
// zombie process. The timeout turns a silent hang into a clear,
// retryable failure. 30 s is generous enough for a cold Postgres start
// on a shared instance while still surfacing a connectivity problem
// quickly.
const START_WORKER_TIMEOUT_MS = 30_000;

// Background worker-start retry cadence. A worker boot failure no
// longer kills the process (see start() below), so we retry on an
// exponential backoff until pg-boss comes up — capped so a sustained
// DB outage settles into a steady once-a-minute probe rather than a
// tight reconnect loop.
const WORKER_RETRY_BASE_MS = 5_000;
const WORKER_RETRY_MAX_MS = 60_000;

// One bounded attempt to start the in-process pg-boss worker. Resolves
// `true` on success and `false` on any failure (already logged). Never
// throws — the caller owns the retry decision.
async function attemptStartWorker(): Promise<boolean> {
  let workerTimeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const workerTimeout = new Promise<never>((_, reject) => {
    workerTimeoutHandle = setTimeout(() => {
      reject(
        new Error(
          `startWorker() timed out after ${START_WORKER_TIMEOUT_MS}ms — pg-boss may be unable to reach the database or is waiting on an advisory lock`,
        ),
      );
    }, START_WORKER_TIMEOUT_MS);
  });
  try {
    await Promise.race([startWorker(), workerTimeout]);
    return true;
  } catch (err) {
    logger.error(
      { err: serializeErr(err), event: "worker_start_failed" },
      "worker failed to start — HTTP stays up; the worker will retry in the background",
    );
    return false;
  } finally {
    clearTimeout(workerTimeoutHandle);
  }
}

// Start the worker in the background, retrying with backoff until it
// succeeds. Decoupled from the HTTP listener so a DB/queue problem
// degrades to "background jobs are paused" instead of taking the whole
// public site down. `startWorker()` is idempotent (it no-ops when
// pg-boss is already running), so a retry that races a slow-but-
// eventually-successful first attempt is harmless.
function scheduleWorkerStart(attempt = 0): void {
  if (shuttingDown) return;
  void attemptStartWorker().then((ok) => {
    if (ok || shuttingDown) return;
    const delay = Math.min(
      WORKER_RETRY_MAX_MS,
      WORKER_RETRY_BASE_MS * 2 ** attempt,
    );
    logger.warn(
      {
        event: "worker_retry_scheduled",
        attempt: attempt + 1,
        delay_ms: delay,
      },
      `worker start failed — retrying in ${Math.round(delay / 1000)}s`,
    );
    workerRetryTimer = setTimeout(
      () => scheduleWorkerStart(attempt + 1),
      delay,
    );
    // Don't let the retry timer alone keep the event loop alive — if
    // everything else has closed, the process should still be free to
    // exit.
    workerRetryTimer.unref?.();
  });
}

async function start(): Promise<void> {
  // Bring the HTTP listener up FIRST, then start the worker in the
  // background. Previously the listener only bound AFTER startWorker()
  // resolved, and a worker failure exited the process — so a transient
  // DB/queue problem at deploy time took the ENTIRE site dark: with no
  // healthy instance, Railway's edge returns a 404 for every path,
  // including the static storefront and company-info / health probes,
  // neither of which needs the worker or even the database. The /readyz
  // probe still
  // reports the worker's true state for monitoring and alerting; we
  // just no longer hold the front door shut on it. (Railway's health
  // check is /healthz — liveness — so a worker hiccup can't blackhole
  // the deploy; see railway.json.)
  // Bind the unspecified IPv6 address (`::`) explicitly. Node already
  // defaults to `::` with dual-stack (IPv4-mapped) when a host is omitted,
  // but stating it makes the intent unambiguous and robust to a future
  // Node default change. On Railway this single bind serves BOTH the
  // public network (IPv4 `0.0.0.0`) and the IPv6-only private network
  // (`::`) — see docs/railway-hosting-review-2026-05-29.md (R3).
  const HOST = "::";
  // …but never let the absence of IPv6 take the whole site dark. On a host
  // with the IPv6 stack compiled out or disabled (some hardened container
  // runtimes, a locked-down CI sandbox, an IPv4-only self-host), binding
  // `::` fails outright with EAFNOSUPPORT / EADDRNOTAVAIL / EINVAL and the
  // process exits — the exact "one dependency blackholes every route"
  // failure this file's header rails against, except here the storefront
  // never even gets a chance to serve. Fall back to the IPv4 unspecified
  // address so the site still comes up (a dual-stack host never reaches
  // this path, so Railway's behaviour is unchanged). Any OTHER bind error
  // (EADDRINUSE, EACCES) is a genuine misconfiguration and still fatal.
  const IPV6_UNAVAILABLE_CODES = new Set([
    "EAFNOSUPPORT",
    "EADDRNOTAVAIL",
    "EINVAL",
  ]);
  // NOTE: the `listening` handler is registered explicitly (not passed as
  // `listen()`'s callback) so the error path can REMOVE it. `listen(port,
  // host, cb)` attaches `cb` as a one-shot `listening` listener that a
  // failed bind does NOT clear — leaving it attached makes the first
  // attempt's callback fire on the SECOND (successful) bind, logging a
  // phantom `host: "::"` line that tells operators we bound dual-stack
  // when we actually fell back to IPv4.
  const listenOn = (host: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => {
        httpServer.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        httpServer.off("error", onError);
        const voiceConfigured = readVoiceConfigOrNull() !== null;
        logger.info(
          {
            host,
            port,
            voice_configured: voiceConfigured,
            voice_ws_path: VOICE_WS_PATH,
          },
          "resupply-api listening",
        );
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.listen(port, host);
    });
  try {
    await listenOn(HOST);
  } catch (err) {
    const code = err instanceof Error ? serializeErrCode(err) : undefined;
    if (code === undefined || !IPV6_UNAVAILABLE_CODES.has(code)) throw err;
    logger.warn(
      { event: "http_listen_ipv6_unavailable", host: HOST, code, port },
      'IPv6 bind unavailable on this host — falling back to "0.0.0.0" (IPv4-only)',
    );
    await listenOn("0.0.0.0");
  }

  // Fold any super-admin System Configuration overrides
  // (resupply.app_config, migration 0211) into process.env so the
  // "restart"-mode settings (Stripe, Twilio, SendGrid, …) entered in
  // /admin/system/configuration are honoured this boot. Fire-and-forget
  // and fail-soft — same decoupled spirit as the worker start below:
  // it runs AFTER the listener is up, never blocks it, and a DB hiccup
  // just leaves the Railway env in place (the function already catches
  // internally; the extra .catch is belt-and-braces).
  void applyAppConfigOverlayToEnv().catch((err) => {
    logger.warn(
      { err: serializeErr(err), event: "app_config_overlay_boot_failed" },
      "app_config overlay failed at boot — continuing on environment values",
    );
  });

  // Same decoupled posture for the admin-entered company identity
  // (resupply.dme_organization): warm the seed tenant's company-info cache
  // so the synchronous accessors (getCompanyInfoSync /
  // applyCompanyIdentityToText) answer without a DB round-trip. Re-applied
  // periodically so a save on another replica (or a missed in-process
  // refresh) converges without a redeploy. This no longer writes
  // process.env — every brand reader resolves its own tenant. Fail-soft.
  void hydrateCompanyInfoCache().catch((err) => {
    logger.warn(
      { err: serializeErr(err), event: "company_info_hydrate_boot_failed" },
      "company info hydration failed at boot — continuing on environment values",
    );
  });
  const companyInfoRefresh = setInterval(
    () => {
      void hydrateCompanyInfoCache().catch(() => {
        // getCompanyInfo already logs; a refresh failure changes nothing.
      });
    },
    5 * 60 * 1000,
  );
  companyInfoRefresh.unref();

  scheduleWorkerStart();
}

start().catch((err) => {
  // We only reach here if the HTTP listener itself fails to bind (e.g.
  // the port is already in use). Worker failures are handled by the
  // background retry above and never reject start().
  logger.fatal(
    { err: serializeErr(err) },
    "fatal: resupply-api failed to start (HTTP listener)",
  );
  void flushLogsAndExit(1);
});
