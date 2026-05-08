import pino from "pino";

import { getRequestId } from "./request-context";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  name: "resupply-api",
  level: process.env.LOG_LEVEL ?? "info",
  // Mixin runs on every log call. Reads the active AsyncLocalStorage
  // request context (if any) and attaches `requestId` to the line.
  // The result: every logger.warn / .error / .info called from inside
  // a route handler (including ones called many awaits / callbacks
  // deep) carries the same id pino-http already put on the access
  // log, so a single grep ties an HTTP entry to every downstream log
  // event. Worker jobs and top-level boot code log without the
  // field; the mixin returns an empty object in that case.
  mixin() {
    const requestId = getRequestId();
    return requestId ? { requestId } : {};
  },
  // Defense in depth: never log raw auth headers or cookies. This does NOT
  // remove the obligation to redact PHI before passing it to the logger —
  // see ADR 006 + ADR 007. Anything sensitive should be redacted at the
  // call site as well.
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    // Belt-and-braces: pg / the auth provider / fetch errors routinely embed
    // connection-string fragments, user identifiers, or hostnames
    // inside `error.message` (and friends). The right fix is for
    // call sites to log a categorized failure instead of `{ err }`,
    // and most do — but a stray future `logger.warn({ err })` in a
    // route handler should not be one keystroke away from a PHI /
    // DSN leak. Redact at the log layer too so the failure mode is
    // a missing field, not a leaked secret.
    "err.message",
    "err.detail",
    "err.hint",
    "err.where",
    "err.hostname",
    "err.address",
    // Stack traces normally embed the message at the top
    // (`Error: <message>\n    at ...`), so redacting message
    // without redacting stack would leak the same secret one field
    // over. Admins lose stack visibility on `{ err }` logs by
    // design — call sites that NEED a stack should categorize
    // (e.g. `{ errCategory: 'db.timeout', stackHash }`) instead of
    // dumping `err`.
    "err.stack",
    // pino-std-serializers also exposes `err.cause` (Error chains
    // from `throw new Error(..., { cause })`), and the same leak
    // shape repeats on the cause. Redact both fields there too.
    "err.cause.message",
    "err.cause.stack",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
