import React, { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, BookOpen, Search, Sparkles } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Term = {
  term: string;
  acronym?: string;
  definition: string;
  category: "diagnosis" | "therapy" | "equipment" | "billing" | "anatomy";
};

const terms: Term[] = [
  {
    term: "Adherence",
    category: "billing",
    definition:
      "How consistently you wear your CPAP. The Medicare threshold is ≥4 hours/night on 70% of nights across any 30-day window. Below that, insurance can deny ongoing rental coverage.",
  },
  {
    term: "AHI",
    acronym: "Apnea-Hypopnea Index",
    category: "diagnosis",
    definition:
      "The number of apnea + hypopnea events per hour of sleep. <5 is normal, 5-15 is mild OSA, 15-30 moderate, >30 severe. Your therapy goal is usually to drop AHI under 5 on machine.",
  },
  {
    term: "Apnea",
    category: "diagnosis",
    definition:
      "A complete (>90%) cessation of airflow lasting 10+ seconds during sleep. Classified as obstructive (airway blocked), central (no signal to breathe), or mixed.",
  },
  {
    term: "APAP",
    acronym: "Auto-titrating Positive Airway Pressure",
    category: "therapy",
    definition:
      "A PAP mode that adjusts pressure on the fly within a prescribed range, ramping up only when it detects events. Now the most commonly prescribed mode for new adult OSA patients.",
  },
  {
    term: "ASV",
    acronym: "Adaptive Servo-Ventilation",
    category: "therapy",
    definition:
      "An advanced bilevel device that intervenes when breathing pattern becomes irregular. Used for central sleep apnea, Cheyne-Stokes respiration, and treatment-emergent complex apnea.",
  },
  {
    term: "BiPAP / Bilevel",
    acronym: "Bilevel Positive Airway Pressure",
    category: "therapy",
    definition:
      "Delivers a higher inhalation pressure (IPAP) and a lower exhalation pressure (EPAP). Used at high pressures, in COPD overlap, or when a patient can't tolerate exhaling against fixed CPAP.",
  },
  {
    term: "cmH₂O",
    acronym: "Centimeters of water",
    category: "therapy",
    definition:
      "The pressure unit used in respiratory medicine. Most adult CPAP prescriptions land between 4 and 16 cmH₂O.",
  },
  {
    term: "CPAP",
    acronym: "Continuous Positive Airway Pressure",
    category: "therapy",
    definition:
      "The original PAP therapy — one fixed pressure delivered continuously through the night. Simple, reliable, and clinically validated longer than any other mode.",
  },
  {
    term: "CSA",
    acronym: "Central Sleep Apnea",
    category: "diagnosis",
    definition:
      "A form of sleep apnea where the airway stays open but the brain briefly stops signaling breath. Common in patients with heart failure, stroke history, or long-term opioid use.",
  },
  {
    term: "Desaturation",
    category: "diagnosis",
    definition:
      "A drop in blood oxygen saturation (SpO₂). Sleep studies count desaturations of 3-4% or more as part of the hypopnea definition.",
  },
  {
    term: "DME",
    acronym: "Durable Medical Equipment",
    category: "billing",
    definition:
      "The category of equipment your CPAP falls under for insurance purposes. PennPaps is a DME supplier — we run benefits, bill insurance, and ship your supplies.",
  },
  {
    term: "EPAP",
    acronym: "Expiratory Positive Airway Pressure",
    category: "therapy",
    definition:
      "The exhalation pressure setting on a bilevel device. Lower than IPAP. Set together with IPAP by your sleep doctor based on titration.",
  },
  {
    term: "EPR",
    acronym: "Expiratory Pressure Relief",
    category: "therapy",
    definition:
      "ResMed's name for the feature that briefly drops pressure during exhalation so you don't breathe out against a wall of air. Called A-Flex / C-Flex on Philips, SmartFlex on React Health.",
  },
  {
    term: "HSAT",
    acronym: "Home Sleep Apnea Test",
    category: "diagnosis",
    definition:
      "A small portable device you wear at home for 1-3 nights, measuring airflow, oxygen, heart rate, and effort. Increasingly the first-line diagnostic test for straightforward OSA workups.",
  },
  {
    term: "Hypopnea",
    category: "diagnosis",
    definition:
      "A partial reduction in airflow (typically 30-50%) lasting 10+ seconds, paired with a desaturation or arousal. Less severe than an apnea but contributes to AHI.",
  },
  {
    term: "Insurance allowable",
    category: "billing",
    definition:
      "The amount insurance will pay for a given supply. You pay any difference between the allowable and the supplier's price (often $0 — most DMEs accept assignment).",
  },
  {
    term: "IPAP",
    acronym: "Inspiratory Positive Airway Pressure",
    category: "therapy",
    definition:
      "The inhalation pressure setting on a bilevel device. Higher than EPAP. The difference between IPAP and EPAP determines comfort at high pressures.",
  },
  {
    term: "Leak rate",
    category: "therapy",
    definition:
      "How much air is escaping past your mask seal beyond the intentional exhalation vent. Persistent high leak means a refit is needed — therapy can't maintain pressure if air is leaking.",
  },
  {
    term: "OSA",
    acronym: "Obstructive Sleep Apnea",
    category: "diagnosis",
    definition:
      "The most common form of sleep apnea (~85% of cases). Soft tissue at the back of the throat collapses inward when muscle tone relaxes, blocking the airway during sleep.",
  },
  {
    term: "P95",
    acronym: "95th-percentile pressure",
    category: "therapy",
    definition:
      "On APAP, the pressure your machine is reaching for 95% of the night. If your P95 is bumping against your maximum setting, your prescribed range may need adjustment.",
  },
  {
    term: "Polysomnography",
    acronym: "PSG / In-lab sleep study",
    category: "diagnosis",
    definition:
      "Full overnight sleep study at a sleep lab — EEG, EKG, EMG, airflow, oxygen, video. The gold standard for complex cases and titration.",
  },
  {
    term: "Prescription",
    category: "billing",
    definition:
      "Required for every CPAP machine and (for billing purposes) often for replacement supplies. Issued by your sleep medicine provider after a sleep study.",
  },
  {
    term: "Prior authorization",
    category: "billing",
    definition:
      "An insurance step where your DME submits clinical documentation before equipment is shipped. PennPaps handles this for you; you don't need to do anything.",
  },
  {
    term: "Rainout",
    category: "equipment",
    definition:
      "Condensation inside the hose, caused by humidified air cooling as it travels from the machine to your face. Fixed with a heated hose, by lowering humidifier temp, or by tubing wrap insulation.",
  },
  {
    term: "Ramp",
    category: "therapy",
    definition:
      "A feature that starts therapy at a low pressure and gradually builds up to your prescribed level over 5-45 minutes. Useful when lights-off pressure feels uncomfortable.",
  },
  {
    term: "RDI",
    acronym: "Respiratory Disturbance Index",
    category: "diagnosis",
    definition:
      "AHI plus RERAs. A more inclusive count of respiratory events; tends to be slightly higher than AHI. Some sleep labs report RDI as the primary number.",
  },
  {
    term: "RERA",
    acronym: "Respiratory Effort-Related Arousal",
    category: "diagnosis",
    definition:
      "A subtle breathing disturbance that doesn't meet hypopnea criteria but causes a brief arousal from sleep. Counted in RDI but not always in AHI.",
  },
  {
    term: "Resupply",
    category: "billing",
    definition:
      "The insurance-allowed cadence for shipping replacement parts. PennPaps' resupply program ships cushions, headgear, filters, and tubing on schedule with insurance billing handled for you.",
  },
  {
    term: "Soft palate",
    category: "anatomy",
    definition:
      "The fleshy area at the back of the roof of your mouth. Collapses inward in many cases of OSA when muscle tone relaxes during sleep.",
  },
  {
    term: "STOP-BANG",
    category: "diagnosis",
    definition:
      "An 8-question validated clinical screener for OSA risk. Used by sleep clinics, cardiology offices, and our self-screener at /learn/sleep-apnea-quiz.",
  },
  {
    term: "Titration",
    category: "therapy",
    definition:
      "The process of finding your optimal pressure. Done in-lab (full sleep study with PAP) or via auto-titrating CPAP over a few nights at home.",
  },
];

const categoryMeta: Record<Term["category"], { label: string; color: string }> =
  {
    diagnosis: { label: "Diagnosis", color: "chip-tier-budget" },
    therapy: { label: "Therapy", color: "chip-tier-standard" },
    equipment: { label: "Equipment", color: "chip-tier-premium" },
    billing: { label: "Billing", color: "chip-tier-budget" },
    anatomy: { label: "Anatomy", color: "chip-tier-standard" },
  };

export function LearnGlossary() {
  useDocumentTitle(
    "CPAP & sleep apnea glossary",
    "Every acronym and term you'll encounter in CPAP therapy and sleep apnea — AHI, EPR, IPAP/EPAP, RDI, RERA, and more. Searchable A-Z reference.",
  );
  const [, navigate] = useLocation();
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return terms;
    const q = query.toLowerCase();
    return terms.filter(
      (t) =>
        t.term.toLowerCase().includes(q) ||
        t.acronym?.toLowerCase().includes(q) ||
        t.definition.toLowerCase().includes(q),
    );
  }, [query]);

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Breadcrumb */}
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Glossary</span>
      </div>

      {/* Header */}
      <header className="w-full mb-8">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Reference · A-Z
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The CPAP glossary.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Every acronym, abbreviation, and clinical term you&apos;ll encounter
          on a sleep report, a machine screen, an insurance letter, or a forum
          thread — defined in plain English.
        </p>
      </header>

      {/* Search */}
      <div className="w-full mb-10">
        <div className="relative">
          <Search
            className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search terms, acronyms, or definitions"
            className="w-full h-12 pl-11 pr-4 rounded-full bg-white border border-border/60 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/40 transition"
            data-testid="glossary-search"
            aria-label="Search the glossary"
          />
        </div>
        <div className="text-xs text-muted-foreground mt-2 ml-1">
          {filtered.length} of {terms.length} terms shown
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="ml-3 text-primary hover:underline"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Terms list */}
      <section className="w-full mb-12">
        {filtered.length === 0 ? (
          <div className="glass-card rounded-2xl p-10 text-center">
            <BookOpen className="w-8 h-8 text-muted-foreground mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">
              No terms match &ldquo;{query}&rdquo;. Try a different word or
              acronym.
            </p>
          </div>
        ) : (
          <dl className="space-y-3">
            {filtered.map((t, i) => (
              <div
                key={t.term}
                className={
                  i === 0 && !query
                    ? "glass-card-tech rounded-2xl p-5 md:p-6 relative overflow-hidden"
                    : "glass-card rounded-2xl p-5 md:p-6"
                }
              >
                {i === 0 && !query && (
                  <span className="scan-line" aria-hidden="true" />
                )}
                <div className="relative z-10 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-2">
                  <dt className="flex flex-wrap items-baseline gap-2">
                    <span className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                      {t.term}
                    </span>
                    {t.acronym && (
                      <span className="text-xs font-mono uppercase tracking-[0.18em] text-muted-foreground">
                        {t.acronym}
                      </span>
                    )}
                  </dt>
                  <Badge
                    variant="outline"
                    className={`text-[10px] border-0 font-medium shrink-0 ${categoryMeta[t.category].color}`}
                  >
                    {categoryMeta[t.category].label}
                  </Badge>
                </div>
                <dd className="relative z-10 text-sm text-muted-foreground leading-relaxed">
                  {t.definition}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/glossary"
          title="The CPAP & sleep apnea glossary"
          blurb="Every term you'll encounter — AHI, EPR, IPAP/EPAP, RDI, RERA, prior auth, rainout — defined plainly. Bookmark for the next time a doctor or sleep report throws you an acronym."
          testIdPrefix="share-glossary"
        />
      </div>

      {/* Bottom CTA */}
      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> Ready to go deeper?
        </Badge>
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight mb-3 text-foreground/90">
          Pick a starting topic.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-xl mx-auto mb-7">
          Vocabulary down — the deeper guides give you context for every term
          you just read.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Button
            size="lg"
            className="h-12 px-7 rounded-full btn-primary-glow group"
            onClick={() => navigate("/sleep-apnea-101")}
          >
            Sleep apnea 101
            <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="h-12 px-6 rounded-full glass-card hover:border-primary/40"
            onClick={() => navigate("/learn")}
          >
            All articles
          </Button>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational reference only — not a substitute for the definitions your
        sleep medicine provider or insurance company uses on documentation.
      </p>
    </div>
  );
}
