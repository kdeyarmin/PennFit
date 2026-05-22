import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Award,
  Sparkles,
  ShieldCheck,
  Wind,
  Heart,
  Globe2,
  Factory,
  Leaf,
  Star,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import fullFaceImg from "@/assets/masks/full-face.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";

type Brand = {
  slug: string;
  name: string;
  tagline: string;
  positioning: string;
  flagship: string;
  image: string;
  href: string;
  badge?: string;
  highlights: Array<{ Icon: typeof Award; label: string }>;
};

const brands: Brand[] = [
  {
    slug: "react-health",
    name: "React Health",
    tagline: "Our flagship line. Best-in-class fit, comfort, and value.",
    positioning:
      "US-engineered, lightweight, ultra-quiet, and priced so insurance and cash-pay patients alike get a clinically excellent mask without the import-tier markup. Our top recommendation for most new CPAP users.",
    flagship: "Rio II Nasal Pillow · Numa Full Face",
    image: nasalPillowImg,
    href: "/cpap-masks/react-health",
    badge: "Best Overall",
    highlights: [
      { Icon: Factory, label: "Engineered in Florida" },
      { Icon: Wind, label: "Ultra-quiet diffuser vent" },
      { Icon: Heart, label: "Minimal-contact frame" },
    ],
  },
  {
    slug: "resmed",
    name: "ResMed",
    tagline: "The market leader — broadest catalog, proven clinical record.",
    positioning:
      "The mask line most sleep labs grew up on. AirFit and AirTouch cushions deliver excellent seal across pressure ranges, with the deepest size matrix in the industry.",
    flagship: "AirFit F30i · AirFit N30i · AirFit P10",
    image: fullFaceImg,
    href: "/cpap-masks/resmed",
    badge: "Most Popular",
    highlights: [
      { Icon: Award, label: "Industry-leading sizing matrix" },
      { Icon: ShieldCheck, label: "QuietAir diffuser vent" },
      { Icon: Globe2, label: "Worldwide clinical footprint" },
    ],
  },
  {
    slug: "fisher-paykel",
    name: "Fisher & Paykel",
    tagline: "Innovative cushion technology. Designed in New Zealand.",
    positioning:
      "Famous for the RollFit and AirPillow cushions that adjust as you move. A go-to for side and stomach sleepers who shift overnight, plus the gentlest foam options for sensitive skin.",
    flagship: "Evora · Brevida · Vitera · Solo",
    image: nasalImg,
    href: "/cpap-masks/fisher-paykel",
    badge: "Best for Movers",
    highlights: [
      { Icon: Leaf, label: "Low-waste packaging" },
      { Icon: Sparkles, label: "RollFit auto-adjusting seal" },
      { Icon: Heart, label: "Foam cushion options" },
    ],
  },
];

export function CpapMasks() {
  useDocumentTitle(
    "CPAP Mask Brands",
    "Compare CPAP masks from React Health, ResMed, and Fisher & Paykel — the three brands PennPaps carries, with our top picks and a clinically-matched fitter.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Hero — dark navy gradient card matching home.tsx language */}
      <section className="hero-card w-full mb-14 md:mb-20 animate-shimmer-in">
        <div className="relative z-10 text-center max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-20">
          <div className="flex flex-wrap items-center justify-center gap-2 mb-7">
            <span className="status-pill status-pill-gold status-pill-on-dark">
              Three brands. One curated catalog.
            </span>
          </div>

          <h1 className="text-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-[1.08] text-white">
            The right mask
            <br />
            <span className="hero-headline-swoosh">changes everything.</span>
          </h1>

          <p className="text-base sm:text-lg md:text-xl text-white/80 leading-relaxed mb-9 max-w-2xl mx-auto">
            We don&apos;t carry every mask on the market — only the ones our
            clinicians stand behind. Browse our flagship{" "}
            <span className="font-semibold text-white">React Health</span> line,
            plus full-line support for{" "}
            <span className="font-semibold text-white">ResMed</span> and{" "}
            <span className="font-semibold text-white">Fisher &amp; Paykel</span>.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button
              size="lg"
              className="h-14 px-8 text-base font-semibold rounded-full btn-gold-glow group"
              data-testid="brands-cta-fit"
              onClick={() => navigate("/consent")}
            >
              Get matched in 3 minutes
              <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-0.5" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-14 px-6 text-base rounded-full btn-on-dark-outline gap-2"
              data-testid="brands-cta-catalog"
              onClick={() => navigate("/masks")}
            >
              Browse the full catalog
            </Button>
          </div>
        </div>
      </section>

      {/* Section eyebrow */}
      <div className="w-full max-w-3xl mx-auto text-center mb-10">
        <div className="flex justify-center mb-3">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              The brands we carry
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
          Picked for clinical performance, not catalog count.
        </h2>
        <p className="text-muted-foreground leading-relaxed">
          Every mask on this site passes a three-point screen with our
          respiratory therapists: seal stability across the prescribed pressure
          range, cushion durability over the 90-day replacement cycle, and
          real-world quiet under 26 dBA. The three brands below are the only
          ones that consistently clear all three.
        </p>
      </div>

      {/* Brand cards — React Health card uses the gold-trimmed "tech" treatment
          (same language as the featured fitter card on home.tsx) to signal
          flagship status without burying the other two. */}
      <div className="w-full grid grid-cols-1 lg:grid-cols-3 gap-5 mb-20">
        {brands.map((b, idx) => {
          const isFlagship = idx === 0;
          return (
            <Link
              key={b.slug}
              href={b.href}
              className={
                isFlagship
                  ? "glass-card-tech lift-on-hover rounded-2xl p-7 relative overflow-hidden flex flex-col text-left group"
                  : "glass-card lift-on-hover rounded-2xl p-7 flex flex-col text-left group"
              }
              data-testid={`brand-card-${b.slug}`}
            >
              {isFlagship && <span className="scan-line" aria-hidden="true" />}

              <div className="flex items-start justify-between mb-5 relative z-10">
                <div className="inline-flex items-center gap-3">
                  <div className="h-px w-6 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
                  <span className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-gold-deep))]">
                    {b.badge}
                  </span>
                </div>
                {isFlagship && (
                  <Award
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))]"
                    aria-hidden="true"
                  />
                )}
              </div>

              <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 rounded-xl border border-border/40 mb-5 overflow-hidden relative z-10">
                <img
                  src={b.image}
                  alt={`${b.name} CPAP mask`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                  decoding="async"
                />
              </div>

              <h3
                className={
                  isFlagship
                    ? "text-display text-2xl md:text-3xl font-bold tracking-tight mb-2 relative z-10"
                    : "text-2xl font-bold tracking-tight mb-2 text-foreground/90 relative z-10"
                }
              >
                {isFlagship ? (
                  <span className="text-gradient-tech">{b.name}</span>
                ) : (
                  b.name
                )}
              </h3>

              <p className="text-sm font-medium text-foreground/80 mb-3 relative z-10">
                {b.tagline}
              </p>

              <p className="text-sm text-muted-foreground leading-relaxed mb-5 relative z-10">
                {b.positioning}
              </p>

              <ul className="space-y-2 mb-5 relative z-10">
                {b.highlights.map(({ Icon, label }) => (
                  <li
                    key={label}
                    className="flex items-center gap-2.5 text-xs text-foreground/80"
                  >
                    <Icon
                      className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]/75 shrink-0"
                      strokeWidth={2}
                      aria-hidden="true"
                    />
                    <span>{label}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-auto pt-3 border-t border-border/40 relative z-10">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                  Featured masks
                </div>
                <div className="text-xs text-foreground/85 mb-4">
                  {b.flagship}
                </div>
                <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all">
                  Explore {b.name}
                  <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Why these three — a quick comparison rail */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Not sure which brand is right for you?
          </h2>
          <p className="text-muted-foreground">
            A 30-second cheat sheet — then run the fitter for a clinical match.
          </p>
        </div>

        <div className="glass-panel rounded-2xl p-2 sm:p-3">
          <div className="grid sm:grid-cols-3 gap-1 sm:gap-2">
            {[
              {
                title: "New to CPAP",
                body: "Start with React Health. Lightest seal pressure, lowest learning curve, and the price difference frees up budget for filters and cushion replacements.",
                cta: "See React Health",
                href: "/cpap-masks/react-health",
                halo: "icon-halo-gold",
                Icon: Star,
              },
              {
                title: "Hard-to-fit faces",
                body: "ResMed's sizing matrix is the deepest in the industry — six AirFit cushion shapes plus AirTouch memory foam fallbacks.",
                cta: "See ResMed",
                href: "/cpap-masks/resmed",
                halo: "icon-halo-navy",
                Icon: ShieldCheck,
              },
              {
                title: "Side or stomach sleepers",
                body: "Fisher & Paykel's RollFit cushion rocks with you as you turn. Best leak resistance for restless sleepers in our testing.",
                cta: "See Fisher & Paykel",
                href: "/cpap-masks/fisher-paykel",
                halo: "icon-halo-navy",
                Icon: Heart,
              },
            ].map(({ title, body, cta, href, halo, Icon }) => (
              <Link
                key={title}
                href={href}
                className="rounded-xl p-5 flex items-start gap-3 hover:bg-white/55 transition group"
              >
                <div
                  className={`relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${halo}`}
                >
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm font-semibold tracking-tight mb-1">
                    {title}
                  </span>
                  <span className="text-xs text-muted-foreground leading-relaxed mb-2">
                    {body}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-primary group-hover:gap-1.5 transition-all">
                    {cta}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Bottom CTA — fitter reminder */}
      <div className="w-full glass-card rounded-2xl p-8 md:p-10 text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> Clinical match
        </Badge>
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3 text-foreground/90">
          Skip the guesswork — let the fitter pick.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-xl mx-auto mb-7">
          Three minutes of on-device face capture plus a short sleep
          questionnaire returns a ranked list across all three brands. No
          images leave your browser.
        </p>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          data-testid="brands-bottom-cta-fit"
          onClick={() => navigate("/consent")}
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>
    </div>
  );
}
