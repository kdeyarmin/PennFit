// Patient-portal payment portal.
//
//   POST /api/me/payments/intent — create a Stripe PaymentIntent for
//        the supplied per-claim allocations. Returns the client_secret
//        the frontend uses to confirm via Stripe Elements.
//   GET  /api/me/payments — list patient's payment history.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { createPaymentIntent } from "../../lib/billing/patient-payment";
import { logger } from "../../lib/logger";

const router: IRouter = Router();

const intentBody = z
  .object({
    allocations: z
      .array(
        z.object({
          claimId: z.string().uuid(),
          amountAppliedCents: z.number().int().min(1),
        }),
      )
      .min(1)
      .max(20),
    note: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

async function resolvePatientForCustomer(
  customerId: string,
): Promise<{ patientId: string; customerEmail: string } | null> {
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
    .select("id, email")
    .eq("email", customer.email_lower)
    .limit(1)
    .maybeSingle();
  return patient
    ? { patientId: patient.id, customerEmail: customer.email_lower }
    : null;
}

router.post("/me/payments/intent", async (req, res) => {
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = intentBody.safeParse(req.body);
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
    res.status(404).json({ error: "no_linked_patient" });
    return;
  }
  const result = await createPaymentIntent({
    patientId: link.patientId,
    allocations: parsed.data.allocations,
    source: "portal",
    note: parsed.data.note,
    initiatorEmail: link.customerEmail,
  });
  if ("error" in result) {
    // 503 — Stripe not configured (service unavailable in this env).
    // 502 — Stripe accepted the call but rejected (upstream error).
    // 409 — caller error (no_allocations / claim_not_owned /
    //       claim_balance_mismatch).
    const status =
      result.error === "stripe_not_configured"
        ? 503
        : result.error === "stripe_rejected"
          ? 502
          : 409;
    res.status(status).json(result);
    return;
  }
  logger.info(
    {
      event: "patient_payment.intent_created",
      patientId: link.patientId,
      paymentId: result.paymentId,
      amountCents: result.amountCents,
    },
    "patient_payment: intent created",
  );
  res.status(201).json({
    paymentId: result.paymentId,
    clientSecret: result.paymentIntentClientSecret,
    amountCents: result.amountCents,
  });
});

router.get("/me/payments", async (req, res) => {
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ payments: [] });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data } = await supabase
    .schema("resupply")
    .from("patient_payments")
    .select(
      "id, amount_cents, currency, status, applied_claims_json, note, failure_reason, succeeded_at, created_at",
    )
    .eq("patient_id", link.patientId)
    .order("created_at", { ascending: false })
    .limit(50);
  res.json({ payments: data ?? [] });
});

export default router;
