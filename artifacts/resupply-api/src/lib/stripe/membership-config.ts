// Cash-pay membership price configuration.
//
// Maps each paid membership tier to its Stripe recurring price id. Feature-
// gated + fail-soft: a tier with no configured price is simply unavailable
// (the storefront hides it; the join route 503s for it), so a deploy without
// membership prices behaves exactly as before (membership stays CSR-set only).
//
// v1 reads platform-level env vars. Per-tenant membership pricing would move
// these into app_config / organizations, resolved by orgId — the join route
// already passes the tenant through, so that's an additive change later.

/** Paid membership tiers a customer can self-serve join. (payg is the free
 *  base tier and has no price.) */
export type PaidMembershipTier = "monthly_unlimited" | "quarterly_unlimited";

export const PAID_MEMBERSHIP_TIERS: readonly PaidMembershipTier[] = [
  "monthly_unlimited",
  "quarterly_unlimited",
] as const;

export type MembershipPriceConfig = Partial<Record<PaidMembershipTier, string>>;

/** Resolve the configured Stripe price id per paid tier (omitting unset
 *  tiers). Returns an empty object when nothing is configured. */
export function readMembershipPriceConfig(
  env: NodeJS.ProcessEnv = process.env,
): MembershipPriceConfig {
  const config: MembershipPriceConfig = {};
  const monthly = env.STRIPE_MEMBERSHIP_MONTHLY_PRICE_ID?.trim();
  const quarterly = env.STRIPE_MEMBERSHIP_QUARTERLY_PRICE_ID?.trim();
  if (monthly) config.monthly_unlimited = monthly;
  if (quarterly) config.quarterly_unlimited = quarterly;
  return config;
}

export function isPaidMembershipTier(v: unknown): v is PaidMembershipTier {
  return v === "monthly_unlimited" || v === "quarterly_unlimited";
}
