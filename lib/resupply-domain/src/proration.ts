// Partial-period proration — pure money math (ADR 008: no I/O).
//
// The canonical "charge the fraction of a monthly amount that matches the
// fraction of the billing period still remaining" formula, factored out of
// the billing-preview so the subscription/upgrade preview, and any future
// invoice path, prorate exactly one tested way. Money is integer cents.
//
//   prorated = round(amountCents × daysRemaining / periodDays)
//
// Inputs are clamped defensively: a non-positive period yields 0 (nothing
// to prorate), and daysRemaining is clamped into [0, periodDays] so a
// stale period can't produce a negative or over-100% charge.

export interface ProrationInput {
  /** The full-period amount being prorated, in integer cents (the monthly
   *  delta for an upgrade/downgrade). May be negative (a credit). */
  amountCents: number;
  /** Whole days left in the current billing period. Clamped to
   *  [0, periodDays]. */
  daysRemaining: number;
  /** Whole days in the full billing period. <= 0 → nothing to prorate. */
  periodDays: number;
}

/**
 * Prorate `amountCents` to the fraction of the period still remaining.
 * Pure + total — never throws. Returns integer cents (rounded).
 */
export function prorateCents(input: ProrationInput): number {
  const periodDays = Number.isFinite(input.periodDays)
    ? Math.floor(input.periodDays)
    : 0;
  if (periodDays <= 0) return 0;

  const rawRemaining = Number.isFinite(input.daysRemaining)
    ? Math.floor(input.daysRemaining)
    : 0;
  const daysRemaining = Math.min(Math.max(rawRemaining, 0), periodDays);

  const amountCents = Number.isFinite(input.amountCents)
    ? Math.trunc(input.amountCents)
    : 0;

  return Math.round((amountCents * daysRemaining) / periodDays);
}
