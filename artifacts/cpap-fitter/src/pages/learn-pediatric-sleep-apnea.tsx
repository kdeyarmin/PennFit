import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Baby,
  Sparkles,
  AlertTriangle,
  CheckCircle2,
  Stethoscope,
  Moon,
  Brain,
  School,
  Heart,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Sign = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
};

const signs: Sign[] = [
  {
    Icon: Moon,
    title: "Loud snoring, gasps, mouth breathing",
    body: "Habitual loud snoring in a child isn't 'cute' — it's the single most reliable sign of pediatric OSA. Witnessed pauses, choking sounds, or sustained mouth breathing during sleep all add to the picture.",
  },
  {
    Icon: School,
    title: "Behavioral & attention symptoms",
    body: "Where adults with OSA tend to feel sleepy, kids with OSA tend to look hyperactive, irritable, or distracted. ADHD-like symptoms are common, and the relationship is bidirectional — undiagnosed pediatric OSA can mimic, mask, or worsen attention disorders.",
  },
  {
    Icon: Brain,
    title: "Academic & cognitive impact",
    body: "Untreated pediatric OSA is associated with measurably worse academic performance, working-memory deficits, and executive-function challenges. Many of these reverse with effective treatment — a meaningful argument for early identification.",
  },
  {
    Icon: AlertTriangle,
    title: "Restless sleep & odd positions",
    body: "Children with OSA often sleep in unusual positions (neck hyperextended, head off the bed) trying to keep the airway open. Bedwetting that returns after years of dry nights is also a quiet sign worth flagging.",
  },
];

export function LearnPediatricSleepApnea() {
  useDocumentTitle(
    "Pediatric sleep apnea — signs, causes, treatment",
    "Pediatric obstructive sleep apnea looks different than the adult version — hyperactivity and behavioral symptoms instead of daytime sleepiness. Snoring in a child isn't normal. Here's what to know.",
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
        <span className="text-foreground/85">Pediatric sleep apnea</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Special populations · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Children snore differently than they should.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          Roughly{" "}
          <span className="font-semibold text-foreground">
            1–5% of children
          </span>{" "}
          have obstructive sleep apnea, and many more snore habitually in
          ways that affect their daytime behavior, academic performance,
          and growth. Pediatric OSA presents very differently than adult
          OSA — and the parent is almost always the first to notice the
          symptoms.
        </p>
      </header>

      {/* Important framing */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                First, the key difference.
              </h2>
            </div>
            <p className="text-base md:text-lg text-foreground/90 leading-relaxed font-medium mb-3">
              Adults with sleep apnea look <em>sleepy</em>. Children with
              sleep apnea often look <em>wired</em>.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Hyperactivity, irritability, and inattention are the
              everyday presentation of pediatric OSA — not the heavy
              daytime sleepiness adults report. If your child snores
              loudly and seems to be struggling with attention or
              behavior in school, the two might be the same problem.
            </p>
          </div>
        </div>
      </section>

      {/* The four signs */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <AlertTriangle className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Four signs worth flagging to your pediatrician.
          </h2>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          {signs.map((s) => (
            <article key={s.title} className="glass-card rounded-2xl p-5">
              <div className="relative h-10 w-10 rounded-lg flex items-center justify-center mb-3 icon-halo-gold">
                <s.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-base font-bold tracking-tight mb-2">
                {s.title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {s.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* The cause is usually mechanical */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Baby className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            The cause is usually mechanical.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Unlike adult OSA — which is driven by weight, anatomy, and
          tissue relaxation — pediatric OSA is most commonly caused by
          enlarged tonsils and adenoids physically narrowing the airway.
          This is why the treatment pathway is different:
        </p>

        <div className="space-y-3">
          {[
            {
              title: "Step 1 — Evaluation",
              body: "A pediatrician or pediatric ENT examines the airway. If tonsils and adenoids look enlarged, that's often the working hypothesis even before a sleep study.",
            },
            {
              title: "Step 2 — Sleep study (if needed)",
              body: "Polysomnography in a pediatric sleep lab. The diagnostic threshold for pediatric OSA is lower than adult OSA — even an AHI of 1–5 is considered meaningful in children.",
            },
            {
              title: "Step 3 — Adenotonsillectomy",
              body: "Surgical removal of enlarged tonsils and adenoids resolves OSA in roughly 70–80% of pediatric cases. The standard first-line treatment.",
            },
            {
              title: "Step 4 — CPAP (if surgery isn't enough)",
              body: "When OSA persists post-surgery, or in children with anatomical or neuromuscular conditions where surgery isn't appropriate, pediatric CPAP is used. The masks are sized smaller and the pressure ranges are lower than adult therapy.",
            },
          ].map((s) => (
            <div key={s.title} className="glass-card rounded-2xl p-5">
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                {s.title.split(" — ")[0]}
              </div>
              <h3 className="text-base font-semibold tracking-tight mb-2">
                {s.title.split(" — ")[1]}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {s.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Important callouts */}
      <section className="w-full mb-12 space-y-4">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <School className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                The ADHD overlap
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Some studies estimate a quarter to a third of children
                diagnosed with ADHD also have undiagnosed OSA. This
                doesn&apos;t mean ADHD is sleep apnea — it means the two
                overlap, and treating OSA in a child with attention
                problems can produce striking improvement when it&apos;s
                contributing.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                When to escalate quickly
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Children with Down syndrome, craniofacial differences,
                neuromuscular conditions, or severe obesity have much
                higher OSA prevalence and should be screened proactively.
                Talk to your pediatrician sooner rather than waiting for
                symptoms to be obvious.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* What to do as a parent */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <Sparkles className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What to do as a parent.
          </h2>
        </div>
        <div className="space-y-3">
          {[
            "Record a one-minute video of your child sleeping on a typical night — the audio matters more than the picture. Show it at the pediatric visit.",
            "Track sleep duration, bedwetting, mood/behavior, and academic concerns for two weeks. Patterns convince pediatricians faster than complaints.",
            "Ask your pediatrician directly: 'Could this be sleep apnea?' Their workup will start there — usually a tonsil/adenoid exam and a sleep study referral.",
            "If surgery is recommended, ask about the expected recovery, follow-up sleep study schedule, and what 'success' looks like for your child.",
            "If CPAP is recommended, know that pediatric mask fit is a specialty — work with a pediatric sleep team or a DME with pediatric experience.",
          ].map((step) => (
            <div
              key={step}
              className="flex items-start gap-3 glass-card rounded-xl p-4"
            >
              <CheckCircle2
                className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                strokeWidth={2.5}
              />
              <span className="text-sm text-foreground/85 leading-relaxed">
                {step}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/pediatric-sleep-apnea"
          title="Children snore differently than they should"
          blurb="Pediatric sleep apnea presents as hyperactivity and behavioral symptoms — not the daytime sleepiness adults have. If a kid in your life snores loudly and is struggling at school, this is worth sending to a parent."
          testIdPrefix="share-pediatric"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-explained"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Moon className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              What sleep apnea really is
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The adult primer — useful context for what the disease
              actually does.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/glossary"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              CPAP glossary
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Every term and acronym you&apos;ll encounter on the pediatric
              sleep study report.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-standard border-0 font-medium"
        >
          <Heart className="w-3 h-3 mr-1.5" /> For pediatric patients
        </Badge>
        <p className="text-sm text-muted-foreground leading-relaxed max-w-xl mx-auto mb-5">
          PennPaps is set up primarily for adult CPAP. For pediatric
          equipment, we&apos;ll connect you with a partner DME with
          pediatric sizing and fit experience. Call us and we&apos;ll route
          you appropriately.
        </p>
        <Button
          variant="outline"
          size="lg"
          className="h-12 px-7 rounded-full glass-card hover:border-primary/40"
          onClick={() => navigate("/faq")}
          data-testid="pediatric-cta-faq"
        >
          See our FAQ
          <ArrowRight className="w-4 h-4 ml-1.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not pediatric medical advice. Children
        with sleep concerns should be evaluated by a pediatrician or
        pediatric sleep specialist.
      </p>
    </div>
  );
}
