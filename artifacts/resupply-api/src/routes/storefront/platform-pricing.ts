// GET /api/platform/pricing — PUBLIC SaaS plan catalog for the platform
// marketing site (cmbreathe.com / the Breathe home page).
//
// Surfaces the same `billing_plans` / `billing_addons` catalog the
// super-admin edits and that tenant accounts bill from, so a price the
// operator changes in the platform portal shows on the marketing page
// without a frontend redeploy. STRICTLY public marketing data: plan
// names, prices, allowances, features, and add-on prices — never any
// Stripe ids, internal sync timestamps, or tenant data.
//
// Fail-soft by design: a DB hiccup returns an empty catalog (200) so the
// marketing page falls back to its static copy instead of erroring.

import { Router, type IRouter } from "express";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const router: IRouter = Router();

interface PublicPlanRow {
  code: string;
  name: string;
  description: string | null;
  monthly_price_cents: number | null;
  onboarding_fee_cents: number | null;
  is_custom: boolean | null;
  allowances: Record<string, unknown> | null;
  features: string[] | null;
  product_scope: string | null;
  sort_order: number | null;
  // Founder launch pricing (migration 0426).
  per_active_patient_cents: number | null;
  regular_monthly_price_cents: number | null;
  founder_rate_locked_months: number | null;
}

interface PublicAddonRow {
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  recurring_price_cents: number | null;
  one_time_min_cents: number | null;
  one_time_max_cents: number | null;
  unit_label: string | null;
  sort_order: number | null;
}

router.get("/platform/pricing", async (_req, res) => {
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) {
    res.json({ plans: [], addons: [] });
    return;
  }
  const raw = getOrgScopedClient(seedOrgId).raw();
  try {
    const [plans, addons] = await Promise.all([
      raw
        .schema("resupply")
        .from("billing_plans")
        .select("*")
        // Public, self-selectable plans plus the custom/Enterprise tier
        // (rendered as "Contact us" by the marketing page).
        .or("is_public.eq.true,is_custom.eq.true")
        .order("sort_order"),
      raw
        .schema("resupply")
        .from("billing_addons")
        .select("*")
        .eq("is_active", true)
        .order("sort_order"),
    ]);
    if (plans.error || addons.error) {
      logger.error(
        {
          event: "platform_pricing_read_failed",
          err: plans.error ?? addons.error,
        },
        "public platform pricing read failed",
      );
      res.json({ plans: [], addons: [] });
      return;
    }
    // Cacheable at the edge/browser for 5 min — pricing changes are rare
    // and the marketing page tolerates slight staleness (same posture as
    // /api/company-info).
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      plans: ((plans.data ?? []) as PublicPlanRow[]).map((p) => {
        // Custom/Enterprise tiers carry NEGOTIATED pricing — never expose a
        // concrete amount publicly even if one is stored. The marketing page
        // renders these as a "Custom / contact us" tier.
        const custom = Boolean(p.is_custom);
        return {
          code: p.code,
          name: p.name,
          description: p.description,
          monthlyPriceCents: custom ? null : p.monthly_price_cents,
          onboardingFeeCents: custom ? null : p.onboarding_fee_cents,
          isCustom: custom,
          allowances: p.allowances ?? {},
          features: p.features ?? [],
          productScope: p.product_scope ?? "full",
          // Founder launch pricing: the per-active-patient charge, the
          // pre-discount "regular" monthly price (shown struck-through), and
          // the months the founder rate is locked. Null on non-founder plans.
          perActivePatientCents: custom ? null : p.per_active_patient_cents,
          regularMonthlyPriceCents: custom
            ? null
            : p.regular_monthly_price_cents,
          founderRateLockedMonths: p.founder_rate_locked_months,
        };
      }),
      addons: ((addons.data ?? []) as PublicAddonRow[]).map((a) => ({
        code: a.code,
        name: a.name,
        category: a.category,
        description: a.description,
        recurringPriceCents: a.recurring_price_cents,
        oneTimeMinCents: a.one_time_min_cents,
        oneTimeMaxCents: a.one_time_max_cents,
        unitLabel: a.unit_label,
      })),
    });
  } catch (err) {
    logger.error(
      { event: "platform_pricing_read_threw", err },
      "public platform pricing read threw",
    );
    res.json({ plans: [], addons: [] });
  }
});

export default router;
