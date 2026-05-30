import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  TrendingDown,
  Apple,
  Activity,
  Scale,
  HeartPulse,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Mechanism = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
};

const mechanisms: Mechanism[] = [
  {
    Icon: Apple,
    title: "Hunger hormones rebalance",
    body: "Sleep fragmentation flips the leptin/ghrelin ratio — you wake up wired hungrier than you should be, with stronger cravings for fast carbs. Consolidated sleep on CPAP restores normal appetite signaling within weeks for most patients.",
  },
  {
    Icon: Activity,
    title: "Daytime energy enables exercise",
    body: "Untreated OSA patients often blame poor exercise tolerance on age, weight, or lack of motivation. The real cause is often a chronically under-rested cardiovascular system. Patients consistently report easier workouts and better recovery within 4-8 weeks on therapy.",
  },
  {
    Icon: Scale,
    title: "Cortisol drops",
    body: "Repeated overnight sympathetic surges keep daytime cortisol elevated. Cortisol drives central (belly) fat storage and resists weight loss. Adherent CPAP normalizes the diurnal cortisol curve, removing one of the most stubborn metabolic headwinds.",
  },
  {
    Icon: HeartPulse,
    title: "Insulin sensitivity improves",
    body: "Better glucose handling means more of what you eat gets used as energy instead of stored as fat. Patients in cohort studies see fasting insulin drop measurably within the first quarter on adherent therapy.",
  },
];

export function LearnCpapAndWeightLoss() {
  useDocumentTitle(
    "CPAP and weight loss — the bidirectional link",
    "Untreated sleep apnea makes weight loss measurably harder. Treating it doesn't burn calories directly — but it removes the metabolic and behavioral headwinds that prevented your other efforts from working.",
    { schema: "MedicalWebPage" },
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">CPAP &amp; weight loss</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Living with therapy · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Why dieting hasn&apos;t worked.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Sleep apnea and weight have a circular relationship — extra weight
          worsens apnea, untreated apnea makes weight loss measurably harder.
          CPAP doesn&apos;t burn calories. What it does is remove the metabolic
          and behavioral headwinds that were sabotaging every weight-loss effort
          you&apos;ve made.
        </p>
      </header>

      {/* Reframe the myth */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                A quick reframe.
              </h2>
            </div>
            <p className="text-base text-foreground/90 leading-relaxed font-medium mb-3">
              CPAP isn&apos;t a weight-loss intervention. It&apos;s a
              metabolic-conditions intervention that makes weight loss
              meaningfully achievable for the first time.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Patients commonly say they&apos;d been trying to lose weight for
              years with mediocre results. After starting CPAP, the same efforts
              start working. The diet is the same; the body has finally stopped
              fighting it.
            </p>
          </div>
        </div>
      </section>

      {/* The four mechanisms */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <TrendingDown className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Four ways therapy moves the needle.
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {mechanisms.map((m) => (
            <article key={m.title} className="glass-card rounded-2xl p-5">
              <div className="relative h-10 w-10 rounded-lg flex items-center justify-center mb-3 icon-halo-gold">
                <m.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-base font-bold tracking-tight mb-2">
                {m.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {m.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Realistic expectations */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The realistic numbers
            </div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-4">
              What to expect — and what not to.
            </h2>
            <div className="space-y-3 text-sm text-white/85 leading-relaxed">
              <p>
                <span className="font-semibold text-white">
                  CPAP alone, no diet change:
                </span>{" "}
                Most patients see modest weight stability or slight loss (0-5
                lbs) in the first six months — driven by appetite normalization
                and reduced midnight snacking, not by any direct caloric effect.
              </p>
              <p>
                <span className="font-semibold text-white">
                  CPAP + sustainable diet change:
                </span>{" "}
                The interventions compound. Patients combining adherent therapy
                with a moderate caloric deficit typically lose weight at 1.5–2×
                the rate they did before CPAP — same diet, different metabolic
                backdrop.
              </p>
              <p>
                <span className="font-semibold text-white">
                  CPAP + GLP-1 medication:
                </span>{" "}
                Increasingly common combination. Sleep apnea is one of the
                conditions GLP-1s like semaglutide and tirzepatide treat
                indirectly — but the apnea won&apos;t resolve from weight loss
                alone in most patients. Treat both concurrently.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Weight loss → apnea cure? */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Will losing weight make CPAP unnecessary?
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Sometimes — particularly for patients with primarily
                weight-driven OSA who lose 10%+ of their body weight. But
                don&apos;t plan around it. Most patients still need CPAP at a
                lower weight (anatomy matters more than the scale at the
                margin). If you do lose significant weight, ask your sleep
                doctor about a repeat study to confirm whether your prescription
                needs adjustment or whether therapy can be discontinued.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What to do */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <CheckCircle2 className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The honest playbook.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Treat both conditions concurrently. CPAP first; weight loss efforts continue or restart in parallel.",
            "Track your appetite changes in the first month — many patients notice reduced cravings before they notice anything else. That's the leptin/ghrelin normalization showing up.",
            "Don't crash diet during the first month on CPAP. Establish the therapy routine first; layer dietary change in once nightly wear is automatic.",
            "If you're on a GLP-1 or considering one, mention it to your sleep doctor — interactions are minimal but they'll want it in the chart.",
            "Re-evaluate at 6-12 months. If you've lost meaningful weight, repeat sleep study to confirm your apnea status and prescription.",
          ].map((step) => (
            <div
              key={step}
              className="flex items-start gap-3 glass-card rounded-xl p-4"
            >
              <CheckCircle2
                className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span className="text-sm text-foreground/85 leading-relaxed">
                {step}
              </span>
            </div>
          ))}
        </div>
      </section>

      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/cpap-and-weight-loss"
          title="CPAP and weight loss — the bidirectional link"
          blurb="Untreated sleep apnea makes weight loss measurably harder. CPAP doesn't burn calories — it removes the metabolic headwinds that sabotage every effort. Worth sharing with anyone frustrated by stalled progress."
          testIdPrefix="share-weight-loss"
        />
      </div>

      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-diabetes"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep apnea &amp; diabetes
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The companion article — same metabolic conditions, different
              clinical endpoint.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/sleep-hygiene"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep hygiene + CPAP
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Six habits that compound with therapy. Cool room, constant
              wake-time, no caffeine after 2pm.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> Treat both
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="weight-loss-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Weight-loss interventions — diet, exercise,
        GLP-1 medications, bariatric surgery — should be coordinated with your
        primary care or endocrinologist.
      </p>
    </div>
  );
}
