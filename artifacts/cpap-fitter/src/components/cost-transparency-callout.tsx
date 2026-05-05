// Pre-order cost transparency callout (Phase A.4 — feature #9).
//
// v1 placeholder. Aeroflow markets pre-order cost transparency as
// their unique differentiator because no one else does it well —
// "Total: $124.50. Insurance covers $109.50. Your cost: $15.00".
// We don't yet have an insurance-eligibility integration so we ship
// a structured placeholder that:
//
//   1. Confirms the cash total the customer is about to be charged.
//   2. Tells them clearly that the receipt is HSA/FSA/insurance-
//      reimbursement eligible, with one click to learn how.
//   3. Leaves a slot we can swap for a real eligibility-verified
//      breakdown without touching cart layout when partner
//      integration lands.
//
// Why a structural callout vs. tucking it into copy: the "I'll think
// about it" exit happens at the moment of price reveal. Surfacing the
// reimbursement story right there — visible, scannable — keeps the
// conversion loop tight without misrepresenting that we have live
// insurance verification.

import { Link } from "wouter";
import { Receipt, ArrowRight } from "lucide-react";

import { formatMoneyCents } from "@/lib/shop-api";

interface Props {
  /** Cart subtotal in cents — excludes shipping and tax, which are
   *  calculated later in Stripe Checkout. */
  subtotalCents: number;
  currency?: string;
  className?: string;
  testId?: string;
}

export function CostTransparencyCallout({
  subtotalCents,
  currency = "usd",
  className = "",
  testId,
}: Props) {
  // Render nothing for empty carts so the placeholder doesn't
  // appear on the marketing surface during cart hydration.
  if (subtotalCents <= 0) return null;
  return (
    <div
      className={`rounded-xl border border-[hsl(var(--penn-navy)/0.18)] bg-[hsl(var(--penn-navy)/0.04)] p-4 ${className}`}
      data-testid={testId ?? "cost-transparency-callout"}
    >
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-[hsl(var(--penn-navy)/0.10)] flex items-center justify-center shrink-0">
          <Receipt className="w-5 h-5 text-[hsl(var(--penn-navy))]" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-2 flex-wrap">
            <p className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
              Subtotal (before shipping &amp; tax)
            </p>
            <span
              className="text-sm font-semibold tabular-nums"
              data-testid="cost-transparency-cash"
            >
              {formatMoneyCents(subtotalCents, currency)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
            We&apos;ll email you an itemized receipt that&apos;s eligible for
            HSA, FSA, and most insurance reimbursement plans. If you&apos;d
            rather have us bill insurance directly,{" "}
            <Link
              href="/insurance"
              className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
              data-testid="cost-transparency-insurance-link"
            >
              start the insurance flow
              <ArrowRight className="inline-block w-3 h-3 ml-0.5 align-middle" />
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  );
}
