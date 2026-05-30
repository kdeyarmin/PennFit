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
  Wind,
  Heart,
  Factory,
  DollarSign,
  Feather,
  Moon,
  CheckCircle2,
  Stethoscope,
  Truck,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import fullFaceImg from "@/assets/masks/full-face.webp";

type FlagshipMask = {
  name: string;
  type: string;
  image: string;
  pitch: string;
  bullets: string[];
  bestFor: string[];
};

const flagshipMasks: FlagshipMask[] = [
  {
    name: "Rio II",
    type: "Nasal Pillow",
    image: nasalPillowImg,
    pitch:
      "The mask we put on more first-time CPAP users than any other. 88g all-in — barely there once you fall asleep.",
    bullets: [
      "Three nasal pillow sizes ship in every box",
      "Diffuser vent measures under 24 dBA at 10 cmH₂O",
      "Magnetic clip headgear — one-handed put-on",
    ],
    bestFor: ["First-time users", "Glasses + reading", "Side sleepers"],
  },
  {
    name: "Viva Nasal",
    type: "Nasal",
    image: nasalImg,
    pitch:
      "Step up to a traditional nasal cushion when you need more pressure tolerance than pillows can deliver — without surrendering quiet operation.",
    bullets: [
      "Silicone cushion seals at pressures up to 25 cmH₂O",
      "Open field of vision — top-of-head tube routing",
      "Three frame sizes, four cushion sizes",
    ],
    bestFor: ["Higher pressures", "Mouth tape users", "Allergies"],
  },
  {
    name: "Numa Full Face",
    type: "Full Face",
    image: fullFaceImg,
    pitch:
      "A surprisingly light full-face cushion for mouth breathers and bilevel patients. Wide field of vision with a low-profile bridge that clears glasses.",
    bullets: [
      "Hybrid silicone cushion — soft sealing edge, firm structural core",
      "Quick-release elbow for nighttime bathroom trips",
      "Compatible with every CPAP we sell",
    ],
    bestFor: ["Mouth breathers", "BiPAP", "Bearded patients"],
  },
];

const whyReactHealth = [
  {
    Icon: Factory,
    title: "Built in Florida",
    body: "Engineered and assembled in the United States. Tariff-free pricing, faster restocks, and a real human on the phone when something needs replaced.",
  },
  {
    Icon: DollarSign,
    title: "Insurance-friendly pricing",
    body: "Often hundreds of dollars less per system than equivalent ResMed or Fisher & Paykel SKUs. Same clinical performance, more left over for cushion replacements.",
  },
  {
    Icon: Feather,
    title: "Genuinely lightweight",
    body: "The Rio II weighs 88g fully assembled. You forget you're wearing it within a week — the single biggest predictor of long-term CPAP adherence.",
  },
  {
    Icon: Wind,
    title: "Quietest exhalation vents on the market",
    body: "React Health's diffuser geometry delivers sub-24 dBA exhaust noise. Your bed partner will thank you.",
  },
  {
    Icon: Moon,
    title: "Designed for real sleepers",
    body: "Magnetic clips, top-routed tubing, cushion sizes that ship with the box — every design choice removes a 3am frustration.",
  },
  {
    Icon: Stethoscope,
    title: "Cleared for the same pressures",
    body: "FDA-cleared for the same 4–25 cmH₂O range as every other mask we stock. The price tag is the only thing that's smaller.",
  },
];

export function CpapMasksReactHealth() {
  useDocumentTitle(
    "React Health CPAP Masks",
    "React Health is our flagship CPAP mask line — US-engineered, ultra-quiet, and lighter than every comparable ResMed or Fisher & Paykel system. Featured: Rio II, Viva, Numa.",
    { schema: "Article" },
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
        <span className="text-foreground/85">React Health</span>
      </div>

      {/* Hero — dark navy gradient with gold accent and best-overall badge */}
      <section className="hero-card w-full mb-14 animate-shimmer-in">
        <div className="relative z-10 max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-20">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-6">
                <span className="status-pill status-pill-gold status-pill-on-dark">
                  <Award className="w-3 h-3 mr-1.5 inline" />
                  Best Overall · PennPaps flagship
                </span>
              </div>

              <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-5 leading-[1.05] text-white">
                React Health.
                <br />
                <span className="hero-headline-swoosh">
                  Your best night, sooner.
                </span>
              </h1>

              <p className="text-base md:text-lg text-white/85 leading-relaxed mb-7">
                US-engineered CPAP masks built for real-world adherence —
                lighter, quieter, and meaningfully more affordable than every
                comparable import-tier system. The mask we hand to most new CPAP
                patients on day one.
              </p>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  size="lg"
                  className="h-13 px-7 rounded-full btn-gold-glow group"
                  data-testid="rh-cta-fit"
                  onClick={() => navigate("/consent")}
                >
                  Match me to a React Health mask
                  <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-13 px-6 rounded-full btn-on-dark-outline"
                  data-testid="rh-cta-shop"
                  onClick={() => navigate("/shop")}
                >
                  Shop the line
                </Button>
              </div>
            </div>

            <div className="hidden lg:block relative">
              <div className="aspect-square w-full bg-white/10 rounded-3xl border border-white/15 backdrop-blur-sm p-8 relative overflow-hidden">
                <span className="scan-line" aria-hidden="true" />
                <img
                  src={nasalPillowImg}
                  alt="React Health Rio II Nasal Pillow Mask"
                  className="w-full h-full object-contain relative z-10"
                  loading="lazy"
                />
                <div className="absolute bottom-5 left-5 right-5 z-10 text-white">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))] mb-1">
                    Featured · 88g
                  </div>
                  <div className="text-lg font-semibold">
                    Rio II Nasal Pillow
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why React Health — six selling points */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Why we put React Health first
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Six reasons it&apos;s our flagship line.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            We don&apos;t sell what wins design awards. We sell what shows up in
            our 90-day adherence data.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {whyReactHealth.map(({ Icon, title, body }) => (
            <div
              key={title}
              className="glass-card rounded-2xl p-6 lift-on-hover"
            >
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-gold">
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

      {/* Flagship masks */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Three masks. Every breathing pattern.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Nasal pillows for most new users, a traditional nasal for higher
            pressures, and a full-face for mouth breathers and BiPAP. All three
            ship in 1–3 business days.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {flagshipMasks.map((m, idx) => (
            <div
              key={m.name}
              className="glass-card rounded-2xl overflow-hidden flex flex-col lift-on-hover"
            >
              <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 relative">
                <img
                  src={m.image}
                  alt={`React Health ${m.name}`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                />
                <Badge className="absolute top-3 left-3 glass-panel text-foreground border-0 font-medium">
                  React Health
                </Badge>
                {idx === 0 && (
                  <Badge className="absolute top-3 right-3 chip-tier-premium border-0 font-medium">
                    <Award className="w-3 h-3 mr-1" /> Top pick
                  </Badge>
                )}
              </div>
              <div className="flex-1 flex flex-col p-6">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1">
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
                        className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
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

      {/* Quote/social proof rail */}
      <div className="w-full glass-card-tech rounded-2xl p-8 md:p-12 mb-20 relative overflow-hidden">
        <span className="scan-line" aria-hidden="true" />
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <div className="flex justify-center mb-5">
            <Heart
              className="w-8 h-8 text-[hsl(var(--penn-gold))]"
              fill="currentColor"
            />
          </div>
          <blockquote className="text-display text-xl md:text-2xl font-semibold tracking-tight text-foreground/85 leading-relaxed mb-5">
            &ldquo;I&apos;d been on a ResMed P10 for two years and assumed every
            nasal pillow felt the same. The Rio II is a third the price and I
            genuinely sleep through to morning now.&rdquo;
          </blockquote>
          <div className="text-sm font-medium text-foreground/70">
            — Verified PennPaps patient · West Chester, PA
          </div>
        </div>
      </div>

      {/* FAQ — React-Health-specific objections. Five questions
          answering the most common things shoppers ask before
          committing to the flagship line. */}
      <div className="w-full mb-12">
        <div className="text-center max-w-2xl mx-auto mb-6">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-2">
            React Health questions, answered.
          </h2>
          <p className="text-sm text-muted-foreground">
            The specific things shoppers ask before switching from a name they
            recognize.
          </p>
        </div>
        <div className="glass-card rounded-2xl p-5 md:p-7">
          <Accordion type="single" collapsible className="w-full">
            {[
              {
                q: "I've never heard of React Health. Is it a real brand?",
                a: "Yes — React Health is the rebrand of 3B Medical, a US respiratory equipment maker that's been in CPAP since 2009 and now owns Sefam (Europe) and the Luna line of devices. They're FDA-cleared, ECRI-vetted, and stocked by DMEs nationwide. The reason their masks feel like an upstart is that ResMed and Philips' marketing budgets are roughly 100× theirs.",
              },
              {
                q: "How is it cheaper if it's clinically equivalent?",
                a: "Three reasons. (1) US engineering and assembly avoids the import tariff stack the Australian and New Zealand brands carry. (2) Smaller marketing spend — no Super Bowl ads, no celebrity endorsements. (3) Direct-to-DME relationships skip a layer of distribution markup. None of those affect the silicone or the diffuser geometry on the cushion itself.",
              },
              {
                q: "My sleep lab fit me in ResMed. Can I switch?",
                a: "Yes. The mask types map cleanly — Rio II is the React Health analog of the AirFit P10, Viva of the AirFit N20, and Numa of the AirFit F30. Your prescribed pressure, your face geometry, and your AHI target don't change. We can run the fitter on file and recommend the closest React Health equivalent.",
              },
              {
                q: "Is the cushion replacement schedule the same?",
                a: "Yes — every 30 days for nasal pillows, 90 days for cushions and headgear, six months for tubing, the same as ResMed and F&P. Insurance allowables are the same. Our resupply program ships React Health cushions on the same cadence as the other brands.",
              },
              {
                q: "What if I want to try it but I'm not sure?",
                a: "Our 30-day comfort guarantee covers a one-time mask exchange — including into a different brand. Try the Rio II, and if it doesn't work, exchange it for an AirFit P10 or an F&P Brevida. No re-stocking fee, no insurance impact.",
              },
            ].map((item, idx) => (
              <AccordionItem
                key={item.q}
                value={`item-${idx}`}
                className={idx === 4 ? "border-b-0" : undefined}
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

      {/* Share rail — these brand pages double as awareness content
          for the React Health line, and the comfort/value angle is
          worth forwarding to a friend who's struggling with a heavier
          mask. */}
      <div className="w-full mb-12">
        <ShareArticle
          path="/cpap-masks/react-health"
          title="React Health CPAP masks — lighter, quieter, better value"
          blurb="If you or someone you know is on CPAP and the mask is the problem, take a look at React Health. The Rio II is 88g and a third the price of equivalents."
          testIdPrefix="share-react-health"
        />
      </div>

      {/* Bottom dual CTA */}
      <div className="w-full grid md:grid-cols-2 gap-5 mb-10">
        <div className="glass-card rounded-2xl p-7 flex flex-col">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-gold">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h3 className="text-xl font-bold tracking-tight mb-2">
            Run the fitter first
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            Three minutes of face capture plus a short questionnaire returns the
            best-fit React Health mask for your face geometry and breathing
            pattern.
          </p>
          <Button
            className="self-start h-11 px-6 rounded-full btn-primary-glow group"
            data-testid="rh-bottom-cta-fit"
            onClick={() => navigate("/consent")}
          >
            Start the fitter
            <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
          </Button>
        </div>
        <div className="glass-card rounded-2xl p-7 flex flex-col">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-navy">
            <Truck className="w-5 h-5" strokeWidth={2} />
          </div>
          <h3 className="text-xl font-bold tracking-tight mb-2">
            Know what you want?
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            Jump straight to the shop — Rio II, Viva, and Numa systems plus
            replacement cushions and headgear, ready to ship.
          </p>
          <Button
            variant="outline"
            className="self-start h-11 px-6 rounded-full glass-panel hover:border-primary/40"
            data-testid="rh-bottom-cta-shop"
            onClick={() => navigate("/shop")}
          >
            Shop React Health
          </Button>
        </div>
      </div>
    </div>
  );
}
