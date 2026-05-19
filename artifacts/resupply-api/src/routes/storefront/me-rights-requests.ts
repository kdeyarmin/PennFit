// Patient-portal HIPAA rights surface.
//
//   POST /api/me/rights-requests    — submit a new §164.522/524/526/528
//                                       request (access, amendment, etc.).
//   GET  /api/me/rights-requests    — list the patient's open + closed
//                                       requests with current status.
//   GET  /api/me/disclosures        — read the §164.528 accounting of
//                                       disclosures for this patient.
//
// Authentication: same `requireAuthenticatedShopper` posture as
// me-claims.ts. Customer → patient via shop_customers.email ↔
// patients.email.
//
// PHI posture: every query is bounded by patient_id resolved from the
// authenticated shop_customer; no PHI ever leaks across patients.

import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
  PATIENT_RIGHTS_KIND_VALUES,
} from "@workspace/resupply-db";

import { getDisclosureAccounting } from "../../lib/compliance/disclosure-logger";

const router: IRouter = Router();

const submitRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  // A patient should not need to file more than a few rights requests
  // an hour; this guards against accidental form double-submits and
  // abuse.
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
});

async function resolvePatientForCustomer(
  customerId: string,
): Promise<{ patientId: string } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: customer } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (!customer?.email_lower) return null;
  const { data: patient } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("email", customer.email_lower)
    .limit(1)
    .maybeSingle();
  if (!patient) return null;
  return { patientId: patient.id };
}

const submitBody = z
  .object({
    requestKind: z.enum(PATIENT_RIGHTS_KIND_VALUES),
    requestBody: z.string().trim().min(1).max(8000),
    requestDetails: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

router.post(
  "/me/rights-requests",
  submitRateLimiter,
  async (req, res) => {
    const customerId =
      (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const parsed = submitBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const link = await resolvePatientForCustomer(customerId);
    if (!link) {
      res.status(409).json({ error: "patient_not_linked" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_rights_requests")
      .insert({
        patient_id: link.patientId,
        request_kind: parsed.data.requestKind,
        submitted_via: "patient_portal",
        request_body: parsed.data.requestBody,
        request_details_json: (parsed.data.requestDetails ?? {}) as Database["resupply"]["Tables"]["patient_rights_requests"]["Row"]["request_details_json"],
      })
      .select("id, status, received_at")
      .single();
    if (error) throw error;
    res.status(201).json({
      id: data.id,
      status: data.status,
      receivedAt: data.received_at,
    });
  },
);

router.get("/me/rights-requests", async (req, res) => {
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ requests: [] });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("patient_rights_requests")
    .select(
      "id, request_kind, submitted_via, status, decision, decision_rationale, received_at, decided_at, delivered_at",
    )
    .eq("patient_id", link.patientId)
    .order("received_at", { ascending: false })
    .limit(50);
  res.json({
    requests: (data ?? []).map((r) => ({
      id: r.id,
      requestKind: r.request_kind,
      submittedVia: r.submitted_via,
      status: r.status,
      decision: r.decision,
      decisionRationale: r.decision_rationale,
      receivedAt: r.received_at,
      decidedAt: r.decided_at,
      deliveredAt: r.delivered_at,
    })),
  });
});

const accountingQuery = z
  .object({
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  })
  .strict();

router.get("/me/disclosures", async (req, res) => {
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = accountingQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_query" });
    return;
  }
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ disclosures: [] });
    return;
  }
  const rows = await getDisclosureAccounting({
    patientId: link.patientId,
    fromDate: parsed.data.from
      ? `${parsed.data.from}T00:00:00.000Z`
      : undefined,
    toDate: parsed.data.to
      ? `${parsed.data.to}T23:59:59.999Z`
      : undefined,
  });
  res.json({
    disclosures: rows.map((r) => ({
      id: r.id,
      recipientName: r.recipient_name,
      recipientAddress: r.recipient_address,
      purpose: r.disclosure_purpose,
      description: r.description,
      legalAuthority: r.legal_authority,
      disclosedAt: r.disclosed_at,
    })),
  });
});

export default router;
