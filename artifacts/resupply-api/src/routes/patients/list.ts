// GET /patients — paginated patient list for the admin console.
//
// Decrypts firstName + lastName for display via the existing
// `decrypt(...)` SQL helper so plaintext PHI never crosses the
// process boundary into Node memory between Postgres and the JSON
// response. Phone + email are never returned — they are surfaced
// as boolean `hasPhone` / `hasEmail` markers (CASE WHEN NOT NULL)
// so the admin can see "this patient is reachable on SMS" without
// the page itself rendering the number.
//
// Search semantics:
//   The single `search` box accepts any of:
//     - pacware id (plaintext, indexed): "PAC-001"
//     - patient name fragment: "alice", "smith"
//     - email fragment: "@gmail.com", "alice@"
//     - phone number in any format: "+14155551212", "(415) 555-1212",
//       "4155551212". Treated specially via the phone_lookup HMAC
//       index for an O(1) exact match — the encrypted phone column
//       has random IV, so equality search isn't possible without it.
//
//   When the input normalizes to a valid E.164, we go through the
//   HMAC index. Otherwise we do the existing decrypt+ILIKE union,
//   now extended to also cover the email column. The decrypted
//   union is a Postgres-side full scan; admin-only access + small
//   steady-state row count make this acceptable.
//
// We do NOT write an audit row per list-view: list pages are
// page-flipped many times during normal admin workflow and one
// audit row per page-flip drowns the audit log. The /patients/{id}
// detail view does write an audit row (see ./detail.ts).

import { Router, type IRouter } from "express";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  decrypt,
  getDbPool,
  hmacPhone,
  normalizeE164,
  patients,
  phoneLookup,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const listQuery = z
  .object({
    status: z.enum(["active", "paused", "closed"]).optional(),
    search: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/patients", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_query",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const { status, search, limit, offset } = parsed.data;

  const filters: SQL[] = [];
  if (status) {
    filters.push(eq(patients.status, status));
  }
  if (search) {
    // Phone-shaped input → exact-match via the HMAC lookup table.
    // We try this BEFORE the decrypt-ILIKE branch so that a
    // perfectly-formatted phone number never accidentally lands in
    // the slow path. `normalizeE164` returns null for anything that
    // doesn't parse as a real phone; treat that as "this is a name
    // or email or pacware id" and fall through.
    const normalizedPhone = normalizeE164(search);
    if (normalizedPhone) {
      // hmacPhone() throws if RESUPPLY_PHONE_HMAC_KEY is unset. In
      // that case fall back to the decrypt-ILIKE union rather than
      // crashing the list endpoint — admins should still be able to
      // search by name/email when phone search isn't configured.
      try {
        const hash = hmacPhone(normalizedPhone);
        filters.push(
          sql`${patients.id} IN (SELECT patient_id FROM ${phoneLookup} WHERE hmac_phone = ${hash})`,
        );
      } catch (err) {
        req.log?.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "patients/list: phone HMAC search unavailable, falling back to text search",
        );
        const needle = `%${search}%`;
        filters.push(textSearchClause(needle));
      }
    } else {
      const needle = `%${search}%`;
      filters.push(textSearchClause(needle));
    }
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  const db = drizzle(getDbPool());

  const [totalRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(patients)
    .where(whereClause);

  const rows = await db
    .select({
      id: patients.id,
      pacwareId: patients.pacwareId,
      firstName: decrypt(patients.legalFirstName),
      lastName: decrypt(patients.legalLastName),
      status: patients.status,
      hasPhone: sql<boolean>`(${patients.phoneE164} IS NOT NULL)`,
      hasEmail: sql<boolean>`(${patients.email} IS NOT NULL)`,
      createdAt: patients.createdAt,
      updatedAt: patients.updatedAt,
    })
    .from(patients)
    .where(whereClause)
    .orderBy(sql`${patients.createdAt} DESC`)
    .limit(limit)
    .offset(offset);

  res.status(200).json({
    items: rows.map((r) => ({
      id: r.id,
      pacwareId: r.pacwareId,
      firstName: r.firstName ?? "",
      lastName: r.lastName ?? "",
      status: r.status,
      hasPhone: Boolean(r.hasPhone),
      hasEmail: Boolean(r.hasEmail),
      createdAt:
        r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
      updatedAt:
        r.updatedAt instanceof Date ? r.updatedAt.toISOString() : r.updatedAt,
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

// Build the OR-union of decrypt-ILIKE clauses for the
// non-phone-shaped search path. Pacware id is plaintext and indexed
// (cheap); the rest are full-table decrypted scans (acceptable for
// admin-only / small dataset). Email is included so an admin can
// look up a patient by partial email when they don't have the
// pacware id handy.
function textSearchClause(needle: string): SQL {
  return sql`(${patients.pacwareId} ILIKE ${needle} OR ${decrypt(
    patients.legalFirstName,
  )} ILIKE ${needle} OR ${decrypt(patients.legalLastName)} ILIKE ${needle} OR ${decrypt(
    patients.email,
  )} ILIKE ${needle})`;
}

export default router;
