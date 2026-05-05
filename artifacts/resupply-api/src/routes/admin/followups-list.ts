// /admin/followups — cross-flow daily queue of open CSR follow-ups
// across both shop_customers (Phase 17) and patients (Phase 19).
//
// One HTTP request returns followups from both surfaces via two SQL
// queries in parallel, each joined with the corresponding identity
// table for display name, then merged into a single list ordered by
// due_at ASC (most overdue first), capped at 200 total.
//
// Each row carries a `kind: "shop_customer" | "patient"` discriminator
// so the UI can route the customer/patient link correctly. We
// intentionally keep the two tables separate at the SQL level (rather
// than a UNION query) because the schemas differ in subject id type
// and identity fields, and the merge in JS is trivially fast at this
// row volume.
//
// PHI posture: bodies are returned plain (CSR is admin-gated), but
// we never log them. Only counts hit the request log.

import { asc, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Router, type IRouter } from "express";

import {
  getDbPool,
  patientFollowups,
  patients,
  shopCustomerFollowups,
  shopCustomers,
} from "@workspace/resupply-db";

import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// We cap each side at 200; in practice the open queue is tiny but
// this prevents a runaway from monopolizing one side's slots.
const PER_SIDE_CAP = 200;
const TOTAL_CAP = 200;

router.get("/admin/followups", requireAdmin, async (req, res) => {
  const db = drizzle(getDbPool());

  const [shopRows, patientRows] = await Promise.all([
    db
      .select({
        id: shopCustomerFollowups.id,
        subjectId: shopCustomerFollowups.customerId,
        body: shopCustomerFollowups.body,
        dueAt: shopCustomerFollowups.dueAt,
        createdByEmail: shopCustomerFollowups.createdByEmail,
        createdAt: shopCustomerFollowups.createdAt,
        displayName: shopCustomers.displayName,
        email: shopCustomers.emailLower,
      })
      .from(shopCustomerFollowups)
      .innerJoin(
        shopCustomers,
        eq(shopCustomers.customerId, shopCustomerFollowups.customerId),
      )
      .where(isNull(shopCustomerFollowups.completedAt))
      .orderBy(asc(shopCustomerFollowups.dueAt))
      .limit(PER_SIDE_CAP),
    db
      .select({
        id: patientFollowups.id,
        subjectId: patientFollowups.patientId,
        body: patientFollowups.body,
        dueAt: patientFollowups.dueAt,
        createdByEmail: patientFollowups.createdByEmail,
        createdAt: patientFollowups.createdAt,
        legalFirstName: patients.legalFirstName,
        legalLastName: patients.legalLastName,
      })
      .from(patientFollowups)
      .innerJoin(patients, eq(patients.id, patientFollowups.patientId))
      .where(isNull(patientFollowups.completedAt))
      .orderBy(asc(patientFollowups.dueAt))
      .limit(PER_SIDE_CAP),
  ]);

  const merged = [
    ...shopRows.map((r) => ({
      kind: "shop_customer" as const,
      id: r.id,
      subjectId: r.subjectId,
      subjectDisplayName: r.displayName,
      subjectEmail: r.email,
      body: r.body,
      dueAt: r.dueAt,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt,
    })),
    ...patientRows.map((r) => ({
      kind: "patient" as const,
      id: r.id,
      subjectId: r.subjectId,
      subjectDisplayName:
        `${r.legalFirstName} ${r.legalLastName}`.trim() || null,
      subjectEmail: null as string | null,
      body: r.body,
      dueAt: r.dueAt,
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt,
    })),
  ];
  merged.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
  const trimmed = merged.slice(0, TOTAL_CAP);

  req.log?.info(
    {
      count: trimmed.length,
      shopCount: shopRows.length,
      patientCount: patientRows.length,
      adminEmail: req.adminEmail,
    },
    "admin.followups.list",
  );

  res.json({
    followups: trimmed.map((r) => ({
      kind: r.kind,
      id: r.id,
      subjectId: r.subjectId,
      subjectDisplayName: r.subjectDisplayName,
      subjectEmail: r.subjectEmail,
      body: r.body,
      dueAt: r.dueAt.toISOString(),
      createdByEmail: r.createdByEmail,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
