import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Settings2,
  Gauge,
  Activity,
  HeartPulse,
  Wind,
  CheckCircle2,
  ShoppingBag,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type TherapyMode = {
  abbrev: string;
  full: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  oneLiner: string;
  body: string;
  whoFor: string[];
  examples: string;
  flagship?: boolean;
};

const modes: TherapyMode[] = [
  {
    abbrev: "CPAP",
    full: "Continuous Positive Airway Pressure",
    Icon: Gauge,
    oneLiner: "One fixed pressure, all night.",
    body: "The original therapy — the machine delivers a single prescribed pressure continuously. Simple, reliable, and clinically validated longer than any other mode. Often the most affordable, and a great fit when a sleep study found a single pressure that worked.",
    whoFor: [
      "Straightforward moderate OSA",
      "Stable pressure requirements",
      "Patients who don't want auto-adjust complexity",
      "Tightest cash-pay budgets",
    ],
    examples: "ResMed AirSense 11 CPAP · React Health Luna G3 CPAP",
  },
  {
    abbrev: "APAP",
    full: "Auto-titrating Positive Airway Pressure",
    Icon: Activity,
    oneLiner: "Adjusts pressure on the fly within a prescribed range.",
    body: "The most commonly prescribed mode today. The machine starts at a low pressure and ramps up only when it detects events — apneas, hypopneas, or flow limitations. Pressure drops back down once breathing is stable, which most patients find more comfortable than fixed CPAP.",
    whoFor: [
      "Most newly diagnosed adult OSA patients",
      "Pressure needs that vary by sleep stage or position",
      "Patients who didn't tolerate a higher fixed CPAP pressure",
      "Anyone who wants the machine to do the titration work",
    ],
    examples: "ResMed AirSense 11 AutoSet · React Health Luna G3 Auto",
    flagship: true,
  },
  {
    abbrev: "BiPAP",
    full: "Bilevel Positive Airway Pressure",
    Icon: HeartPulse,
    oneLiner: "Two pressures — higher on inhale, lower on exhale.",
    body: "Delivers a higher pressure when you inhale (IPAP) and a lower one when you exhale (EPAP). The gap makes therapy noticeably more comfortable at high pressures, helps patients who struggle to exhale against CPAP, and is the right answer for many BiPAP-dependent conditions.",
    whoFor: [
      "Pressures above 15 cmH₂O",
      "COPD with concurrent OSA",
      "Patients who couldn't tolerate CPAP exhalation",
      "Neuromuscular conditions affecting breathing effort",
    ],
    examples: "ResMed AirCurve 11 · Philips Respironics DreamStation BiPAP",
  },
  {
    abbrev: "ASV",
    full: "Adaptive Servo-Ventilation",
    Icon: Wind,
    oneLiner: "Algorithmic mode for central and complex sleep apnea.",
    body: "An advanced bilevel device that actively senses each breath and intervenes when your breathing pattern becomes irregular. Designed for central sleep apnea, Cheyne-Stokes respiration, and treatment-emergent (complex) sleep apnea — conditions where simpler therapies fail.",
    whoFor: [
      "Central sleep apnea (CSA)",
      "Cheyne-Stokes respiration",
      "Treatment-emergent / complex sleep apnea",
      "Always prescribed and monitored by a sleep specialist",
    ],
    examples: "ResMed AirCurve 11 ASV",
  },
];

export function LearnTherapyTypes() {
  useDocumentTitle(
    "CPAP vs APAP vs BiPAP vs ASV",
    "The four common PAP therapy modes explained — what each does, who it's prescribed for, and how your doctor picks between them.",
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
        <span className="text-foreground/85">Therapy types compared</span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Equipment · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          CPAP, APAP, BiPAP, ASV — explained.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Four acronyms, one therapy family. The difference between them is how
          the machine decides what pressure to deliver, when. Most adults end up
          on APAP today — but the right mode depends entirely on what your sleep
          study found.
        </p>
      </header>

      {/* Quick comparison table */}
      <section className="w-full mb-12">
        <div className="hidden md:block glass-card rounded-2xl p-2 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="text-left p-4 font-semibold">Mode</th>
                <th className="text-left p-4 font-semibold">Pressure logic</th>
                <th className="text-left p-4 font-semibold">Most common use</th>
                <th className="text-left p-4 font-semibold">Cost tier</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border/30">
                <td className="p-4 font-semibold">CPAP</td>
                <td className="p-4 text-muted-foreground">
                  One fixed pressure
                </td>
                <td className="p-4 text-muted-foreground">
                  Stable moderate OSA
                </td>
                <td className="p-4">
                  <Badge
                    variant="outline"
                    className="chip-tier-budget border-0"
                  >
                    Budget
                  </Badge>
                </td>
              </tr>
              <tr className="border-t border-border/30 bg-[hsl(var(--penn-gold-soft))]/30">
                <td className="p-4 font-semibold">
                  APAP{" "}
                  <Badge
                    variant="outline"
                    className="ml-1 text-[10px] chip-tier-premium border-0"
                  >
                    Most prescribed
                  </Badge>
                </td>
                <td className="p-4 text-muted-foreground">
                  Auto-adjusts within range
                </td>
                <td className="p-4 text-muted-foreground">
                  Most new diagnoses
                </td>
                <td className="p-4">
                  <Badge
                    variant="outline"
                    className="chip-tier-standard border-0"
                  >
                    Standard
                  </Badge>
                </td>
              </tr>
              <tr className="border-t border-border/30">
                <td className="p-4 font-semibold">BiPAP</td>
                <td className="p-4 text-muted-foreground">
                  Two pressures (in/out)
                </td>
                <td className="p-4 text-muted-foreground">
                  High pressures, COPD overlap
                </td>
                <td className="p-4">
                  <Badge
                    variant="outline"
                    className="chip-tier-premium border-0"
                  >
                    Premium
                  </Badge>
                </td>
              </tr>
              <tr className="border-t border-border/30">
                <td className="p-4 font-semibold">ASV</td>
                <td className="p-4 text-muted-foreground">
                  Algorithmic per-breath
                </td>
                <td className="p-4 text-muted-foreground">
                  Central / complex apnea
                </td>
                <td className="p-4">
                  <Badge
                    variant="outline"
                    className="chip-tier-premium border-0"
                  >
                    Premium
                  </Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        {/* Mobile fallback */}
        <div className="md:hidden text-sm text-muted-foreground italic px-2">
          Quick comparison below — tap each mode for details.
        </div>
      </section>

      {/* Per-mode deep dives */}
      <section className="w-full mb-12 space-y-5">
        {modes.map((m) => (
          <article
            key={m.abbrev}
            className={
              m.flagship
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {m.flagship && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4 mb-4">
                <div
                  className={`relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${
                    m.flagship ? "icon-halo-gold" : "icon-halo-navy"
                  }`}
                >
                  <m.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2 mb-1">
                    <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                      {m.abbrev}
                    </h2>
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
                      {m.full}
                    </span>
                    {m.flagship && (
                      <Badge
                        variant="outline"
                        className="chip-tier-premium border-0 ml-auto"
                      >
                        Most prescribed
                      </Badge>
                    )}
                  </div>
                  <p className="text-base font-medium text-foreground/85 mb-3">
                    {m.oneLiner}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {m.body}
                  </p>
                </div>
              </div>

              <div className="grid md:grid-cols-2 gap-4 mt-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Typically prescribed for
                  </div>
                  <ul className="space-y-1.5">
                    {m.whoFor.map((w) => (
                      <li
                        key={w}
                        className="flex items-start gap-2 text-xs text-foreground/85"
                      >
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                          strokeWidth={2.5}
                        />
                        <span>{w}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Common machines
                  </div>
                  <p className="text-xs text-foreground/85 leading-relaxed">
                    {m.examples}
                  </p>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* How does your doctor pick */}
      <section className="w-full mb-12">
        <div className="glass-panel rounded-2xl p-6 md:p-7">
          <div className="flex items-center gap-3 mb-4">
            <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
              <Settings2 className="w-5 h-5" strokeWidth={2} />
            </div>
            <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
              How your doctor picks the mode.
            </h2>
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed mb-3">
            The decision rests on three pieces of information: your sleep study
            results (AHI, central event count, baseline oxygen), comorbidities
            (COPD, heart failure, neuromuscular disease), and a titration —
            either in-lab or via an auto-adjusting trial.
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            In practice: most newly diagnosed adults start on APAP because the
            auto-adjustment effectively builds in the titration step. BiPAP and
            ASV are reserved for cases where APAP fails or where specific
            clinical criteria are present from day one.
          </p>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/therapy-types"
          title="CPAP vs APAP vs BiPAP vs ASV — what the four modes do differently"
          blurb="Quick reference if you or someone you know is trying to understand the alphabet soup of PAP therapy machines."
          testIdPrefix="share-therapy-types"
        />
      </div>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/how-pap-works"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Wind className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              How PAP therapy actually works
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The mechanism, the pressure, the numbers your machine tracks every
              night.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/shop"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <ShoppingBag className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Shop PAP machines
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Browse the CPAP, APAP, BiPAP, and accessory inventory PennPaps
              stocks today.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="therapy-types-bottom-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Therapy mode is a prescription — your sleep
        medicine provider chooses between CPAP, APAP, BiPAP, and ASV based on
        your individual diagnosis and titration.
      </p>
    </div>
  );
}
