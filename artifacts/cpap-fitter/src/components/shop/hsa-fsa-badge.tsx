// HsaFsaBadge — small, low-visual-weight chip that signals
// the product is HSA/FSA eligible. CPAP supplies (masks,
// cushions, tubing, filters, headgear, humidifier chambers)
// are universally IRS-classified as qualified medical
// expenses, so every product this storefront sells is HSA/FSA
// eligible. We render the badge unconditionally on each card
// rather than carrying a per-SKU flag.
//
// Two visual sizes:
//   "card"  — for the /shop product card price line
//   "pdp"   — slightly larger for the product detail page
//
// We deliberately keep the chip muted (slate ring on a soft
// emerald background) so it complements — not competes with —
// the existing "Out of stock" / "Only N left" inventory badges
// that share the same row.

import { Wallet } from "lucide-react";

interface Props {
  size?: "card" | "pdp";
  /** Override label, e.g. for the in-card variant we use the
   *  short "HSA/FSA" form to avoid wrapping at narrow widths. */
  label?: string;
}

export function HsaFsaBadge({ size = "card", label }: Props) {
  const text = label ?? (size === "pdp" ? "HSA/FSA eligible" : "HSA/FSA");
  const dims =
    size === "pdp"
      ? "text-xs px-2.5 py-1 gap-1.5"
      : "text-[10.5px] px-2 py-0.5 gap-1";
  return (
    <span
      className={`inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 text-emerald-800 font-semibold ${dims}`}
      title="Eligible for HSA / FSA reimbursement"
      data-testid={`hsa-fsa-badge-${size}`}
    >
      <Wallet className={size === "pdp" ? "w-3.5 h-3.5" : "w-3 h-3"} />
      {text}
    </span>
  );
}
