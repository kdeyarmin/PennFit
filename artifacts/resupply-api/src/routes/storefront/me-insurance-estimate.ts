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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

const router: IRouter = Router();

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
  return patient ? { patientId: patient.id } : null;
}

router.get("/me/insurance-estimate", async (req, res) => {
  const customerId =
    (req as unknown as { shopCustomerId?: string }).shopCustomerId ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const link = await resolvePatientForCustomer(customerId);
  if (!link) {
    res.json({ available: false });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();

  // Newest parsed check first. We skip queued/submitted/rejected/
  // transport_failed because their financial fields are unreliable
  // (queued/submitted = not back yet; rejected = no parsed numbers).
  const { data: check } = await supabase
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
  if (!check) {
    res.json({ available: false });
    return;
  }

  // Resolve the payer name; the eligibility row only carries the
  // payer_profile_id. One small round-trip.
  let payerName: string | null = null;
  if (check.payer_profile_id) {
    const { data: payer } = await supabase
      .schema("resupply")
      .from("payer_profiles")
      .select("display_name")
      .eq("id", check.payer_profile_id)
      .limit(1)
      .maybeSingle();
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
