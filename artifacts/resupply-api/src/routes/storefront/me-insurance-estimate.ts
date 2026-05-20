// /api/me/insurance-estimate — personalized resupply cost estimator.
//
// When the signed-in patient has a recent parsed 270/271 eligibility
// check on file, return the actual payer financials so the storefront
// estimator page can show "your deductible, your OOP max, your
// coinsurance" instead of the static payer-average table.
//
// Response is either:
//   { available: false }              — no parsed check on file
//   { available: true, payerName, isActive, inNetwork,
//     deductibleCents, deductibleMetCents, oopMaxCents, oopMetCents,
//     copayCents, coinsurancePct, requiresPriorAuth, asOf }
//
// We deliberately surface only the parsed financial fields — no
// member id, no demographics, no payer profile id (the storefront
// already shows the friendly payer name; an internal UUID buys
// nothing and risks leaking config the patient can't act on).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

const router: IRouter = Router();

const RequestSchema = z.object({
  shopCustomerId: z.string().min(1),
});

async function resolvePatientForCustomer(
  customerId: string,
): Promise<{ patientId: string } | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: customer, error: customerError } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select("customer_id, email_lower")
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (customerError) {
    throw new Error(
      `Failed to fetch customer ${customerId}: ${customerError.message}`,
    );
  }
  if (!customer?.email_lower) return null;
  const { data: patient, error: patientError } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .eq("email", customer.email_lower)
    .limit(1)
    .maybeSingle();
  if (patientError) {
    throw new Error(
      `Failed to fetch patient for email ${customer.email_lower}: ${patientError.message}`,
    );
  }
  return patient ? { patientId: patient.id } : null;
}

router.get("/me/insurance-estimate", async (req, res) => {
  const parsed = RequestSchema.safeParse(req as unknown as Record<string, unknown>);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_request",
      message: "shopCustomerId is required",
    });
    return;
  }
  const customerId = parsed.data.shopCustomerId;
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ available: false });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();

  // Newest parsed check first. We skip queued/submitted/rejected/
  // transport_failed because their financial fields are unreliable
  // (queued/submitted = not back yet; rejected = no parsed numbers).
  const { data: check, error: checkError } = await supabase
    .schema("resupply")
    .from("eligibility_checks")
    .select(
      "is_active, in_network, deductible_cents, deductible_met_cents, oop_max_cents, oop_met_cents, copay_cents, coinsurance_pct, requires_prior_auth, payer_profile_id, responded_at",
    )
    .eq("patient_id", link.patientId)
    .eq("status", "parsed")
    .order("responded_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (checkError) {
    res.status(500).json({
      error: "database_error",
      message: `Failed to fetch eligibility check for patient ${link.patientId}`,
    });
    return;
  }
  if (!check) {
    res.json({ available: false });
    return;
  }

  // Resolve the payer name; the eligibility row only carries the
  // payer_profile_id. One small round-trip.
  let payerName: string | null = null;
  if (check.payer_profile_id) {
    const { data: payer, error: payerError } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("display_name")
      .eq("id", check.payer_profile_id)
      .limit(1)
      .maybeSingle();
    if (payerError) {
      res.status(500).json({
        error: "database_error",
        message: `Failed to fetch payer profile ${check.payer_profile_id}`,
      });
      return;
    }
    payerName = payer?.display_name ?? null;
  }

  res.json({
    available: true,
    payerName,
    isActive: check.is_active,
    inNetwork: check.in_network,
    deductibleCents: check.deductible_cents,
    deductibleMetCents: check.deductible_met_cents,
    oopMaxCents: check.oop_max_cents,
    oopMetCents: check.oop_met_cents,
    copayCents: check.copay_cents,
    coinsurancePct: check.coinsurance_pct,
    requiresPriorAuth: check.requires_prior_auth,
    asOf: check.responded_at,
  });
});

export default router;
