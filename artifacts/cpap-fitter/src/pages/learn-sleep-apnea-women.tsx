import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  AlertTriangle,
  Sparkles,
  Brain,
  HeartPulse,
  Moon,
  CheckCircle2,
  Stethoscope,
  TrendingUp,
  Sun,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Symptom = {
  women: string;
  men: string;
};

const symptomComparison: Symptom[] = [
  {
    women: "Insomnia, fragmented sleep, early-morning wakings",
    men: "Loud snoring, witnessed apneas, daytime sleepiness",
  },
  {
    women: "Daytime fatigue described as 'tired' more than 'sleepy'",
    men: "Falling asleep at desk, in meetings, behind the wheel",
  },
  {
    women: "Morning headaches and tension",
    men: "Morning headaches",
  },
  {
    women: "Depressed mood, anxiety, irritability",
    men: "Irritability less prominent",
  },
  {
    women: "Difficulty concentrating, brain fog",
    men: "Excessive daytime sleepiness",
  },
  {
    women: "Cold extremities, lower energy for exercise",
    men: "Lower libido often noted earlier",
  },
];

const lifeStages = [
  {
    Icon: Sun,
    stage: "Pre-menopause",
    body: "Female hormones (progesterone in particular) protect upper-airway muscle tone during sleep. OSA prevalence in pre-menopausal women is roughly half that of age-matched men — but it's not zero, and women in this group are diagnosed years later on average because the symptom profile is atypical.",
  },
  {
    Icon: HeartPulse,
    stage: "Pregnancy",
    body: "OSA prevalence climbs in pregnancy — especially in the third trimester — driven by weight gain, fluid shifts, and airway tissue changes. Untreated OSA in pregnancy is associated with gestational hypertension, preeclampsia, and gestational diabetes. Pregnancy is a window when screening matters most.",
  },
  {
    Icon: TrendingUp,
    stage: "Peri- and post-menopause",
    body: "Estrogen and progesterone decline, and OSA prevalence in women rapidly approaches the male rate. Sleep complaints in mid-life women are often attributed to 'menopause' when the underlying driver is undiagnosed apnea — which menopause can be a primary trigger for, but not a substitute diagnosis.",
  },
];

export function LearnSleepApneaWomen() {
  useDocumentTitle(
    "Sleep apnea in women",
    "Sleep apnea in women presents differently than in men — insomnia, fatigue, mood symptoms instead of loud snoring. That mismatch with the textbook profile is why women are diagnosed years later.",
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
        <span className="text-foreground/85">Sleep apnea in women</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Special populations · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Sleep apnea in women.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Roughly{" "}
          <span className="font-semibold text-foreground">40% of OSA</span>{" "}
          patients are women — but the average woman is diagnosed 5–8 years
          later than the average man, often after being told the problem is
          insomnia, anxiety, depression, or menopause. The symptoms look
          different. Here&apos;s how, and why screening matters earlier than
          most clinicians realize.
        </p>
      </header>

      {/* Big-stat banner */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-6 p-7 md:p-9 text-center">
            {[
              { stat: "~40%", label: "of OSA patients are women" },
              { stat: "5-8 yrs", label: "later diagnosis on average" },
              { stat: "2-3×", label: "OSA prevalence post-menopause" },
              { stat: "Reversible", label: "with adherent therapy" },
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

      {/* The symptom mismatch */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <AlertTriangle className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Why the textbook misses women.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The classic OSA symptom triad — loud snoring, witnessed apneas,
          daytime sleepiness — was characterized in male-dominated study
          cohorts in the 1980s and 90s. Women express the same underlying
          disease through a different symptom mix. When a primary care
          provider screens for &ldquo;the snorer who falls asleep at the
          wheel,&rdquo; women routinely don&apos;t fit that pattern.
        </p>

        <div className="glass-card rounded-2xl p-2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-[hsl(var(--penn-mist))]/40">
                  <th className="text-left p-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-1/2">
                    What women report
                  </th>
                  <th className="text-left p-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-1/2">
                    What the textbook describes (mostly male data)
                  </th>
                </tr>
              </thead>
              <tbody>
                {symptomComparison.map((row) => (
                  <tr
                    key={row.women}
                    className="border-t border-border/30"
                  >
                    <td className="p-4 text-sm text-foreground/85 bg-[hsl(var(--penn-gold-soft))]/15">
                      {row.women}
                    </td>
                    <td className="p-4 text-sm text-muted-foreground">
                      {row.men}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Life stages */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Moon className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            How risk shifts across the life cycle.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Female sex hormones are protective against airway collapse. The
          loss of that protection — across menopause especially — is what
          drives women&apos;s OSA prevalence toward male rates in mid-life.
        </p>

        <div className="space-y-4">
          {lifeStages.map((s, i) => (
            <article
              key={s.stage}
              className={
                i === 1
                  ? "glass-card-tech rounded-2xl p-6 relative overflow-hidden"
                  : "glass-card rounded-2xl p-6"
              }
            >
              {i === 1 && <span className="scan-line" aria-hidden="true" />}
              <div className="relative z-10 flex items-start gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <s.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="text-base md:text-lg font-bold tracking-tight text-foreground/90 mb-2">
                    {s.stage}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {s.body}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Pregnancy callout */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-2">
                If you&apos;re pregnant
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed mb-3">
                OSA in pregnancy is increasingly recognized as a meaningful
                obstetric risk factor. New-onset snoring, witnessed pauses,
                or pronounced daytime sleepiness in the second or third
                trimester are worth raising with your OB — especially if
                you&apos;re also being monitored for gestational hypertension
                or pre-existing diabetes.
              </p>
              <p className="text-sm text-foreground/85 leading-relaxed">
                CPAP is safe in pregnancy and used routinely when OSA is
                diagnosed. The therapy itself doesn&apos;t cross the
                placenta — it just helps you breathe.
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
            What to do if this sounds like you.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Take the STOP-BANG screener — it works for women but you may score lower than your symptoms suggest. A high score is meaningful; a borderline score isn't a clean negative.",
            "Bring this article to your primary care visit. Ask specifically about a home sleep apnea test (HSAT) — the diagnostic, not the treatment.",
            "Track your sleep for two weeks: bedtime, wake time, perceived rest level, mood, and energy. Patterns in this data convince clinicians faster than symptoms in isolation.",
            "If your sleep specialist tells you your AHI is 'borderline,' ask whether your symptom profile justifies treating it. Even mild OSA matters more in symptomatic patients.",
            "If you've been diagnosed with insomnia, anxiety, or depression but treatment isn't working — sleep apnea overlap is common and worth ruling out.",
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
          path="/learn/sleep-apnea-women"
          title="Sleep apnea in women looks different. That's why it's missed."
          blurb="Women with OSA report insomnia, fatigue, and mood symptoms — not the textbook loud-snoring profile. Share this if a woman in your life is being treated for insomnia or depression without anyone screening her for sleep apnea."
          testIdPrefix="share-women"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-mental-health"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Brain className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Sleep apnea &amp; mental health
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The overlap with depression, anxiety, and the brain-fog
              symptom cluster.
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
          <Sparkles className="w-3 h-3 mr-1.5" /> When you&apos;re ready
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="women-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice or a diagnosis.
        Pregnancy, perimenopause, and hormonal changes all interact with
        sleep in ways your physician should evaluate individually.
      </p>
    </div>
  );
}
