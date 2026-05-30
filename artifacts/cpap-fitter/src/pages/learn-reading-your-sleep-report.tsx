import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  FileText,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Activity,
  Gauge,
  HeartPulse,
  ClipboardList,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Metric = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  abbr: string;
  full: string;
  normal: string;
  body: string;
  watchFor: string;
};

const metrics: Metric[] = [
  {
    Icon: Activity,
    abbr: "AHI",
    full: "Apnea-Hypopnea Index",
    normal: "< 5/hr",
    body: "The headline number. Counts apneas (full breathing pauses ≥10 sec) plus hypopneas (≥30% airflow reduction) per hour of sleep. Severity bands: 5–15 mild, 15–30 moderate, ≥30 severe.",
    watchFor:
      "An AHI of 4.9 isn't a clean negative if you have classic symptoms — borderline numbers with daytime sleepiness, partner-reported pauses, or comorbid HTN/diabetes still warrant a treatment conversation.",
  },
  {
    Icon: Gauge,
    abbr: "RDI",
    full: "Respiratory Disturbance Index",
    normal: "< 5/hr",
    body: "AHI plus RERAs (Respiratory Effort-Related Arousals — subtle disturbances that don't meet hypopnea criteria but still fragment sleep). Some labs report this as the primary number; it tends to be slightly higher than the AHI.",
    watchFor:
      "If your AHI is 4 but your RDI is 12, you have meaningful sleep fragmentation that the AHI alone undercounts. Worth flagging to your sleep doctor.",
  },
  {
    Icon: HeartPulse,
    abbr: "ODI",
    full: "Oxygen Desaturation Index",
    normal: "< 5/hr",
    body: "How often your blood oxygen saturation drops by ≥3-4% per hour. Tracks closely with AHI but in some patients runs higher (suggesting more cardiovascular strain per event).",
    watchFor:
      "A high ODI with a borderline AHI argues for treatment more strongly than the AHI alone — the cardiovascular and cognitive risks scale with oxygen drops, not just event count.",
  },
  {
    Icon: AlertTriangle,
    abbr: "Lowest SpO₂",
    full: "Oxygen saturation nadir",
    normal: "> 89%",
    body: "The lowest oxygen reading recorded during the night. Healthy adults stay above 90% even in REM. Below 80% is a meaningful red flag for downstream cardiovascular risk.",
    watchFor:
      "Sustained time below 88% (T90, sometimes reported separately) is one of the strongest correlates with cardiovascular events in untreated OSA — your sleep doctor will weight this heavily.",
  },
  {
    Icon: ClipboardList,
    abbr: "Total Sleep Time",
    full: "TST",
    normal: "Adult: 6-9 hrs",
    body: "How much you actually slept during the study. Sleep efficiency (TST ÷ time in bed) is reported alongside; > 85% is normal. Low efficiency in a sleep lab is common (unfamiliar bed, wires) and doesn't usually mean you have insomnia.",
    watchFor:
      "If TST was under 4 hours, the AHI estimate is less reliable. Some labs will repeat the study; home tests sometimes oversample because they capture multiple nights.",
  },
  {
    Icon: Stethoscope,
    abbr: "Position / REM",
    full: "Positional and REM-related apnea",
    normal: "Variable",
    body: "Sleep labs note whether events cluster in REM sleep or in supine (on-your-back) sleep. Positional OSA can sometimes be treated with positional therapy alone; REM-predominant OSA argues for treating even at modest AHI because REM sleep matters disproportionately for memory and mood.",
    watchFor:
      "A normal supine AHI plus a high REM AHI is not a 'mild' diagnosis — REM-predominant OSA needs treatment.",
  },
];

export function LearnReadingYourSleepReport() {
  useDocumentTitle(
    "Reading your sleep study report",
    "What AHI, RDI, ODI, and the rest of your sleep study acronyms actually mean — and what numbers to ask your sleep doctor about specifically.",
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
        <span className="text-foreground/85">Reading your sleep report</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Foundations · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Your sleep report, decoded.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Sleep study reports are dense — three pages of acronyms, indices, and
          graphs with very little plain-English summary. Here&apos;s what each
          major number actually means, what the normal range is, and the
          specific patterns worth flagging to your sleep doctor.
        </p>
      </header>

      {/* Big banner — AHI severity bands */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The headline number · AHI severity bands
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-center">
              {[
                {
                  range: "< 5",
                  label: "Normal",
                  caption: "No treatment indicated absent symptoms",
                },
                {
                  range: "5-15",
                  label: "Mild",
                  caption: "Treat if symptomatic",
                },
                { range: "15-30", label: "Moderate", caption: "Treat" },
                {
                  range: "≥ 30",
                  label: "Severe",
                  caption: "Treat — high cardiovascular stakes",
                },
              ].map((b) => (
                <div key={b.label}>
                  <div className="text-display text-3xl font-bold text-white mb-1">
                    {b.range}
                  </div>
                  <div className="text-xs uppercase tracking-wider text-[hsl(var(--penn-gold))] mb-1">
                    {b.label}
                  </div>
                  <div className="text-[10px] text-white/70 leading-snug">
                    {b.caption}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Metrics */}
      <section className="w-full mb-12 space-y-4">
        {metrics.map((m, i) => (
          <article
            key={m.abbr}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4 mb-3">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <m.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                        {m.abbr}
                      </h2>
                      <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
                        {m.full}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-[hsl(var(--penn-gold-deep))]">
                      Normal: {m.normal}
                    </div>
                  </div>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-3">
                {m.body}
              </p>
              <div className="rounded-xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-3">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                  <p className="text-xs text-foreground/85 leading-relaxed">
                    <span className="font-semibold">Watch for: </span>
                    {m.watchFor}
                  </p>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* What to ask */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                Five questions for your sleep doctor.
              </h2>
            </div>
            <ol className="space-y-2">
              {[
                "What was my AHI in REM sleep specifically — and was it higher than my overall AHI?",
                "Did my oxygen saturation drop below 88% at any point, and for how long?",
                "Is my apnea primarily obstructive, central, or mixed?",
                "Was the AHI similar across positions, or did it cluster on my back?",
                "What pressure or pressure range are you prescribing, and why?",
              ].map((q) => (
                <li
                  key={q}
                  className="flex items-start gap-2.5 text-sm text-foreground/85 leading-relaxed"
                >
                  <CheckCircle2
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2.5}
                  />
                  <span>{q}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/reading-your-sleep-report"
          title="Reading your sleep study report"
          blurb="What AHI, RDI, ODI, T90, and the rest of your sleep study acronyms actually mean — and what to ask your sleep doctor about."
          testIdPrefix="share-sleep-report"
        />
      </div>

      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/glossary"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Full glossary
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Every CPAP and sleep apnea acronym, searchable A-Z.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/therapy-types"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Activity className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              CPAP vs APAP vs BiPAP vs ASV
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              How your report's findings map to the therapy mode you&apos;ll be
              prescribed.
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
          data-testid="sleep-report-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Sleep report interpretation is your sleep
        medicine provider&apos;s job — this article helps you ask better
        questions, not diagnose yourself.
      </p>
    </div>
  );
}
