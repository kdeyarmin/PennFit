// Effective per-tenant plan allowances — pure.
//
// Two sources decide how much of a metered thing a tenant gets before
// overage bills:
//
//   1. `billing_plans.allowances`            — the marketed tier's numbers.
//   2. `tenant_billing_subscriptions.custom_allowances` — this tenant's
//      negotiated override (the Enterprise plan is `is_custom`, and any
//      tenant can carry one).
//
// Both admin surfaces already merged the two the obvious way
// (`{...plan, ...custom}` in admin-billing-package.tsx and
// platform/console.tsx) — but the BILLING path never did:
// `reportMeteredOverage` read `billing_plans(allowances)` alone. So a
// platform admin could set a custom allowance, watch both consoles report
// the tenant comfortably inside it, and still have Stripe bill overage
// against the plan's smaller number. This module is the one place that
// resolution lives, so the console and the invoice cannot disagree again.
//
// UNLIMITED
// ---------
// `null` in `custom_allowances` means "no cap" — deliberately distinct
// from `0`, which means "none included" (the fitter-only plan uses 0 for
// the suite metrics it doesn't sell). `null` survives the JSONB round-trip
// and already renders as uncapped in the platform console
// (`capped = allowance !== null`), so the sentinel is the one the UI was
// written for.
//
// Unlimited suppresses OVERAGE BILLING, not measurement:
// `recordTenantUsage` writes `tenant_usage_monthly_rollups` before any of
// this is consulted, so an unlimited tenant is still fully metered and
// still shows real numbers on both usage surfaces. That is the point —
// "unlimited" is a pricing decision, never a reason to stop counting.
//
// Note what this does NOT change: `meteredAddonAttaches` keys off whether
// the metric appears in the allowance map at all, not its value, so an
// unlimited tenant keeps its metered add-on attached and simply reports
// zero billable overage forever. Leaving the Stripe line item in place
// makes this reversible — clear `custom_allowances` and normal billing
// resumes with no subscription surgery.

/** A resolved allowance: a numeric cap, or `null` for unlimited. */
export type Allowance = number | null;

/**
 * True when the resolved allowance means "no cap". A type predicate, so a
 * caller that returns early on unlimited has `number` in hand afterwards
 * without a cast.
 */
export function isUnlimited(value: Allowance | undefined): value is null {
  return value === null;
}

/**
 * Read one override value out of a raw `custom_allowances` JSONB blob.
 *
 * Returns `undefined` for "no opinion — use the plan's number". Only two
 * shapes are honoured as an override: an explicit `null` (unlimited) and a
 * finite, non-negative number. Anything else (a string, NaN, a negative,
 * an object) is IGNORED rather than guessed at, so a malformed row falls
 * back to the marketed plan instead of silently granting a tenant
 * unlimited usage or a nonsense cap.
 */
function readOverride(raw: unknown): Allowance | undefined {
  if (raw === null) return null; // explicit unlimited
  if (typeof raw !== "number") return undefined;
  if (!Number.isFinite(raw) || raw < 0) return undefined;
  return Math.floor(raw);
}

/**
 * Merge a tenant's `custom_allowances` over their plan's `allowances`.
 *
 * Keys present in either source appear in the result. A custom override
 * wins where it is well-formed (see `readOverride`); otherwise the plan's
 * value stands. Plan values are normalised the same way, so a junk plan
 * row can't produce a NaN cap either.
 */
export function resolveEffectiveAllowances(
  planAllowances: Record<string, unknown> | null | undefined,
  customAllowances: Record<string, unknown> | null | undefined,
): Record<string, Allowance> {
  const out: Record<string, Allowance> = {};
  for (const [key, raw] of Object.entries(planAllowances ?? {})) {
    const v = readOverride(raw);
    if (v !== undefined) out[key] = v;
  }
  for (const [key, raw] of Object.entries(customAllowances ?? {})) {
    const v = readOverride(raw);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/**
 * The allowance that applies to one metric, for overage purposes.
 *
 * Returns `null` for unlimited (the caller must skip billing entirely) and
 * a number otherwise. A metric with NO allowance on either source resolves
 * to `0`, preserving the long-standing behaviour that a pure-metered
 * add-on with no plan-included amount (fax_automation, ai_voice_agent)
 * bills from the first unit.
 */
export function overageAllowanceFor(
  effective: Record<string, Allowance>,
  metricKey: string,
): Allowance {
  if (!(metricKey in effective)) return 0;
  return effective[metricKey] ?? null;
}
