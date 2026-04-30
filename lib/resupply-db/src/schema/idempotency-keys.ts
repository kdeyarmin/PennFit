// idempotency_keys — replay protection for write endpoints.
//
// Why a dedicated table (not Redis / in-memory):
//   * The audit trail is the legal source of truth for "what
//     actually happened". An at-rest, durable record of "this
//     Idempotency-Key produced this exact response" gives ops the
//     same forensics window as the audit log itself — 24h is
//     plenty for "did my last POST succeed?" without ballooning the
//     row count.
//   * One database, one backup story. No cross-system consistency
//     between "the patient row I created" and "the response I
//     promised to replay" — both live in the same Postgres
//     transaction history.
//
// Why composite PK on (user_id, endpoint, key):
//   * Different admins should be able to use the same opaque key
//     value (e.g. a UUID generated client-side) without colliding.
//     Scoping by user_id makes that safe by construction.
//   * Including `endpoint` means a key reused across different
//     endpoints (e.g. the dashboard's per-action UUID factory) is
//     not treated as a replay — different endpoint means different
//     intent.
//
// `request_hash` is sha256(stable_json(req.body)). Storing only the
// hash (not the body itself) keeps PHI out of this table. If a
// caller replays a key with a body whose hash doesn't match the
// stored hash, the middleware returns 422 — that's the "you reused
// the key with different intent" path that protects against client
// bugs.
//
// `response_status` + `response_body` capture exactly what the
// original handler emitted, so a replay returns byte-identical
// JSON to the caller. We persist response bodies for 2xx replies
// only (the middleware skips the insert for 4xx/5xx) — replaying a
// stored 4xx would lock the caller out of fixing a typo by retrying
// with a corrected body under the same key.
//
// `expires_at` defaults to 24 hours after creation; the middleware
// treats expired rows as "no record" and overwrites them on the
// next request with the same key. A simple `lte(expires_at, now())`
// DELETE can prune them on a cron, but we don't strictly need to —
// the index keeps lookups O(log n) regardless of stale rows.

import { sql } from "drizzle-orm";
import {
  customType,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { resupplySchema } from "./_schema";

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

export const idempotencyKeys = resupplySchema.table(
  "idempotency_keys",
  {
    userId: text("user_id").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    requestHash: bytea("request_hash").notNull(),
    responseStatus: integer("response_status").notNull(),
    responseBody: jsonb("response_body").$type<unknown>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.endpoint, t.key] }),
    expiresAtIdx: index("idempotency_keys_expires_at_idx").on(t.expiresAt),
  }),
);

export type IdempotencyKeyRow = typeof idempotencyKeys.$inferSelect;
export type InsertIdempotencyKeyRow = typeof idempotencyKeys.$inferInsert;
