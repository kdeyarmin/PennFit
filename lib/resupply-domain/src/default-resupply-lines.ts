// Default Medicare-style consumable lines for bootstrapping resupply
// outreach on patients who have demographics but no active prescriptions
// yet (common after a PacWare roster import).
//
// SKU prefixes align with migration 0070 frequency_rules (FILTER-DISP,
// CUSHION, MASK, TUBING). `cadenceDays` is the prescription fallback
// when no rule matches; resolveOutreachPlan may shorten it per payer.

export interface DefaultResupplyLine {
  /** Placeholder SKU; must start with the frequency-rule prefix. */
  itemSku: string;
  /** Prescription-level fallback cadence (days). */
  cadenceDays: number;
}

/** Four consumables most CPAP resupply programs track out of the box. */
export const DEFAULT_MEDICARE_RESUPPLY_LINES: readonly DefaultResupplyLine[] =
  [
    { itemSku: "FILTER-DISP-STD", cadenceDays: 15 },
    { itemSku: "CUSHION-STD", cadenceDays: 30 },
    { itemSku: "MASK-STD", cadenceDays: 90 },
    { itemSku: "TUBING-STD", cadenceDays: 90 },
  ] as const;
