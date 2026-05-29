import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Brain,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Stethoscope,
  HeartPulse,
  Moon,
  Cloud,
  Shield,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Overlap = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  condition: string;
  body: string;
  data: string;
};

const overlaps: Overlap[] = [
  {
    Icon: Cloud,
    condition: "Depression",
    body: "Patients with untreated moderate-to-severe OSA are roughly 2× more likely to meet criteria for major depression than matched controls. The relationship runs both ways — depression worsens sleep, and disrupted sleep worsens depression — but treating OSA often produces measurable PHQ-9 improvement within 6–12 weeks, sometimes faster than antidepressants alone.",
    data: "~2× depression prevalence in untreated OSA",
  },
  {
    Icon: AlertTriangle,
    condition: "Anxiety",
    body: "Generalized anxiety and panic disorder overlap substantially with OSA. The overnight adrenaline surges from repeated apneas prime the daytime nervous system. Patients who can't fall asleep without their CPAP often discover their long-standing 'anxiety' was sleep apnea wearing a costume.",
    data: "GAD-7 scores improve with adherent therapy",
  },
  {
    Icon: Shield,
    condition: "PTSD",
    body: "Veterans and trauma survivors have markedly higher OSA prevalence — partly because of the disrupted sleep architecture PTSD itself causes, partly because PTSD-driven hyperarousal masks the daytime sleepiness that would normally prompt OSA screening. The VA now routinely screens for OSA in PTSD evaluations.",
    data: "Up to 70% co-prevalence in veterans with PTSD",
  },
  {
    Icon: Brain,
    condition: "Cognitive symptoms (brain fog)",
    body: "The 'foggy, slow, can't-find-the-word' cognitive pattern attributed to depression, ADHD, or aging is frequently driven by fragmented sleep. Memory consolidation requires deep and REM sleep — both of which are repeatedly interrupted by apnea events. Effective therapy clears the fog within weeks.",
    data: "Hippocampal MRI changes reversible on PAP",
  },
];

export function LearnSleepApneaMentalHealth() {
  useDocumentTitle(
    "Sleep apnea and mental health",
    "Sleep apnea overlaps deeply with depression, anxiety, PTSD, and the brain-fog symptom cluster. Treating the apnea often moves the mood and cognitive numbers measurably.",
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
          Sleep apnea &amp; mental health
        </span>
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
          Sometimes &lsquo;depression&rsquo; is sleep apnea.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The overlap between sleep apnea and mood disorders is dense and
          underappreciated. Patients being treated for depression that
          isn&apos;t responding to medication, or for anxiety that won&apos;t
          settle, are statistically much more likely than the general population
          to also have undiagnosed OSA. Treating the apnea moves the mental
          health numbers — sometimes dramatically.
        </p>
      </header>

      {/* Stat banner */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-6 p-7 md:p-9 text-center">
            {[
              { stat: "~2×", label: "depression risk in untreated OSA" },
              { stat: "~70%", label: "PTSD-OSA co-prevalence in veterans" },
              { stat: "6-12 wks", label: "to measurable PHQ-9 improvement" },
              { stat: "Reversible", label: "brain fog with adherent therapy" },
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

      {/* The four overlaps */}
      <section className="w-full mb-12 space-y-5">
        {overlaps.map((o, i) => (
          <article
            key={o.condition}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <o.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                    <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                      {o.condition}
                    </h2>
                    <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[hsl(var(--penn-gold-deep))]">
                      {o.data}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {o.body}
                  </p>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* The mechanism */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Brain className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Why sleep is the missing variable.
          </h2>
        </div>
        <div className="glass-card rounded-2xl p-6 md:p-7 space-y-3 text-sm text-muted-foreground leading-relaxed">
          <p>
            Deep and REM sleep are when the brain processes emotion, files
            memory, and clears metabolic waste. Sleep apnea fragments both —
            sometimes hundreds of times a night — without you remembering it the
            next morning.
          </p>
          <p>
            The downstream effects are the symptom cluster mental health
            clinicians recognize: persistent low mood, anxiety, irritability,
            brain fog, motivational deficits, and impaired concentration. If
            those symptoms are happening on top of an underlying sleep disorder
            no one has tested for, the psychiatric treatment is fighting uphill.
          </p>
          <p>
            This is not a claim that sleep apnea explains all mental health
            symptoms — it doesn&apos;t. It&apos;s the observation that
            treatment-resistant or atypical mental health presentations should
            include sleep apnea screening on the workup. The response rate to
            adherent CPAP in this population is one of the more striking in
            clinical sleep medicine.
          </p>
        </div>
      </section>

      {/* Veteran callout */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Veterans &amp; PTSD
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                The VA covers sleep studies, CPAP machines, and replacement
                supplies for veterans with diagnosed OSA. If you&apos;re a
                veteran being treated for PTSD, ask your VA primary care or
                mental health provider about sleep apnea screening specifically
                — the prevalence in this population is high enough that it
                should be on every workup.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What to do */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What to do if this resonates.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Don't change psychiatric medications. Adding sleep apnea evaluation does not subtract from existing mental health treatment — it complements it.",
            "Ask your primary care or your psychiatrist for a sleep study referral. Bring the STOP-BANG screener result if you've taken it.",
            "If you have a partner, ask them whether you snore loudly or seem to stop breathing. Patient self-report is unreliable here; partner report is gold.",
            "If you start PAP therapy, give it real time — meaningful improvement in mood and cognition typically takes 6–12 weeks, not days.",
            "Continue working with your mental health provider throughout. They want to know the sleep data, and a coordinated team produces better outcomes.",
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
          path="/learn/sleep-apnea-mental-health"
          title="Sometimes 'depression' is sleep apnea."
          blurb="The overlap between sleep apnea and depression, anxiety, PTSD, and brain fog is huge and underappreciated. If you or someone you know has treatment-resistant mood symptoms, this is worth a read."
          testIdPrefix="share-mental-health"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-women"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Moon className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep apnea in women
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Why women with OSA are systematically misdiagnosed with insomnia,
              anxiety, and depression first.
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
              STOP-BANG — eight quick questions, two minutes.
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
          <HeartPulse className="w-3 h-3 mr-1.5" /> A real next step
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="mental-health-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. If you are experiencing a mental health
        crisis, contact 988 (Suicide and Crisis Lifeline) or your mental health
        provider — sleep apnea screening is not a substitute for immediate care.
      </p>
    </div>
  );
}
