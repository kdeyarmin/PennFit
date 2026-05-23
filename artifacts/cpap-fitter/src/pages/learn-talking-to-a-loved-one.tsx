import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  MessageCircle,
  Sparkles,
  CheckCircle2,
  X,
  Heart,
  Users,
  AlertTriangle,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type ScriptPair = {
  context: string;
  bad: string;
  better: string;
  why: string;
};

const scripts: ScriptPair[] = [
  {
    context: "Opening the conversation",
    bad: "Your snoring is keeping me up. You need to do something about it.",
    better:
      "I've been noticing something at night that I think might be more than snoring — I'm worried about it. Can we talk about it?",
    why:
      "The first framing centers the listener's annoyance. The second centers concern for the person you're talking to. The reaction is completely different.",
  },
  {
    context: "Describing what you've noticed",
    bad: "You snore so loud I can't sleep, and you stop breathing all the time.",
    better:
      "There are stretches of 10–20 seconds where you don't seem to be breathing — and then you gasp and start again. That's the part that concerns me, not the snoring itself.",
    why:
      "Specifics convince. A description of witnessed apnea events lands differently than a complaint about volume.",
  },
  {
    context: "Why it matters",
    bad: "You're going to die of a heart attack if you don't fix this.",
    better:
      "Untreated sleep apnea is linked to higher blood pressure, AFib, and cognitive decline. I want you around for a long time, and I want both of us to actually sleep.",
    why:
      "Catastrophizing produces defensiveness. Stating real risks calmly, paired with care, produces curiosity.",
  },
  {
    context: "Suggesting the next step",
    bad: "You should go to the doctor.",
    better:
      "Would you be willing to bring this up at your next primary care visit? I'd be happy to go with you. There's a take-home sleep test now — much easier than going to a sleep lab.",
    why:
      "A specific, low-friction next step is much more likely to be accepted than an open-ended directive.",
  },
  {
    context: "If they push back",
    bad: "Why won't you just take this seriously?",
    better:
      "I hear you. Can I share an article with you — and we revisit this conversation next week?",
    why:
      "Forcing a yes in the moment produces resentment. Planting the seed and giving space lets the patient arrive at the decision themselves — which is what actually predicts follow-through.",
  },
];

const audiences = [
  {
    Icon: Heart,
    relationship: "A spouse or partner",
    body: "You sleep next to them. You've witnessed the pauses. Your influence is highest here — and your sleep is on the line too. See the dedicated bed-partner guide for more.",
  },
  {
    Icon: Users,
    relationship: "A parent",
    body: "Older parents often resist anything that sounds like 'you're getting old' — frame around independence, mental sharpness, and not wanting to lose decades of cognitive vitality. Offer to drive them to the appointment.",
  },
  {
    Icon: Users,
    relationship: "A sibling or adult child",
    body: "Less daily visibility means you need a concrete trigger — a road-trip drowsy-driving incident, a comment about being constantly tired, a new diagnosis of hypertension. Use the trigger as the opening.",
  },
  {
    Icon: Users,
    relationship: "A friend",
    body: "Different etiquette. Send the article rather than have the conversation directly. 'This made me think of you' is easier to receive than face-to-face concern, and friends often discover sleep apnea this way.",
  },
];

export function LearnTalkingToALovedOne() {
  useDocumentTitle(
    "How to talk to a loved one about sleep apnea",
    "If someone you love snores loudly or seems exhausted all the time, the conversation about getting tested is harder than it should be. Here's how to have it well.",
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
        <span className="text-foreground/85">Talking to a loved one</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            For partners &amp; family · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The conversation that&apos;s harder than it should be.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The hardest part of getting someone tested for sleep apnea is
          usually getting them to admit it&apos;s worth testing. The good
          news: there&apos;s a pattern to the conversations that work —
          and a pattern to the ones that backfire. Here&apos;s both.
        </p>
      </header>

      {/* Quick framing */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                The one rule.
              </h2>
            </div>
            <p className="text-lg text-foreground/90 leading-relaxed font-medium mb-3">
              Frame everything around{" "}
              <span className="text-gradient-brand font-bold">their</span>{" "}
              long-term health — not your sleep, not their snoring, not
              what&apos;s &ldquo;wrong&rdquo; with them.
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              The patient hears care, not complaint. They&apos;re much
              more likely to take the next step when the conversation
              feels like advocacy for them rather than relief for you.
            </p>
          </div>
        </div>
      </section>

      {/* Bad/better script pairs */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <MessageCircle className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Five scripts — what works, what doesn&apos;t.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The wording changes the outcome more than the truth value of
          what you&apos;re saying. Same facts, different reception.
        </p>

        <div className="space-y-5">
          {scripts.map((s, i) => (
            <article key={s.context} className="glass-card rounded-2xl p-6">
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-3">
                {`Script 0${i + 1} · ${s.context}`}
              </div>
              <div className="grid gap-3">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-[hsl(var(--penn-mist))]/40 border border-border/40">
                  <div className="shrink-0 h-7 w-7 rounded-lg bg-muted/60 flex items-center justify-center">
                    <X
                      className="w-4 h-4 text-muted-foreground"
                      strokeWidth={2.5}
                    />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      What backfires
                    </div>
                    <p className="text-sm text-foreground/80 italic leading-snug">
                      &ldquo;{s.bad}&rdquo;
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-xl bg-[hsl(var(--penn-gold-soft))]/30 border-l-4 border-[hsl(var(--penn-gold))]">
                  <div className="shrink-0 h-7 w-7 rounded-lg bg-[hsl(var(--penn-gold))]/20 flex items-center justify-center">
                    <CheckCircle2
                      className="w-4 h-4 text-[hsl(var(--penn-gold-deep))]"
                      strokeWidth={2.5}
                    />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--penn-gold-deep))] mb-1">
                      Try instead
                    </div>
                    <p className="text-sm text-foreground/85 italic leading-snug">
                      &ldquo;{s.better}&rdquo;
                    </p>
                  </div>
                </div>
              </div>
              <p className="text-xs text-muted-foreground leading-relaxed mt-3 pl-1">
                <span className="font-semibold">Why: </span>
                {s.why}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Different audiences */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Users className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Adjusting for who they are to you.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The relationship changes the framing. A spouse takes a
          different approach than an adult child, and a friend takes
          another approach entirely.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {audiences.map((a) => (
            <article key={a.relationship} className="glass-card rounded-2xl p-5">
              <div className="relative h-10 w-10 rounded-lg flex items-center justify-center mb-3 icon-halo-gold">
                <a.Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-base font-bold tracking-tight mb-2">
                {a.relationship}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {a.body}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* Watch-out */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                Don&apos;t be a doctor.
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                Your job is to encourage them to see one — not to
                diagnose them, prescribe a mask brand, or tell them
                what pressure they should be on. The doctor handles all
                of that. You handle the part where they actually go.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/talking-to-a-loved-one"
          title="How to talk to a loved one about sleep apnea"
          blurb="If someone you love clearly has sleep apnea symptoms but won't get tested, the conversation matters more than the medical facts. Here's how to have it well — what to say, what backfires, and what to do when they push back."
          testIdPrefix="share-talking"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/partner-guide"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Heart className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The bed partner&apos;s guide
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Specifically for partners — what you&apos;ve noticed, what
              to do, what the first month looks like.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Stethoscope className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Send them the self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              STOP-BANG — eight questions, two minutes, often the
              gentle push that opens the next conversation.
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
          <Sparkles className="w-3 h-3 mr-1.5" /> When they&apos;re ready
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="talking-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. The route to diagnosis goes through
        their physician — your role is encouragement, information, and
        showing up to the appointment if you&apos;re invited.
      </p>
    </div>
  );
}
