import type { NextFunction, Request, Response } from "express";

import { logger } from "../lib/logger";

/**
 * Top-level Express error handler.
 *
 * Two reasons this exists rather than letting Express's default
 * handler do its thing:
 *
 *   1. The default handler echoes a stack trace to the response in
 *      development, and an empty 500 in production. Neither is what
 *      we want — every 5xx in production should emit a small,
 *      consistent JSON envelope ({error, requestId}) so the
 *      dashboard's "transient" handling kicks in cleanly.
 *
 *   2. Stack traces and route-handler error messages can echo
 *      identifiers we treat as PHI-adjacent (patient ids, phone
 *      hashes, vendor ids). Logging them is fine — that channel is
 *      access-controlled — but bouncing them back in an error
 *      response body is not.
 *
 * Logging:
 *   The pino-http logger already emits one line per request with
 *   method/url/status. We add ONE additional line per 5xx with the
 *   error class + message + the response's request id so an
 *   operator can grep both lines as a pair. Stack traces only
 *   appear in the log, never in the response.
 *
 * Headers-already-sent:
 *   If the route handler started streaming a response before
 *   throwing (the CSV downloads, for example), Express will pass
 *   the error here AFTER `res.headersSent === true`. We delegate
 *   to Express's default in that case — it knows how to abort the
 *   half-streamed response. There's no useful JSON envelope we
 *   can prepend at that point.
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const requestId = (req as Request & { id?: string }).id ?? null;
  const errName = err instanceof Error ? err.name : "unknown";
  const errMessage = err instanceof Error ? err.message : String(err);

  // Pino's req.log carries the per-request id automatically. Fall
  // back to the module logger if it isn't attached (e.g. early
  // middleware error before pino-http ran).
  const log = req.log ?? logger;
  log.error(
    {
      event: "unhandled_route_error",
      errName,
      errMessage,
      stack: err instanceof Error ? err.stack : undefined,
      requestId,
    },
    "unhandled error in route handler",
  );

  res.status(500).json({
    error: "internal_error",
    message: "Something went wrong. Please try again in a moment.",
    requestId,
  });
}
