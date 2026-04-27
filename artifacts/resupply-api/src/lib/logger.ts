import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  name: "resupply-api",
  level: process.env.LOG_LEVEL ?? "info",
  // Defense in depth: never log raw auth headers or cookies. This does NOT
  // remove the obligation to redact PHI before passing it to the logger —
  // see ADR 006 + ADR 007. Anything sensitive should be redacted at the
  // call site as well.
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
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
