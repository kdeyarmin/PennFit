// csr_macros — admin-managed canned reply library for the
// conversation reply composer. See migration 0017.

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

export type MacroChannel = "sms" | "email";

export const csrMacros = resupplySchema.table(
  "csr_macros",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    key: text("key").notNull().unique(),
    label: text("label").notNull(),
    category: text("category"),
    body: text("body").notNull(),
    channels: jsonb("channels")
      .$type<MacroChannel[]>()
      .notNull()
      .default(sql`'["sms","email"]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(100),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdBy: text("created_by"),
    updatedBy: text("updated_by"),
  },
  (t) => ({
    activeSortIdx: index("csr_macros_active_sort_idx").on(
      t.isActive,
      t.sortOrder,
      t.label,
    ),
    bodyLength: check(
      "csr_macros_body_max_length",
      sql`length(${t.body}) <= 10000`,
    ),
  }),
);

export type CsrMacroRow = typeof csrMacros.$inferSelect;
export type InsertCsrMacroRow = typeof csrMacros.$inferInsert;
