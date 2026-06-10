// Categorized fields for warn-logging a Stripe SDK failure.
//
// The log layer (lib/logger.ts) redacts free-text `err.message` /
// `err.stack` on error objects because vendor messages routinely
// embed sensitive fragments — and a message string smuggled under
// the `err` key dodges that redaction entirely (redact paths only
// match object properties). The prescribed shape is a categorized
// failure: Stripe's enumerated identifiers carry the "why" (HTTP
// status, error code, error type) plus the Dashboard lookup handle
// (requestId) without the free-text leak surface.
//
// Spread the result into any warn/error log payload alongside the
// route's own identifiers:
//
//   req.log?.warn?.(
//     { productId, ...stripeErrLogFields(err) },
//     "stripe update failed",
//   );
export function stripeErrLogFields(
  err: unknown,
): Record<string, string | number> {
  const e = err as {
    statusCode?: unknown;
    code?: unknown;
    type?: unknown;
    requestId?: unknown;
  } | null;
  const fields: Record<string, string | number> = {};
  if (typeof e?.statusCode === "number") fields.stripeStatus = e.statusCode;
  if (typeof e?.code === "string") fields.stripeCode = e.code;
  if (typeof e?.type === "string") fields.stripeType = e.type;
  if (typeof e?.requestId === "string") fields.stripeRequestId = e.requestId;
  return fields;
}
