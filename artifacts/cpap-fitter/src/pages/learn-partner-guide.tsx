import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Heart,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Moon,
  Users,
  HeartPulse,
  Bed,
  MessageCircle,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Section = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  title: string;
  body: string;
  list?: string[];
};

const sections: Section[] = [
  {
    Icon: AlertTriangle,
    title: "What you've probably noticed (and what it might mean).",
    body: `Bed partners are usually the first person in the relationship to recognize sleep apnea — long before the patient is willing to call it that. Loud snoring that's gotten worse, witnessed pauses in breathing followed by a gasp or choke, restless legs, and the partner waking up unrefreshed despite being in bed for eight hours. These aren't "just snoring." They're often the early signs of obstructive sleep apnea.`,
  },
  {
    Icon: Bed,
    title: "Your sleep matters too. (It might be worse than theirs.)",
    body: "Partners of people with untreated OSA have measurably worse sleep quality, more nighttime arousals, and higher rates of daytime fatigue — and a meaningful minority of couples end up in separate bedrooms because of it. The partner's health takes a hit alongside the patient's, even though only one of you has the underlying condition.",
  },
  {
    Icon: MessageCircle,
    title: "How to bring it up without starting a fight.",
    body: `The conversation goes badly when the partner frames it as "your snoring is the problem." It goes well when framed as "I'm worried about your health and I'd like us to get this checked out together."`,
    list: [
      "Pick a quiet daytime moment. Not in the middle of the night, not during a fight about sleep.",
      "Lead with what you've noticed at night — specifically the pauses, gasps, or choking sounds. These aren't normal snoring.",
      "Frame it around the health consequences (cardiovascular, cognitive) — not the noise level. The medical angle is harder to dismiss.",
      "Offer to go to the doctor visit with them. The most reliable predictor of someone getting tested is having a partner go to the appointment.",
      "Record a one-minute audio clip of a typical night and offer to share it with the primary care doctor.",
    ],
  },
  {
    Icon: Moon,
    title: "What the first month on CPAP looks like for you.",
    body: "When your partner starts therapy, expect 2-4 weeks of imperfect transition. The first nights are louder than you'd hope (the cushion fit is rarely right on night one). Leak whistling at 3am is common until the seal is dialed in. Most couples describe a moment in week 2 or 3 where they realize their partner stopped snoring — and they also realize how rested they themselves feel from finally getting a quiet night.",
  },
  {
    Icon: Heart,
    title: "The everyday wins you didn't expect.",
    body: "Beyond the obvious quiet, partners of patients on consistent therapy commonly report: less daytime irritability from their partner, less of the foggy distracted behavior, restored intimacy, and the resumption of conversations that used to get short-circuited by exhaustion. The relationship benefits are real and often arrive faster than the patient's own subjective improvement.",
  },
];

export function LearnPartnerGuide() {
  useDocumentTitle(
    "The bed partner's guide to sleep apnea",
    "If your partner snores loudly or seems to stop breathing in their sleep, you're often the first person to notice — and the best advocate for getting them tested. Here's how.",
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
        <span className="text-foreground/85">For bed partners</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            For partners &amp; family · 8 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          A letter to the bed partner.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          If your partner snores loudly enough that you&apos;ve thought about
          earplugs, separate bedrooms, or an elbow to the ribs at 2am — this
          article is for you. You&apos;re probably the first person who&apos;ll
          notice the difference between snoring and sleep apnea. You&apos;re
          also probably the most influential person in whether they ever get
          tested.
        </p>
      </header>

      {/* Quick stats */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9 text-center">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The honest framing
            </div>
            <p className="text-xl md:text-2xl text-white leading-relaxed font-medium max-w-2xl mx-auto">
              The single biggest predictor of whether someone gets tested for
              sleep apnea is{" "}
              <span className="text-[hsl(var(--penn-gold))]">
                whether a loved one goes to the doctor with them
              </span>
              . You&apos;re not nagging. You&apos;re the catalyst.
            </p>
          </div>
        </div>
      </section>

      {/* Five sections */}
      <section className="w-full mb-12 space-y-5">
        {sections.map((s, i) => (
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
                  <h2 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90 mb-2">
                    {s.title}
                  </h2>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {s.body}
                  </p>
                </div>
              </div>
              {s.list && (
                <ul className="space-y-2 pl-0 md:pl-14">
                  {s.list.map((item) => (
                    <li
                      key={item}
                      className="flex items-start gap-2.5 text-sm text-foreground/85"
                    >
                      <CheckCircle2
                        className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0"
                        strokeWidth={2.5}
                      />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </article>
        ))}
      </section>

      {/* What to do tonight */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                What you can do this week.
              </h2>
            </div>
            <div className="space-y-3">
              {[
                {
                  when: "Tonight",
                  what: "Record a one-minute audio clip of a typical night. Phone on the nightstand on voice memo. The witnessed pauses or choking sounds are what convince a doctor faster than any verbal description.",
                },
                {
                  when: "This week",
                  what: "Have the conversation — daytime, calm, framed around their health rather than the snoring. Send them this article if it helps you bring it up.",
                },
                {
                  when: "This month",
                  what: "Offer to go with them to their primary care visit. Ask specifically about a home sleep apnea test referral. Most primary care offices can order one without a sleep specialist visit.",
                },
                {
                  when: "Long term",
                  what: "If they're diagnosed and start CPAP, your role is just being supportive during the 2-4 week adjustment. You'll know it's working when your own sleep improves — that's the marker patients sometimes notice last.",
                },
              ].map((s) => (
                <div key={s.when} className="flex items-start gap-3">
                  <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] pt-1 shrink-0 w-20">
                    {s.when}
                  </span>
                  <span className="text-sm text-foreground/85 leading-relaxed">
                    {s.what}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Reassurance about the mask */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <HeartPulse className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                And about the mask in your bed
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                The therapy isn&apos;t loud (modern machines are quieter than a
                quiet conversation), the mask itself is small and discreet, and
                intimacy isn&apos;t affected — most patients take it off then
                put it back on, the same way they wouldn&apos;t sleep with their
                phone in hand. Your partner with treated sleep apnea is a more
                rested, more present, more available version of the person who
                used to elbow you at 2am. The trade is overwhelmingly worth it.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/partner-guide"
          title="A letter to the bed partner — about sleep apnea"
          blurb="If you suspect your partner has sleep apnea but don't know how to bring it up, this is the article. Frames the conversation, lays out what you can actually do, and explains why your sleep is on the line too."
          testIdPrefix="share-partner"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/talking-to-a-loved-one"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <MessageCircle className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Talking to a loved one
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              How to have the conversation with a parent, sibling, or friend —
              not just a partner.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Users className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              STOP-BANG quiz — share the link with your partner.
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
          <Heart className="w-3 h-3 mr-1.5" /> When you&apos;re both ready
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="partner-cta-fit"
        >
          Start the mask fitter together
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. The path to a sleep apnea diagnosis goes
        through your partner&apos;s primary care provider — your role is
        encouragement and information, not diagnosis.
      </p>
    </div>
  );
}
