// /admin/shop/insurance-leads/* — admin queue + status updates for
// the lead-capture form on the public /insurance page.
//
// Endpoints (all requireAdmin-gated):
//
//   GET   /admin/shop/insurance-leads?status=new
//                                   — paginated list, default sort
//                                     newest first, optional status
//                                     filter.
//   PATCH /admin/shop/insurance-leads/:id
//                                   — update status and/or csr note.
//                                     Stamps moderated_at +
//                                     moderated_by on every change.
//
// PHI handling:
//   The list endpoint returns the patient's name, email, phone, DOB,
//   carrier, and member-id in the clear — every admin who can hit
//   /admin/* has already cleared the PHI-access policy gate
//   (requireAdmin + the team allowlist). For the audit log we emit a
//   counts-only line that records the row count + filter + actor,
//   but NEVER the per-row PHI itself, mirroring the policy used for
//   the patients/conversations endpoints.

import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  getDbPool,
  INSURANCE_LEAD_STATUSES,
  insuranceLeads,
  type InsuranceLeadStatus,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const listQuery = z.object({
  // Allow filtering by status, plus an "all" sentinel for the
  // admin's "show me everything" toggle.
  // z.enum needs a mutable tuple — INSURANCE_LEAD_STATUSES is
  // readonly, so spread into a fresh array literal here.
  status: z
    .enum(["all", ...INSURANCE_LEAD_STATUSES] as [
      "all",
      ...typeof INSURANCE_LEAD_STATUSES,
    ])
    .optional()
    .default("all"),
  limit: z
    .string()
    .optional()
    .transform((v) => {
      const n = v ? Number.parseInt(v, 10) : 100;
      if (!Number.isFinite(n)) return 100;
      return Math.max(1, Math.min(200, n));
    }),
});

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const patchBody = z
  .object({
    status: z
      .enum([...INSURANCE_LEAD_STATUSES] as [
        InsuranceLeadStatus,
        ...InsuranceLeadStatus[],
      ])
      .optional(),
    csrNote: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform((v) => (v === undefined || v === null || v === "" ? null : v)),
  })
  .strict()
  .refine(
    (b) => b.status !== undefined || b.csrNote !== undefined,
    { message: "must include status or csrNote" },
  );

router.get("/admin/shop/insurance-leads", requireAdmin, async (req, res) => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const { status, limit } = parsed.data;
  const db = drizzle(getDbPool());

  const where =
    status === "all" ? undefined : eq(insuranceLeads.status, status);

  const rows = await db
    .select({
      id: insuranceLeads.id,
      fullName: insuranceLeads.fullName,
      email: insuranceLeads.email,
      phone: insuranceLeads.phone,
      dateOfBirth: insuranceLeads.dateOfBirth,
      insuranceCarrier: insuranceLeads.insuranceCarrier,
      memberId: insuranceLeads.memberId,
      groupNumber: insuranceLeads.groupNumber,
      prescribingPhysician: insuranceLeads.prescribingPhysician,
      notes: insuranceLeads.notes,
      status: insuranceLeads.status,
      csrNote: insuranceLeads.csrNote,
      notificationEmailDelivered: insuranceLeads.notificationEmailDelivered,
      confirmationEmailDelivered: insuranceLeads.confirmationEmailDelivered,
      moderatedAt: insuranceLeads.moderatedAt,
      moderatedBy: insuranceLeads.moderatedBy,
      createdAt: insuranceLeads.createdAt,
      updatedAt: insuranceLeads.updatedAt,
    })
    .from(insuranceLeads)
    .where(where)
    .orderBy(desc(insuranceLeads.createdAt))
    .limit(limit);

  // Status counts for the small KPI strip above the table. One
  // GROUP BY query rather than five separate counts. The strip is
  // computed over the whole table (not the filtered list) so the
  // admin can see "10 new" even while filtered to "verified".
  const countRows = await db
    .select({
      status: insuranceLeads.status,
      n: sql<number>`count(*)::int`,
    })
    .from(insuranceLeads)
    .groupBy(insuranceLeads.status);
  const counts: Record<InsuranceLeadStatus, number> = {
    new: 0,
    contacted: 0,
    verified: 0,
    closed: 0,
  };
  for (const r of countRows) {
    if (r.status in counts) {
      counts[r.status as InsuranceLeadStatus] = r.n;
    }
  }

  req.log?.info?.(
    { rowCount: rows.length, filter: status, counts },
    "admin/shop/insurance-leads: list",
  );

  res.json({
    rows: rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      email: r.email,
      phone: r.phone,
      dateOfBirth: r.dateOfBirth,
      insuranceCarrier: r.insuranceCarrier,
      memberId: r.memberId,
      groupNumber: r.groupNumber,
      prescribingPhysician: r.prescribingPhysician,
      notes: r.notes,
      status: r.status,
      csrNote: r.csrNote,
      notificationEmailDelivered: r.notificationEmailDelivered,
      confirmationEmailDelivered: r.confirmationEmailDelivered,
      moderatedAt: r.moderatedAt ? r.moderatedAt.toISOString() : null,
      moderatedBy: r.moderatedBy,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
    counts,
  });
});

router.patch(
  "/admin/shop/insurance-leads/:id",
  requireAdmin,
  async (req, res) => {
    // req.params is typed as Record<string, string | string[]> in
    // strict express; this route's path uses a single :id segment so
    // narrow with a runtime guard.
    const idParam = req.params.id;
    if (typeof idParam !== "string" || !ID_RE.test(idParam)) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const parse = patchBody.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parse.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    // Build the partial update set explicitly so we never overwrite
    // fields the caller didn't intend to touch.
    const update: Record<string, unknown> = {
      updatedAt: sql`now()`,
      moderatedAt: sql`now()`,
      moderatedBy: req.adminEmail ?? null,
    };
    if (parse.data.status !== undefined) update.status = parse.data.status;
    if (parse.data.csrNote !== undefined) update.csrNote = parse.data.csrNote;

    const db = drizzle(getDbPool());
    const updated = await db
      .update(insuranceLeads)
      .set(update)
      .where(eq(insuranceLeads.id, idParam))
      .returning({
        id: insuranceLeads.id,
        status: insuranceLeads.status,
        csrNote: insuranceLeads.csrNote,
        moderatedAt: insuranceLeads.moderatedAt,
        moderatedBy: insuranceLeads.moderatedBy,
        updatedAt: insuranceLeads.updatedAt,
      });
    const row = updated[0];
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    req.log?.info?.(
      {
        leadId: row.id,
        statusUpdated: parse.data.status !== undefined,
        noteUpdated: parse.data.csrNote !== undefined,
        actor: req.adminEmail ?? null,
      },
      "admin/shop/insurance-leads: patch",
    );

    res.json({
      id: row.id,
      status: row.status,
      csrNote: row.csrNote,
      moderatedAt: row.moderatedAt ? row.moderatedAt.toISOString() : null,
      moderatedBy: row.moderatedBy,
      updatedAt: row.updatedAt.toISOString(),
    });
  },
);

export default router;
