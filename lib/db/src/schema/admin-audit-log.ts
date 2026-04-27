import {
  pgTable,
  text,
  timestamp,
  index,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Audit log — every time an admin views an individual patient record,
 * we write a row here. Required by HIPAA "access tracking" expectations.
 *
 * What we log:
 *   - admin_email + admin_clerk_id (so we can prove WHO viewed it)
 *   - action (e.g. "view_order_detail", "search_orders")
 *   - target_order_id (when applicable)
 *   - ip (request IP at view time)
 *   - occurred_at
 *
 * What we deliberately DON'T log here: the order contents themselves —
 * that would just duplicate PHI into a second table. The audit row points
 * to the order; the order is the system of record.
 */
export const adminAuditLogTable = pgTable(
  "admin_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    adminEmail: text("admin_email").notNull(),
    adminClerkId: text("admin_clerk_id").notNull(),
    action: text("action").notNull(),
    targetOrderId: uuid("target_order_id"),
    ip: text("ip"),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    occurredAtIdx: index("admin_audit_log_occurred_at_idx").on(t.occurredAt),
    adminEmailIdx: index("admin_audit_log_admin_email_idx").on(t.adminEmail),
    targetOrderIdx: index("admin_audit_log_target_order_idx").on(t.targetOrderId),
  }),
);

export type AdminAuditLogRow = typeof adminAuditLogTable.$inferSelect;
export type InsertAdminAuditLogRow = typeof adminAuditLogTable.$inferInsert;
