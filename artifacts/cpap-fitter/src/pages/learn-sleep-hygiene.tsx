import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Moon,
  Sun,
  Sparkles,
  CheckCircle2,
  Coffee,
  Smartphone,
  Bed,
  Thermometer,
  AlertTriangle,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Habit = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  do: string;
  dont: string;
  why: string;
};

const habits: Habit[] = [
  {
    Icon: Sun,
    do: "Get bright sunlight in your eyes within 30 minutes of waking",
    dont: "Stare at your phone for the first hour of the day",
    why: "Morning sunlight anchors your circadian rhythm and accelerates the cortisol awakening response. Indoor light is ~10× dimmer than overcast morning sky. The intervention is free and the effect is measurable in a week.",
  },
  {
    Icon: Coffee,
    do: "Cut off caffeine by 2pm",
    dont: "Drink coffee or espresso after lunch",
    why: "Caffeine's half-life is 5-7 hours, meaning the cup you had at 4pm is still circulating at midnight even if you can't subjectively feel it. It doesn't prevent sleep — it just lightens it.",
  },
  {
    Icon: Bed,
    do: "Use your bed only for sleep and intimacy",
    dont: "Work, scroll, or watch TV in bed",
    why: "Stimulus control. When your brain has learned that the bed equals being awake (or worse, being anxious), falling asleep gets harder. Recovering the association takes 2-3 weeks of strict practice.",
  },
  {
    Icon: Smartphone,
    do: "Stop screens 60 minutes before lights-off",
    dont: "Doomscroll until you're tired enough to drop the phone",
    why: "Blue light suppresses melatonin and emotionally activating content delays sleep onset. The 60-minute buffer matters more than the device — reading on a Kindle is fine; reading the news is not.",
  },
  {
    Icon: Thermometer,
    do: "Sleep in a cool room (65-68°F)",
    dont: "Crank the heat at bedtime",
    why: "Core body temperature naturally drops at sleep onset. A cool room facilitates that drop; a warm room fights it. Patients with sleep apnea benefit doubly because cool ambient air pairs better with the heated humidifier.",
  },
  {
    Icon: Moon,
    do: "Keep wake-up time constant (even on weekends)",
    dont: "Sleep in on Saturday to 'catch up'",
    why: "Bedtime can shift; wake-time consistency is what stabilizes circadian rhythm. The Saturday-sleep-in routinely produces 'social jet lag' that takes Sunday-Tuesday to recover from.",
  },
];

export function LearnSleepHygiene() {
  useDocumentTitle(
    "Sleep hygiene + CPAP — how to actually use them together",
    "CPAP treats sleep apnea, but it can't make up for caffeine at 4pm or a phone in bed. Six evidence-based sleep hygiene habits that compound with your therapy.",
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
        <span className="text-foreground/85">Sleep hygiene + CPAP</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Living with therapy · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          CPAP isn&apos;t a substitute for sleep hygiene.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          PAP therapy fixes the breathing problem that fragments your sleep. It
          can&apos;t fix the second cup of espresso at 4pm, the phone-in-bed
          habit, the warm bedroom, or the inconsistent wake-time. Six
          evidence-based habits that compound with your therapy and produce
          better sleep than either alone.
        </p>
      </header>

      {/* Framing */}
      <section className="w-full mb-10">
        <div className="glass-card-tech rounded-2xl p-7 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                Why this matters more on CPAP.
              </h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              When sleep apnea was fragmenting your nights, sleep hygiene barely
              mattered — the apneas dominated the data. Now that the breathing
              problem is solved, every other variable starts to matter again.
              Patients who pair CPAP with these six habits consistently report
              deeper, more refreshing sleep than CPAP alone delivers.
            </p>
          </div>
        </div>
      </section>

      {/* Six habits — do/don't pattern */}
      <section className="w-full mb-12 space-y-4">
        {habits.map((h, i) => (
          <article
            key={h.do}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 relative overflow-hidden"
                : "glass-card rounded-2xl p-6"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4 mb-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <h.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] pt-3">
                  Habit 0{i + 1}
                </div>
              </div>
              <div className="space-y-2 mb-3">
                <div className="flex items-start gap-2.5">
                  <CheckCircle2
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2.5}
                  />
                  <span className="text-sm font-semibold text-foreground/90">
                    Do: {h.do}
                  </span>
                </div>
                <div className="flex items-start gap-2.5">
                  <AlertTriangle
                    className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0"
                    strokeWidth={2}
                  />
                  <span className="text-sm text-muted-foreground line-through decoration-muted-foreground/40">
                    {h.dont}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed pl-7">
                <span className="font-semibold">Why: </span>
                {h.why}
              </p>
            </div>
          </article>
        ))}
      </section>

      {/* The 2-week starter */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The realistic starter pack
            </div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-4">
              Don&apos;t try all six at once.
            </h2>
            <p className="text-sm text-white/85 leading-relaxed mb-5">
              Layering six habit changes on top of starting CPAP is too much.
              Pick the two that feel easiest, do them for two weeks, then add
              the next two. Most patients land at all six by the end of month
              three.
            </p>
            <div className="grid sm:grid-cols-3 gap-4">
              {[
                {
                  weeks: "Weeks 1-2",
                  what: "Cut caffeine after 2pm + constant wake-time",
                },
                {
                  weeks: "Weeks 3-4",
                  what: "Morning sunlight + cool bedroom",
                },
                {
                  weeks: "Weeks 5-6",
                  what: "60-min screen buffer + bed for sleep only",
                },
              ].map((p) => (
                <div key={p.weeks}>
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))] mb-1.5">
                    {p.weeks}
                  </div>
                  <div className="text-sm text-white/90 leading-relaxed">
                    {p.what}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/sleep-hygiene"
          title="Sleep hygiene + CPAP — how to actually use them together"
          blurb="CPAP fixes the breathing problem. It can't fix coffee at 4pm or a warm bedroom. Six evidence-based habits that compound with PAP therapy."
          testIdPrefix="share-hygiene"
        />
      </div>

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
              What treatment feels like
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The benefits timeline — paired with these habits, the numbers move
              faster.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/first-two-weeks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Bed className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              First two weeks
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Establish the CPAP routine first. Layer hygiene habits in after
              the mask becomes automatic.
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
          data-testid="hygiene-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
        Educational content only. Sleep hygiene complements but does not replace
        evaluation of sleep disorders by a sleep medicine provider.
      </p>
    </div>
  );
}
