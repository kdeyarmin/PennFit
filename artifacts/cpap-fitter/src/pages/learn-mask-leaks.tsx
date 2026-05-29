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
  Eye,
  Droplets,
  Smile,
  ArrowDown,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type LeakType = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  where: string;
  feels: string;
  why: string;
  fix: string;
};

const leakTypes: LeakType[] = [
  {
    Icon: Eye,
    where: "Bridge of the nose",
    feels: "Cool air jets directly into your eye(s). Wakes you up.",
    why: "The cushion is either too small (sliding up) or too big (gapping at the bridge). Sometimes the headgear top strap is too loose, letting the mask drop on the pillow.",
    fix: "First try lowering the mask 1cm and re-fitting. If that doesn't seat, try a smaller cushion size (a single cushion often spans 2-3 sizes — yours might be wrong even on the right mask). Bridge tape is a workaround, not a fix.",
  },
  {
    Icon: ArrowDown,
    where: "Side of the cheek",
    feels:
      "A constant whoosh or whistle in one ear; sometimes pulls the cushion off-center.",
    why: "The cushion isn't seating evenly — usually one strap is tighter than its mirror, or the cushion is past its replacement window and has lost its memory.",
    fix: "Pull the cushion away from your face completely, then lay it back down with mouth and nose centered. Tighten the looser side one click. If it persists, replace the cushion — every 30-90 days depending on type.",
  },
  {
    Icon: Smile,
    where: "Around the mouth (corners of the lips)",
    feels:
      "Air pushing out your mouth, often with dry mouth in the morning. Sometimes audible whistling.",
    why: "You're a mouth breather on therapy — common during the first month. Your nasal mask is sealing fine; the air is exiting through your relaxed jaw.",
    fix: "Two options: a chin strap (a velcro wrap that holds your jaw closed), or a switch to a full-face mask that covers nose + mouth. Most patients prefer the full-face for long-term comfort.",
  },
  {
    Icon: Droplets,
    where: "Top of the mask (intentional vent)",
    feels: "A constant gentle airflow that's audible but not strong.",
    why: "This isn't a leak — it's the diffuser vent every CPAP mask has by design. The exhaled CO₂ is meant to escape there.",
    fix: "Nothing to fix. If the diffuser is loud enough to bother your partner, look at a quieter mask cushion (React Health Rio II and ResMed AirFit P10 are notable for sub-25dBA vents).",
  },
];

export function LearnMaskLeaks() {
  useDocumentTitle(
    "Fixing CPAP mask leaks",
    "Mask leaks are the #1 reason new CPAP patients quit. Diagnose by where the leak is — bridge, side, mouth — and fix it without an exchange in most cases.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Fixing mask leaks</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Troubleshooting · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Where the leak is tells you how to fix it.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Mask leaks are the single biggest reason new CPAP patients quit — and
          almost every leak is identifiable from where it&apos;s coming. Four
          locations, four causes, four fixes. Diagnose first; don&apos;t just
          keep tightening the headgear.
        </p>
      </header>

      {/* The cardinal rule */}
      <section className="w-full mb-10">
        <div className="glass-card-tech rounded-2xl p-7 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-3">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
                The cardinal rule.
              </h2>
            </div>
            <p className="text-base md:text-lg text-foreground/90 leading-relaxed font-medium mb-2">
              Don&apos;t overtighten.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A cushion that&apos;s too tight leaks <em>more</em>, not less —
              the silicone deforms and the seal breaks at the compressed edges.
              The correct fit is loose enough that you can feel a faint hiss
              when you first put it on, then snug just enough to silence that
              hiss.
            </p>
          </div>
        </div>
      </section>

      {/* Four leak types */}
      <section className="w-full mb-10 space-y-4">
        {leakTypes.map((l) => (
          <article key={l.where} className="glass-card rounded-2xl p-6">
            <div className="flex items-start gap-4 mb-3">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <l.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1">
                  Leak at the…
                </div>
                <h3 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                  {l.where}
                </h3>
              </div>
            </div>
            <div className="space-y-3 text-sm leading-relaxed">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Feels like
                </div>
                <p className="text-foreground/85">{l.feels}</p>
              </div>
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Why
                </div>
                <p className="text-muted-foreground">{l.why}</p>
              </div>
              <div className="rounded-xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-3">
                <div className="flex items-start gap-2">
                  <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                  <p className="text-foreground/85">
                    <span className="font-semibold">Fix: </span>
                    {l.fix}
                  </p>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* The nuclear option */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                When the mask just isn&apos;t right
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                If you&apos;ve tried every fit adjustment and the leaks persist,
                the mask was probably wrong for your face. Our comfort guarantee
                covers a one-time mask exchange in the first 30 days — including
                across brands. Don&apos;t white- knuckle through weeks of bad
                sleep; call us.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/mask-leaks"
          title="Where the CPAP mask leak is tells you how to fix it"
          blurb="Four leak locations, four causes, four fixes. If a CPAP mask is whistling, hissing, or shooting cold air in your eye — this article diagnoses it."
          testIdPrefix="share-leaks"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/dry-mouth"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Droplets className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Fixing dry mouth
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Often co-presents with mouth leaks — both point at the same cause.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/cpap-masks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Browse brands
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              See React Health, ResMed, and F&amp;P compared head to head.
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
          <Wind className="w-3 h-3 mr-1.5" /> Time for a new mask?
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="leaks-cta-fit"
        >
          Re-run the fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
        Educational content only. Persistent therapy issues should be discussed
        with your sleep medicine provider.
      </p>
    </div>
  );
}
