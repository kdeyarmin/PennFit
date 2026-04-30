// Admin-console human labels for snake_case event/action strings that
// come from the backend.
//
// Why a central module
// --------------------
// Several admin views surface raw machine identifiers that the
// backend writes (funnel step names, audit-log actions). A customer-
// service rep should never see `capture_started` or
// `view_order_detail` in the UI — they should see "Started face
// scan" and "Opened a patient record".
//
// Keeping the lookup in one file means:
//   * the dashboard funnel and the audit-log table can share one
//     vocabulary,
//   * adding a new backend event (`routes/usage-events.ts` adds a
//     step, or `routes/admin.ts` writes a new audit action) is a
//     single-file change here,
//   * unknown identifiers degrade gracefully via the
//     `humaniseSnakeCase` fallback at the bottom rather than leaking
//     the raw machine string into the UI.

/**
 * Funnel step → friendly label, in the chronological order a
 * shopper experiences them. The keys MUST match the
 * `usageEventStepEnum` in `artifacts/api-server/src/routes/usage-events.ts`.
 *
 * Drift contract: when you add a step to that enum, add a matching
 * entry here in the same edit. The `funnelStepLabel()` lookup below
 * has a humanised fallback so a missing entry degrades to readable
 * (if generic) text instead of a TypeScript or runtime error — but
 * relying on the fallback long-term means CSRs see a less precise
 * label than they could.
 */
export const FUNNEL_STEP_LABEL: Record<string, string> = {
  home_view: "Visited home page",
  consent_given: "Accepted privacy notice",
  capture_started: "Started face scan",
  capture_taken: "Took face photo",
  measurements_extracted: "Got face measurements",
  questionnaire_completed: "Finished questionnaire",
  results_viewed: "Viewed mask recommendations",
  mask_chosen: "Selected a mask",
  order_started: "Began checkout",
  order_submitted_success: "Completed order",
};

/**
 * Look up a funnel step's friendly label. If the backend introduces
 * a new step before this map is updated, fall back to a humanised
 * version of the key (`new_step_name` → "New step name") rather than
 * leaking the raw machine identifier into the UI.
 */
export function funnelStepLabel(step: string): string {
  return FUNNEL_STEP_LABEL[step] ?? humaniseSnakeCase(step);
}

/**
 * Audit-log action → friendly label.
 *
 * The backend writes a few shapes:
 *   - `list_orders` (and `list_orders:status=sent&q=Smith`) — index
 *     view with optional filter suffix.
 *   - `view_order_detail` — opened a single patient record.
 *   - `reminder.send_batch sent=N failed=N` — kicked off a reminder
 *     batch, with counters appended.
 *
 * The lookup strips any suffix after the first whitespace or `:` so
 * the "kind" of action is what gets translated; the full original
 * string is still available for power users who want the detail.
 */
export const AUDIT_ACTION_LABEL: Record<string, string> = {
  list_orders: "Searched the orders list",
  view_order_detail: "Opened a patient record",
  "reminder.send_batch": "Sent reminder batch",
};

export function auditActionLabel(action: string): string {
  // Strip ":..." filter suffix (list_orders) and " ..." counter
  // suffix (reminder.send_batch) so we look up the action kind.
  const kind = action.split(/[\s:]/, 1)[0];
  return AUDIT_ACTION_LABEL[kind] ?? humaniseSnakeCase(action);
}

/**
 * "snake_case_thing" → "Snake case thing". Last-resort fallback so
 * an unknown backend identifier still reads as English instead of
 * looking like a developer string.
 *
 * Dot-separated kinds (e.g. `reminder.send_batch`) are joined with
 * spaces too. Trailing/leading whitespace is dropped.
 */
function humaniseSnakeCase(raw: string): string {
  const cleaned = raw.replace(/[._]+/g, " ").trim();
  if (cleaned.length === 0) return raw;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
