import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Wind,
  Gauge,
  Droplets,
  Activity,
  Sparkles,
  CheckCircle2,
  Settings2,
  LineChart,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

export function LearnHowPapWorks() {
  useDocumentTitle(
    "How PAP therapy actually works",
    "The science of positive airway pressure — the pneumatic splint mechanism, pressure ranges, exhalation relief, humidification, and the AHI and leak numbers your machine measures every night.",
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
        <span className="text-foreground/85">How PAP therapy works</span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            The science · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          A pneumatic splint, basically.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          PAP therapy looks complicated — a machine, a hose, a mask, a screen
          full of acronyms. The underlying mechanism is one of the simplest in
          medicine. Here&apos;s how it works, what each setting does, and what
          your machine is actually measuring every night.
        </p>
      </header>

      {/* The core mechanism */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Wind className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The mechanism, in one sentence.
          </h2>
        </div>
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <p className="text-lg md:text-xl text-foreground/90 leading-relaxed font-medium mb-4">
              A gentle, continuous stream of room air, delivered at a pressure
              just high enough to{" "}
              <span className="text-gradient-brand font-bold">
                hold your airway open
              </span>{" "}
              when the soft tissues around it would otherwise collapse.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              That&apos;s the entire therapy. The machine is not pushing
              breaths into your lungs. It&apos;s not delivering oxygen.
              It&apos;s not medicated. It&apos;s simply maintaining enough
              pressure in your upper airway to act as a{" "}
              <span className="font-semibold">pneumatic splint</span> —
              keeping the tube open by the same physics that keeps a bouncy
              castle inflated.
            </p>
          </div>
        </div>
      </section>

      {/* Pressure */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Gauge className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Pressure: what cmH₂O actually means.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Your prescription will list a number in <code className="font-mono">cmH₂O</code> —
          centimeters of water — the pressure unit used in respiratory medicine.
          For context, atmospheric pressure at sea level is about 1,033 cmH₂O.
          Therapy pressures are a tiny fraction of that.
        </p>
        <div className="grid md:grid-cols-4 gap-3">
          {[
            {
              range: "4–6",
              label: "Light",
              body: "Common starting pressure for mild OSA or APAP minimum.",
            },
            {
              range: "7–11",
              label: "Typical",
              body: "Most adults with moderate OSA land in this range after titration.",
            },
            {
              range: "12–16",
              label: "Higher",
              body: "Severe OSA or anatomical challenges — often where BiPAP becomes more comfortable than CPAP.",
            },
            {
              range: "17–25",
              label: "Maximum",
              body: "The upper end of any approved mask's seal range. Almost always delivered via BiPAP or ASV.",
            },
          ].map(({ range, label, body }) => (
            <div key={range} className="glass-card rounded-2xl p-5">
              <div className="text-display text-2xl font-bold text-[hsl(var(--penn-navy))] mb-1">
                {range}
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {label}
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed">
                {body}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed mt-5">
          Your physician sets your pressure based on a sleep study titration,
          or your auto-titrating machine learns it overnight within a
          prescribed range. Either way — the number isn&apos;t arbitrary and
          isn&apos;t something to change on your own.
        </p>
      </section>

      {/* Exhalation relief + humidification */}
      <section className="w-full mb-12 grid md:grid-cols-2 gap-5">
        <div className="glass-card rounded-2xl p-6 md:p-7">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-navy">
            <Activity className="w-5 h-5" strokeWidth={2} />
          </div>
          <h3 className="text-xl font-bold tracking-tight mb-3">
            Exhalation relief
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-3">
            The single feature that determines whether a new patient sticks
            with therapy. Every modern machine briefly drops pressure during
            exhalation so you aren&apos;t breathing out against a wall of air.
          </p>
          <ul className="space-y-1.5 text-xs text-foreground/85">
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                <span className="font-semibold">EPR</span> on ResMed —
                Expiratory Pressure Relief
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                <span className="font-semibold">A-Flex / C-Flex</span> on
                Philips Respironics
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                <span className="font-semibold">SmartFlex</span> on React
                Health Luna
              </span>
            </li>
          </ul>
        </div>
        <div className="glass-card rounded-2xl p-6 md:p-7">
          <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-4 icon-halo-navy">
            <Droplets className="w-5 h-5" strokeWidth={2} />
          </div>
          <h3 className="text-xl font-bold tracking-tight mb-3">
            Humidification
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-3">
            Therapy air is drier than room air because it moves faster. A
            heated humidifier adds moisture back so you don&apos;t wake up with
            a desert mouth or a bloody nose.
          </p>
          <ul className="space-y-1.5 text-xs text-foreground/85">
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                <span className="font-semibold">Heated humidifier</span> built
                into every modern bedside CPAP
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                <span className="font-semibold">Heated tubing</span> prevents
                condensation (&ldquo;rainout&rdquo;) on the inside of the hose
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2
                className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span>
                Fill with{" "}
                <span className="font-semibold">distilled water only</span>{" "}
                — tap water leaves mineral deposits
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* What gets measured */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <LineChart className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The numbers your machine tracks every night.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Every modern PAP machine logs detailed therapy data and uploads it
          via cellular modem or SD card. Your sleep medicine provider reviews
          it; you can see most of it in your machine&apos;s companion app.
        </p>

        <div className="space-y-4">
          {[
            {
              metric: "AHI",
              full: "Apnea-Hypopnea Index",
              good: "< 5/hr",
              body: "The number of breathing disruptions per hour during therapy. On effective treatment this should drop into the normal range — under 5 per hour — even if your untreated AHI was 30+.",
            },
            {
              metric: "Leak rate",
              full: "Unintentional leak",
              good: "Brand-specific threshold",
              body: "How much air is escaping past your mask seal beyond the intentional exhalation vent. Persistent high leak means a refit is needed — therapy can't maintain pressure if air is leaking out.",
            },
            {
              metric: "Pressure (P95)",
              full: "95th-percentile pressure",
              good: "Below your max",
              body: "On APAP, the pressure your machine is reaching for 95% of the night. A useful titration signal — if it's bumping against your max setting, your prescribed range may need adjustment.",
            },
            {
              metric: "Usage hours",
              full: "Hours per night",
              good: "≥ 4 hrs / 70%+ nights",
              body: "The Medicare adherence threshold — and the rough cutoff above which the cardiovascular benefits in clinical trials actually materialize. Insurance companies require this for rental compliance.",
            },
          ].map((m) => (
            <div key={m.metric} className="glass-card rounded-2xl p-5 md:p-6">
              <div className="grid md:grid-cols-[120px_1fr_auto] gap-4 items-start">
                <div>
                  <div className="text-display text-2xl font-bold text-[hsl(var(--penn-navy))]">
                    {m.metric}
                  </div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {m.full}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {m.body}
                  </p>
                </div>
                <div className="md:text-right">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-0.5">
                    Target
                  </div>
                  <div className="text-sm font-mono font-semibold text-[hsl(var(--penn-gold-deep))]">
                    {m.good}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* What isn't true */}
      <section className="w-full mb-12">
        <div className="glass-panel rounded-2xl p-6 md:p-7">
          <div className="flex items-center gap-3 mb-4">
            <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
              <Sparkles className="w-5 h-5" strokeWidth={2} />
            </div>
            <h2 className="text-xl md:text-2xl font-bold tracking-tight text-foreground/90">
              A few things PAP therapy is <span className="italic">not</span>.
            </h2>
          </div>
          <ul className="space-y-2.5 text-sm text-foreground/85">
            <li className="flex items-start gap-2.5">
              <span className="font-semibold w-4 shrink-0">×</span>
              <span>
                Not a ventilator. The machine doesn&apos;t breathe for you —
                you breathe normally; it just keeps your airway open.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="font-semibold w-4 shrink-0">×</span>
              <span>
                Not oxygen therapy. PAP machines deliver room air. (Oxygen
                concentrators are separate devices and can be combined with
                PAP only under physician direction.)
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="font-semibold w-4 shrink-0">×</span>
              <span>
                Not addictive. Your airway doesn&apos;t become dependent on
                pressure — your tolerance for sleeping well does. Stop
                therapy and the original apnea returns; that&apos;s the
                disease, not the device.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <span className="font-semibold w-4 shrink-0">×</span>
              <span>
                Not a cure. PAP treats sleep apnea while you&apos;re using it.
                Weight loss, anatomical surgery, or oral appliances may
                reduce the underlying disease severity — but for most
                patients, nightly PAP remains the most effective long-term
                option.
              </span>
            </li>
          </ul>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/how-pap-works"
          title="How CPAP / PAP therapy actually works"
          blurb="A short read explaining the science behind the machine, the pressure, the numbers, and what the therapy is actually doing."
          testIdPrefix="share-how-pap-works"
        />
      </div>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/therapy-types"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Settings2 className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              CPAP vs APAP vs BiPAP vs ASV
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The four common therapy modes — and the patient profile each
              one was designed for.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/device-setup"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Settings2 className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Set up your CPAP or BiPAP
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The new-patient walkthrough — unboxing, first night, daily
              care, common first-week issues.
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
          data-testid="how-works-bottom-cta-fit"
        >
          Get fitted for a mask
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. Pressure prescriptions, mode selection, and
        adherence reviews are managed by your sleep medicine provider —
        don&apos;t change settings or stop therapy without speaking with them
        first.
      </p>
    </div>
  );
}
