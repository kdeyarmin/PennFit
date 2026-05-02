// Storefront DB handle — mirrors the export shape of the pre-merge
// `@workspace/db` package so the storefront routes (orders, admin,
// usage-events, reminders) — which were lifted in from the deleted
// `api-server` artifact during the Task #37 consolidation — keep
// using `import { db, pool } from "../../lib/storefront/db.js"`
// without touching their bodies.
//
// After Task #37 the schema + the connection both live in
// `@workspace/resupply-db`. The Drizzle `schema` here is the union
// of resupply + auth + storefront tables, which is what we want:
// any cross-schema query that becomes useful later (e.g. joining
// `public.orders` with `auth.users`) "just works" off this single
// instance.
//
// Lifecycle: `getDbPool()` is lazy and memoized inside resupply-db.
// Importing this module triggers exactly one `getDbPool()` call,
// so we share the same single Postgres pool with every other
// resupply-api route — no doubled connection counts.

import { drizzle } from "drizzle-orm/node-postgres";

import * as schema from "@workspace/resupply-db";
import { getDbPool } from "@workspace/resupply-db";

export const pool = getDbPool();
export const db = drizzle(pool, { schema });

// Re-export the storefront tables / row types so the lifted-in
// routes can keep their `from "@workspace/db"` shape with a one-line
// `from "../../lib/storefront/db.js"` swap. New code should import
// these directly from `@workspace/resupply-db`.
export {
  ordersTable,
  adminAuditLogTable,
  usageEventsTable,
  reminderSubscriptionsTable,
  type ReminderSubscriptionRow,
} from "@workspace/resupply-db";
