import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  HeartPulse,
  Brain,
  TrendingUp,
  Car,
  AlertTriangle,
  Sparkles,
  Stethoscope,
  Frown,
  Pill,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type RiskBlock = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  category: string;
  headline: string;
  body: string;
  data: string;
};

const risks: RiskBlock[] = [
  {
    Icon: HeartPulse,
    category: "Cardiovascular",
    headline: "The biggest preventable risk factor for hypertension.",
    body: "Every apnea event spikes blood pressure and floods the bloodstream with stress hormones. Over years, that load reshapes the heart. Untreated severe OSA roughly doubles stroke risk and significantly increases the odds of atrial fibrillation, heart failure, and heart attack — even after controlling for weight and other risk factors.",
    data: "2–3× stroke risk · 2.6× AFib risk",
  },
  {
    Icon: TrendingUp,
    category: "Metabolic",
    headline: "Insulin resistance, type 2 diabetes, weight gain.",
    body: "Fragmented sleep elevates cortisol and dysregulates the hormones that govern hunger (leptin, ghrelin) and glucose handling. People with untreated moderate-to-severe OSA are 2–3× more likely to develop type 2 diabetes — and find it harder to control if they already have it.",
    data: "A1C improves measurably on PAP therapy",
  },
  {
    Icon: Brain,
    category: "Cognitive",
    headline: "Memory, focus, and long-term brain health.",
    body: "Repeated oxygen desaturations and disrupted slow-wave sleep degrade memory consolidation overnight. Long-term, untreated sleep apnea is associated with significantly higher rates of mild cognitive impairment and Alzheimer-type dementia — onset roughly a decade earlier than matched controls in some studies.",
    data: "MRI changes appear in the hippocampus",
  },
  {
    Icon: Car,
    category: "Daily safety",
    headline: "2.5× the crash risk on the road.",
    body: "Untreated OSA roughly 2.5× the risk of motor-vehicle crashes — the same ballpark as legal-limit alcohol intoxication. The DOT recognizes this: commercial drivers diagnosed with moderate-to-severe OSA may not legally drive without documented PAP adherence.",
    data: "DOT-disqualifying without treatment",
  },
  {
    Icon: Frown,
    category: "Mental health",
    headline: "Depression, anxiety, irritability.",
    body: "Untreated OSA is independently associated with depression at roughly 2× the rate of matched non-OSA adults. Mood symptoms often improve within weeks of starting effective therapy — sometimes faster than antidepressants alone.",
    data: "PHQ-9 scores drop on PAP therapy",
  },
  {
    Icon: Pill,
    category: "Medication efficacy",
    headline: "Some drugs simply don't work as well.",
    body: "Resistant hypertension — blood pressure that won't come down on three or more medications — has a 70-80% sleep apnea co-prevalence. The medications aren't the problem; untreated OSA is undoing their work every night.",
    data: "70–80% co-prevalence in resistant HTN",
  },
];

export function LearnHealthRisks() {
  useDocumentTitle(
    "The hidden health costs of untreated sleep apnea",
    "What's at stake when sleep apnea goes untreated — cardiovascular, metabolic, cognitive, and daily-safety risks, with the data behind each.",
    { schema: "MedicalWebPage" },
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
        <span className="text-foreground/85">
          Health risks of untreated apnea
        </span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Why treatment matters · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The hidden cost of leaving it alone.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Untreated sleep apnea isn't just a sleep problem. It's a slow-burn
          cardiovascular, metabolic, and cognitive risk — and one of the few
          that's genuinely reversible with consistent therapy. Here's what the
          data actually says.
        </p>
      </header>

      {/* Quick stat row */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-6 p-7 md:p-9 text-center">
            {[
              { stat: "30M+", label: "US adults with OSA" },
              { stat: "80%", label: "undiagnosed" },
              { stat: "2.5×", label: "drowsy-driving crash risk" },
              { stat: "2–3×", label: "stroke risk untreated" },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-display text-3xl md:text-4xl font-bold text-white mb-1">
                  {s.stat}
                </div>
                <div className="text-xs uppercase tracking-wider text-white/70">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Risk cards */}
      <section className="w-full mb-12 space-y-5">
        {risks.map((r) => (
          <article
            key={r.category}
            className="glass-card rounded-2xl p-6 md:p-7"
          >
            <div className="flex items-start gap-4">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <r.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))]">
                    {r.category}
                  </div>
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-muted-foreground">
                    {r.data}
                  </div>
                </div>
                <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90 mb-2">
                  {r.headline}
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {r.body}
                </p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* The hopeful close */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                Most of this is reversible.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-4">
              The remarkable thing about every risk on this page is that
              consistent PAP therapy{" "}
              <span className="font-semibold text-foreground/90">
                meaningfully reverses or reduces it
              </span>{" "}
              in months, not years. Blood pressure begins to drop within weeks.
              A1C trends down by the first quarterly check. Cognitive and mood
              scores recover. Crash risk falls back to baseline.
            </p>
            <p className="text-muted-foreground leading-relaxed mb-2">
              The biggest predictor of whether someone gets those benefits is
              simply <span className="font-semibold">comfort</span> — whether
              the mask is wearable enough to use every night. That's the whole
              reason PennPaps exists.
            </p>
          </div>
        </div>
      </section>

      {/* Share affordance */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/health-risks"
          title="The hidden cost of leaving sleep apnea alone"
          blurb="I just read this — worth a few minutes if you or someone you love snores. The risks add up faster than most people realize, and they're reversible."
          testIdPrefix="share-health-risks"
        />
      </div>

      {/* Disclaimer + warning callout */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div className="text-sm text-foreground/85 leading-relaxed">
              <span className="font-semibold">A word of caution:</span> the
              statistics above are population-level. Your individual risk
              depends on apnea severity (AHI), how long you've had it, your
              overall cardiovascular profile, and other factors. Talk to your
              physician before drawing any personal conclusion — and don't stop
              or change any medication based on a single article.
            </div>
          </div>
        </div>
      </section>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/pap-therapy-benefits"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              What treatment actually feels like
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The benefits of PAP therapy, week by week. The good news side of
              this article.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Am I at risk?
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The validated STOP-BANG screener — eight questions, two minutes,
              clear next step.
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
          data-testid="health-risks-bottom-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice. Sources include the
        American Academy of Sleep Medicine, AHA scientific statements on OSA,
        and peer-reviewed literature. Specific numbers vary by study population;
        the magnitudes cited reflect commonly-reported ranges.
      </p>
    </div>
  );
}
