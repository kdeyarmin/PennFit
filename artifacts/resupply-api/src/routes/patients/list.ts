// GET /patients — paginated patient list for the operator console.
//
// Decrypts firstName + lastName for display via the existing
// `decrypt(...)` SQL helper so plaintext PHI never crosses the
// process boundary into Node memory between Postgres and the JSON
// response. Phone + email are never returned — they are surfaced
// as boolean `hasPhone` / `hasEmail` markers (CASE WHEN NOT NULL)
// so the operator can see "this patient is reachable on SMS" without
// the page itself rendering the number.
//
// `search` is matched against the plaintext, indexed `pacware_id`
// AND against the decrypted first/last name. Decrypted-name search
// is a Postgres-side full scan; the limit cap and the operator-only
// gate make this acceptable for the small steady-state operator
// workload.
//
// We do NOT write an audit row per list-view: list pages are
// page-flipped many times during normal operator workflow and one
// audit row per page-flip drowns the audit log. The /patients/{id}
// detail view does write an audit row (see ./detail.ts).

import { Router, type IRouter } from "express";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import { decrypt, getDbPool, patients } from "@workspace/resupply-db";

import { requireOperator } from "../../middlewares/requireOperator";

const listQuery = z
  .object({
    status: z.enum(["active", "paused", "closed"]).optional(),
    search: z.string().min(1).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const router: IRouter = Router();

router.get("/patients", requireOperator, async (req, res) => {
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
    const needle = `%${search}%`;
    filters.push(
      sql`(${patients.pacwareId} ILIKE ${needle} OR ${decrypt(
        patients.legalFirstName,
      )} ILIKE ${needle} OR ${decrypt(patients.legalLastName)} ILIKE ${needle})`,
    );
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

export default router;
