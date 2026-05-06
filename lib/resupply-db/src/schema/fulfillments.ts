import { sql } from "drizzle-orm";
import { index, jsonb, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { episodes } from "./episodes";
import { patients } from "./patients";
import { resupplySchema } from "./_schema";

/**
 * Fulfillments — what got shipped (or is queued to ship) for a confirmed
 * episode. Created when an episode reaches `confirmed`; updated as the
 * Pacware CSV exchange (ADR 009) round-trips.
 *
 * Why this is its own table:
 *   - One episode can spawn multiple fulfillment rows if Pacware splits
 *     the order (mask + tubing + filters arriving in separate cartons).
 *   - It is the integration boundary with Pacware — `pacwareOrderRef`
 *     and the admin-uploaded CSV row both land here.
 *
 * No PHI on this row. Shipping address lookup goes through the patient.
 */
export const fulfillments = resupplySchema.table(
  "fulfillments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    patientId: uuid("patient_id")
      .notNull()
      .references(() => patients.id, { onDelete: "cascade" }),
    episodeId: uuid("episode_id")
      .notNull()
      .references(() => episodes.id, { onDelete: "cascade" }),

    itemSku: text("item_sku").notNull(),
    quantity: text("quantity").notNull().default("1"),

    status: text("status", {
      enum: [
        "queued",
        "submitted_to_pacware",
        "in_fulfillment",
        "shipped",
        "delivered",
        "canceled",
        "failed",
      ],
    })
      .notNull()
      .default("queued"),

    // Identifier on the Pacware side once the admin uploads the CSV
    // batch. Plaintext, indexed.
    pacwareOrderRef: text("pacware_order_ref"),

    // Carrier metadata (tracking number, carrier name, ship date) —
    // not PHI.
    shipmentMetadata: jsonb("shipment_metadata")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),

    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
  },
  (t) => ({
    patientIdx: index("fulfillments_patient_idx").on(t.patientId),
    episodeIdx: index("fulfillments_episode_idx").on(t.episodeId),
    statusIdx: index("fulfillments_status_idx").on(t.status),
    pacwareOrderRefIdx: index("fulfillments_pacware_order_ref_idx").on(
      t.pacwareOrderRef,
    ),
  }),
);

export type FulfillmentRow = typeof fulfillments.$inferSelect;
export type InsertFulfillmentRow = typeof fulfillments.$inferInsert;
