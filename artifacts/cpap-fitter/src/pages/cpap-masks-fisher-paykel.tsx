import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Heart,
  Leaf,
  Sparkles,
  CheckCircle2,
  Droplets,
  Wind,
  MapPin,
  Moon,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import fullFaceImg from "@/assets/masks/full-face.webp";

type FpMask = {
  name: string;
  type: string;
  image: string;
  pitch: string;
  bullets: string[];
  bestFor: string[];
};

const masks: FpMask[] = [
  {
    name: "Evora",
    type: "Nasal · Compact",
    image: nasalImg,
    pitch:
      "Fisher & Paykel's most compact nasal mask. The CapFit headgear acts like a baseball cap — pull it on, no buckles to tighten, no straps to trap your hair.",
    bullets: [
      "Front-routed AutoFit short tube — easy bedside attachment",
      "RollFit XT cushion follows the bridge of the nose",
      "Three frame sizes plus VisionFit clear bridge",
    ],
    bestFor: ["Side sleepers", "Glasses", "Anti-claustrophobia"],
  },
  {
    name: "Brevida",
    type: "Nasal Pillow",
    image: nasalPillowImg,
    pitch:
      "The AirPillow cushion lightly inflates around the nostrils rather than wedging into them. The most comfortable nasal pillow we stock for shoppers who couldn't tolerate a P10.",
    bullets: [
      "AirPillow gentle-seal cushion",
      "Stability wings cup the upper lip — no slippage",
      "Two cushion sizes cover XS through L",
    ],
    bestFor: ["Sensitive skin", "Nostril irritation", "First-time pillows"],
  },
  {
    name: "Vitera",
    type: "Full Face",
    image: fullFaceImg,
    pitch:
      "F&P's traditional over-the-nose full-face. The RollFit XT cushion rolls along with you when you change positions — the lowest leak rate we measure in restless sleepers.",
    bullets: [
      "RollFit XT cushion auto-adjusts to motion",
      "EasyClip headgear — magnetic side release",
      "Three cushion sizes ship in the box",
    ],
    bestFor: ["Restless sleepers", "Mouth breathers", "Larger faces"],
  },
];

const whyFp = [
  {
    Icon: Sparkles,
    title: "RollFit cushion technology",
    body: "Fisher & Paykel's signature cushion rolls along the bridge of your nose as you shift position. The best leak resistance we've ever measured in side sleepers.",
  },
  {
    Icon: Droplets,
    title: "AirPillow gentle-seal nasal pillows",
    body: "Rather than wedging silicone into the nostril, the Brevida's pillows inflate around the opening. The right choice for anyone irritated by traditional pillows.",
  },
  {
    Icon: Moon,
    title: "Designed for real overnight motion",
    body: "F&P's R&D centers around how the human face moves during the eight hours you actually wear the mask — not the seal you get sitting upright in clinic.",
  },
  {
    Icon: Leaf,
    title: "Low-impact packaging",
    body: "Recyclable molded-pulp inserts replace foam blocks across the AirFit-equivalent SKUs. A meaningful step in a category that ships a lot of cardboard.",
  },
  {
    Icon: Wind,
    title: "Whisper-quiet diffuser vents",
    body: "F&P's bias-flow vent geometry routes exhaled air downward and away from your bed partner. Subjectively the gentlest airflow in our side-by-side testing.",
  },
  {
    Icon: MapPin,
    title: "Designed in New Zealand",
    body: "Independent of the US/AU duopoly. F&P's design team has been refining respiratory products in Auckland since 1971.",
  },
];

export function CpapMasksFisherPaykel() {
  useDocumentTitle(
    "Fisher & Paykel CPAP Masks",
    "Fisher & Paykel CPAP masks at PennPaps — RollFit and AirPillow cushion technology designed in New Zealand. Featured: Evora, Brevida, Vitera.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Breadcrumb */}
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link
          href="/cpap-masks"
          className="hover:text-primary transition-colors"
        >
          Brands
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Fisher &amp; Paykel</span>
      </div>

      {/* Hero */}
      <section className="hero-card w-full mb-14 animate-shimmer-in">
        <div className="relative z-10 max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-20">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-6">
                <span className="status-pill status-pill-gold status-pill-on-dark">
                  Best for Movers · Designed in New Zealand
                </span>
              </div>

              <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-5 leading-[1.05] text-white">
                Fisher &amp; Paykel.
                <br />
                <span className="hero-headline-swoosh">A cushion that moves with you.</span>
              </h1>

              <p className="text-base md:text-lg text-white/85 leading-relaxed mb-7">
                Five decades of respiratory engineering out of Auckland. F&amp;P&apos;s
                RollFit XT and AirPillow cushions adjust as you shift through the
                night — the best leak resistance we&apos;ve ever measured in side
                and stomach sleepers.
              </p>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  size="lg"
                  className="h-13 px-7 rounded-full btn-gold-glow group"
                  data-testid="fp-cta-fit"
                  onClick={() => navigate("/consent")}
                >
                  Match me to an F&amp;P mask
                  <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-13 px-6 rounded-full btn-on-dark-outline"
                  data-testid="fp-cta-shop"
                  onClick={() => navigate("/shop")}
                >
                  Shop the line
                </Button>
              </div>
            </div>

            <div className="hidden lg:block relative">
              <div className="aspect-square w-full bg-white/10 rounded-3xl border border-white/15 backdrop-blur-sm p-8 relative overflow-hidden">
                <img
                  src={nasalImg}
                  alt="Fisher & Paykel Evora Nasal Mask"
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
                <div className="absolute bottom-5 left-5 right-5 z-10 text-white">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))] mb-1">
                    Featured · CapFit headgear
                  </div>
                  <div className="text-lg font-semibold">F&amp;P Evora</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why F&P */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Why Fisher &amp; Paykel
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            The engineering reads like a sleep lab&apos;s wish list.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            We recommend F&amp;P when overnight motion, nostril sensitivity, or
            sustainability are deciding factors.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {whyFp.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="glass-card rounded-2xl p-6 lift-on-hover"
            >
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-navy">
                <Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-base font-semibold tracking-tight mb-2">
                {title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Featured masks */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            The Fisher &amp; Paykel masks we stock.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Evora for the everyday nasal sleeper, Brevida for sensitive
            nostrils, and Vitera for full-face mouth breathers.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {masks.map((m) => (
            <div
              key={m.name}
              className="glass-card rounded-2xl overflow-hidden flex flex-col lift-on-hover"
            >
              <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 relative">
                <img
                  src={m.image}
                  alt={`Fisher & Paykel ${m.name}`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                />
                <Badge className="absolute top-3 left-3 glass-panel text-foreground border-0 font-medium">
                  Fisher &amp; Paykel
                </Badge>
              </div>
              <div className="flex-1 flex flex-col p-6">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-navy))]/70 mb-1">
                  {m.type}
                </div>
                <h3 className="text-xl font-bold tracking-tight mb-3">
                  {m.name}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  {m.pitch}
                </p>
                <ul className="space-y-2 mb-5">
                  {m.bullets.map((b) => (
                    <li
                      key={b}
                      className="flex items-start gap-2 text-xs text-foreground/85"
                    >
                      <CheckCircle2
                        className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]/75 mt-0.5 shrink-0"
                        strokeWidth={2.5}
                      />
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto pt-4 border-t border-border/40">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                    Best for
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {m.bestFor.map((tag) => (
                      <Badge
                        key={tag}
                        variant="outline"
                        className="text-xs font-normal"
                      >
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Compare back to flagship */}
      <div className="w-full glass-panel rounded-2xl p-7 md:p-9 mb-12">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-gold-deep))] mb-2">
              See our flagship
            </div>
            <h3 className="text-xl md:text-2xl font-bold tracking-tight mb-2">
              React Health is our top recommendation for most new users.
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              If you&apos;re not specifically chasing the RollFit cushion or
              AirPillow technology, our React Health line costs noticeably
              less and is lighter overnight. Worth a side-by-side look.
            </p>
          </div>
          <Button
            variant="outline"
            className="h-11 px-6 rounded-full glass-card hover:border-primary/40 self-start md:self-center"
            asChild
          >
            <Link href="/cpap-masks/react-health">
              See React Health
              <ArrowRight className="w-4 h-4 ml-1.5" />
            </Link>
          </Button>
        </div>
      </div>

      {/* Bottom CTA */}
      <div className="w-full glass-card rounded-2xl p-8 md:p-10 text-center">
        <div className="flex justify-center mb-3">
          <Heart
            className="w-6 h-6 text-[hsl(var(--penn-gold))]"
            fill="currentColor"
          />
        </div>
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3 text-foreground/90">
          Try Fisher &amp; Paykel with the fitter.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-xl mx-auto mb-7">
          Three minutes of face capture plus a short questionnaire returns
          the best Evora, Brevida, or Vitera for your face geometry and sleep
          posture.
        </p>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          data-testid="fp-bottom-cta-fit"
          onClick={() => navigate("/consent")}
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>
    </div>
  );
}
