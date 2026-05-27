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
  // Limit 2 + .length !== 1 guards against the email-collision
  // PHI leak: if two patient records share an email, returning
  // either one would expose the wrong patient's coverage estimate
  // (a PHI surface) to the shopper. .ilike is case-INsensitive so
  // legacy mixed-case patient.email rows still resolve. See
  // me-billing.ts for the planned fix.
  const escapedEmail = customer.email_lower.replace(
    /[\\%_]/g,
    (c: string) => `\\${c}`,
  );
  const { data: patients, error: patientError } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id")
    .ilike("email", escapedEmail)
    .limit(2);
  if (patientError) {
    throw new Error(
      `Failed to fetch patient for email ${customer.email_lower}: ${patientError.message}`,
    );
  }
  if (!patients || patients.length !== 1) return null;
  return { patientId: patients[0]!.id };
}

router.get("/me/insurance-estimate", async (req, res) => {
  // shopCustomerId is set by the storefront session middleware in
  // app.ts. Treat its absence as "not signed in" → 401, which the
  // SPA's fetchPersonalEstimate() resolves to { available: false }
  // and falls back to the static estimator. NOTE: do NOT zod-parse
  // `req` here — the field is a middleware-set property, not HTTP
  // input, and a 400 response would break the silent-fallback the
  // page relies on for unauthenticated visitors.
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
