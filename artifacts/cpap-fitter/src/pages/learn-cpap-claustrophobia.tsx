import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Brain,
  CheckCircle2,
  Sparkles,
  Clock,
  Wind,
  Sunrise,
  AlertTriangle,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

const desensitizationSteps = [
  {
    day: "Day 0 (daytime)",
    what:
      "Just hold the mask up to your face. Don't strap it on. Breathe through it for 5-10 minutes. Watch TV. Read. Whatever — your only job is to let your nervous system register that you can still breathe normally with this thing on your face.",
  },
  {
    day: "Day 1 (daytime)",
    what:
      "Put the mask on with the headgear loose. Connect the hose; turn the machine on at the lowest pressure. Sit with it for 20 minutes during the day. Most patients describe this step as 'almost relaxing' — proof that the mask isn't the problem, the dark-and-trying-to-sleep context was.",
  },
  {
    day: "Day 2-3 (daytime + first sleep attempts)",
    what:
      "Daytime: 30+ minutes wearing the mask connected to the machine. Bedtime: put it on, then take it off whenever you want — no pressure to keep it on all night. Track how long you wore it. The number will climb.",
  },
  {
    day: "Day 4-7",
    what:
      "Use the ramp feature so the machine starts at minimum pressure. Wear the mask falling asleep. If you take it off in the middle of the night, that's fine — write down what time, and tomorrow aim for 30 minutes longer.",
  },
  {
    day: "Week 2",
    what:
      "Full-night wear becomes routine. The mask stops registering as a foreign object. Most patients describe a turning point somewhere between night 10 and 18 where they stop noticing it consciously.",
  },
];

export function LearnCpapClaustrophobia() {
  useDocumentTitle(
    "CPAP claustrophobia & anxiety",
    "If a CPAP mask makes you panic or feel suffocated, you're not alone — and it's the most fixable barrier to adherence. Here's the desensitization protocol that actually works.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Claustrophobia &amp; anxiety</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Troubleshooting · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          When the mask feels suffocating.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          About <span className="font-semibold text-foreground">15-20%</span>{" "}
          of new CPAP patients describe at least some claustrophobia in
          the first week — and a meaningful number nearly quit because of
          it. The fix isn&apos;t willpower. It&apos;s a structured
          desensitization protocol that takes about a week of daytime
          practice. It works for almost everyone who tries it.
        </p>
      </header>

      {/* The reframe */}
      <section className="w-full mb-10">
        <div className="glass-card-tech rounded-2xl p-7 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Brain className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                What&apos;s actually happening.
              </h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              Claustrophobia in CPAP isn&apos;t a moral failing or a sign
              that &ldquo;CPAP isn&apos;t for you.&rdquo; It&apos;s a
              learned response — your nervous system has correctly
              identified that there&apos;s something on your face and is
              reacting accordingly. The fix is to let your nervous system
              learn that the mask isn&apos;t a threat. That&apos;s exactly
              what the desensitization steps below do.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              You can do this on your own. Most patients who try the
              protocol report a meaningful shift within 5-7 days.
            </p>
          </div>
        </div>
      </section>

      {/* Desensitization protocol */}
      <section className="w-full mb-10">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Clock className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The desensitization protocol.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          One step per day. The key principle: build up daytime exposure
          before adding the &ldquo;dark room, trying to sleep&rdquo;
          variable. The 11pm panic doesn&apos;t happen at 3pm.
        </p>
        <div className="space-y-3">
          {desensitizationSteps.map((s) => (
            <article key={s.day} className="glass-card rounded-2xl p-5">
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                {s.day}
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                {s.what}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* In-the-moment tips */}
      <section className="w-full mb-10">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            If panic hits in the middle of the night.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Take the mask off. Don't fight through panic — that teaches your nervous system the mask = panic. Take a 30-second break and put it back on.",
            "Use the ramp feature next time. Starting at lower pressure makes the first 5-10 minutes much less intense.",
            "Switch to a nasal pillow mask if you're in a full-face. Smaller surface area, less of the face covered, less claustrophobia-inducing for most patients.",
            "Sleep with the bedroom door open. Light from the hallway can help dampen the &ldquo;dark + restrained + can't see&rdquo; trigger pattern.",
            "Talk to your sleep doctor about a low-dose benzodiazepine for the first 2-3 weeks if anxiety is severe — short-term use is appropriate and effective.",
          ].map((tip) => (
            <div
              key={tip}
              className="flex items-start gap-3 glass-card rounded-xl p-4"
            >
              <CheckCircle2
                className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span className="text-sm text-foreground/85 leading-relaxed">
                {tip}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Mask switch callout */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Mask choice matters more than you think
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Patients who feel claustrophobic in a full-face mask are
                usually fine in a nasal pillow setup like the Rio II,
                P10, or Brevida — much less hardware on the face, no
                cushion across the bridge of the nose, and an open field
                of vision. The comfort guarantee covers a one-time
                exchange; if claustrophobia is your blocker, switching
                mask types is usually the right move.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/cpap-claustrophobia"
          title="When the CPAP mask feels suffocating"
          blurb="If CPAP claustrophobia is keeping you (or someone you love) from sticking with therapy, this is a structured desensitization protocol that takes a week and works for almost everyone."
          testIdPrefix="share-claustro"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/first-two-weeks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Sunrise className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Surviving the first two weeks
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The broader adjustment guide. Claustrophobia is one of
              several common Week 1 challenges.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/cpap-masks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Wind className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Nasal pillow brands
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Rio II, P10, Brevida — the lower-contact masks for
              claustrophobia-prone patients.
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
          data-testid="claustro-cta-fit"
        >
          Try a lower-profile mask
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
        Educational content only. Severe panic or anxiety should be
        discussed with your physician and a mental health provider —
        CPAP-related claustrophobia is treatable but doesn&apos;t replace
        general anxiety care.
      </p>
    </div>
  );
}
