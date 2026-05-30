import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Moon,
  HeartPulse,
  Sparkles,
  Wind,
  ClipboardList,
  Plane,
  Sunrise,
  ShieldCheck,
  Stethoscope,
  BookOpen,
  Heart,
  Compass,
  Search,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Section = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  eyebrow: string;
  title: string;
  body: string;
  links: Array<{ href: string; label: string }>;
};

const sections: Section[] = [
  {
    Icon: Moon,
    eyebrow: "What is it",
    title: "Sleep apnea: the disease.",
    body: "Sleep apnea is a sleep-disordered breathing condition where the airway repeatedly closes (obstructive), or the brain stops signaling breath (central). Affects ~30 million US adults — 80% of them undiagnosed.",
    links: [
      {
        href: "/learn/sleep-apnea-explained",
        label: "What sleep apnea really is",
      },
      {
        href: "/learn/sleep-apnea-quiz",
        label: "Take the STOP-BANG self-screener",
      },
      { href: "/learn/myths-debunked", label: "Common myths, debunked" },
    ],
  },
  {
    Icon: HeartPulse,
    eyebrow: "What it costs",
    title: "Why treatment isn't optional.",
    body: "Untreated sleep apnea drives hypertension, AFib, stroke, type 2 diabetes, depression, and a 2.5× crash risk on the road. Most of it reverses with consistent therapy.",
    links: [
      {
        href: "/learn/health-risks",
        label: "Hidden health costs of untreated apnea",
      },
      {
        href: "/learn/sleep-apnea-heart-health",
        label: "Sleep apnea & your heart",
      },
      {
        href: "/learn/pap-therapy-benefits",
        label: "What treatment actually feels like",
      },
    ],
  },
  {
    Icon: Wind,
    eyebrow: "How treatment works",
    title: "PAP therapy: the mechanism.",
    body: "A gentle stream of pressurized air keeps your airway open while you sleep. Not oxygen, not a ventilator — a pneumatic splint. Four modes (CPAP, APAP, BiPAP, ASV) for different patient profiles.",
    links: [
      { href: "/learn/how-pap-works", label: "How PAP therapy actually works" },
      { href: "/learn/therapy-types", label: "CPAP vs APAP vs BiPAP vs ASV" },
      { href: "/cpap-masks", label: "Mask brands compared" },
    ],
  },
  {
    Icon: Sparkles,
    eyebrow: "The first month",
    title: "Living with therapy.",
    body: "The first two weeks are the hardest — and the biggest dropout window. Most patients who survive that adjustment are still on therapy a decade later.",
    links: [
      {
        href: "/learn/first-two-weeks",
        label: "Surviving the first two weeks",
      },
      { href: "/learn/device-setup", label: "Setting up your CPAP / BiPAP" },
      {
        href: "/learn/cleaning-routine",
        label: "Daily, weekly, monthly cleaning",
      },
    ],
  },
  {
    Icon: Plane,
    eyebrow: "Day-to-day",
    title: "Real life with a mask.",
    body: "TSA, hotels, road trips, camping, partners, intimacy, dry mouth, leaks, congestion. The practical questions that aren't in the manual.",
    links: [
      { href: "/learn/traveling-with-cpap", label: "Traveling with CPAP" },
      { href: "/learn/replacement-schedule", label: "Replacement schedules" },
      { href: "/faq", label: "Browse the FAQ" },
    ],
  },
  {
    Icon: ShieldCheck,
    eyebrow: "Coverage & cost",
    title: "Paying for it.",
    body: "Medicare, Medicaid, and most commercial plans cover CPAP and replacement supplies. HSA and FSA cards work for cash-pay. The catch is the adherence threshold and the prior-authorization paperwork.",
    links: [
      { href: "/learn/insurance-guide", label: "Insurance & coverage guide" },
      { href: "/insurance/estimate", label: "Estimate your benefits" },
      { href: "/learn/glossary", label: "Glossary of CPAP terms" },
    ],
  },
];

const journeyStages = [
  {
    Icon: Search,
    label: "Just curious",
    body: "Wondering if you might have it",
    href: "/learn/sleep-apnea-quiz",
    cta: "Take the quiz",
  },
  {
    Icon: Stethoscope,
    label: "Just diagnosed",
    body: "Got your AHI, need to know what's next",
    href: "/learn/sleep-apnea-explained",
    cta: "Start here",
  },
  {
    Icon: Sunrise,
    label: "First weeks",
    body: "Adjusting to nightly therapy",
    href: "/learn/first-two-weeks",
    cta: "Survive the start",
  },
  {
    Icon: Heart,
    label: "Living with it",
    body: "Long-term care and routine",
    href: "/learn/cleaning-routine",
    cta: "Day-to-day care",
  },
];

export function SleepApnea101() {
  useDocumentTitle(
    "Sleep apnea 101 — everything you need to know",
    "Your one-stop primer on sleep apnea and PAP therapy. What it is, why it matters, how treatment works, what daily life looks like, and how to pay for it.",
    { schema: "MedicalWebPage" },
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Hero — flagship navy gradient card, longer than usual because
          this is the "front door" SEO landing surface */}
      <section className="hero-card w-full mb-14 animate-shimmer-in">
        <div className="relative z-10 max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-24">
          <div className="text-center">
            <div className="flex flex-wrap items-center justify-center gap-2 mb-7">
              <span className="status-pill status-pill-gold status-pill-on-dark">
                <BookOpen className="w-3 h-3 mr-1.5 inline" />
                The complete primer
              </span>
            </div>

            <h1 className="text-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 leading-[1.08] text-white">
              Sleep apnea, end to end.
              <br />
              <span className="hero-headline-swoosh">In one place.</span>
            </h1>

            <p className="text-base sm:text-lg md:text-xl text-white/85 leading-relaxed mb-9 max-w-2xl mx-auto">
              What sleep apnea is. Why it matters. How treatment works. What
              real life with a mask looks like. How to pay for it. Twenty
              long-form articles and a clinical-grade fitter, organized for the
              way new patients actually search.
            </p>

            <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
              <Button
                size="lg"
                className="h-14 px-8 text-base font-semibold rounded-full btn-gold-glow group"
                data-testid="101-cta-fit"
                onClick={() => navigate("/consent")}
              >
                Match me to a mask
                <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-0.5" />
              </Button>
              <Button
                size="lg"
                variant="outline"
                className="h-14 px-6 text-base rounded-full btn-on-dark-outline gap-2"
                data-testid="101-cta-quiz"
                onClick={() => navigate("/learn/sleep-apnea-quiz")}
              >
                <ClipboardList className="w-5 h-5" />
                Take the self-screener
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Journey stages — "where are you?" navigation. Four tiles that
          route to the right starting article based on the reader's
          stage. Distinct visual treatment from the section grid below. */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-8">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Find your starting point
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Where are you in this?
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Patients arrive at this page in four different places. Jump straight
            to the article that matches yours.
          </p>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {journeyStages.map(({ Icon, label, body, href, cta }, idx) => (
            <Link
              key={label}
              href={href}
              className={
                idx === 0
                  ? "glass-card-tech lift-on-hover rounded-2xl p-5 md:p-6 relative overflow-hidden flex flex-col text-left group"
                  : "glass-card lift-on-hover rounded-2xl p-5 md:p-6 flex flex-col text-left group"
              }
              data-testid={`101-stage-${label.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {idx === 0 && <span className="scan-line" aria-hidden="true" />}
              <div className="relative z-10">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-gold">
                  <Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                  Stage 0{idx + 1}
                </div>
                <h3 className="text-base md:text-lg font-bold tracking-tight mb-2">
                  {label}
                </h3>
                <p className="text-xs md:text-sm text-muted-foreground leading-relaxed mb-4">
                  {body}
                </p>
                <span className="inline-flex items-center gap-1.5 text-xs md:text-sm font-semibold text-primary group-hover:gap-2 transition-all mt-auto">
                  {cta}
                  <ArrowRight className="w-3.5 h-3.5 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </div>

      {/* Big-number stat band — a single horizontal strip below the
          journey stages. Gives the page a moment of "this is a real
          problem" before the topical sections kick in. */}
      <div className="w-full mb-20">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 grid grid-cols-2 md:grid-cols-4 gap-6 p-7 md:p-9 text-center">
            {[
              { stat: "30M+", label: "US adults with OSA" },
              { stat: "80%", label: "still undiagnosed" },
              { stat: "2-3×", label: "stroke risk untreated" },
              { stat: "Reversible", label: "with adherent therapy" },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-display text-3xl md:text-4xl font-bold text-white mb-1">
                  {s.stat}
                </div>
                <div className="text-xs uppercase tracking-wider text-white/70">
                  {s.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Six topical sections — the spine of the page. Each maps to
          one of the existing long-form articles plus 2-3 related
          deep-links. Built as cards with a strong icon-halo + eyebrow
          treatment so the page scans cleanly on a phone. */}
      <div className="w-full mb-20">
        <div className="text-center max-w-2xl mx-auto mb-10">
          <div className="flex justify-center mb-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                The full library
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-3">
            Six topics. Twenty deep-dive articles.
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Every section below maps to a primary explainer plus the practical
            articles that surround it. Start anywhere.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          {sections.map((s, idx) => (
            <article
              key={s.title}
              className="glass-card lift-on-hover rounded-2xl p-6 md:p-7 flex flex-col"
            >
              <div className="flex items-start gap-4 mb-4">
                <div
                  className={`relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 ${
                    idx % 2 === 0 ? "icon-halo-gold" : "icon-halo-navy"
                  }`}
                >
                  <s.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1">
                    {s.eyebrow}
                  </div>
                  <h3 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                    {s.title}
                  </h3>
                </div>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed mb-5">
                {s.body}
              </p>
              <ul className="space-y-2 mt-auto">
                {s.links.map((l) => (
                  <li key={l.href}>
                    <Link
                      href={l.href}
                      className="flex items-center justify-between gap-3 p-3 rounded-xl border border-border/40 hover:border-primary/40 hover:bg-[hsl(var(--penn-mist))]/40 transition group/link"
                    >
                      <span className="text-sm font-medium text-foreground/85 group-hover/link:text-primary transition-colors">
                        {l.label}
                      </span>
                      <ArrowRight className="w-3.5 h-3.5 text-muted-foreground shrink-0 group-hover/link:text-primary group-hover/link:translate-x-0.5 transition-all" />
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>

      {/* Quick-reference utility row — three compact tiles for the
          highest-utility resources (glossary, FAQ, fitter). Different
          visual weight from the topical grid so they don't compete. */}
      <div className="w-full mb-20">
        <div className="glass-panel rounded-2xl p-2 sm:p-3">
          <div className="grid sm:grid-cols-3 gap-1 sm:gap-2">
            {[
              {
                href: "/learn/glossary",
                Icon: BookOpen,
                title: "Glossary",
                body: "AHI, EPR, IPAP, RDI — every term defined.",
                halo: "icon-halo-navy",
              },
              {
                href: "/faq",
                Icon: Compass,
                title: "FAQ",
                body: "Quick answers to specific ordering questions.",
                halo: "icon-halo-gold",
              },
              {
                href: "/consent",
                Icon: Sparkles,
                title: "Virtual Mask Fitter",
                body: "On-device fitting in three minutes.",
                halo: "icon-halo-gold",
              },
            ].map(({ href, Icon, title, body, halo }) => (
              <Link
                key={href}
                href={href}
                className="rounded-xl p-4 flex items-center gap-3 hover:bg-white/55 transition group"
              >
                <div
                  className={`relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${halo}`}
                >
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm font-semibold tracking-tight truncate">
                    {title}
                  </span>
                  <span className="text-xs text-muted-foreground">{body}</span>
                </div>
                <ArrowRight className="w-3.5 h-3.5 text-muted-foreground group-hover:translate-x-0.5 transition-transform" />
              </Link>
            ))}
          </div>
        </div>
      </div>

      {/* Share rail */}
      <div className="w-full mb-12">
        <ShareArticle
          path="/sleep-apnea-101"
          title="Sleep apnea, end to end — the complete primer"
          blurb="Twenty long-form articles on what sleep apnea is, why it matters, how treatment works, and how to live with it. Pass it to anyone who needs to start somewhere."
          testIdPrefix="share-101"
        />
      </div>

      {/* Final CTA */}
      <div className="w-full glass-card rounded-2xl p-8 md:p-10 text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> When you&apos;re ready
        </Badge>
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3 text-foreground/90">
          Reading isn&apos;t therapy. A mask is.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-xl mx-auto mb-7">
          Whenever you&apos;re ready to take the next step, the on-device fitter
          matches you to a CPAP mask in three minutes. No images leave your
          browser.
        </p>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          data-testid="101-bottom-cta-fit"
          onClick={() => navigate("/consent")}
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice or a diagnosis. If you
        suspect sleep apnea, talk to your primary care provider or a sleep
        medicine specialist about a study.
      </p>
    </div>
  );
}
