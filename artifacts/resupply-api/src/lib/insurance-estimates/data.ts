// Server-side mirror of artifacts/cpap-fitter/src/lib/insurance-estimate-data.ts.
//
// Why two copies
// --------------
// The frontend renders the payer dropdown + the inline result range,
// and the backend renders the same range inside the confirmation
// email the patient receives. The list is tiny (~11 rows) and very
// rarely changes, so duplicating the data is cheaper than spinning
// up a shared package or having the frontend round-trip to fetch it
// on page load. The risk is drift — if you update one, update the
// other; both files cite each other in the header so the next reader
// trips over the dependency the same way you did.
//
// What this is NOT
// ----------------
// A live 270/271 eligibility result. The numbers are conservative
// ranges; the patient confirmation email explicitly tells the
// recipient "this is an estimate; we verify your specific plan
// before any charge."

export interface PayerEstimate {
  slug: string;
  label: string;
  postDeductibleLowDollars: number;
  postDeductibleHighDollars: number;
  note: string;
}

export const PAYER_ESTIMATES: PayerEstimate[] = [
  {
    slug: "medicare",
    label: "Medicare (Original / Part B)",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 25,
    note: "Medicare Part B covers CPAP supplies at 80% after the annual deductible; a secondary plan typically covers the remaining 20%.",
  },
  {
    slug: "medicare_advantage",
    label: "Medicare Advantage",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 60,
    note: "Medicare Advantage plans vary — most have a flat copay or a small coinsurance for DME after the deductible.",
  },
  {
    slug: "medicaid",
    label: "Medicaid",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 10,
    note: "Most state Medicaid programs cover CPAP supplies in full with $0 patient responsibility once we confirm eligibility.",
  },
  {
    slug: "bcbs",
    label: "Blue Cross Blue Shield",
    postDeductibleLowDollars: 10,
    postDeductibleHighDollars: 75,
    note: "BCBS plan tiers differ widely. We verify your specific plan's DME benefit before any charge.",
  },
  {
    slug: "aetna",
    label: "Aetna",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 80,
    note: "Aetna typically pays 80% of the allowed amount for DME after the deductible; out-of-pocket varies with the plan.",
  },
  {
    slug: "united",
    label: "UnitedHealthcare",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 90,
    note: "UnitedHealthcare DME coverage varies by employer plan. We verify in-network before billing.",
  },
  {
    slug: "cigna",
    label: "Cigna",
    postDeductibleLowDollars: 15,
    postDeductibleHighDollars: 85,
    note: "Cigna commercial plans usually cover DME at 70-90% after the deductible.",
  },
  {
    slug: "humana",
    label: "Humana",
    postDeductibleLowDollars: 10,
    postDeductibleHighDollars: 70,
    note: "Humana Medicare Advantage often has a flat per-month CPAP supply copay; commercial plans are coinsurance-based.",
  },
  {
    slug: "tricare",
    label: "TRICARE",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 30,
    note: "TRICARE Prime is typically $0 cost-share for in-network DME; Select has a small copay.",
  },
  {
    slug: "kaiser",
    label: "Kaiser Permanente",
    postDeductibleLowDollars: 20,
    postDeductibleHighDollars: 80,
    note: "Kaiser plans have plan-tier-specific DME copays. We confirm before billing.",
  },
  {
    slug: "other",
    label: "Other / Not sure",
    postDeductibleLowDollars: 0,
    postDeductibleHighDollars: 120,
    note: "Tell us your payer in the comments and we'll verify your specific plan within one business day.",
  },
];

export const PAYER_SLUGS = PAYER_ESTIMATES.map(
  (p) => p.slug,
) as readonly string[];

/**
 * Look up by slug; falls back to 'other' (the safe wide-range entry)
 * for unknown values so a stale frontend can't 404 the email send.
 */
export function findPayerEstimate(slug: string): PayerEstimate {
  const match = PAYER_ESTIMATES.find((p) => p.slug === slug);
  if (match) return match;
  const fallback = PAYER_ESTIMATES.find((p) => p.slug === "other");
  if (!fallback) {
    throw new Error(
      'Payer estimates configuration missing "other" fallback entry',
    );
  }
  return fallback;
}

export function formatEstimateRange(p: PayerEstimate): string {
  if (p.postDeductibleLowDollars === 0 && p.postDeductibleHighDollars === 0) {
    return "$0 (free)";
  }
  if (p.postDeductibleLowDollars === 0) {
    return `$0–$${p.postDeductibleHighDollars}`;
  }
  return `$${p.postDeductibleLowDollars}–$${p.postDeductibleHighDollars}`;
}
