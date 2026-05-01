// GET /patients — paginated patient list for the admin console.
//
// All PHI columns are stored as plaintext after migration 0025; we
// select them directly. Phone + email values themselves are never
// returned in the list response — they are surfaced as boolean
// `hasPhone` / `hasEmail` markers (CASE WHEN NOT NULL) so the admin
// can see "this patient is reachable on SMS" without the page itself
// rendering the number.
//
// Search semantics:
//   The single `search` box accepts any of:
//     - pacware id (plaintext, indexed): "PAC-001"
//     - patient name fragment: "alice", "smith"
//     - email fragment: "@gmail.com", "alice@"
//     - phone number in any format: "+14155551212", "(415) 555-1212",
//       "4155551212". When the input normalizes to a valid E.164,
//       we do an exact-match against `patients.phone_e164` (now
//       indexed btree). Otherwise we fall through to the ILIKE
//       union below.
//
// We do NOT write an audit row per list-view: list pages are
// page-flipped many times during normal admin workflow and one
// audit row per page-flip drowns the audit log. The /patients/{id}
// detail view does write an audit row (see ./detail.ts).

import { Router, type IRouter } from "express";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { normalizeE164 } from "@workspace/resupply-domain";
import {
  getDbPool,
  patientLatestMessage,
  patients,
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
    // Phone-shaped input → exact-match against the indexed
    // `phone_e164` column. We try this BEFORE the ILIKE branch so
    // that a perfectly-formatted phone number lands in the index
    // path. `normalizeE164` returns null for anything that doesn't
    // parse as a real phone; treat that as "this is a name or
    // email or pacware id" and fall through.
    const normalizedPhone = normalizeE164(search);
    if (normalizedPhone) {
      filters.push(eq(patients.phoneE164, normalizedPhone));
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

  // LEFT JOIN the latest-message projection so the list can show
  // "last contacted" without a per-row scan of the messages table.
  // The projection is patient-scoped (one row per patient, refreshed
  // in-line on every message write) so this is a 1:1 join — no row
  // multiplication, no GROUP BY needed. Patients with no messages
  // yet land with NULLs across the three lastMessage* columns,
  // exactly matching the API contract.
  const rows = await db
    .select({
      id: patients.id,
      pacwareId: patients.pacwareId,
      firstName: patients.legalFirstName,
      lastName: patients.legalLastName,
      status: patients.status,
      hasPhone: sql<boolean>`(${patients.phoneE164} IS NOT NULL)`,
      hasEmail: sql<boolean>`(${patients.email} IS NOT NULL)`,
      createdAt: patients.createdAt,
      updatedAt: patients.updatedAt,
      lastMessageAt: patientLatestMessage.lastMessageAt,
      lastMessageDirection: patientLatestMessage.lastMessageDirection,
      lastMessagePreview: patientLatestMessage.lastMessagePreview,
    })
    .from(patients)
    .leftJoin(
      patientLatestMessage,
      eq(patientLatestMessage.patientId, patients.id),
    )
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
      lastMessageAt:
        r.lastMessageAt instanceof Date
          ? r.lastMessageAt.toISOString()
          : (r.lastMessageAt ?? null),
      lastMessageDirection: r.lastMessageDirection ?? null,
      lastMessagePreview: r.lastMessagePreview ?? null,
    })),
    total: totalRow?.count ?? 0,
    limit,
    offset,
  });
});

// Build the OR-union of ILIKE clauses for the non-phone-shaped
// search path. Pacware id is plaintext and indexed (cheap); the
// rest are full-table scans on plaintext columns (acceptable for
// admin-only / small dataset). Email is included so an admin can
// look up a patient by partial email when they don't have the
// pacware id handy.
function textSearchClause(needle: string): SQL {
  return sql`(${patients.pacwareId} ILIKE ${needle} OR ${patients.legalFirstName} ILIKE ${needle} OR ${patients.legalLastName} ILIKE ${needle} OR ${patients.email} ILIKE ${needle})`;
}

export default router;
