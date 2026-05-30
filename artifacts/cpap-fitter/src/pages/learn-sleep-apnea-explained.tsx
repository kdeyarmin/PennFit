import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Moon,
  AlertTriangle,
  Stethoscope,
  Users,
  Activity,
  CheckCircle2,
  Wind,
  Brain,
  HeartPulse,
  ClipboardList,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

export function LearnSleepApneaExplained() {
  useDocumentTitle(
    "What sleep apnea really is",
    "A plain-English guide to obstructive, central, and mixed sleep apnea — what causes it, who it affects, the warning signs, and how it's diagnosed.",
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
        <span className="text-foreground/85">Sleep apnea explained</span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Foundations · 8 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          What sleep apnea really is.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Roughly{" "}
          <span className="font-semibold text-foreground">30 million</span>{" "}
          American adults have obstructive sleep apnea — and an estimated{" "}
          <span className="font-semibold text-foreground">80% of them</span>{" "}
          don&apos;t know it. Here&apos;s what&apos;s actually happening, who it
          affects, and the warning signs worth listening to.
        </p>
      </header>

      {/* Section: the three types */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Moon className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Three types — and they&apos;re not the same disease.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-6">
          &ldquo;Sleep apnea&rdquo; is an umbrella term for repeated breathing
          pauses during sleep. The mechanism behind those pauses is what
          separates the three forms — and what determines the right therapy.
        </p>

        <div className="grid md:grid-cols-3 gap-4">
          <div className="glass-card rounded-2xl p-6">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
              ~85% of cases
            </div>
            <h3 className="text-lg font-semibold tracking-tight mb-2">
              Obstructive (OSA)
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Soft tissue in the back of the throat collapses inward when muscle
              tone relaxes during sleep. The airway physically closes — you keep
              trying to breathe, but no air moves until your brain briefly wakes
              you up enough to reopen it. This cycle can repeat 30 times an hour
              or more.
            </p>
          </div>
          <div className="glass-card rounded-2xl p-6">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
              ~5% of cases
            </div>
            <h3 className="text-lg font-semibold tracking-tight mb-2">
              Central (CSA)
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The airway stays open, but the brain briefly stops sending the
              signal to breathe. Common in patients with congestive heart
              failure, stroke history, or long-term opioid use. Treatment
              usually requires bilevel or ASV therapy rather than standard CPAP.
            </p>
          </div>
          <div className="glass-card rounded-2xl p-6">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
              ~10% of cases
            </div>
            <h3 className="text-lg font-semibold tracking-tight mb-2">
              Mixed / Complex
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A combination — obstructive events plus emergent central events
              that can appear once CPAP is started. Often managed with adaptive
              servo-ventilation (ASV) or careful titration.
            </p>
          </div>
        </div>
      </section>

      {/* Section: how it happens */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Wind className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What&apos;s actually happening, second by second.
          </h2>
        </div>
        <div className="glass-card rounded-2xl p-6 md:p-8">
          <ol className="space-y-4">
            {[
              {
                t: "0s",
                title: "You drift into deeper sleep.",
                body: "Muscle tone throughout your body drops. The tongue, soft palate, and throat tissues relax along with everything else.",
              },
              {
                t: "10s",
                title: "The airway narrows.",
                body: "In an at-risk anatomy — thicker neck, large tonsils, low-set jaw, or extra weight around the throat — relaxed tissues sag inward until the airway is partly or completely blocked.",
              },
              {
                t: "20s",
                title: "Breathing effort spikes.",
                body: "Your diaphragm keeps pulling, but no air moves. Blood oxygen begins to drop. CO₂ builds up.",
              },
              {
                t: "30s",
                title: "The brain partially wakes you.",
                body: "A surge of adrenaline pulls you out of deep sleep just long enough to restore muscle tone. The airway opens, you take 2–3 deep breaths — sometimes with the loud gasp or choke a bed partner notices — and you fall back asleep.",
              },
              {
                t: "Repeat",
                title: "And again, and again.",
                body: "In severe untreated OSA, this cycle can repeat 60+ times per hour. You may have no memory of it the next morning — but you spent the night fragmenting your sleep architecture and starving your brain of oxygen.",
              },
            ].map(({ t, title, body }) => (
              <li key={t} className="flex gap-4">
                <div className="shrink-0 text-[11px] font-mono tracking-[0.18em] text-[hsl(var(--penn-gold-deep))] w-12 pt-1">
                  {t}
                </div>
                <div className="flex-1 pb-1 border-b border-border/30 last:border-0">
                  <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                    {title}
                  </div>
                  <div className="text-sm text-muted-foreground leading-relaxed">
                    {body}
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Section: who's at risk */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Users className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Who&apos;s at risk?
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Sleep apnea affects every body type, gender, and age — but the
          following raise risk meaningfully. The more boxes you check, the
          stronger the case for a sleep study.
        </p>
        <div className="grid sm:grid-cols-2 gap-3">
          {[
            "Age 40+ — risk increases with each decade",
            "Neck circumference >17in (men) / >16in (women)",
            "BMI in the overweight or obese range",
            "Family history of sleep apnea",
            "Loud, habitual snoring",
            "Witnessed breathing pauses by a partner",
            "Hypertension — especially if hard to control",
            "Type 2 diabetes or pre-diabetes",
            "Atrial fibrillation or heart failure",
            "Anatomical: deviated septum, large tonsils, recessed jaw",
            "Post-menopause (women)",
            "Alcohol or sedative use near bedtime",
          ].map((risk) => (
            <div
              key={risk}
              className="flex items-start gap-2.5 glass-card rounded-xl p-4"
            >
              <CheckCircle2
                className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span className="text-sm text-foreground/85">{risk}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Section: warning signs */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <AlertTriangle className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Warning signs worth listening to.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The two most reliable signs come from the people around you — not from
          how you feel. By definition, you&apos;re asleep when the events
          happen.
        </p>

        <div className="space-y-4">
          <div className="glass-card-tech rounded-2xl p-6 relative overflow-hidden">
            <span className="scan-line" aria-hidden="true" />
            <div className="relative z-10">
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
                The strongest signals
              </div>
              <ul className="space-y-2.5">
                <li className="flex items-start gap-2.5">
                  <HeartPulse
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2}
                  />
                  <span className="text-sm text-foreground/85">
                    <span className="font-semibold">
                      Loud, habitual snoring
                    </span>{" "}
                    that&apos;s gotten worse over years
                  </span>
                </li>
                <li className="flex items-start gap-2.5">
                  <HeartPulse
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2}
                  />
                  <span className="text-sm text-foreground/85">
                    <span className="font-semibold">
                      Witnessed breathing pauses
                    </span>{" "}
                    or gasping/choking sounds at night (reported by a partner)
                  </span>
                </li>
              </ul>
            </div>
          </div>

          <div className="grid sm:grid-cols-2 gap-3">
            {[
              {
                Icon: Brain,
                title: "Excessive daytime sleepiness",
                body: "Falling asleep at the desk, in meetings, behind the wheel, or while reading — even after a full night in bed.",
              },
              {
                Icon: Activity,
                title: "Morning headaches",
                body: "Caused by overnight CO₂ buildup. Often resolve within 30 minutes of waking.",
              },
              {
                Icon: Moon,
                title: "Unrefreshing sleep",
                body: "You sleep 7+ hours but wake up exhausted. Repeated arousal cycles prevent meaningful deep and REM sleep.",
              },
              {
                Icon: Stethoscope,
                title: "Frequent nighttime urination",
                body: "Apnea events suppress antidiuretic hormone — three or more bathroom trips a night is a quiet but specific sign.",
              },
            ].map(({ Icon, title, body }) => (
              <div key={title} className="glass-card rounded-2xl p-5">
                <div className="relative h-9 w-9 rounded-lg flex items-center justify-center mb-3 icon-halo-navy">
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </div>
                <h3 className="text-sm font-semibold tracking-tight mb-1.5">
                  {title}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Section: diagnosis */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <ClipboardList className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            How it&apos;s diagnosed.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Diagnosis is always done by a physician — typically a sleep medicine
          specialist or pulmonologist — using one of two studies:
        </p>
        <div className="grid md:grid-cols-2 gap-4">
          <div className="glass-card rounded-2xl p-6">
            <Badge
              variant="outline"
              className="mb-3 chip-tier-premium border-0 font-medium"
            >
              In-lab polysomnography
            </Badge>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              An overnight study at a sleep lab with full instrumentation — EEG,
              EKG, EMG, airflow, oxygen, video. The gold standard for complex
              cases, central apnea, and titration of pressure for hard-to-treat
              patients.
            </p>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Best for: complex cases, central apnea, custom titration
            </div>
          </div>
          <div className="glass-card rounded-2xl p-6">
            <Badge
              variant="outline"
              className="mb-3 chip-tier-standard border-0 font-medium"
            >
              Home sleep apnea test (HSAT)
            </Badge>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              A small device you wear at home for one to three nights — measures
              airflow, oxygen, heart rate, and effort. Increasingly the
              first-line test for straightforward obstructive cases. Less data,
              much less hassle.
            </p>
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Best for: typical OSA workups, follow-up screens
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed mt-5">
          Both studies produce an{" "}
          <span className="font-semibold">AHI (Apnea-Hypopnea Index)</span> —
          the number of breathing disruptions per hour of sleep. Under 5 is
          normal, 5–15 mild, 15–30 moderate, and over 30 severe. Treatment
          recommendations follow from that number plus your symptoms.
        </p>
      </section>

      {/* Share affordance */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/sleep-apnea-explained"
          title="What sleep apnea really is — a plain-English guide"
          blurb="A friend put this in front of me and I thought of you. Quick read on what sleep apnea actually is, who it affects, and the warning signs."
          testIdPrefix="share-sleep-apnea"
        />
      </div>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4">
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <ClipboardList className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Take the self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Eight questions, two minutes — based on the validated STOP-BANG
              clinical tool.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/health-risks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <HeartPulse className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Why treatment matters
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The cardiovascular, metabolic, and cognitive risks of leaving
              sleep apnea untreated.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full mt-10 text-center">
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="sleep-apnea-bottom-cta-fit"
        >
          Get fitted for a CPAP mask
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      {/* Medical disclaimer */}
      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        This article is educational. Nothing here is medical advice or a
        diagnosis. If you suspect sleep apnea, talk to your primary care
        provider about a sleep study.
      </p>
    </div>
  );
}
