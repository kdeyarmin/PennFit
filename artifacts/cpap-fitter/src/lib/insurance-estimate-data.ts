// Static payer → estimate table for the /insurance/estimate page.
//
// What this is NOT
// ----------------
// Live 270/271 eligibility lookup. We don't have a Stedi / Change
// Healthcare clearinghouse account wired up, and even if we did, the
// public estimator page is the wrong surface for live PHI exchange
// (the form here is intentionally low-friction with no member id).
//
// What this IS
// ------------
// A hand-curated, range-only "what most patients with this payer pay"
// table. The numbers are deliberately conservative ranges; the email
// the patient receives explicitly says "this is an estimate; we
// verify your specific plan before any charge." If you tighten any
// of these numbers, you take on the responsibility of keeping them
// current — re-confirm with billing before changing.
//
// Carriers are slugged so the API + UI can refer to them by stable
// id. The label is what we show on the dropdown + in the email.
//
// "Other / not sure" is intentionally last + carries the widest
// range; we ALWAYS want the patient to be able to submit even when
// they don't know their payer.

export interface PayerEstimate {
  /** Stable id; persisted on fitter_leads.user_agent → notes for triage. */
  slug: string;
  label: string;
  /**
   * Typical patient out-of-pocket per resupply ORDER (mask + cushion +
   * filters + hose at the standard quarterly cadence), AFTER the patient
   * has met their deductible. Both bounds inclusive, in whole dollars.
   *
   * Where this comes from: 2024-2026 internal billing-team consensus
   * for the most common plan tiers. Update via PR with billing review.
   */
  postDeductibleLowDollars: number;
  postDeductibleHighDollars: number;
  /**
   * Free-form one-line "what to know" the email surfaces. Kept short
   * (<140 chars) so it renders well in both the email body and the
   * inline result card on the page.
   */
  note: string;
}

export const PAYER_ESTIMATES: PayerEstimate[] = [
  {
    slug: "medicare",
    label: "Medicare (Original / Part B)",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 25,
    note:
      "Medicare Part B covers CPAP supplies at 80% after the annual deductible; a secondary plan typically covers the remaining 20%.",
  },
  {
    slug: "medicare_advantage",
    label: "Medicare Advantage",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 60,
    note:
      "Medicare Advantage plans vary — most have a flat copay or a small coinsurance for DME after the deductible.",
  },
  {
    slug: "medicaid",
    label: "Medicaid",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 10,
    note:
      "Most state Medicaid programs cover CPAP supplies in full with $0 patient responsibility once we confirm eligibility.",
  },
  {
    slug: "bcbs",
    label: "Blue Cross Blue Shield",
    postDeductibleLowDollars: 10,
    postDeductibleHighDollars: 75,
    note:
      "BCBS plan tiers differ widely. We verify your specific plan's DME benefit before any charge.",
  },
  {
    slug: "aetna",
    label: "Aetna",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 80,
    note:
      "Aetna typically pays 80% of the allowed amount for DME after the deductible; out-of-pocket varies with the plan.",
  },
  {
    slug: "united",
    label: "UnitedHealthcare",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 90,
    note:
      "UnitedHealthcare DME coverage varies by employer plan. We verify in-network before billing.",
  },
  {
    slug: "cigna",
    label: "Cigna",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 85,
    note:
      "Cigna commercial plans usually cover DME at 70-90% after the deductible.",
  },
  {
    slug: "humana",
    label: "Humana",
    postDeductibleLowDollars: 10,
    postDeductibleHighDollars: 70,
    note:
      "Humana Medicare Advantage often has a flat per-month CPAP supply copay; commercial plans are coinsurance-based.",
  },
  {
    slug: "tricare",
    label: "TRICARE",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 30,
    note:
      "TRICARE Prime is typically $0 cost-share for in-network DME; Select has a small copay.",
  },
  {
    slug: "kaiser",
    label: "Kaiser Permanente",
    postDeductibleLowDollars: 20,
    postDeductibleHighDollars: 80,
    note:
      "Kaiser plans have plan-tier-specific DME copays. We confirm before billing.",
  },
  {
    slug: "other",
    label: "Other / Not sure",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 120,
    note:
      "Tell us your payer in the comments and we'll verify your specific plan within one business day.",
  },
];

/**
 * Format the post-deductible range as a friendly dollar string:
 *   "$0–$25" / "$15–$85" / "free" when both bounds are 0.
 */
export function formatEstimateRange(p: PayerEstimate): string {
  if (p.postDeductibleLowDollars === 0 && p.postDeductibleHighDollars === 0) {
    return "$0 (free)";
  }
  if (p.postDeductibleLowDollars === 0) {
    return `$0–$${p.postDeductibleHighDollars}`;
  }
  return `$${p.postDeductibleLowDollars}–$${p.postDeductibleHighDollars}`;
}

export function findPayerEstimate(slug: string): PayerEstimate | null {
  return PAYER_ESTIMATES.find((p) => p.slug === slug) ?? null;
}
