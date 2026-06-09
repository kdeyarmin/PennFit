// Canonical Zod-validation error response for HTTP boundaries.
//
// Why this exists
// ---------------
// ~180 routes return `{ error: "invalid_body" }` on a failed Zod parse,
// but a handful diverged to `{ error: "Invalid input", details: [...] }`,
// so clients couldn't rely on a single validation-error contract: some
// surfaces got field-level `details`, most got an opaque token, and a
// few used a different `error` string entirely.
//
// Canonical shape
// ---------------
//   400 { "error": "invalid_body", "details": [{ "path", "message" }] }
//
// `error: "invalid_body"` is kept as the stable code the large majority
// already emit (so existing clients/tests that switch on `error` are
// unaffected); `details` is purely ADDITIVE — a structured, field-level
// breakdown for clients that want to surface which field failed. New
// routes should use `respondInvalidBody`; existing `invalid_body` sites
// can adopt it incrementally with zero contract change.

import type { Response } from "express";
import type { ZodError } from "zod";

export interface ValidationIssue {
  /** Dotted path to the offending field, e.g. "items.0.quantity". */
  path: string;
  message: string;
}

/** Flatten a ZodError's issues into the canonical `details` array. */
export function zodIssues(error: ZodError): ValidationIssue[] {
  return error.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
  }));
}

/**
 * Send the canonical 400 for a failed Zod parse:
 * `{ error: "invalid_body", details: [{ path, message }] }`.
 */
export function respondInvalidBody(res: Response, error: ZodError): void {
  res.status(400).json({ error: "invalid_body", details: zodIssues(error) });
}
