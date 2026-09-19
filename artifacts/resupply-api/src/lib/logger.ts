import pino from "pino";

import { getRequestId } from "./request-context";

const isProduction = process.env.NODE_ENV === "production";

/**
 * How a request/response is rendered into a log line — an allowlist, not
 * a blocklist, so a field nobody thought about is absent by default
 * rather than present until someone notices.
 *
 * `url` is deliberately path-only. A query string can carry PHI (a
 * patient lookup by email), and it arrives URL-ENCODED, so it survives
 * a naive grep for the plaintext — `?email=patient%40example.com` does
 * not contain "patient@example.com".
 *
 * Shared with pino-http in `app.ts` rather than written twice: the
 * access log and a direct `logger.warn({ req }, …)` should not have
 * different ideas about what a request is allowed to reveal.
 */
export const LOG_SERIALIZERS = {
  req(req: { id?: unknown; method?: string; url?: string }) {
    return {
      id: req.id,
      method: req.method,
      url: req.url?.split("?")[0],
    };
  },
  res(res: { statusCode?: number }) {
    return { statusCode: res.statusCode };
  },
};

/**
 * Paths pino strips before a line is written.
 *
 * Exported so `logger.test.ts` can assert the shapes below really do
 * redact — a typo in a path is silent in pino (an unmatched path is
 * simply never applied), so the list is only worth having if something
 * checks it.
 */
export const LOG_REDACT_PATHS = [
  // `req` / `res` wholesale. `LOG_SERIALIZERS` above already drops
  // these, so these paths are the second line: they still hold if a
  // caller logs a request under a child logger that overrides the
  // serializer, or if the allowlist is ever loosened.
  //
  // `req.body` is the one that matters most: "no order request bodies
  // in the application logger" is a hard rule (order payloads are PHI),
  // and until now it was enforced only by convention — the raw Express
  // object carries headers (Authorization, Cookie), the parsed body and
  // the query. Nothing logs `{ req }` today; this keeps the first thing
  // that does from being a PHI incident.
  "req.headers",
  "req.body",
  "req.query",
  "res.headers",
  // Belt-and-braces: pg / the auth provider / fetch errors routinely embed
  // connection-string fragments, user identifiers, or hostnames
  // inside `error.message` (and friends). The right fix is for
  // call sites to log a categorized failure instead of `{ err }`,
  // and most do — but a stray future `logger.warn({ err })` in a
  // route handler should not be one keystroke away from a PHI /
  // DSN leak. Redact at the log layer too so the failure mode is
  // a missing field, not a leaked secret.
  "err.message",
  // `err.detail` (singular) is node-postgres' field; supabase-js /
  // PostgREST errors use `err.details` (plural). Both can echo the
  // offending row's column values on a constraint violation (patient
  // name / DOB / email / address), so redact both spellings.
  "err.detail",
  "err.details",
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
  // Cause chains (`throw new Error(..., { cause })`). Under the
  // DEFAULT `err` serializer these paths are inert: pino folds the
  // chain into `err.message` ("outer: inner") and `err.stack`
  // ("…\ncaused by: …") — both redacted above — and drops the cause's
  // own fields, so there is no `err.cause` key to match. They are the
  // guard for the other serializer: `pino.stdSerializers.errWithCause`
  // preserves `cause` as a nested object, and a PostgREST error carried
  // as a cause has the identical PHI-bearing fields. Kept so switching
  // serializers is not also a PHI regression. `logger.test.ts` pins the
  // fold, so this comment cannot quietly go stale.
  "err.cause.message",
  "err.cause.stack",
  "err.cause.detail",
  "err.cause.details",
  "err.cause.hint",
  "err.cause.where",
  "err.cause.hostname",
  "err.cause.address",
];

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
  // Defense in depth: never log raw request/response envelopes or the
  // internals of an error. This does NOT remove the obligation to
  // redact PHI before passing it to the logger — see ADR 006 + ADR 007.
  // Anything sensitive should be redacted at the call site as well.
  //
  // Deliberately NOT a list of field NAMES (`email`, `dob`, `phone`…):
  // that reads as coverage it cannot deliver — the leak would be
  // `{ patient }` or `{ row }`, which no name list catches — and it
  // collides with fields that carry real operational signal, e.g. the
  // staff recipient in `{ to, err }` on a failed low-stock alert.
  redact: LOG_REDACT_PATHS,
  serializers: LOG_SERIALIZERS,
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
