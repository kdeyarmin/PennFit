// Pure cost / proration preview for tenant billing changes.
//
// Before a tenant owner (self-service) or a platform super-admin confirms a
// plan switch or an add-on quantity change, the UI shows what it will cost:
// the new recurring monthly total, the change versus today, and — when we
// know the current billing-period window — the prorated amount that lands on
// the next invoice for the partial period.
//
// This is a deterministic, local estimate. It deliberately does NOT call
// Stripe's upcoming-invoice API: platform billing is best-effort and often
// runs with Stripe unconfigured (dev/preview), so the preview must work from
// catalog prices + the period dates we already persist. Stripe remains the
// source of truth for the actual charge (it prorates on its own with
// `proration_behavior: "create_prorations"`); this is the human-readable
// heads-up before confirming.
//
// Posture: aggregate dollar math only — no patient data, no PHI.

/** Inputs describing the current and proposed recurring monthly cost, plus
 *  the current billing period (when known) so we can prorate. */
export interface BillingPreviewInput {
  /** Tenant's current recurring monthly total, cents (plan + add-ons). */
  currentMonthlyCents: number;
  /** Recurring monthly total after the change, cents (plan + add-ons). */
  newMonthlyCents: number;
  /** Current billing period start (ISO), or null when not Stripe-synced. */
  currentPeriodStart: string | null;
  /** Current billing period end (ISO), or null when not Stripe-synced. */
  currentPeriodEnd: string | null;
  /** "Now" — injectable for tests. Defaults to the call time. */
  now?: Date;
}

export interface BillingPreview {
  currentMonthlyCents: number;
  newMonthlyCents: number;
  /** newMonthly − currentMonthly. Positive = costs more going forward. */
  deltaMonthlyCents: number;
  /**
   * Estimated prorated amount applied to the next invoice for the remainder
   * of the current period: deltaMonthly × (daysRemaining / periodDays).
   * Positive = an additional charge, negative = a credit. `null` when the
   * billing period is unknown (no Stripe sync yet) — we can't prorate, so
   * the UI shows only the monthly delta.
   */
  proratedNowCents: number | null;
  /** Whole days left in the current period, or null when unknown. */
  daysRemaining: number | null;
  /** Length of the current period in whole days, or null when unknown. */
  periodDays: number | null;
  /** Echoed period end (ISO) so the UI can say "starting <date>". */
  currentPeriodEnd: string | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two instants, truncated toward zero and floored at 0
 *  (a partial day does not count as a full day). */
function dayspan(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / MS_PER_DAY));
}

/**
 * Compute a deterministic cost/proration preview for a billing change.
 * Pure: no I/O, no Stripe call. Safe to unit-test exhaustively.
 */
export function computeBillingPreview(
  input: BillingPreviewInput,
): BillingPreview {
  const { currentMonthlyCents, newMonthlyCents } = input;
  const deltaMonthlyCents = newMonthlyCents - currentMonthlyCents;
  const now = (input.now ?? new Date()).getTime();

  const startMs = input.currentPeriodStart
    ? Date.parse(input.currentPeriodStart)
    : NaN;
  const endMs = input.currentPeriodEnd
    ? Date.parse(input.currentPeriodEnd)
    : NaN;

  // Without a valid, future-ending period window we can't prorate.
  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return {
      currentMonthlyCents,
      newMonthlyCents,
      deltaMonthlyCents,
      proratedNowCents: null,
      daysRemaining: null,
      periodDays: null,
      currentPeriodEnd: input.currentPeriodEnd,
    };
  }

  const periodDays = dayspan(startMs, endMs);
  // Clamp "now" inside the period so a stale period (already ended) yields
  // 0 days remaining rather than a negative proration.
  const clampedNow = Math.min(Math.max(now, startMs), endMs);
  const daysRemaining = dayspan(clampedNow, endMs);

  const fraction = periodDays > 0 ? daysRemaining / periodDays : 0;
  const proratedNowCents = Math.round(deltaMonthlyCents * fraction);

  return {
    currentMonthlyCents,
    newMonthlyCents,
    deltaMonthlyCents,
    proratedNowCents,
    daysRemaining,
    periodDays,
    currentPeriodEnd: input.currentPeriodEnd,
  };
}
