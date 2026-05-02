/**
 * Human-friendly labels for the snake_case `action` strings written
 * by resupply-api's storefront admin routes (`storefront/admin.ts`,
 * `storefront/admin-users.ts`, `storefront/reminders.ts`) into the
 * `admin_audit_log` table.
 *
 * Why centralised here
 * --------------------
 * A customer-service rep should never see raw `view_order_detail` or
 * `team.role_change` strings in the audit list. The lookup also
 * gracefully degrades to a humanised version of the key for unknown
 * actions, so a backend that adds a new audit kind before this map
 * is updated still produces readable text.
 *
 * Drift contract: when a new `auditLog` insert is added in
 * `routes/storefront/{admin,admin-users,reminders}.ts`, add a
 * matching entry here in the same edit.
 */

export const AUDIT_ACTION_LABEL: Record<string, string> = {
  list_orders: "Searched the orders list",
  view_order_detail: "Opened a patient record",
  "reminder.send_batch": "Sent reminder batch",
  "team.list": "Viewed the team list",
  "team.invite": "Invited a teammate",
  "team.role_change": "Changed a teammate's role",
  "team.revoke": "Removed a teammate",
  "team.invitation_revoke": "Cancelled a pending invitation",
};

export function auditActionLabel(action: string): string {
  // Backend writes shapes like "list_orders:status=sent&q=Smith" or
  // "reminder.send_batch sent=4 failed=0" — strip filter / counter
  // suffix so the lookup hits the action kind.
  const kind = action.split(/[\s:]/, 1)[0];
  return AUDIT_ACTION_LABEL[kind] ?? humaniseSnakeCase(action);
}

function humaniseSnakeCase(raw: string): string {
  const cleaned = raw.replace(/[._]+/g, " ").trim();
  if (cleaned.length === 0) return raw;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1).toLowerCase();
}
