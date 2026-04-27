import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export const logger = pino({
  name: "resupply-worker",
  level: process.env.LOG_LEVEL ?? "info",
  ...(isProduction
    ? {}
    : {
        transport: { target: "pino-pretty", options: { colorize: true } },
      }),
});
