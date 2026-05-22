import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Moon,
  Sunrise,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Heart,
  Droplets,
  Wind,
  Activity,
  Clock,
  LifeBuoy,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Stage = {
  when: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  goals: string[];
  pitfalls: string[];
};

const stages: Stage[] = [
  {
    when: "Night 1",
    Icon: Moon,
    title: "The first night is for getting the mask on.",
    body: "Don't set a sleep goal. Set a wear-time goal. The hardest part of night one is the moment you turn the light off with a foreign object on your face. If you wear it for two hours and pull it off at 1am, you won the night.",
    goals: [
      "Mask on, machine on, lights off",
      "Wear time of 2+ hours counts as a win",
      "Position the hose so it doesn't tug on the mask when you turn",
      "Use the ramp feature if available — it starts at low pressure and builds up",
    ],
    pitfalls: [
      "Trying to power through claustrophobia — take it off, breathe, put it back on",
      "Over-tightening straps to fix a leak (loosening usually works better)",
      "Sleeping with the hose under the bedsheet — it kinks and triggers low-pressure alerts",
    ],
  },
  {
    when: "Days 2–4",
    Icon: Wind,
    title: "Build the routine. Tolerate the weirdness.",
    body: "Your face is adjusting to wearing something for eight hours. Skin redness, mild ear pressure, and dry mouth all show up in this window and resolve as the cushion conforms. Therapy data will look terrible for a few nights — that's normal.",
    goals: [
      "Wear the mask every single night, even if only for 2-3 hours",
      "Identify your worst comfort issue (leaks, dry mouth, congestion) — write it down",
      "Take a phone photo of the cushion outline on your face in the morning",
    ],
    pitfalls: [
      "Skipping nights — the adjustment restarts each time",
      "Diagnosing a fit problem from one bad night — patterns matter, single nights don't",
      "Reading the AHI on day 2 and panicking — early data is noisy",
    ],
  },
  {
    when: "Week 1",
    Icon: Sunrise,
    title: "The first 'different morning' arrives.",
    body: "Most patients hit a morning in week one where they wake up and something feels distinctly different — clearer head, less morning headache, an actual rested feeling. It often shows up two or three nights before therapy data looks good on paper.",
    goals: [
      "Average 4+ hours of wear per night",
      "Settle on a sleeping position that works with the mask",
      "Master the put-on / take-off motion in the dark",
      "Try humidifier level 2-3 if you're getting dry mouth",
    ],
    pitfalls: [
      "Stopping therapy on a good morning because 'maybe I don't need it' — you do",
      "Comparing your AHI to someone else's — the right target is your own decreasing trend",
      "Cleaning routine letting slip in week one — start the daily wipe-down habit now",
    ],
  },
  {
    when: "Week 2",
    Icon: Activity,
    title: "Diagnose what's not working.",
    body: "By the start of week two you have enough data — both subjective and machine-recorded — to identify exactly what's bothering you. This is the right time to escalate to your DME (us) or your sleep doctor about specific issues. Don't suffer through them.",
    goals: [
      "Identify your single biggest issue and call us — not your spouse, not Reddit",
      "Confirm AHI is trending toward your target (typically under 5)",
      "Notice the daytime difference — energy, partner sleep, headaches",
      "Lock in a daily cleaning routine",
    ],
    pitfalls: [
      "Living with a bad mask fit — the comfort guarantee exists exactly for this",
      "Adjusting your own pressure settings — those are a prescription, not a preference",
      "Quitting silently — survival rates plummet between weeks 2 and 4 for people who don't ask for help",
    ],
  },
];

const commonIssues = [
  {
    Icon: Droplets,
    issue: "Dry mouth",
    body: "Almost always a humidifier setting issue, sometimes a mouth-breathing issue. Bump humidifier to 3-4. If you're still dry, you may be leaking out your mouth — try a chin strap or talk to us about a full-face mask.",
  },
  {
    Icon: AlertTriangle,
    issue: "Red pressure marks",
    body: "Cushion is too tight. Loosen the straps until you feel a small leak, then tighten one click at a time until it stops. Marks should fade within 30 minutes of waking.",
  },
  {
    Icon: Wind,
    issue: "Cool air shooting in your eye",
    body: "A leak at the bridge of your nose. Reposition the mask higher, or try a different cushion size. Bridge leaks are the most common single fix-it issue.",
  },
  {
    Icon: Heart,
    issue: "Your partner can't sleep",
    body: "Either the machine is too loud (almost certainly the mask vent, not the motor — try a different cushion) or you're leaking. Both fixable in one call.",
  },
  {
    Icon: AlertTriangle,
    issue: "Bloating, gas, swallowed air",
    body: "Aerophagia. Common in the first month; usually subsides as you learn to breathe through your nose. Sleeping with your head slightly elevated helps. Persistent aerophagia is a reason to call your sleep doctor.",
  },
  {
    Icon: Sparkles,
    issue: "Just feels weird",
    body: "It will. Adjustment is real. The honest fix is wear time — most patients describe a turning point somewhere between night 10 and night 18 where the mask stops feeling foreign.",
  },
];

export function LearnFirstTwoWeeks() {
  useDocumentTitle(
    "Surviving the first two weeks on CPAP",
    "A day-by-day, week-by-week guide to the CPAP adjustment period — what's normal, what's not, and how to fix the issues that drive most new patients to quit.",
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
        <span className="text-foreground/85">Surviving the first two weeks</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Living with therapy · 9 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The first two weeks decide everything.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The biggest predictor of whether someone is still on CPAP at the
          one-year mark is whether they got through the first 14 nights.
          Most of the people who quit do so silently in this window —
          frustrated by problems that almost all have a five-minute fix.
          Here&apos;s how to survive it.
        </p>
      </header>

      {/* Mission framing */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                The one rule.
              </h2>
            </div>
            <p className="text-lg text-foreground/90 leading-relaxed font-medium">
              For the first 14 nights, the goal is <span className="text-gradient-brand font-bold">not</span> good sleep,
              not a low AHI, not a glowing therapy report. The goal is to{" "}
              <span className="text-gradient-brand font-bold">wear the mask every night</span>
              .
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed mt-4">
              That&apos;s it. Everything else — the comfort tuning, the seal
              fixes, the pressure adjustments — happens on top of the
              foundation of nightly wear. Skip a night and the adjustment
              clock restarts.
            </p>
          </div>
        </div>
      </section>

      {/* Four-stage timeline */}
      <section className="w-full mb-12 space-y-5">
        {stages.map((s, i) => (
          <article
            key={s.when}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-start gap-4 mb-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <s.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                    {s.when}
                  </div>
                  <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                    {s.title}
                  </h2>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                {s.body}
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--penn-gold-deep))] mb-2">
                    Aim for
                  </div>
                  <ul className="space-y-1.5">
                    {s.goals.map((g) => (
                      <li
                        key={g}
                        className="flex items-start gap-2 text-xs text-foreground/85"
                      >
                        <CheckCircle2
                          className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                          strokeWidth={2.5}
                        />
                        <span>{g}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                    Avoid
                  </div>
                  <ul className="space-y-1.5">
                    {s.pitfalls.map((p) => (
                      <li
                        key={p}
                        className="flex items-start gap-2 text-xs text-foreground/85"
                      >
                        <AlertTriangle
                          className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0"
                          strokeWidth={2}
                        />
                        <span>{p}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Common issues */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <LifeBuoy className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The six issues that drive 90% of dropouts.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-6">
          Every one of these is fixable — usually in a single call with us or
          a single tweak to your setup. Suffering through them is the most
          expensive choice you can make in week one.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {commonIssues.map(({ Icon, issue, body }) => (
            <div key={issue} className="glass-card rounded-2xl p-5">
              <div className="flex items-start gap-3 mb-2">
                <div className="relative h-9 w-9 rounded-lg flex items-center justify-center shrink-0 icon-halo-gold">
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </div>
                <h3 className="text-sm font-semibold tracking-tight text-foreground/90 pt-1.5">
                  {issue}
                </h3>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Daily checklist */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The nightly habit · 90 seconds
            </div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-5">
              Your 90-second nightly checklist.
            </h2>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
              {[
                "Fill humidifier with distilled water (not tap)",
                "Wipe cushion with a baby wipe or warm soapy cloth",
                "Check that the hose is fully seated at machine and mask",
                "Run the mask under cool air for 60 sec before lights off",
                "Set the ramp if you find lights-off pressure uncomfortable",
                "Position the hose to clear your turning radius",
                "Phone on the nightstand — not buried under pillows",
                "Pull the mask up high, then settle straps last",
              ].map((item, i) => (
                <div key={item} className="flex items-start gap-2.5">
                  <span className="text-[10px] font-mono text-[hsl(var(--penn-gold))] pt-1 shrink-0">
                    0{i + 1}
                  </span>
                  <span className="text-sm text-white/90 leading-relaxed">
                    {item}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* When to call */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <Clock className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Don&apos;t suffer in silence.
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                If something hurts, leaks, dries you out, or wakes you up
                more than once a night — call us. Fixing it on day 3 takes
                ten minutes; trying to live with it for three weeks
                permanently shapes your relationship with the therapy.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/first-two-weeks"
          title="The first two weeks on CPAP decide everything"
          blurb="If you or someone you know just started CPAP, send this their way. The dropout rate in week one is real — and almost every problem in this window has a five-minute fix."
          testIdPrefix="share-first-two-weeks"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/cleaning-routine"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Droplets className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The cleaning routine
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Daily, weekly, monthly — what to wipe, soak, and replace.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/myths-debunked"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <AlertTriangle className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              CPAP myths, debunked
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Ten things people get wrong about therapy — and why each one
              isn&apos;t true.
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
          data-testid="first-two-weeks-cta-fit"
        >
          Get matched to a comfortable mask
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice. Don&apos;t change
        pressure settings or stop therapy without speaking with your sleep
        medicine provider first.
      </p>
    </div>
  );
}
