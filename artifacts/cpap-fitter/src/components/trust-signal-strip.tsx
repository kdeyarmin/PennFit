// Trust-signal strip — compact badges of social proof and
// reassurance, rendered just under the home-page hero. Badges are
// static brand promises that already appear (in long form) on
// /consent (on-device privacy), /insurance, /comfort-guarantee, and
// the footer. The privacy badge surfaces the mask-fitter's on-device
// guarantee — images never leave the browser — as a headline marketing
// signal, not just consent-gate fine print.
//
// A live star-rating chip used to load from the public shop reviews
// aggregate. Reviews collection and that endpoint were retired when
// patient card checkout was removed (migration 0530 /
// DELIBERATELY_OFF_FLAGS). Static badges alone are honest; a silent
// 404 fetch is not.

import React from "react";
import { ShieldCheck, RefreshCw, PackageCheck, Lock } from "lucide-react";

export function TrustSignalStrip() {
  const items: Array<{
    Icon: React.ComponentType<{ className?: string }>;
    label: React.ReactNode;
    testid: string;
  }> = [
    {
      Icon: Lock,
      label: "Private by design — images never leave your device",
      testid: "trust-privacy",
    },
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
      </div>
    </div>
  );
}
