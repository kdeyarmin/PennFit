import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
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
  Truck,
  CreditCard,
  MapPin,
  Stethoscope,
  PackageCheck,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { TrustSignalStrip } from "@/components/trust-signal-strip";
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
    { schema: "Article" },
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

      {/* Trust strip — live aggregate review rating + brand promises.
          Same component the home page uses; gives the marketing surface
          the same social-proof anchor without duplicating copy. */}
      <div className="w-full mb-14">
        <TrustSignalStrip />
      </div>

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

      {/* Side-by-side comparison table — concrete attributes laid out
          flat across all three brands. Desktop table; mobile renders a
          stacked attribute-per-card layout. Honest, not promotional —
          if you're considering ResMed for sizing depth, this should
          reinforce that, not undercut it. */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Honest comparison
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Side by side, across the things that actually matter.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Trade-offs are real. We&apos;d rather you start on the right brand
            than the one we wish you&apos;d picked.
          </p>
        </div>

        {/* Desktop comparison table */}
        <div className="hidden md:block glass-card rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--penn-mist))]/40">
                <th className="text-left p-5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground w-1/4">
                  Attribute
                </th>
                <th className="text-left p-5 bg-[hsl(var(--penn-gold-soft))]/40 relative">
                  <div className="inline-flex items-center gap-2 mb-1">
                    <Award className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))]" />
                    <span className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))]">
                      Flagship
                    </span>
                  </div>
                  <div className="text-base font-bold tracking-tight text-foreground">
                    React Health
                  </div>
                </th>
                <th className="text-left p-5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground mb-1">
                    Most popular
                  </div>
                  <div className="text-base font-bold tracking-tight text-foreground">
                    ResMed
                  </div>
                </th>
                <th className="text-left p-5">
                  <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-muted-foreground mb-1">
                    Best for movers
                  </div>
                  <div className="text-base font-bold tracking-tight text-foreground">
                    Fisher &amp; Paykel
                  </div>
                </th>
              </tr>
            </thead>
            <tbody>
              {[
                {
                  attr: "Origin",
                  rh: "🇺🇸 Engineered in Florida",
                  rm: "🇦🇺 Sydney, Australia",
                  fp: "🇳🇿 Auckland, New Zealand",
                },
                {
                  attr: "Flagship weight",
                  rh: "88g (Rio II)",
                  rm: "131g (AirFit P10)",
                  fp: "115g (Evora)",
                },
                {
                  attr: "Vent noise (10 cmH₂O)",
                  rh: "<24 dBA",
                  rm: "21 dBA",
                  fp: "<25 dBA",
                },
                {
                  attr: "Sizes shipped in box",
                  rh: "All sizes (S/M/L)",
                  rm: "Multiple per box (varies)",
                  fp: "Multiple per box (varies)",
                },
                {
                  attr: "Cushion technology",
                  rh: "Silicone diffuser vent",
                  rm: "QuietAir + AirTouch foam",
                  fp: "RollFit XT + AirPillow",
                },
                {
                  attr: "Sizing matrix depth",
                  rh: "Standard (3–4 options)",
                  rm: "Deepest in industry",
                  fp: "Standard (3–4 options)",
                },
                {
                  attr: "Pressure range",
                  rh: "4–25 cmH₂O",
                  rm: "4–30 cmH₂O (F-series)",
                  fp: "4–25 cmH₂O",
                },
                {
                  attr: "Best for restless sleepers",
                  rh: "Good",
                  rm: "Good",
                  fp: "Best in class",
                },
                {
                  attr: "Typical price tier",
                  rh: "Budget – Standard",
                  rm: "Standard – Premium",
                  fp: "Standard – Premium",
                },
                {
                  attr: "Insurance-eligible",
                  rh: "Yes",
                  rm: "Yes",
                  fp: "Yes",
                },
              ].map((row) => (
                <tr
                  key={row.attr}
                  className="border-t border-border/30 hover:bg-[hsl(var(--penn-mist))]/20 transition-colors"
                >
                  <td className="p-4 font-semibold text-foreground/85">
                    {row.attr}
                  </td>
                  <td className="p-4 bg-[hsl(var(--penn-gold-soft))]/15 text-foreground/85">
                    {row.rh}
                  </td>
                  <td className="p-4 text-muted-foreground">{row.rm}</td>
                  <td className="p-4 text-muted-foreground">{row.fp}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile comparison cards — one per brand with a flat attribute list */}
        <div className="md:hidden space-y-4">
          {[
            {
              name: "React Health",
              badge: "Flagship",
              flagship: true,
              attrs: [
                ["Origin", "US — Florida"],
                ["Weight", "88g (Rio II)"],
                ["Vent noise", "<24 dBA"],
                ["Price tier", "Budget – Standard"],
                ["Strength", "Lightest, quietest, best value"],
              ],
            },
            {
              name: "ResMed",
              badge: "Most popular",
              flagship: false,
              attrs: [
                ["Origin", "Australia — Sydney"],
                ["Weight", "131g (AirFit P10)"],
                ["Vent noise", "21 dBA"],
                ["Price tier", "Standard – Premium"],
                ["Strength", "Deepest sizing matrix, highest pressures"],
              ],
            },
            {
              name: "Fisher & Paykel",
              badge: "Best for movers",
              flagship: false,
              attrs: [
                ["Origin", "New Zealand — Auckland"],
                ["Weight", "115g (Evora)"],
                ["Vent noise", "<25 dBA"],
                ["Price tier", "Standard – Premium"],
                ["Strength", "RollFit motion-following cushions"],
              ],
            },
          ].map((b) => (
            <div
              key={b.name}
              className={
                b.flagship
                  ? "glass-card-tech rounded-2xl p-5 relative overflow-hidden"
                  : "glass-card rounded-2xl p-5"
              }
            >
              {b.flagship && <span className="scan-line" aria-hidden="true" />}
              <div className="relative z-10">
                <div className="flex items-center justify-between mb-3">
                  <div className="text-lg font-bold tracking-tight">
                    {b.name}
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      b.flagship
                        ? "chip-tier-premium border-0 text-[10px]"
                        : "border-0 text-[10px] bg-muted/50"
                    }
                  >
                    {b.badge}
                  </Badge>
                </div>
                <dl className="space-y-2 text-xs">
                  {b.attrs.map(([k, v]) => (
                    <div
                      key={k}
                      className="flex justify-between gap-3 border-b border-border/30 pb-1.5 last:border-0"
                    >
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="font-medium text-foreground/85 text-right">
                        {v}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          ))}
        </div>
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

      {/* Brand FAQ — common cross-brand questions. Lives on the hub
          (not on per-brand pages) because the answers are about how
          PennPaps stocks/ships/insures across the catalog, not about a
          specific mask. Each brand page has its own narrower FAQ. */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Common questions
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Before you pick a brand.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            The questions we hear most often when shoppers are comparing
            React Health, ResMed, and Fisher &amp; Paykel.
          </p>
        </div>

        <div className="glass-card rounded-2xl p-5 md:p-7">
          <Accordion type="single" collapsible className="w-full">
            {[
              {
                q: "Why do you put React Health first?",
                a: "Adherence data. We track which masks our patients are still wearing 90 days in, and React Health systems show up disproportionately in the still-wearing column — lighter, quieter, and meaningfully more affordable for cash-pay shoppers. None of that makes ResMed or Fisher & Paykel a worse choice for the patients who specifically need them; it just makes React Health our default recommendation for a first-time CPAP user with no specific anatomical or pressure constraint.",
              },
              {
                q: "Are all three brands covered by insurance?",
                a: "Yes. Every mask we list is FDA-cleared and covered by Medicare, Medicaid, and most commercial plans the same way. The deciding factor is usually your plan's preferred-supplier list and how much of your annual DME benefit you've already used — not the brand. Get an estimate at /insurance/estimate or call us and we'll run benefits live.",
              },
              {
                q: "What if the mask I pick isn't right?",
                a: "Our comfort guarantee covers a one-time mask exchange within 30 days of delivery if the fit doesn't work out. No re-stocking fee, no insurance impact. See /comfort-guarantee for the specifics. The whole reason we built the fitter is to make this exchange rare — but it's there if you need it.",
              },
              {
                q: "Do I need a prescription?",
                a: "A new CPAP machine requires a prescription. Replacement cushions, headgear, filters, and tubing — the parts you replace on a schedule — do not. We can verify your prescription on file before you check out, or your physician's office can fax/upload it directly.",
              },
              {
                q: "How fast does a mask actually arrive?",
                a: "In-stock complete mask systems ship the same business day if you order before 1pm ET, the next business day otherwise. Standard ground takes 2–4 business days; expedited shipping is available at checkout. Tracking arrives by SMS and email.",
              },
              {
                q: "Can I switch brands later without losing my fit?",
                a: "Yes — your face geometry doesn't change. The fitter result and your saved sizing carry across brand changes. If your insurance allows a replacement mask, we can ship a different brand at the next eligible cycle without you re-running anything.",
              },
            ].map((item, idx) => (
              <AccordionItem
                key={item.q}
                value={`item-${idx}`}
                className={idx === 5 ? "border-b-0" : undefined}
              >
                <AccordionTrigger className="text-base font-semibold tracking-tight text-foreground/90 hover:no-underline py-4">
                  {item.q}
                </AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground leading-relaxed pb-4">
                  {item.a}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </div>

      {/* Why PennPaps credentials block — five trust statements that
          give the marketing surface a clear "why buy here, not Amazon"
          answer. Glass tiles, gold-haloed icons. */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Why PennPaps
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            More than a checkout button.
          </h2>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[
            {
              Icon: MapPin,
              title: "Local Penn DME team",
              body: "Penn Home Medical Supply has fitted CPAP patients in the Greater Philadelphia area for years. The voice on the phone is here, not offshore.",
              halo: "icon-halo-gold",
            },
            {
              Icon: Stethoscope,
              title: "Licensed respiratory therapists",
              body: "Our fit reviews and clinical questions go to credentialed RTs, not chatbots. You get human eyes on every borderline case.",
              halo: "icon-halo-navy",
            },
            {
              Icon: ShieldCheck,
              title: "Insurance billed for you",
              body: "We're contracted with Medicare, Medicaid, and the major commercials. We run benefits, file claims, and handle the paperwork loop.",
              halo: "icon-halo-navy",
            },
            {
              Icon: CreditCard,
              title: "Cash-pay friendly",
              body: "HSA and FSA cards accepted. Transparent pricing with no surprise back-bills — the price at checkout is the price you pay.",
              halo: "icon-halo-gold",
            },
            {
              Icon: Truck,
              title: "Fast, tracked shipping",
              body: "Same-day fulfillment on orders placed before 1pm ET. Discreet packaging, SMS + email tracking, free shipping over $49.",
              halo: "icon-halo-navy",
            },
            {
              Icon: PackageCheck,
              title: "30-day comfort guarantee",
              body: "If your mask doesn't fit right, we exchange it once — no re-stocking fee, no insurance impact. Adherence is the only metric we care about.",
              halo: "icon-halo-gold",
            },
          ].map(({ Icon, title, body, halo }) => (
            <div key={title} className="glass-card rounded-2xl p-6 lift-on-hover">
              <div
                className={`relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 ${halo}`}
              >
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
