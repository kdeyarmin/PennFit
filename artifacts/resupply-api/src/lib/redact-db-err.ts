// Strip a supabase-js / PostgREST (or node-postgres) error down to
// safe identifiers before it reaches the logger.
//
// supabase-js wraps PostgREST errors in objects of shape
// `{ message, details, hint, code }`. On constraint violations
// (unique, NOT NULL, foreign key) the `details` and `hint` fields
// echo back the offending row's column values — for patient/order
// rows that means name, DOB, insurance member id, address, and email
// all land in structured logs. CLAUDE.md hard rule: treat every log
// line as world-readable; no PHI / order request bodies in the
// application logger. Pino does NOT redact these by default.
//
// Apply this helper at the call site (`logger.warn({ err:
// redactDbErr(e) }, …)`) instead of logging the raw error. The
// logger's redact list is a defense-in-depth backstop, not a licence
// to pass raw DB errors through.
export function redactDbErr(err: unknown): {
  name: string;
  code?: string;
  message?: string;
} {
  if (err instanceof Error) {
    const code =
      (err as Error & { code?: unknown }).code !== undefined
        ? String((err as Error & { code?: unknown }).code)
        : undefined;
    return { name: err.name, code, message: err.message };
  }
  if (err && typeof err === "object") {
    const e = err as { code?: unknown; message?: unknown };
    return {
      name: "non_error",
      code: e.code !== undefined ? String(e.code) : undefined,
      message: e.message !== undefined ? String(e.message) : undefined,
    };
  }
  return { name: "non_error", message: String(err) };
}
