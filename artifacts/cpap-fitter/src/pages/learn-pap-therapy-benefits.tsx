import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  ArrowRight,
  Sunrise,
  Heart,
  Brain,
  Zap,
  Users,
  Moon,
  Coffee,
  Sparkles,
  HeartPulse,
  CheckCircle2,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Timeline = {
  when: string;
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  signs: string[];
};

const timeline: Timeline[] = [
  {
    when: "The first morning",
    Icon: Sunrise,
    title: "You wake up feeling rested. Often for the first time in years.",
    body: "Most patients describe the first successful night on therapy as one of the clearest before/after moments in their adult life. The morning headache is gone. The fog lifts within the first hour of waking. The phrase we hear most often is 'I forgot what this felt like.'",
    signs: [
      "No morning headache",
      "Clear-headed within minutes of waking",
      "Bed partner reports quiet sleep",
    ],
  },
  {
    when: "Week 1–2",
    Icon: Coffee,
    title: "The 3pm crash disappears.",
    body: "By the second week, daytime sleepiness is dramatically reduced. The afternoon energy dip — the one most people blame on lunch — turns out to have been driven by overnight sleep fragmentation. With consolidated sleep architecture, that crash flattens out.",
    signs: [
      "No more 3pm slump",
      "Easier to stay alert driving",
      "Less coffee through the afternoon",
    ],
  },
  {
    when: "Month 1",
    Icon: HeartPulse,
    title: "Blood pressure begins measurably dropping.",
    body: "Continuous overnight pressure removes the recurring spikes that drove daytime hypertension. Meta-analyses show systolic drops of 2–5 mmHg on average — more in patients with resistant hypertension or severe baseline OSA. Your primary care doctor may be the first to notice.",
    signs: [
      "Home BP cuff trending lower",
      "Possible medication reduction (talk to your physician)",
      "Reduced AM sympathetic surge",
    ],
  },
  {
    when: "Month 2–3",
    Icon: Brain,
    title: "Memory, focus, and mood meaningfully improve.",
    body: "The brain finally gets the deep and REM sleep it was missing. Patients report sharper short-term memory, easier task-switching, and a noticeable lift in mood. Depression and anxiety scales (PHQ-9, GAD-7) show measurable improvement in published cohorts.",
    signs: [
      "Better word recall",
      "Mood symptoms ease",
      "Easier emotional regulation",
    ],
  },
  {
    when: "Quarter 1",
    Icon: Zap,
    title: "Metabolic markers move.",
    body: "A1C trends down in diabetic patients. Hunger hormones (leptin and ghrelin) re-balance. Weight loss becomes easier — not because PAP burns calories, but because consolidated sleep restores the metabolic and behavioral conditions under which appetite and exercise tolerance recover.",
    signs: [
      "A1C improvement at next labs",
      "Less middle-of-the-night snacking",
      "More energy for exercise",
    ],
  },
  {
    when: "Year 1",
    Icon: Heart,
    title: "Cardiovascular risk trends back toward baseline.",
    body: "After 12 months of consistent adherence, large cohort studies show stroke and major cardiovascular event risk falling toward the rate of matched non-OSA adults. AFib recurrence after ablation drops. Heart-failure symptoms stabilize. Treated OSA is one of the few cardiovascular interventions that gets stronger over time, not weaker.",
    signs: [
      "Stroke risk approaches baseline",
      "AFib burden reduces",
      "Cardio fitness measurably better",
    ],
  },
];

const partnerBenefits = [
  {
    Icon: Moon,
    title: "Your partner sleeps too.",
    body: "Untreated OSA snoring is loud enough to push partners into separate bedrooms in a measurable fraction of couples. Quiet, consistent therapy ends that — and 'I get my own sleep back too' is the most common partner testimonial we hear.",
  },
  {
    Icon: Users,
    title: "Your family gets you back.",
    body: "Patients consistently report being more patient with kids, more present in conversation, and more able to follow what's happening at dinner. The cumulative weekend recovery they used to need disappears.",
  },
  {
    Icon: Sparkles,
    title: "Libido and intimacy.",
    body: "Both are commonly affected by untreated OSA, in both men and women. Both improve on consistent therapy — partly via hormonal pathways, mostly because you stop being exhausted.",
  },
];

export function LearnPapTherapyBenefits() {
  useDocumentTitle(
    "What PAP therapy actually feels like",
    "The benefits of CPAP / BiPAP therapy week by week — energy, blood pressure, mood, cognition, metabolic health, and relationships. What the data and patients both report.",
    { schema: "MedicalWebPage" },
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
        <span className="text-foreground/85">Benefits of PAP therapy</span>
      </div>

      {/* Article header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            What treatment feels like · 8 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The benefits, on a real timeline.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          PAP therapy isn&apos;t a one-night fix and it isn&apos;t a six-month
          slog. The benefits arrive in distinct waves over the first year —
          some within hours, some that take quarters to settle in. Here&apos;s
          what the published literature and our own patient cohort consistently
          report.
        </p>
      </header>

      {/* Timeline */}
      <section className="w-full mb-12 space-y-5">
        {timeline.map((t, i) => (
          <article
            key={t.when}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10 flex items-start gap-4">
              <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <t.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                  {t.when}
                </div>
                <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90 mb-2">
                  {t.title}
                </h2>
                <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                  {t.body}
                </p>
                <ul className="space-y-1.5">
                  {t.signs.map((s) => (
                    <li
                      key={s}
                      className="flex items-start gap-2 text-xs text-foreground/85"
                    >
                      <CheckCircle2
                        className="w-3.5 h-3.5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                        strokeWidth={2.5}
                      />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* The relational benefits */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Users className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            And the part the studies undercount.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Clinical trials measure AHI, blood pressure, and A1C. What patients
          tell us actually changed their life rarely makes it into a primary
          endpoint.
        </p>
        <div className="grid md:grid-cols-3 gap-4">
          {partnerBenefits.map(({ Icon, title, body }) => (
            <div key={title} className="glass-card rounded-2xl p-6">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center mb-3 icon-halo-navy">
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
      </section>

      {/* The adherence reality */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                The honest catch.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed mb-4">
              Every benefit on this page depends on{" "}
              <span className="font-semibold text-foreground/90">
                wearing the mask
              </span>{" "}
              — most nights, most of the night. Patients who average four or
              more hours per night, five-plus nights a week, get the
              cardiovascular and metabolic outcomes the studies report.
              Patients who can&apos;t tolerate their mask don&apos;t.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              That&apos;s why fit matters. A mask that wakes you up at 3am
              isn&apos;t therapy — it&apos;s a frustrating object on your face.
              The single biggest decision you&apos;ll make is choosing one
              that&apos;s genuinely comfortable enough to sleep through. The
              fitter exists for that exact reason.
            </p>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/pap-therapy-benefits"
          title="What PAP therapy actually feels like, on a real timeline"
          blurb="If someone you know is dragging their feet on starting CPAP, this lays out exactly what they'll feel and when. Worth a forward."
          testIdPrefix="share-benefits"
        />
      </div>

      {/* CTAs */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/how-pap-works"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Brain className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              How PAP therapy actually works
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The science under the hood — pressure, exhalation relief,
              humidification, and the numbers your machine tracks every night.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/therapy-types"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <HeartPulse className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              CPAP vs APAP vs BiPAP vs ASV
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              What the four therapy modes do differently, and how your doctor
              picks between them.
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
          data-testid="benefits-bottom-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice. Individual results
        vary. Specific medication and treatment decisions should always
        involve your physician.
      </p>
    </div>
  );
}
