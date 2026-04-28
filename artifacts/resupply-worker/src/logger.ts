import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  name: "resupply-worker",
  level: process.env.LOG_LEVEL ?? "info",
  // Belt-and-braces redaction: pg-boss and pg drivers embed
  // connection-string fragments in error.message. Even though every
  // call site SHOULD categorize before logging, redact at the log
  // layer too — a future `logger.error({ err })` in a job handler
  // should not be one keystroke away from a DSN leak. Treat every
  // log line as world-readable.
  redact: [
    "err.message",
    "err.detail",
    "err.hint",
    "err.where",
    "err.hostname",
    "err.address",
    // Stack traces embed the message on line one — redacting one
    // without the other leaves the same leak surface. Same logic
    // for Error.cause chains. See the api logger for the long
    // version of this rationale.
    "err.stack",
    "err.cause.message",
    "err.cause.stack",
  ],
  ...(isProduction
    ? {}
    : {
        transport: { target: "pino-pretty", options: { colorize: true } },
      }),
});
