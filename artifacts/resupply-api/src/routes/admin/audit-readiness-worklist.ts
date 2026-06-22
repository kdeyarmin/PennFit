// /admin/billing/audit-readiness-worklist — proactive audit-gap report.
//
//   GET /admin/billing/audit-readiness-worklist
//
// The denials-worklist badge tells a biller whether a DENIED claim is
// defensible. This is the proactive complement: across patients with billed
// (auditable) claims, which are document-SHORT on the audit-critical chart
// documents — so staff can chase the paperwork before an ADR or a denial ever
// arrives. Ranked by billed dollars at risk.
//
// Gated behind billing.adr_queue. reports.read. PHI: patient name + amounts
// (same posture as the bill-hold worklist); no clinical content.

import { Router, type IRouter } from "express";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  assessAuditReadiness,
  coveredKeysFromDocumentTypes,
  getAuditPacketItem,
} from "@workspace/resupply-domain";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

// Claim statuses that have gone to a payer and could be audited.
const AUDITABLE_STATUSES = [
  "submitted",
  "accepted",
  "paid",
  "partially_paid",
  "appealed",
  "closed",
] as const;

const MAX_PATIENTS = 400;
const MAX_ITEMS = 200;

router.get(
  "/admin/billing/audit-readiness-worklist",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!(await isFeatureEnabled("billing.adr_queue", orgId))) {
      res.status(404).json({ error: "feature_disabled" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Auditable claims → per-patient claim count + billed total.
    const { data: claimRows } = await supabase
      .from("insurance_claims")
      .select("patient_id, total_billed_cents, status")
      .in("status", [...AUDITABLE_STATUSES])
      .limit(8000);
    const claims = (claimRows ?? []) as Array<{
      patient_id: string;
      total_billed_cents: number | null;
    }>;

    const agg = new Map<string, { claims: number; billedCents: number }>();
    for (const c of claims) {
      if (!c.patient_id) continue;
      const a = agg.get(c.patient_id) ?? { claims: 0, billedCents: 0 };
      a.claims += 1;
      a.billedCents += c.total_billed_cents ?? 0;
      agg.set(c.patient_id, a);
    }
    // Heaviest-billed patients first, capped.
    const patientIds = Array.from(agg.entries())
      .sort((x, y) => y[1].billedCents - x[1].billedCents)
      .slice(0, MAX_PATIENTS)
      .map(([id]) => id);
    if (patientIds.length === 0) {
      res.json({ items: [], counts: { short: 0, billedAtRiskCents: 0 } });
      return;
    }

    const [{ data: pdocs }, { data: pnames }] = await Promise.all([
      supabase
        .from("patient_documents")
        .select("patient_id, document_type")
        .in("patient_id", patientIds),
      supabase
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .in("id", patientIds),
    ]);

    const docTypesByPatient = new Map<string, Set<string>>();
    for (const d of (pdocs ?? []) as Array<{
      patient_id: string;
      document_type: string;
    }>) {
      const set = docTypesByPatient.get(d.patient_id) ?? new Set<string>();
      set.add(d.document_type);
      docTypesByPatient.set(d.patient_id, set);
    }
    const nameById = new Map(
      (
        (pnames ?? []) as Array<{
          id: string;
          legal_first_name: string;
          legal_last_name: string;
        }>
      ).map((p) => [p.id, `${p.legal_first_name} ${p.legal_last_name}`]),
    );

    const items = patientIds
      .map((pid) => {
        const r = assessAuditReadiness(
          "device",
          coveredKeysFromDocumentTypes([
            ...(docTypesByPatient.get(pid) ?? new Set<string>()),
          ]),
        );
        if (r.ready) return null;
        const a = agg.get(pid)!;
        return {
          patientId: pid,
          patientName: nameById.get(pid) ?? "Patient",
          auditableClaims: a.claims,
          billedCents: a.billedCents,
          score: r.score,
          missing: r.missing.map((k) => getAuditPacketItem(k)?.label ?? k),
        };
      })
      .filter((i): i is NonNullable<typeof i> => i !== null)
      .sort((x, y) => y.billedCents - x.billedCents)
      .slice(0, MAX_ITEMS);

    res.json({
      items,
      counts: {
        short: items.length,
        billedAtRiskCents: items.reduce((s, i) => s + i.billedCents, 0),
      },
    });
  },
);

export default router;
