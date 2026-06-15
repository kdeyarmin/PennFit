// Patient-portal claim explorer.
//
//   GET /api/me/claims                          — list patient's claims
//   GET /api/me/claims/:claimId                 — claim detail incl. lines + events
//   GET /api/me/billing-balance                 — total open patient_responsibility
//
// Authentication: relies on the storefront `attachSignedIn` middleware
// (mounted in routes/storefront/index.ts) that sets req.shopCustomerId
// from the pf_session cookie. We map customer → patient via the
// shop_customers.email_lower ↔ patients.email join.
//
// PHI posture: only the logged-in patient sees their own data. No
// PHI leaks across patients because every query is bounded by
// patient_id (resolved from the authenticated shop_customer row).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, type Database } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

type InsuranceClaimRow =
  Database["resupply"]["Tables"]["insurance_claims"]["Row"];
type InsuranceClaimLineItemRow =
  Database["resupply"]["Tables"]["insurance_claim_line_items"]["Row"];
type InsuranceClaimEventRow =
  Database["resupply"]["Tables"]["insurance_claim_events"]["Row"];

const router: IRouter = Router();

const idParam = z.object({ claimId: z.string().uuid() });

async function resolvePatientForCustomer(
  supabase: ReturnType<typeof getOrgScopedClient>,
  customerId: string,
): Promise<{ patientId: string } | null> {
  const { data: customer } = await supabase
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (!customer?.email_lower) return null;
  // Refuse to bind when more than one patient row matches the email.
  // The /me/claims list and detail surfaces are PHI; returning
  // either patient's claim history to the wrong shopper is a
  // cross-patient PHI leak. .ilike is case-INsensitive so legacy
  // mixed-case patient.email rows still resolve. See me-billing.ts
  // for the planned fix.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients } = await supabase
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (!patients || patients.length !== 1) return null;
  return { patientId: patients[0]!.id };
}

router.get("/me/claims", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const link = await resolvePatientForCustomer(supabase, customerId);
  if (!link) {
    res.json({ claims: [] });
    return;
  }
  const { data, error: claimsErr } = await supabase
    .from("insurance_claims")
    .select(
      "id, payer_name, date_of_service, status, total_billed_cents, total_paid_cents, patient_responsibility_cents, submitted_at, decision_at, paid_at",
    )
    .eq("patient_id", link.patientId)
    .order("date_of_service", { ascending: false })
    .limit(100);
  if (claimsErr) throw claimsErr;
  res.json({
    claims: (data ?? []).map((c: InsuranceClaimRow) => ({
      id: c.id,
      payerName: c.payer_name,
      dateOfService: c.date_of_service,
      status: c.status,
      totalBilledCents: c.total_billed_cents,
      totalPaidCents: c.total_paid_cents,
      patientResponsibilityCents: c.patient_responsibility_cents,
      submittedAt: c.submitted_at,
      decisionAt: c.decision_at,
      paidAt: c.paid_at,
    })),
  });
});

router.get("/me/claims/:claimId", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const paramParsed = idParam.safeParse(req.params);
  if (!paramParsed.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const link = await resolvePatientForCustomer(supabase, customerId);
  if (!link) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const { data: claim } = await supabase
    .from("insurance_claims")
    .select(
      "id, payer_name, date_of_service, status, total_billed_cents, total_paid_cents, patient_responsibility_cents, submitted_at, decision_at, paid_at, denial_reason",
    )
    .eq("id", paramParsed.data.claimId)
    .eq("patient_id", link.patientId)
    .limit(1)
    .maybeSingle();
  if (!claim) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const [{ data: lines, error: linesErr }, { data: events, error: eventsErr }] =
    await Promise.all([
      supabase
        .from("insurance_claim_line_items")
        .select(
          "hcpcs_code, modifier, description, quantity, billed_cents, allowed_cents, paid_cents, status",
        )
        .eq("claim_id", claim.id)
        .order("created_at", { ascending: true }),
      supabase
        .from("insurance_claim_events")
        .select("event_type, amount_cents, payer_ref, note, occurred_at")
        .eq("claim_id", claim.id)
        .order("occurred_at", { ascending: false })
        .limit(30),
    ]);
  if (linesErr) throw linesErr;
  if (eventsErr) throw eventsErr;
  // Strip the actor_email from events — patient doesn't need our
  // internal staff identifiers.
  res.json({
    claim: {
      id: claim.id,
      payerName: claim.payer_name,
      dateOfService: claim.date_of_service,
      status: claim.status,
      totalBilledCents: claim.total_billed_cents,
      totalPaidCents: claim.total_paid_cents,
      patientResponsibilityCents: claim.patient_responsibility_cents,
      submittedAt: claim.submitted_at,
      decisionAt: claim.decision_at,
      paidAt: claim.paid_at,
      denialReason: claim.denial_reason,
    },
    lineItems: (lines ?? []).map((l: InsuranceClaimLineItemRow) => ({
      hcpcsCode: l.hcpcs_code,
      modifier: l.modifier,
      description: l.description,
      quantity: l.quantity,
      // Extended line charge for the patient view: billed_cents is
      // per-unit. allowed/paid are payer 835 line totals already.
      billedCents: l.billed_cents * l.quantity,
      allowedCents: l.allowed_cents,
      paidCents: l.paid_cents,
      status: l.status,
    })),
    events: (events ?? []).map((e: InsuranceClaimEventRow) => ({
      eventType: e.event_type,
      amountCents: e.amount_cents,
      payerRef: e.payer_ref,
      note: e.note,
      occurredAt: e.occurred_at,
    })),
  });
});

router.get("/me/billing-balance", async (req, res) => {
  const customerId = req.shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const orgId = req.orgId;
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }
  const supabase = getOrgScopedClient(orgId);
  const link = await resolvePatientForCustomer(supabase, customerId);
  if (!link) {
    res.json({ totalOpenCents: 0, claimCount: 0, claims: [] });
    return;
  }
  const { data, error: balanceErr } = await supabase
    .from("insurance_claims")
    .select("id, payer_name, date_of_service, patient_responsibility_cents")
    .eq("patient_id", link.patientId)
    .gt("patient_responsibility_cents", 0)
    .in("status", ["paid", "denied", "appealed", "closed"]);
  if (balanceErr) throw balanceErr;
  const claimList = data ?? [];
  const totalOpenCents = claimList.reduce(
    (s: number, c: InsuranceClaimRow) => s + c.patient_responsibility_cents,
    0,
  );
  res.json({
    totalOpenCents,
    claimCount: claimList.length,
    claims: claimList.map((c: InsuranceClaimRow) => ({
      id: c.id,
      payerName: c.payer_name,
      dateOfService: c.date_of_service,
      patientResponsibilityCents: c.patient_responsibility_cents,
    })),
  });
  void logger; // silence no-unused if log statements get added later
});

export default router;
