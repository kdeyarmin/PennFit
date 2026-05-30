import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Plane,
  Hotel,
  Tent,
  Globe2,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Briefcase,
  Battery,
  Wifi,
  ShieldCheck,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Scenario = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  intro: string;
  steps: string[];
  watchOut?: string;
};

const scenarios: Scenario[] = [
  {
    Icon: Plane,
    title: "TSA & airport security",
    intro:
      "CPAP is a medical device. It doesn't count toward your carry-on limit and you don't need a doctor's note.",
    steps: [
      "Pack the machine in its travel case as a separate carry-on item",
      "At security: take the machine out of the case (like a laptop) and place it in its own bin",
      "Leave the humidifier chamber empty — full water reservoirs trigger a secondary screening",
      "Keep your prescription saved in your phone for international travel",
      "If asked, say 'CPAP, medical device' — TSA agents see hundreds per day",
    ],
    watchOut:
      "If your machine is swabbed for explosives, that's standard — not a problem with your gear.",
  },
  {
    Icon: Plane,
    title: "Using CPAP on the plane",
    intro:
      "FAA-approved on every US carrier. Most patients don't bother on flights under 4 hours, but red-eye and intercontinental are when it's worth setting up.",
    steps: [
      "Call the airline 48 hours ahead and confirm they have an FAA-compliant outlet at your seat",
      "Bring your DC adapter or a battery pack — many older planes have no in-seat power",
      "Bring distilled water in a sealed bottle for the humidifier (TSA allows it as a medical liquid)",
      "Pack a mask wipe kit; airplane air is dry and your cushion will need a fresh seal",
      "Don't connect to the humidifier in flight — turbulence sloshes water into the hose",
    ],
    watchOut:
      "Some airlines require an FAA 'POC' statement form. Easier to confirm one week ahead than at the gate.",
  },
  {
    Icon: Hotel,
    title: "Hotels & overnights",
    intro:
      "The easy one. Every modern hotel has nightstand outlets and the cleaning staff has seen a CPAP before.",
    steps: [
      "Request a room near an outlet on the side of the bed you sleep on",
      "Bring a 6ft extension cord — hotel outlets are often awkwardly placed",
      "Distilled water is sold at any pharmacy; don't use tap or bottled spring water",
      "If the room is dry, set humidifier higher than your home setting",
      "Pack a small empty container for clean cushions / chamber on the return trip",
    ],
  },
  {
    Icon: Tent,
    title: "Camping & off-grid",
    intro:
      "Doable with a battery pack and a willingness to skip the humidifier for one or two nights.",
    steps: [
      "Bring a dedicated CPAP battery (Medistrom Pilot 24, EXP Pursuit, etc.) — most run 1-3 nights per charge",
      "Most modern CPAPs draw 30-90W; check your model's wattage before buying a battery",
      "Skip the humidifier in the field — it doubles the power draw and isn't strictly necessary for one night",
      "Use a saline nasal spray before bed instead",
      "Solar panels work as a top-up but rarely as the sole source — sun + battery combo is the safer plan",
    ],
    watchOut:
      "Cold nights below 50°F can stress the machine and tube; keep the unit inside the tent and the hose under blankets.",
  },
  {
    Icon: Globe2,
    title: "International travel",
    intro:
      "Bring your prescription and your machine in carry-on. Almost everywhere has compatible power; the catch is plug shape and water purity.",
    steps: [
      "Every modern CPAP is auto-voltage (100-240V) — only the plug shape needs an adapter",
      "Print your prescription and pack a copy in your bag separate from your carry-on",
      "Buy distilled water locally; pharmacy or supermarket. Tap water differs by country and damages the humidifier",
      "Customs almost never inspects a CPAP, but keep it labeled as a medical device",
      "Set humidifier higher in dry climates (Spain, Middle East) and lower in humid ones (Caribbean, Southeast Asia)",
    ],
    watchOut:
      "A few countries (UAE, Singapore) require declaring controlled medical devices on arrival. CPAP isn't one of them, but check ahead for prescription drugs you may also be bringing.",
  },
];

const packingList = [
  "Machine + power cord",
  "Mask + headgear (consider a spare cushion)",
  "Hose (one spare for trips >7 days)",
  "Humidifier chamber",
  "Distilled water (or plan to buy at destination)",
  "DC adapter or travel battery (flights, off-grid)",
  "Universal plug adapter (international)",
  "Printed prescription or photo on phone",
  "Mask wipes + small microfiber cloth",
  "Sealed bag for transport between bag and bed",
  "Surge protector or quality power strip",
  "Earplugs (hotel hallways, planes)",
];

export function LearnTravelingWithCpap() {
  useDocumentTitle(
    "Traveling with CPAP — TSA, hotels, camping & international",
    "Practical answers for traveling with your CPAP. Airport security, flights, hotels, camping, and international power — what works, what doesn't, what to pack.",
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
        <span className="text-foreground/85">Traveling with CPAP</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Living with therapy · 8 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Traveling with CPAP, for real.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Don&apos;t skip therapy on travel nights. The one or two nights
          patients leave the machine at home routinely show up in their data as
          the worst nights of the month — and reset the adjustment clock for the
          week that follows. Here&apos;s what actually works, scenario by
          scenario.
        </p>
      </header>

      {/* TL;DR card */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-2">
              The short version
            </div>
            <p className="text-base md:text-lg text-foreground/90 leading-relaxed">
              Pack it in carry-on. It doesn&apos;t count toward your bag limit.
              You don&apos;t need a doctor&apos;s note. Every modern CPAP is
              auto-voltage — only the plug shape needs an adapter abroad. Buy
              distilled water at your destination. And don&apos;t skip nights.
            </p>
          </div>
        </div>
      </section>

      {/* Five scenarios */}
      <section className="w-full mb-12 space-y-5">
        {scenarios.map((s, i) => (
          <article
            key={s.title}
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
                  <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90 mb-1.5">
                    {s.title}
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {s.intro}
                  </p>
                </div>
              </div>
              <ul className="space-y-2 mt-4">
                {s.steps.map((step) => (
                  <li
                    key={step}
                    className="flex items-start gap-2.5 text-sm text-foreground/85"
                  >
                    <CheckCircle2
                      className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                      strokeWidth={2.5}
                    />
                    <span>{step}</span>
                  </li>
                ))}
              </ul>
              {s.watchOut && (
                <div className="mt-4 rounded-xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-3">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                    <span className="text-xs text-foreground/85">
                      <span className="font-semibold">Watch out:</span>{" "}
                      {s.watchOut}
                    </span>
                  </div>
                </div>
              )}
            </div>
          </article>
        ))}
      </section>

      {/* Packing checklist */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9">
            <div className="flex items-center gap-3 mb-5">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Briefcase className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-white">
                Universal packing checklist
              </h2>
            </div>
            <p className="text-sm text-white/80 leading-relaxed mb-6">
              Print or screenshot. The shorter the trip, the more you can skip —
              but anything longer than three nights needs the full list.
            </p>
            <div className="grid sm:grid-cols-2 gap-x-8 gap-y-2">
              {packingList.map((item, i) => (
                <div key={item} className="flex items-start gap-2.5">
                  <span className="text-[10px] font-mono text-[hsl(var(--penn-gold))] pt-1 shrink-0 w-5">
                    {String(i + 1).padStart(2, "0")}
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

      {/* Travel-friendly machines callout */}
      <section className="w-full mb-12">
        <div className="glass-panel rounded-2xl p-6 md:p-7">
          <div className="flex items-start gap-3 mb-3">
            <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
              <Battery className="w-5 h-5" strokeWidth={2} />
            </div>
            <div>
              <h3 className="text-lg font-bold tracking-tight text-foreground/90 mb-1">
                Do I need a separate travel CPAP?
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Probably not for most travelers. The ResMed AirMini and
                Transcend Micro are genuinely smaller and lighter, but they lack
                a humidifier reservoir — meaning you trade rainout for
                dry-mouth. If you travel more than 6-8 weeks per year, the
                trade-off is worth it. If you travel less than that, bring your
                everyday machine.
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 mt-4">
            <Badge variant="outline" className="text-xs font-normal">
              ResMed AirMini — 10.6 oz
            </Badge>
            <Badge variant="outline" className="text-xs font-normal">
              Transcend Micro — 17 oz
            </Badge>
            <Badge variant="outline" className="text-xs font-normal">
              HDM Z2 Auto — 10.4 oz
            </Badge>
          </div>
        </div>
      </section>

      {/* Connectivity callout */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <Wifi className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                One thing to know about insurance compliance
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Your machine&apos;s cellular modem reports usage data daily to
                your DME. Travel doesn&apos;t pause that requirement. Keeping
                your average above 4 hours/night across 70% of nights is the
                Medicare adherence threshold — a skipped travel night
                doesn&apos;t fail you, but a skipped week might. Plug in and run
                it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/traveling-with-cpap"
          title="Traveling with CPAP — TSA, hotels, camping, international"
          blurb="Practical, no-fluff travel guide for CPAP users. If you or someone you know is dragging the machine on a trip, this answers the questions the manual skips."
          testIdPrefix="share-traveling"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/cleaning-routine"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The cleaning routine
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Travel-friendly daily, weekly, monthly habits.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/replacement-schedule"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Replacement schedules
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Per-part cadences for cushions, headgear, tubing, filters.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/shop")}
          data-testid="traveling-cta-shop"
        >
          Shop travel supplies
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Airline and TSA policies can change — check
        your carrier&apos;s current medical-device rules within a week of
        departure for international or charter flights.
      </p>
    </div>
  );
}
