import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Wind,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Activity,
  Bed,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

const fixes = [
  {
    Icon: Bed,
    title: "Sleep with your head slightly elevated",
    body: "Even 2-4 inches of elevation helps gravity keep swallowed air down. Wedge pillow, adjustable bed, or a couple of pillows under the upper back (not just the neck). Most patients see meaningful improvement in the first week.",
  },
  {
    Icon: Activity,
    title: "Switch from CPAP to APAP",
    body: "Fixed CPAP delivers full pressure even when you're not having events. APAP only ramps up when needed — meaning lower average pressure across the night, less air pushed past the throat. Talk to your sleep doctor; most modern machines can be switched at the device level.",
  },
  {
    Icon: Wind,
    title: "Check for mouth breathing",
    body: "Pressurized air entering through an open mouth is swallowed much more readily than air entering through the nose. A chin strap or full-face mask resolves this and is the single most common true cause of aerophagia in our patient cohort.",
  },
  {
    Icon: Stethoscope,
    title: "Ask about EPR / Flex / SmartFlex",
    body: "Most modern machines drop pressure briefly during exhalation. If your exhalation relief is set to 0 (off) or 1, bumping to 2 or 3 reduces the perceived pressure your throat works against — and reduces swallowed air. Your sleep doctor can authorize a setting change remotely.",
  },
];

export function LearnCpapBloating() {
  useDocumentTitle(
    "CPAP bloating and gas (aerophagia)",
    "Waking up bloated, gassy, or with a swollen stomach from CPAP is called aerophagia — swallowed air. Common in the first month and almost always fixable. Four solutions to try in order.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">CPAP bloating &amp; gas</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Troubleshooting · 4 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          When CPAP gives you gas.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The clinical term is{" "}
          <span className="font-semibold text-foreground">aerophagia</span> —
          swallowed air. It&apos;s common in the first month on therapy
          (especially at higher pressures), it&apos;s harmless from a
          long-term standpoint, and it&apos;s almost always fixable with
          one or two small changes.
        </p>
      </header>

      {/* Quick framing */}
      <section className="w-full mb-10">
        <div className="glass-card-tech rounded-2xl p-7 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                What&apos;s actually happening.
              </h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              When the pressure delivered to your airway is higher than
              what your throat muscles relax to handle, some of the
              therapy air gets pushed into your esophagus and stomach
              instead of (or in addition to) your lungs. Overnight that
              air accumulates as belching, bloating, gas, and morning
              stomach distension. Your body clears it normally during the
              day — the question is how to make less of it in the first
              place.
            </p>
          </div>
        </div>
      </section>

      {/* The four fixes */}
      <section className="w-full mb-10 space-y-4">
        {fixes.map((f, i) => (
          <article
            key={f.title}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 relative overflow-hidden"
                : "glass-card rounded-2xl p-6"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10 flex items-start gap-4">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <f.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1">
                  Fix 0{i + 1}
                </div>
                <h3 className="text-lg font-bold tracking-tight mb-2">
                  {f.title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {f.body}
                </p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* When to escalate */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                When to escalate to your sleep doctor
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Aerophagia that persists past 6-8 weeks despite the four
                fixes above is a reason to discuss either a BiPAP
                conversion (separate inhale/exhale pressures relieve the
                throat pressure delta) or a pressure-range adjustment.
                Don&apos;t change settings yourself — but absolutely
                bring this up at your next sleep follow-up.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/cpap-bloating"
          title="When CPAP gives you gas — fixing aerophagia"
          blurb="If you're waking up bloated or gassy after a night on CPAP, this is aerophagia — and it's fixable. Four solutions in order of likelihood."
          testIdPrefix="share-bloating"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/dry-mouth"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Wind className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Fixing CPAP dry mouth
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Often the partner symptom — both point at mouth breathing or
              pressure too high.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/first-two-weeks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Surviving the first two weeks
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Aerophagia is common in the adjustment window. The broader
              guide.
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
          <Sparkles className="w-3 h-3 mr-1.5" /> Can&apos;t resolve it?
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="bloating-cta-fit"
        >
          See if a different mask helps
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
        Educational content only. Persistent abdominal symptoms unrelated
        to therapy timing should be evaluated by your physician — not
        every stomach issue is aerophagia.
      </p>
    </div>
  );
}
