import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  HeartPulse,
  TrendingDown,
  Activity,
  AlertTriangle,
  CheckCircle2,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type CardioRisk = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  condition: string;
  body: string;
  data: string;
};

const cardio: CardioRisk[] = [
  {
    Icon: TrendingDown,
    condition: "Hypertension",
    body: "Untreated OSA is the most common identified cause of resistant hypertension — blood pressure that won't come down despite three or more medications. Each apnea event drives an adrenaline surge that recurs hundreds of times a night. Effective PAP therapy typically lowers daytime systolic by 2–5 mmHg on average, more in resistant cases.",
    data: "Up to 80% of resistant HTN patients have OSA",
  },
  {
    Icon: HeartPulse,
    condition: "Atrial fibrillation",
    body: "Patients with untreated moderate-to-severe OSA are 2–4× more likely to develop AFib, and 2× more likely to have AFib recur after a successful ablation. The combination of overnight intrathoracic pressure swings and adrenergic surges is hard on the left atrium. Treating OSA improves rhythm control outcomes substantially.",
    data: "2× AFib recurrence post-ablation untreated",
  },
  {
    Icon: Activity,
    condition: "Stroke",
    body: "Severe untreated OSA roughly doubles to triples the risk of stroke, independent of hypertension and other risk factors. Both ischemic and hemorrhagic stroke risk are elevated, and OSA is highly prevalent in stroke survivors — a recursive risk where stroke makes OSA worse and OSA raises recurrence risk.",
    data: "2–3× stroke risk in severe OSA",
  },
  {
    Icon: HeartPulse,
    condition: "Heart failure",
    body: "OSA is found in roughly 30–50% of patients with congestive heart failure. The mechanical strain of repeatedly inhaling against a closed airway is hard on the left ventricle. Effective treatment improves ejection fraction in many patients and reduces hospitalization rates.",
    data: "30–50% co-prevalence in CHF",
  },
  {
    Icon: AlertTriangle,
    condition: "Sudden cardiac death",
    body: "The 6am-to-noon peak for cardiac events in the general population shifts to the midnight-to-6am window in patients with OSA. Untreated severe OSA approximately doubles the risk of sudden cardiac death — and the difference disappears with adherent therapy in observational cohorts.",
    data: "~2× SCD risk; window shifts to night",
  },
];

export function LearnSleepApneaHeartHealth() {
  useDocumentTitle(
    "Sleep apnea and your heart",
    "How untreated sleep apnea affects cardiovascular health — hypertension, atrial fibrillation, stroke, heart failure, sudden cardiac death — and the reversal that PAP therapy delivers.",
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
        <span className="text-foreground/85">Sleep apnea and your heart</span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Cardiology · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Sleep apnea is a cardiovascular disease.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          We talk about sleep apnea in the context of sleep because that&apos;s
          where you notice it. But the long-term damage isn&apos;t in your
          dreams — it&apos;s in your heart and your blood vessels. Here&apos;s
          how, and why most cardiology guidelines now screen for it.
        </p>
      </header>

      {/* Stat banner */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9 text-center">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-2">
              The American Heart Association
            </div>
            <p className="text-xl md:text-2xl text-white leading-relaxed font-medium max-w-2xl mx-auto">
              In 2021, the AHA issued a formal scientific statement
              recommending OSA screening in patients with{" "}
              <span className="text-[hsl(var(--penn-gold))]">
                hypertension, atrial fibrillation, heart failure, and stroke
              </span>{" "}
              — naming OSA a modifiable cardiovascular risk factor.
            </p>
          </div>
        </div>
      </section>

      {/* Why */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <HeartPulse className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Why your heart pays the bill.
          </h2>
        </div>
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10 space-y-4 text-muted-foreground leading-relaxed">
            <p>
              Every apnea event creates the same three insults to your
              cardiovascular system, in tight succession:
            </p>
            <ol className="space-y-3 ml-5">
              <li>
                <span className="font-semibold text-foreground/90">
                  Oxygen falls.
                </span>{" "}
                Hemoglobin saturation drops — sometimes from 98% into the
                70s — while you&apos;re still trying to breathe against a
                closed airway.
              </li>
              <li>
                <span className="font-semibold text-foreground/90">
                  Pressure swings.
                </span>{" "}
                Inhaling forcefully against a blocked airway pulls
                intrathoracic pressure deeply negative — mechanically
                stretching the left atrium and afterloading the left
                ventricle.
              </li>
              <li>
                <span className="font-semibold text-foreground/90">
                  Adrenaline floods.
                </span>{" "}
                The sympathetic surge that finally wakes you up spikes blood
                pressure and heart rate. Then the cycle repeats — 30, 60,
                sometimes 90 times an hour.
              </li>
            </ol>
            <p>
              Cumulative over years, this is what drives the cardiovascular
              risks below. The good news: the damage is largely a function
              of <em>ongoing exposure</em>. Stop the exposure with consistent
              PAP therapy, and most of the risk recedes within months.
            </p>
          </div>
        </div>
      </section>

      {/* Specific risks */}
      <section className="w-full mb-12 space-y-5">
        {cardio.map((r) => (
          <article
            key={r.condition}
            className="glass-card rounded-2xl p-6 md:p-7"
          >
            <div className="flex items-start gap-4">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <r.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2 mb-2">
                  <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                    {r.condition}
                  </h2>
                  <span className="text-[10px] font-mono uppercase tracking-[0.18em] text-[hsl(var(--penn-gold-deep))]">
                    {r.data}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {r.body}
                </p>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* The reversal section */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                What changes when you treat it.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Among the modifiable cardiovascular risk factors — smoking,
              diet, exercise, blood pressure, lipids — sleep apnea is one of
              the only ones where{" "}
              <span className="font-semibold text-foreground/90">
                the intervention works while you sleep
              </span>
              . You don&apos;t have to change behavior at 6am or remember a
              noon medication. You just have to wear a mask that&apos;s
              comfortable enough to keep on.
            </p>
            <ul className="space-y-2 mb-4">
              {[
                "Daytime blood pressure drops within weeks",
                "AFib recurrence after ablation drops on adherent PAP",
                "Heart-failure ejection fraction improves measurably in many patients",
                "Sudden-death risk in observational cohorts approaches non-OSA baseline",
                "Cardiologists increasingly view adherence as a vital sign",
              ].map((s) => (
                <li
                  key={s}
                  className="flex items-start gap-2.5 text-sm text-foreground/85"
                >
                  <CheckCircle2
                    className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                    strokeWidth={2.5}
                  />
                  <span>{s}</span>
                </li>
              ))}
            </ul>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The single biggest driver of whether someone reaches that
              adherence threshold is mask comfort. Which is the entire
              reason we built the fitter.
            </p>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/sleep-apnea-heart-health"
          title="Sleep apnea is a cardiovascular disease"
          blurb="Send this to anyone in your life with hypertension, AFib, or a heart-health concern. Sleep apnea is a major piece of the picture and almost nobody talks about it."
          testIdPrefix="share-heart-health"
        />
      </div>

      {/* Disclaimer */}
      <section className="w-full mb-10">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div className="text-sm text-foreground/85 leading-relaxed">
              <span className="font-semibold">Important:</span> if you have
              an existing cardiovascular condition, talk to your cardiologist
              and your sleep medicine provider together. Don&apos;t change
              cardiac medications based on starting PAP therapy — let your
              physicians titrate them as your blood pressure and rhythm
              respond to treatment.
            </div>
          </div>
        </div>
      </section>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Take the self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Eight quick questions — STOP-BANG, the same screener used in
              cardiology offices.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/pap-therapy-benefits"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              What treatment feels like
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The benefits of PAP therapy on a real timeline — week by
              week, quarter by quarter.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="heart-health-bottom-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice or a diagnosis. Risk
        estimates reflect commonly-cited ranges from peer-reviewed
        literature and the AHA 2021 scientific statement on OSA and
        cardiovascular disease.
      </p>
    </div>
  );
}
