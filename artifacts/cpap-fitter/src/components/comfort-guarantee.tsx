import React from "react";
import { Link } from "wouter";
import { ShieldCheck, BadgeCheck, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 30-day comfort guarantee surface. Mask fit is the single largest
 * source of new-customer anxiety in CPAP — most patients have been
 * burned by an off-the-shelf mask that didn't fit. Surfacing the
 * guarantee at every decision point (recommendation, cart, checkout
 * success, product detail) reduces abandonment far more than it
 * increases swap volume.
 *
 * Three render modes:
 *   * <ComfortGuarantee variant="badge" />    — small inline pill
 *     (mask cards, results page, cart line items).
 *   * <ComfortGuarantee variant="callout" />  — boxed reassurance
 *     above the primary CTA (cart subtotal, product hero).
 *   * <ComfortGuarantee variant="feature" />  — large card for the
 *     order-success / checkout-success "what happens next" section.
 *
 * The link target is the dedicated /comfort-guarantee page (added
 * alongside this component) rather than a generic /faq anchor —
 * patients who click are explicitly looking for the policy details
 * and we don't want them to bounce on a faq scroll-hunt.
 */

export type ComfortGuaranteeVariant = "badge" | "callout" | "feature";

interface ComfortGuaranteeProps {
  variant?: ComfortGuaranteeVariant;
  className?: string;
  /** When true, the entire surface is a link to the policy page. */
  linkToPolicy?: boolean;
  testId?: string;
}

export function ComfortGuarantee({
  variant = "badge",
  className = "",
  linkToPolicy = true,
  testId,
}: ComfortGuaranteeProps) {
  if (variant === "badge") {
    const inner = (
      <span
        className={`inline-flex items-center gap-1.5 rounded-full border border-[hsl(var(--penn-gold)/0.5)] bg-[hsl(var(--penn-gold)/0.10)] px-2.5 py-1 text-xs font-semibold text-[hsl(var(--penn-navy))] ${className}`}
        data-testid={testId ?? "comfort-guarantee-badge"}
      >
        <BadgeCheck className="w-3.5 h-3.5 text-[hsl(var(--penn-gold))]" />
        30-day fit guarantee
      </span>
    );
    return linkToPolicy ? (
      <Link
        href="/comfort-guarantee"
        className="no-underline focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-gold))]/40 rounded-full"
      >
        {inner}
      </Link>
    ) : (
      inner
    );
  }

  if (variant === "callout") {
    return (
      <div
        className={`rounded-xl border border-[hsl(var(--penn-gold)/0.4)] bg-[hsl(var(--penn-gold)/0.06)] p-4 ${className}`}
        data-testid={testId ?? "comfort-guarantee-callout"}
      >
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-[hsl(var(--penn-gold)/0.18)] flex items-center justify-center shrink-0">
            <ShieldCheck className="w-5 h-5 text-[hsl(var(--penn-gold))]" />
          </div>
          <div className="flex-1 text-sm">
            <p className="font-semibold text-[hsl(var(--penn-navy))]">
              30-day fit guarantee
            </p>
            <p className="text-muted-foreground mt-0.5">
              If your mask doesn&apos;t fit comfortably, swap it for a different
              size or style within 30 days — we cover the return shipping.{" "}
              {linkToPolicy && (
                <Link
                  href="/comfort-guarantee"
                  className="font-medium text-[hsl(var(--penn-navy))] underline-offset-2 hover:underline"
                >
                  See how it works
                </Link>
              )}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // feature
  return (
    <div
      className={`rounded-2xl border bg-gradient-to-br from-[hsl(var(--penn-gold)/0.08)] to-[hsl(var(--penn-navy)/0.05)] p-6 sm:p-8 ${className}`}
      data-testid={testId ?? "comfort-guarantee-feature"}
    >
      <div className="flex items-start gap-4">
        <div className="w-12 h-12 rounded-2xl icon-halo-gold flex items-center justify-center shrink-0">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <div className="flex-1">
          <h3 className="text-xl font-semibold tracking-tight">
            30-day comfort guarantee
          </h3>
          <p className="text-muted-foreground mt-1.5">
            Most masks feel different the first night. If yours isn&apos;t
            comfortable after a week of trying, contact us and we&apos;ll send a
            different size or style — and cover return shipping. No
            restocking fee, no hassle.
          </p>
          {linkToPolicy && (
            <div className="mt-4">
              <Link href="/comfort-guarantee">
                <Button variant="outline" data-testid="button-cta-guarantee">
                  How the guarantee works
                  <ArrowRight className="w-4 h-4 ml-1" />
                </Button>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
