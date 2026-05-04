import {
  pgTable,
  text,
  timestamp,
  jsonb,
  index,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Orders table — the only PHI-bearing table in this app.
 *
 * Design notes:
 *   - We split the structured payload into TWO shapes: flat top-level columns
 *     for things admins filter/search on (patient_email, patient_last_name,
 *     mask_id, email_status, created_at), and `payload` jsonb for everything
 *     else (insurance, prescription, optional measurements). This keeps the
 *     admin list query fast without needing a million columns.
 *   - `email_status` is the single source of truth for "did Penn receive this
 *     order?". Values:
 *       - "pending"   — row inserted, send not yet attempted
 *       - "sent"      — SendGrid accepted the message
 *       - "failed"    — SendGrid rejected; admin can retry
 *       - "skipped"   — server is missing SENDGRID_API_KEY (dev / misconfig)
 *   - We store `order_reference` so the patient can call Penn and quote it
 *     (matches the value returned to the browser).
 */
export const ordersTable = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderReference: text("order_reference").notNull().unique(),

    // Patient flat columns (searchable / sortable)
    patientFirstName: text("patient_first_name").notNull(),
    patientLastName: text("patient_last_name").notNull(),
    patientEmail: text("patient_email").notNull(),
    patientPhone: text("patient_phone").notNull(),
    patientDateOfBirth: text("patient_date_of_birth").notNull(), // YYYY-MM-DD

    // Mask flat columns
    maskId: text("mask_id").notNull(),
    maskName: text("mask_name").notNull(),
    maskManufacturer: text("mask_manufacturer").notNull(),
    maskModelNumber: text("mask_model_number").notNull(),

    // Address summary (still flat for quick display in lists)
    shippingCity: text("shipping_city").notNull(),
    shippingState: text("shipping_state").notNull(),
    shippingZip: text("shipping_zip").notNull(),

    // Everything nested — full original payload, including street, insurance,
    // prescription, measurements, notes. Admin detail view reads from here.
    payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),

    // Email delivery state
    emailStatus: text("email_status", {
      enum: ["pending", "sent", "failed", "skipped"],
    })
      .notNull()
      .default("pending"),
    emailError: text("email_error"), // populated when status=failed
    emailDeliveredAt: timestamp("email_delivered_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    createdAtIdx: index("orders_created_at_idx").on(t.createdAt),
    patientEmailIdx: index("orders_patient_email_idx").on(t.patientEmail),
    patientLastNameIdx: index("orders_patient_last_name_idx").on(
      t.patientLastName,
    ),
    emailStatusIdx: index("orders_email_status_idx").on(t.emailStatus),
  }),
);

export type OrderRow = typeof ordersTable.$inferSelect;
export type InsertOrderRow = typeof ordersTable.$inferInsert;
