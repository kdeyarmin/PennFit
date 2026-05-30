import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Sparkles,
  AlertTriangle,
  Stethoscope,
  Brain,
  HeartPulse,
  Building2,
  Pill,
  Users,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Topic = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
};

const topics: Topic[] = [
  {
    Icon: Brain,
    title: "Cognitive decline & dementia risk",
    body: "Untreated OSA in older adults is associated with significantly higher rates of mild cognitive impairment and Alzheimer-type dementia — sometimes onset a decade earlier than matched controls. Adherent therapy can slow this trajectory and, in some cases, improve cognitive scores measurably. The fix-it window is now, not later.",
  },
  {
    Icon: HeartPulse,
    title: "Cardiovascular & falls risk",
    body: "Older patients with OSA have higher rates of stroke, atrial fibrillation, heart failure, and nighttime falls. Repeated overnight blood pressure surges and unrefreshing sleep both contribute. Treatment moves the cardiovascular needle here even more than it does in middle-aged patients.",
  },
  {
    Icon: Pill,
    title: "Polypharmacy & sedative interactions",
    body: "Sedatives, benzodiazepines, opioids, and many sleep aids worsen OSA by relaxing the upper airway further. Older adults are commonly on one or more of these — and the medications are often blamed for daytime fog when the OSA they're worsening is the real driver. Talk to your physician about reviewing the full medication list with sleep apnea in mind.",
  },
  {
    Icon: Building2,
    title: "Medicare & coverage",
    body: "Medicare Part B covers CPAP machines, masks, and replacement supplies with the same compliance trial used for younger adults — ≥4 hours/night on 70% of nights. Medicare and Medicaid dual-eligibility patients typically pay $0 out of pocket. The /learn/insurance-guide article walks through the specifics.",
  },
];

export function LearnSleepApneaSeniors() {
  useDocumentTitle(
    "Sleep apnea in older adults",
    "OSA prevalence rises sharply with age — and the cognitive, cardiovascular, and falls implications are bigger in seniors. Treatment matters more, not less, as you age.",
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
        <span className="text-foreground/85">Sleep apnea in older adults</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Special populations · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Sleep apnea in older adults.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          OSA prevalence climbs steadily with age — by 65, somewhere between{" "}
          <span className="font-semibold text-foreground">
            25% and 50% of adults
          </span>{" "}
          meet criteria for at least mild OSA. And in older patients, treatment
          matters more than ever: untreated apnea contributes to cognitive
          decline, falls, atrial fibrillation, and heart failure in ways that
          are reversible with adherent therapy.
        </p>
      </header>

      {/* Stat banner */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-3 gap-6 p-7 md:p-9 text-center">
            {[
              { stat: "25-50%", label: "OSA prevalence in adults 65+" },
              { stat: "~2×", label: "dementia risk untreated" },
              { stat: "$0", label: "typical Medicare cost on adherence" },
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

      {/* Reframe — it's not "just getting older" */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                Not &ldquo;just getting older.&rdquo;
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-3">
              Daytime fatigue, brain fog, frequent nighttime bathroom trips,
              morning headaches, and unrefreshing sleep are not normal parts of
              aging — even when they&apos;re common in your peer group. The most
              likely single explanation in an adult over 60 is undiagnosed sleep
              apnea.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              The reason older adults are often told otherwise is that the
              symptoms look similar to what people <em>expect</em> from aging. A
              sleep study (often a home test) is the only way to actually find
              out.
            </p>
          </div>
        </div>
      </section>

      {/* Four topics */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Stethoscope className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What&apos;s specifically different at 65+.
          </h2>
        </div>
        <div className="space-y-4">
          {topics.map((t) => (
            <article key={t.title} className="glass-card rounded-2xl p-6">
              <div className="flex items-start gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <t.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base md:text-lg font-bold tracking-tight text-foreground/90 mb-2">
                    {t.title}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {t.body}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Caregiver section */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <Users className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                If you&apos;re caring for a parent or partner
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed mb-3">
                Caregivers notice the snoring, the witnessed pauses, and the
                daytime changes long before the patient does. Take a one-minute
                audio recording of a typical night of sleeping and bring it to
                the next primary care visit — this is often the catalyst that
                gets a sleep study ordered.
              </p>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Once therapy starts, your role becomes mostly logistical —
                refilling distilled water, helping with the daily cushion wipe,
                and being the second set of eyes on cushion fit and skin
                integrity. Most older adults adapt to CPAP just as well as
                younger patients given the support and the right mask.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Practical pathway */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Your pathway forward.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Bring this article (or the symptoms it describes) to your next primary care visit and ask specifically about a sleep study.",
            "Most older patients get a home sleep apnea test first — much easier than an overnight in a lab.",
            "If diagnosed, your sleep specialist will prescribe either CPAP or APAP. APAP is more comfortable for most patients and is what we recommend most often.",
            "Medicare covers the machine, mask, headgear, and replacement supplies on a defined schedule. We handle all the billing.",
            "Give the adjustment a full month. Older patients sometimes need slightly more time and mask iteration, but our adherence rates in this population match the overall cohort.",
          ].map((step, i) => (
            <div
              key={step}
              className="flex items-start gap-3 glass-card rounded-xl p-4"
            >
              <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] pt-1 shrink-0 w-6">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-sm text-foreground/85 leading-relaxed">
                {step}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/sleep-apnea-seniors"
          title="Sleep apnea in older adults — what's specifically different"
          blurb="OSA prevalence in adults 65+ is 25-50%, the cognitive and cardiovascular stakes are higher, and Medicare covers it. Share with anyone caring for a parent who snores or seems foggier than they used to."
          testIdPrefix="share-seniors"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/insurance-guide"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Building2 className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Insurance &amp; Medicare guide
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Exactly what Medicare covers, the 4-hour adherence rule, and how
              supplies are billed.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/sleep-apnea-heart-health"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <HeartPulse className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep apnea &amp; your heart
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The cardiology connection — HTN, AFib, stroke, heart failure.
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
          <AlertTriangle className="w-3 h-3 mr-1.5" /> Medicare friendly
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="seniors-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Talk to your primary care physician about
        medications that could be worsening sleep apnea — don&apos;t stop or
        change any prescriptions on your own.
      </p>
    </div>
  );
}
