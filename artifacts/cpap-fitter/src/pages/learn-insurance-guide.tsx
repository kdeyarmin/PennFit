import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  ShieldCheck,
  CreditCard,
  Wallet,
  Building2,
  FileText,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Calculator,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Payer = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  name: string;
  oneLiner: string;
  body: string;
  covered: string[];
  watchOut: string;
};

const payers: Payer[] = [
  {
    Icon: Building2,
    name: "Medicare",
    oneLiner: "Covered after a 3-month compliance trial.",
    body: "Medicare Part B covers CPAP machines, masks, and supplies for patients with a documented OSA diagnosis. The first 3 months are a 'compliance trial' — your usage data is reviewed to confirm you meet the adherence threshold (≥4 hours/night on 70% of nights). After that, the machine is rented for 13 months total and then transfers to you.",
    covered: [
      "Machine (13-month rental, then transfer of ownership)",
      "Mask + headgear (replacement every 6 months)",
      "Cushions / nasal pillows (every 2 weeks–3 months by type)",
      "Tubing (every 3 months)",
      "Filters (monthly disposables, every 6 months reusable)",
      "Humidifier chamber (every 6 months)",
    ],
    watchOut:
      "If you fall below the adherence threshold during the trial, Medicare can deny ongoing coverage. We surveil this proactively and contact you before that happens.",
  },
  {
    Icon: Building2,
    name: "Medicaid",
    oneLiner:
      "State-by-state; broadly similar to Medicare but with state-specific quirks.",
    body: "Medicaid CPAP coverage exists in every state but the documentation requirements, prior authorization process, and replacement cadences vary considerably. Pennsylvania Medicaid covers CPAP for diagnosed OSA with limited copay; some states require additional clinical notes or face-to-face evaluations.",
    covered: [
      "Coverage roughly mirrors Medicare in most states",
      "Some states have additional prior-auth steps",
      "Replacement cadences set at the state level",
      "PA Medicaid: standard cushion + filter + tubing schedule",
    ],
    watchOut:
      "If you have dual Medicare + Medicaid eligibility, Medicare bills primary and Medicaid covers the remaining copay. Most patients pay $0 out of pocket.",
  },
  {
    Icon: Building2,
    name: "Commercial insurance",
    oneLiner: "Coverage is the rule; the variance is in the deductible.",
    body: "Most commercial plans — BCBS, Aetna, Cigna, United, the big regional plans — cover CPAP equipment under their DME benefit. The structural piece is whether you've met your deductible: a $500 mask before deductible is a $0 mask after deductible, on the same plan in the same year.",
    covered: [
      "Machine, mask, and supplies under DME benefit",
      "Most plans require prior authorization (we handle it)",
      "Replacement schedules typically mirror Medicare's",
      "Some plans rent-to-own; some purchase outright",
    ],
    watchOut:
      "Plans with high deductibles may make cash-pay competitive in the early months of the year. Run benefits before assuming insurance is the cheaper path.",
  },
  {
    Icon: Wallet,
    name: "HSA / FSA",
    oneLiner: "Yes, eligible. Don't sleep on this.",
    body: "Health Savings Accounts and Flexible Spending Accounts cover every CPAP-related expense — machines, masks, cushions, filters, tubing, distilled water, cleaning supplies. You can use your HSA/FSA card directly at checkout, or pay out of pocket and submit for reimbursement.",
    covered: [
      "All CPAP equipment and accessories",
      "Distilled water and cleaning supplies",
      "Replacement parts (no prescription required for FSA)",
      "Sleep study copays",
    ],
    watchOut:
      "FSA dollars don't roll over (most plans). Use them before year-end on supplies you'll need anyway — a year of cushions and filters wipes most balances cleanly.",
  },
  {
    Icon: CreditCard,
    name: "Cash-pay",
    oneLiner:
      "Transparent pricing. Sometimes cheaper than insurance after the math.",
    body: "Direct purchase without going through insurance. Useful when (a) your deductible is high and unmet, (b) you want a brand insurance won't cover, (c) the prior-auth paperwork is delaying urgent equipment, or (d) you don't have insurance. Every machine and supply we list is available cash-pay with transparent pricing.",
    covered: [
      "Everything we stock, no prior-auth required",
      "HSA/FSA card accepted at checkout",
      "Same-day fulfillment on in-stock items",
      "Returns under our 30-day comfort guarantee",
    ],
    watchOut:
      "Cash-pay forgoes insurance billing — we can't retroactively bill insurance after a cash sale. If you're unsure, call us to run benefits first; the comparison takes one minute.",
  },
];

export function LearnInsuranceGuide() {
  useDocumentTitle(
    "CPAP insurance & coverage guide",
    "How insurance works for CPAP — Medicare, Medicaid, commercial plans, HSA/FSA, and cash-pay. What's covered, what's required, and how to figure out which path is cheaper.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Breadcrumb */}
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Insurance & coverage</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Paying for it · 8 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The honest insurance guide.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          CPAP coverage isn&apos;t mysterious — but it&apos;s also not uniform.
          Five different paths exist, the cheapest one depends on your specific
          plan + deductible state, and most DMEs won&apos;t do the math with
          you. Here&apos;s how it actually works.
        </p>
      </header>

      {/* Hero stat */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9 text-center">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The good news first
            </div>
            <p className="text-xl md:text-2xl text-white leading-relaxed font-medium max-w-2xl mx-auto">
              Every major US insurer{" "}
              <span className="text-[hsl(var(--penn-gold))]">
                covers CPAP therapy
              </span>{" "}
              for diagnosed sleep apnea. The variance is in the deductible, the
              adherence rules, and the resupply cadence — not whether
              you&apos;re covered.
            </p>
          </div>
        </div>
      </section>

      {/* The five paths */}
      <section className="w-full mb-12 space-y-5">
        {payers.map((p, i) => (
          <article
            key={p.name}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4 mb-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <p.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90 mb-1.5">
                    {p.name}
                  </h2>
                  <p className="text-sm font-medium text-foreground/85">
                    {p.oneLiner}
                  </p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                {p.body}
              </p>
              <div className="space-y-3">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--penn-gold-deep))] mb-2">
                    What&apos;s covered
                  </div>
                  <ul className="space-y-1.5">
                    {p.covered.map((c) => (
                      <li
                        key={c}
                        className="flex items-start gap-2 text-xs text-foreground/85"
                      >
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                          strokeWidth={2.5}
                        />
                        <span>{c}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="rounded-xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                    <span className="text-xs text-foreground/85">
                      <span className="font-semibold">Watch out:</span>{" "}
                      {p.watchOut}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* What you'll need */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <FileText className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What insurance actually asks for.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          For prior authorization on a new machine, almost every plan wants the
          same four things. We handle this for you — but knowing what your sleep
          doctor needs to send is useful.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {[
            {
              title: "Face-to-face sleep evaluation note",
              body: "From your sleep medicine provider, within the last 12 months. Documents your symptoms and the rationale for testing.",
            },
            {
              title: "Sleep study report (PSG or HSAT)",
              body: "The full report — not just the AHI. Must show OSA diagnosis with an AHI threshold the plan recognizes (usually ≥5 with symptoms, ≥15 without).",
            },
            {
              title: "CPAP prescription with pressure / titration",
              body: "Specifies device type (CPAP / APAP / BiPAP), pressure setting or range, and any required features (humidifier, heated tube).",
            },
            {
              title: "Compliance documentation (rental period)",
              body: "Your machine reports usage data automatically. We monitor adherence and produce the report at the 90-day mark.",
            },
          ].map((d) => (
            <div key={d.title} className="glass-card rounded-2xl p-5">
              <h3 className="text-sm font-semibold tracking-tight mb-2 text-foreground/90">
                {d.title}
              </h3>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {d.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* The 4-hour rule */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <ShieldCheck className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                The 4-hour rule.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-3">
              The single most important insurance number you&apos;ll encounter
              is the{" "}
              <span className="font-semibold text-foreground/90">
                Medicare adherence threshold
              </span>{" "}
              — and most commercial plans use the same rule.
            </p>
            <p className="text-base font-semibold text-foreground/90 leading-relaxed mb-3">
              4+ hours/night on 70% of nights, across any rolling 30-day window.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Hit it and you keep coverage. Miss it during your initial 90-day
              trial and insurance can deny ongoing rental coverage, billing you
              back for the machine. We track this for you and call before it
              happens — the data is sent from your CPAP modem to us nightly.
            </p>
          </div>
        </div>
      </section>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/insurance/estimate"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Calculator className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Estimate your benefits
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Plug in your plan; we run a real benefit estimate in under a
              minute.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/glossary"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Insurance terms glossary
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Prior auth, allowable, DME, deductible — defined plainly.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/insurance-guide"
          title="The honest CPAP insurance & coverage guide"
          blurb="Five payment paths for CPAP — Medicare, Medicaid, commercial, HSA/FSA, cash-pay. What's covered, what's required, and which is cheaper depending on where your deductible sits."
          testIdPrefix="share-insurance"
        />
      </div>

      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> When you&apos;re ready
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="insurance-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not benefit verification. The honest benefit
        number for your specific plan, deductible state, and diagnosis code
        comes from running benefits live, which we&apos;re happy to do over the
        phone in five minutes.
      </p>
    </div>
  );
}
