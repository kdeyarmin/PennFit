// Trust-signal strip — five compact badges of social proof and
// reassurance, rendered just under the home-page hero. The ★ rating
// + review count comes live from /shop/reviews/site-aggregate; the
// other badges are static brand promises that already appear (in
// long form) on /insurance, /comfort-guarantee, and the footer.
//
// The strip self-hides if the live aggregate request fails or the
// shop has zero approved reviews — better to show four trust badges
// than four trust badges plus a dishonest "0.0★ from 0 reviews"
// chip.

import React, { useEffect, useState } from "react";
import { ShieldCheck, RefreshCw, PackageCheck, Star } from "lucide-react";
import { getShopReviewsSiteAggregate } from "@/lib/shop-api";

interface Aggregate {
  count: number;
  averageRating: number;
}

export function TrustSignalStrip() {
  const [agg, setAgg] = useState<Aggregate | null>(null);

  useEffect(() => {
    let cancelled = false;
    getShopReviewsSiteAggregate()
      .then((r) => {
        if (!cancelled) setAgg(r);
      })
      .catch(() => {
        // Silent fallback — strip just renders without the rating
        // chip if the API hiccups. Marketing surface, not a
        // critical path.
        if (!cancelled) setAgg(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const showRating = agg !== null && agg.count > 0;

  const items: Array<{
    Icon: React.ComponentType<{ className?: string }>;
    label: React.ReactNode;
    testid: string;
  }> = [
    {
      Icon: ShieldCheck,
      label: "Medicare & most major plans",
      testid: "trust-insurance",
    },
    {
      Icon: RefreshCw,
      label: "60-day comfort guarantee",
      testid: "trust-guarantee",
    },
    {
      Icon: PackageCheck,
      label: "Ships in 1–3 business days",
      testid: "trust-shipping",
    },
  ];

  return (
    <div
      className="w-full max-w-5xl mx-auto mb-12 md:mb-16"
      data-testid="trust-signal-strip"
    >
      <div className="glass-panel rounded-2xl px-4 py-3 md:px-6 md:py-4 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs sm:text-sm">
        {items.map(({ Icon, label, testid }) => (
          <span
            key={testid}
            className="inline-flex items-center gap-2 text-muted-foreground"
            data-testid={testid}
          >
            <Icon
              className="w-4 h-4 text-[hsl(var(--penn-navy))]/80"
              aria-hidden="true"
            />
            <span className="font-medium text-foreground/90">{label}</span>
          </span>
        ))}
        {showRating && (
          <span
            className="inline-flex items-center gap-1.5 text-muted-foreground"
            data-testid="trust-rating"
          >
            <Star
              className="w-4 h-4 fill-[hsl(var(--penn-gold))] text-[hsl(var(--penn-gold))]"
              aria-hidden="true"
            />
            <span className="font-semibold text-foreground/90 tabular-nums">
              {agg!.averageRating.toFixed(1)}
            </span>
            <span className="tabular-nums">
              from {agg!.count} customer{agg!.count === 1 ? "" : "s"}
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
