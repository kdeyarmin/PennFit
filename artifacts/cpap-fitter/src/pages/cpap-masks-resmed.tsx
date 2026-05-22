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
  ShieldCheck,
  Globe2,
  Wind,
  CheckCircle2,
  Layers,
  Award,
  Activity,
  Heart,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import fullFaceImg from "@/assets/masks/full-face.webp";

type ResMedMask = {
  name: string;
  type: string;
  image: string;
  pitch: string;
  bullets: string[];
  bestFor: string[];
};

const masks: ResMedMask[] = [
  {
    name: "AirFit F30i",
    type: "Full Face · Top-of-head tube",
    image: fullFaceImg,
    pitch:
      "ResMed's flagship under-the-nose full-face. The tube routes up over the crown so you can sleep on your stomach or read in bed without a hose across your face.",
    bullets: [
      "Under-the-nose cushion clears the bridge of the nose",
      "QuietAir vent — 21 dBA",
      "Four cushion + four frame sizes",
    ],
    bestFor: ["Stomach sleepers", "Glasses + reading", "Claustrophobia"],
  },
  {
    name: "AirFit N30i",
    type: "Nasal · Top-of-head tube",
    image: nasalImg,
    pitch:
      "The nasal version of the F30i geometry. A cradle cushion that sits under the nose instead of around it, with the same top-of-head tube routing.",
    bullets: [
      "Nasal cradle seal — minimal facial contact",
      "QuietAir vent — 21 dBA",
      "Sleek frame compatible with AirFit P30i pillows",
    ],
    bestFor: ["Active sleepers", "Bedtime readers", "Claustrophobia"],
  },
  {
    name: "AirFit P10",
    type: "Nasal Pillow",
    image: nasalPillowImg,
    pitch:
      "The mask that sleep labs hand to anxious first-timers. ResMed's QuietAir diffuser made the P10 the quietest mask on the market for years.",
    bullets: [
      "Iconic split-strap headgear — 11oz total weight",
      "Quietest CPAP mask ever tested at launch",
      "Pillow sizes XS through L ship in the box",
    ],
    bestFor: ["First-time users", "Light sleepers", "Travel"],
  },
];

const whyResmed = [
  {
    Icon: Layers,
    title: "The deepest sizing matrix in the industry",
    body: "Across AirFit and AirTouch, ResMed offers more cushion and frame combinations than any other manufacturer. Hard-to-fit faces have somewhere to land.",
  },
  {
    Icon: Wind,
    title: "QuietAir diffuser vent technology",
    body: "ResMed's vent geometry pioneered sub-25 dBA exhaust noise. Their P10 still anchors the quiet-mask category 12 years after launch.",
  },
  {
    Icon: Globe2,
    title: "Worldwide clinical footprint",
    body: "Used in more sleep labs and titration studies than any other brand. If your physician sized you in-clinic, they likely sized you in a ResMed.",
  },
  {
    Icon: Activity,
    title: "AirTouch memory foam fallback",
    body: "When silicone causes pressure marks, AirTouch swaps in a UltraSoft memory-foam cushion. The same frame — only the cushion changes.",
  },
  {
    Icon: ShieldCheck,
    title: "Proven through high pressures",
    body: "AirFit F-series seals reliably up to 30 cmH₂O — the right call for BiPAP and complex sleep apnea patients with elevated treatment pressures.",
  },
  {
    Icon: Award,
    title: "The category-defining brand",
    body: "If a feature is now standard across CPAP masks, there's an even chance ResMed introduced it first. The price reflects that legacy.",
  },
];

export function CpapMasksResmed() {
  useDocumentTitle(
    "ResMed CPAP Masks",
    "ResMed AirFit and AirTouch CPAP masks at PennPaps — the market-leading line with the deepest sizing matrix. Featured: AirFit F30i, AirFit N30i, AirFit P10.",
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
        <span className="text-foreground/85">ResMed</span>
      </div>

      {/* Hero */}
      <section className="hero-card w-full mb-14 animate-shimmer-in">
        <div className="relative z-10 max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-20">
          <div className="grid lg:grid-cols-2 gap-10 items-center">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-6">
                <span className="status-pill status-pill-gold status-pill-on-dark">
                  Most Popular · Market-leading brand
                </span>
              </div>

              <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight mb-5 leading-[1.05] text-white">
                ResMed.
                <br />
                <span className="hero-headline-swoosh">The category leader.</span>
              </h1>

              <p className="text-base md:text-lg text-white/85 leading-relaxed mb-7">
                The mask line your sleep lab almost certainly fit you in.
                AirFit and AirTouch deliver the deepest sizing matrix in the
                industry, the QuietAir vent that set the quiet-mask standard,
                and a clinical record measured in tens of millions of patient
                nights.
              </p>

              <div className="flex flex-col sm:flex-row gap-3">
                <Button
                  size="lg"
                  className="h-13 px-7 rounded-full btn-gold-glow group"
                  data-testid="resmed-cta-fit"
                  onClick={() => navigate("/consent")}
                >
                  Match me to a ResMed mask
                  <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
                </Button>
                <Button
                  size="lg"
                  variant="outline"
                  className="h-13 px-6 rounded-full btn-on-dark-outline"
                  data-testid="resmed-cta-shop"
                  onClick={() => navigate("/shop")}
                >
                  Shop the line
                </Button>
              </div>
            </div>

            <div className="hidden lg:block relative">
              <div className="aspect-square w-full bg-white/10 rounded-3xl border border-white/15 backdrop-blur-sm p-8 relative overflow-hidden">
                <img
                  src={fullFaceImg}
                  alt="ResMed AirFit F30i Full Face Mask"
                  className="w-full h-full object-contain"
                  loading="lazy"
                />
                <div className="absolute bottom-5 left-5 right-5 z-10 text-white">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))] mb-1">
                    Featured · 21 dBA
                  </div>
                  <div className="text-lg font-semibold">AirFit F30i</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Why ResMed */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Why ResMed
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Why ResMed remains the gold standard.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            We recommend ResMed when sizing complexity, sleep-lab continuity,
            or pressure tolerance is the deciding factor.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {whyResmed.map(({ Icon, title, body }) => (
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
            The three ResMed masks we stock most.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            From the iconic AirFit P10 to the modern under-the-nose AirFit
            F30i — the systems that cover the largest patient population.
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
                  alt={`ResMed ${m.name}`}
                  className="w-full h-full object-contain p-4"
                  loading="lazy"
                />
                <Badge className="absolute top-3 left-3 glass-panel text-foreground border-0 font-medium">
                  ResMed
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

      {/* Testimonial — sleep-lab continuity angle. Specific to ResMed
          because the most common reason patients pick ResMed is "I was
          fit in one at the lab." */}
      <div className="w-full glass-card-tech rounded-2xl p-8 md:p-12 mb-12 relative overflow-hidden">
        <span className="scan-line" aria-hidden="true" />
        <div className="relative z-10 max-w-3xl mx-auto text-center">
          <div className="flex justify-center mb-5">
            <Heart
              className="w-8 h-8 text-[hsl(var(--penn-gold))]"
              fill="currentColor"
            />
          </div>
          <blockquote className="text-display text-xl md:text-2xl font-semibold tracking-tight text-foreground/85 leading-relaxed mb-5">
            &ldquo;The sleep lab put me in an AirFit P10 four years ago and
            I&apos;ve worn one every night since. PennPaps had it on
            auto-resupply within an hour of my first order. I haven&apos;t
            thought about cushions since.&rdquo;
          </blockquote>
          <div className="text-sm font-medium text-foreground/70">
            — Verified PennPaps patient · Drexel Hill, PA
          </div>
        </div>
      </div>

      {/* ResMed-specific FAQ */}
      <div className="w-full mb-12">
        <div className="text-center max-w-2xl mx-auto mb-6">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-2">
            ResMed questions, answered.
          </h2>
          <p className="text-sm text-muted-foreground">
            The questions shoppers ask most when sticking with what their
            sleep lab fit them in.
          </p>
        </div>
        <div className="glass-card rounded-2xl p-5 md:p-7">
          <Accordion type="single" collapsible className="w-full">
            {[
              {
                q: "Does PennPaps stock the AirFit F40 / the newest cushion?",
                a: "We stock the AirFit F30i, F30, F40, N30i, N20, P10, P30i, and the AirTouch F20 / N20 memory-foam variants. If you need a specific cushion size or a less-common SKU, call us — most ResMed inventory is one business day away even when it's not on the shelf.",
              },
              {
                q: "Will my insurance cover an AirTouch / memory-foam mask?",
                a: "Yes, the same way it covers AirFit. AirTouch is a cushion swap on the same frame — your DME billing codes don't change. The catch: AirTouch cushions are replaced more often than silicone (every 30 days instead of 90), and not every plan reimburses the higher cadence. We run benefits before shipping.",
              },
              {
                q: "What's the difference between AirFit N30i and N30?",
                a: "The 'i' suffix means top-of-head tube routing — the hose attaches at the crown of your head rather than at the front. Same cushion, same seal pressure. N30i is better for stomach sleepers, claustrophobic sleepers, and bedtime readers. N30 is lower-profile and slightly lighter.",
              },
              {
                q: "I'm on a ResMed AirSense. Do I have to use a ResMed mask?",
                a: "No — every mask we sell works with every CPAP we sell. The mask and machine are independent devices joined by a standard 22mm hose. Mixing brands (e.g. Rio II on an AirSense) is common and clinically equivalent.",
              },
              {
                q: "How fast does a ResMed mask actually arrive?",
                a: "In-stock systems ship the same business day if ordered before 1pm ET. Most ResMed cushion sizes are in-stock. Backorder windows happen occasionally on newer SKUs (the F40 saw early supply tightness); we surface live availability on the product page.",
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

      {/* Share rail */}
      <div className="w-full mb-12">
        <ShareArticle
          path="/cpap-masks/resmed"
          title="ResMed CPAP masks at PennPaps"
          blurb="The market-leading line with the deepest sizing matrix in CPAP. Full AirFit and AirTouch catalog with same-day shipping and insurance billed for you."
          testIdPrefix="share-resmed"
        />
      </div>

      {/* Compare to React Health rail */}
      <div className="w-full glass-panel rounded-2xl p-7 md:p-9 mb-12">
        <div className="grid md:grid-cols-[1fr_auto] gap-6 items-center">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-gold-deep))] mb-2">
              Considering the alternative?
            </div>
            <h3 className="text-xl md:text-2xl font-bold tracking-tight mb-2">
              See how ResMed compares to our flagship React Health line.
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              React Health typically comes in 30–40% lighter at a noticeably
              lower price — but if you need ResMed&apos;s sizing depth or
              pressure ceiling, it&apos;s the right call.
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
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3 text-foreground/90">
          Let the fitter narrow it down.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-xl mx-auto mb-7">
          ResMed offers 30+ AirFit and AirTouch SKUs. Three minutes of face
          capture plus a short questionnaire returns the right one for you.
        </p>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          data-testid="resmed-bottom-cta-fit"
          onClick={() => navigate("/consent")}
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>
    </div>
  );
}
