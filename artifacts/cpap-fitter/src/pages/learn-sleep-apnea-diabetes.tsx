import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Activity,
  Sparkles,
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  CheckCircle2,
  Stethoscope,
  Heart,
  Apple,
  Pill,
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
    Icon: TrendingUp,
    title: "Sympathetic surge & cortisol",
    body: "Every apnea event triggers an adrenaline-and-cortisol release that drives daytime insulin resistance. Hundreds of events a night compound the metabolic load.",
  },
  {
    Icon: Apple,
    title: "Leptin & ghrelin dysregulation",
    body: "Fragmented sleep flips the balance between leptin (satiety) and ghrelin (hunger). The result is increased appetite, carbohydrate cravings, and harder weight management.",
  },
  {
    Icon: Activity,
    title: "Inflammation",
    body: "Repeated oxygen desaturations generate oxidative stress and systemic inflammation. Both are independent drivers of insulin resistance.",
  },
  {
    Icon: Pill,
    title: "Medication efficacy",
    body: "Sleep apnea blunts the effect of metformin and many other glucose-lowering agents. Patients struggle to control A1C despite escalating therapy.",
  },
];

export function LearnSleepApneaDiabetes() {
  useDocumentTitle(
    "Sleep apnea and diabetes — the bidirectional link",
    "Sleep apnea and type 2 diabetes share a dense bidirectional relationship. Treating one improves control of the other. Here's the mechanism and the data.",
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
        <span className="text-foreground/85">Sleep apnea &amp; diabetes</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Comorbidities · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Sleep apnea and diabetes are the same problem.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Roughly{" "}
          <span className="font-semibold text-foreground">
            70% of patients with type 2 diabetes
          </span>{" "}
          have undiagnosed obstructive sleep apnea, and patients with OSA are
          2–3× more likely to develop type 2 diabetes over a decade.
          They&apos;re not two separate conditions — they&apos;re the same
          dysregulated metabolism, expressed at night and during the day.
        </p>
      </header>

      {/* Stat banner */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9 text-center">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The American Diabetes Association
            </div>
            <p className="text-xl md:text-2xl text-white leading-relaxed font-medium max-w-2xl mx-auto">
              The ADA Standards of Care now recommend{" "}
              <span className="text-[hsl(var(--penn-gold))]">
                screening for OSA in adults with type 2 diabetes
              </span>{" "}
              — particularly those with poor glycemic control or resistant
              hypertension.
            </p>
          </div>
        </div>
      </section>

      {/* The bidirectional loop */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Activity className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            A two-way street.
          </h2>
        </div>
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10 space-y-4 text-muted-foreground leading-relaxed">
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
                OSA → Diabetes
              </div>
              <p>
                Untreated sleep apnea drives daytime insulin resistance
                through repeated sympathetic activation, inflammation, and
                hormone dysregulation. Even non-diabetic patients with OSA
                show measurably impaired glucose tolerance on the morning
                after a poor night.
              </p>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
                Diabetes → OSA
              </div>
              <p>
                Type 2 diabetes drives weight gain, particularly central
                adiposity that compresses the upper airway. Diabetic
                autonomic neuropathy can also affect the muscle tone that
                keeps the airway open during sleep, increasing apnea
                frequency.
              </p>
            </div>
            <div>
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
                The compounding effect
              </div>
              <p>
                Patients with both conditions have worse outcomes on either
                axis than patients with only one. Untreated OSA + diabetes
                roughly doubles the risk of cardiovascular events compared
                to either condition alone — and treating just one of the two
                doesn&apos;t fully break the cycle.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* The four mechanisms */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <TrendingUp className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Four mechanisms tying them together.
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

      {/* The good news */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <TrendingDown className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                Treatment moves both numbers.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Across multiple randomized trials and observational cohorts,
              adherent PAP therapy in patients with co-existing OSA and
              type 2 diabetes produces:
            </p>
            <ul className="space-y-2 mb-4">
              {[
                "A1C reduction of 0.3–0.7 percentage points on average — comparable to adding a second oral agent",
                "Improved fasting glucose and reduced morning insulin requirements",
                "Lower daytime blood pressure (especially in resistant HTN)",
                "Better response to weight-loss interventions",
                "Improved cardiovascular event risk over follow-up",
              ].map((s) => (
                <li
                  key={s}
                  className="flex items-start gap-2.5 text-sm text-foreground/85"
                >
                  <CheckCircle2
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2.5}
                  />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The effect requires real adherence — typical thresholds are 4+
              hours/night across most nights. Patients who can&apos;t
              tolerate their mask don&apos;t see these benefits, which is
              the entire reason mask comfort matters as much as it does.
            </p>
          </div>
        </div>
      </section>

      {/* What to do */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            If you have diabetes, ask about screening.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "If you snore, have witnessed apneas, or have hard-to-control A1C, ask your primary care or endocrinologist for a sleep study referral.",
            "Pre-diabetes counts too. Catching OSA before frank diabetes onset is the highest-leverage screening window.",
            "If you're on metformin, an SGLT-2, or a GLP-1 and your A1C still isn't where it should be — untreated OSA is a common hidden contributor.",
            "Get the STOP-BANG screener result on file. It's a one-page document that opens the door for a sleep study request.",
            "When you start PAP, monitor your blood glucose closely. Some patients see meaningful drops within weeks and need a medication adjustment from their endocrinologist.",
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

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/sleep-apnea-diabetes"
          title="Sleep apnea and diabetes are the same problem"
          blurb="70% of patients with type 2 diabetes have undiagnosed sleep apnea. Treating the apnea moves the A1C. Share with anyone in your life managing both conditions."
          testIdPrefix="share-diabetes"
        />
      </div>

      {/* Disclaimer callout */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div className="text-sm text-foreground/85 leading-relaxed">
              <span className="font-semibold">Don&apos;t change diabetes medications</span> based
              on starting PAP therapy. Coordinate any adjustments with your
              endocrinologist — they&apos;ll want to see post-treatment
              labs before reducing dosing.
            </div>
          </div>
        </div>
      </section>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-heart-health"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Heart className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep apnea &amp; your heart
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The cardiology angle — HTN, AFib, stroke, heart failure.
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
              Take the self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              STOP-BANG — the screener your endocrinologist may already use.
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
          data-testid="diabetes-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. A1C reductions cited reflect commonly-
        reported magnitudes from peer-reviewed cohorts; individual results
        vary with adherence, baseline glycemic control, and concurrent
        therapies.
      </p>
    </div>
  );
}
