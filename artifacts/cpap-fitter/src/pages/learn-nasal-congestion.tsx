import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Droplets,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Wind,
  Activity,
  Sun,
  Bed,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

const causes = [
  {
    Icon: Droplets,
    title: "Air too dry → reactive congestion",
    body: "Your nose protects itself when therapy air is dry — it dumps mucus into the nasal passages, which then swells the tissue. Counterintuitively, congested patients often need MORE humidification, not less.",
    fix: "Bump humidifier to 4-5 out of 5. Add heated tubing if it's not already part of your setup.",
  },
  {
    Icon: Sun,
    title: "Allergies / seasonal triggers",
    body: "If your congestion tracks the seasons (spring grass, summer mold, fall ragweed), the underlying allergies are flaring up against the therapy backdrop. CPAP doesn't cause this but it does intensify the awareness of nasal blockage.",
    fix: "Talk to your physician about a daily nasal steroid (Flonase, Nasacort), an antihistamine, or both. Address the allergies and the CPAP issue resolves itself.",
  },
  {
    Icon: Bed,
    title: "Sleep position pressing on one nostril",
    body: "If congestion is one-sided and switches when you roll over, your bedding is occluding one nostril mechanically. Common with side sleepers who burrow into the pillow.",
    fix: "Try a thinner pillow, a cervical-support pillow, or a deliberate back-sleeping period of 15-20 minutes at lights-off (the time when seal matters most).",
  },
  {
    Icon: Activity,
    title: "Deviated septum or chronic rhinitis",
    body: "Sometimes the underlying structural anatomy is the issue and no amount of humidifier tweaking fixes it. If you've always been congested (with or without CPAP), the diagnosis isn't CPAP-related.",
    fix: "An ENT consult is worth it. Treatments range from saline rinses to nasal-strip dilators to (in select cases) outpatient septoplasty.",
  },
];

const quickWins = [
  "Use a saline rinse (Neti pot or NeilMed bottle) before bed. Most reliable single intervention for nasal CPAP users.",
  "Run the humidifier on the higher end. Dry-air rebound congestion is the #1 fixable cause.",
  "Position the hose so it doesn't tug on the mask when you turn — leaks at the bridge can mimic congestion.",
  "If you have allergies, take a daily nasal steroid in the morning. They take 1-2 weeks to reach full effect.",
  "Skip alcohol within 3 hours of bed. Alcohol dramatically worsens nasal congestion overnight in most people.",
];

export function LearnNasalCongestion() {
  useDocumentTitle(
    "Nasal congestion on CPAP",
    "Stuffy on therapy? Four causes, four fixes — humidifier settings, allergies, sleep position, and structural anatomy. Plus a quick-wins checklist.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Nasal congestion on CPAP</span>
      </div>

      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Troubleshooting · 5 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Stuffy on therapy.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Nasal congestion on CPAP is the second-most-common complaint
          after dry mouth — and it&apos;s sometimes the same problem
          wearing a different costume. Four causes drive almost every
          case. Here&apos;s how to walk through them.
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
                The counterintuitive truth.
              </h2>
            </div>
            <p className="text-base md:text-lg text-foreground/90 leading-relaxed font-medium mb-2">
              Most CPAP-related congestion is caused by air that&apos;s too
              dry, not too humid.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Patients often turn their humidifier off thinking it&apos;ll
              help — and the dry-air rebound makes the problem worse.
              Start by going UP on humidification, not down.
            </p>
          </div>
        </div>
      </section>

      {/* Four causes */}
      <section className="w-full mb-10 space-y-4">
        {causes.map((c) => (
          <article key={c.title} className="glass-card rounded-2xl p-6">
            <div className="flex items-start gap-4 mb-3">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <c.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-lg font-bold tracking-tight">{c.title}</h3>
              </div>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed mb-3">
              {c.body}
            </p>
            <div className="rounded-xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-3">
              <div className="flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                <p className="text-sm text-foreground/85">
                  <span className="font-semibold">Fix: </span>
                  {c.fix}
                </p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Quick wins */}
      <section className="w-full mb-10">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              Five quick wins · try tonight
            </div>
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white mb-4">
              Before you call anyone, try these.
            </h2>
            <ul className="space-y-2">
              {quickWins.map((w, i) => (
                <li key={w} className="flex items-start gap-3">
                  <span className="text-[10px] font-mono text-[hsl(var(--penn-gold))] pt-1 shrink-0 w-6">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <span className="text-sm text-white/90 leading-relaxed">
                    {w}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* When to escalate */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Switch to a full-face mask if you can&apos;t breathe through
                your nose
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                If chronic congestion makes nasal therapy impossible —
                even after addressing humidification and allergies — a
                full-face mask routes around the problem entirely. You
                breathe through your mouth, the seal covers both,
                therapy continues. Our comfort guarantee covers the
                exchange.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/nasal-congestion"
          title="Nasal congestion on CPAP — four causes, four fixes"
          blurb="If you're stuffy on therapy, the cause is usually one of four things — dry air, allergies, sleep position, or anatomy. Walk-through plus a 5-tip quick-wins list."
          testIdPrefix="share-congestion"
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
              Both symptoms often co-occur — both point at humidification.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/mask-leaks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Wind className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Mask leaks
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A bridge leak can mimic congestion — diagnose by where
              air&apos;s actually going.
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
          <Sparkles className="w-3 h-3 mr-1.5" /> Need a full-face?
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="congestion-cta-fit"
        >
          Re-run the fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
        Educational content only. Persistent congestion warrants an ENT
        or allergy consult — CPAP-related fixes don&apos;t replace
        evaluation of an underlying nasal condition.
      </p>
    </div>
  );
}
