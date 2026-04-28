import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  BookOpen,
  Moon,
  Wind,
  Heart,
  Glasses,
  Activity,
  CalendarClock,
  Plane,
  Users,
  Stethoscope,
  Sparkles,
  ArrowRight,
} from "lucide-react";

type Article = {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  takeaway: string;
  body: React.ReactNode;
  tone: "navy" | "gold";
};

const articles: Article[] = [
  {
    Icon: Moon,
    title: "What is Sleep Apnea?",
    takeaway:
      "Repeated breathing pauses during sleep — common, treatable, and often invisible to the patient.",
    tone: "navy",
    body: (
      <>
        Obstructive sleep apnea (OSA) happens when the soft tissues in the
        back of your throat relax during sleep and block your airway, causing
        breathing pauses (apneas) and shallow breaths (hypopneas) — sometimes
        hundreds of times a night. Each pause briefly drops your blood
        oxygen, jolts your nervous system out of deep sleep, and prevents
        the restorative rest your body needs. Over time, untreated OSA is
        linked to high blood pressure, heart disease, stroke risk, daytime
        accidents, and worsened diabetes. The good news: it's one of the
        most treatable sleep disorders we know of.
      </>
    ),
  },
  {
    Icon: Wind,
    title: "How CPAP Works",
    takeaway:
      "A bedside machine delivers a steady, gentle pressure that holds your airway open all night.",
    tone: "navy",
    body: (
      <>
        Your CPAP machine takes in room air, gently pressurizes it (often
        with optional warmed humidification), and sends it through a hose
        and mask. That continuous pressure acts like an air splint —
        keeping your throat from collapsing as you breathe in and out.
        You're not breathing for the machine; the machine is just keeping
        the door open. Modern CPAPs are quiet (~26 dB, quieter than a
        whisper), compact, and automatically adjust to your breathing
        pattern.
      </>
    ),
  },
  {
    Icon: Heart,
    title: "Why Treatment Matters",
    takeaway:
      "Treating sleep apnea improves daytime energy, blood pressure, mood, and long-term cardiovascular health.",
    tone: "gold",
    body: (
      <>
        Patients who use CPAP consistently report sharper morning focus,
        less daytime sleepiness, fewer headaches, and dramatically better
        sleep quality for their bed partner. Long-term, controlled studies
        link consistent CPAP use to lower blood pressure, fewer
        cardiovascular events, better blood sugar control in diabetics,
        and reduced risk of motor vehicle accidents. The therapy only
        works while you're using it — which is why getting a comfortable,
        well-fitting mask is the single biggest predictor of whether
        you'll stick with treatment.
      </>
    ),
  },
  {
    Icon: Glasses,
    title: "Understanding Mask Styles",
    takeaway:
      "Three broad styles — nasal pillows, nasal masks, and full-face — each suited to different sleepers.",
    tone: "navy",
    body: (
      <>
        <strong>Nasal pillows</strong> are minimal — small silicone tips
        that sit just inside the nostrils. They're light, low-contact, and
        ideal for side sleepers and patients with claustrophobia, but
        deliver less pressure stability at higher settings.{" "}
        <strong>Nasal masks</strong> cover only the nose with a triangular
        cushion — a comfortable middle ground for most patients.{" "}
        <strong>Full-face masks</strong> cover both nose and mouth — the
        right call if you're a mouth-breather, run high pressures, or
        struggle with chronic congestion. Penn Fit weighs all three
        against your face shape and questionnaire answers before
        recommending.
      </>
    ),
  },
  {
    Icon: Activity,
    title: "Sleep Position & Mask Choice",
    takeaway:
      "Side and stomach sleepers need lower-profile masks; back sleepers have the most flexibility.",
    tone: "gold",
    body: (
      <>
        If you sleep on your side, a bulky full-face mask will dig into
        the pillow and break its seal at every roll — nasal pillows or a
        slim nasal mask is almost always the better choice. Stomach
        sleepers face the same constraint and benefit from minimal-contact
        styles. Back sleepers can wear any mask comfortably, so the
        decision comes down to whether you mouth-breathe and what
        pressure you're prescribed. Penn Fit's questionnaire asks about
        position so we don't recommend a mask that'll fight your
        favorite sleeping pose.
      </>
    ),
  },
  {
    Icon: CalendarClock,
    title: "Replacement Schedule",
    takeaway:
      "Cushions every 2–4 weeks, headgear every 6 months, tubing every 3 months, filters monthly.",
    tone: "navy",
    body: (
      <>
        CPAP supplies wear out faster than you'd think. Silicone cushions
        gradually lose their shape and seal, headgear elastic stretches,
        tubing collects mineral deposits, and filters trap dust. Most US
        insurance plans cover replacements on a roughly: <em>cushions
        every 2–4 weeks, headgear every 6 months, tubing every 3 months,
        filters monthly</em> cadence. Penn Home Medical Supply's resupply
        program tracks your schedule and reaches out when you're due —
        you don't have to remember.
      </>
    ),
  },
  {
    Icon: Plane,
    title: "Traveling with CPAP",
    takeaway:
      "CPAP machines fly free as medical equipment — pack smart and bring distilled water plans.",
    tone: "gold",
    body: (
      <>
        CPAP machines do not count toward your carry-on allowance on US
        airlines and almost all international carriers — bring it in
        addition to your carry-on. TSA may ask you to remove it from its
        bag at security. For longer trips, pack a backup mask cushion, a
        spare filter, and your prescription (in case airport security or
        a hotel asks). Since tap water varies, plan for distilled water
        at your destination or skip the humidifier for a few nights —
        your therapy still works without it.
      </>
    ),
  },
  {
    Icon: Users,
    title: "Sleeping Together with CPAP",
    takeaway:
      "Modern CPAPs are nearly silent and most bed partners sleep better, not worse.",
    tone: "navy",
    body: (
      <>
        Patients often worry their CPAP will disturb a bed partner —
        the reverse is usually true. Modern CPAPs run quieter than a
        ceiling fan, and eliminating snoring and gasping pauses makes
        the bedroom calmer, not louder. The most common partner
        complaints are mask air leaks (a fit issue we can solve) and
        the sound of the heated humidifier (turn it down or off). If a
        partner is sensitive to the hose movement, a hose hanger above
        the bed keeps it out of the way.
      </>
    ),
  },
  {
    Icon: Stethoscope,
    title: "Working With Your Sleep Provider",
    takeaway:
      "Your prescription, pressure setting, and clinical changes come from your provider — supplies come from us.",
    tone: "gold",
    body: (
      <>
        Penn Home Medical Supply handles the equipment side: mask
        fitting, ordering, insurance verification, and resupply. Your
        sleep medicine provider handles the clinical side: diagnosing
        apnea, prescribing CPAP, setting your pressure, and adjusting
        therapy if symptoms change. The two work together — we'll
        coordinate prescriptions and pressure changes with your
        provider's office on your behalf, so you don't have to be the
        messenger between us.
      </>
    ),
  },
];

const tones = {
  navy: "icon-halo-navy",
  gold: "icon-halo-gold",
} as const;

export function Learn() {
  return (
    <div className="container max-w-5xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <BookOpen className="w-4 h-4" />
            <span>Patient Education from Penn Home Medical Supply</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Learn
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Understand Your CPAP Therapy
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Short, plain-language guides on sleep apnea, CPAP basics, mask
          choice, and living comfortably with therapy — written by the same
          team that fits you.
        </p>
      </header>

      {/* Article cards */}
      <section className="grid gap-5 md:grid-cols-2">
        {articles.map(({ Icon, title, takeaway, body, tone }) => (
          <article
            key={title}
            className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col gap-4"
          >
            <div className="flex items-start gap-4">
              <div
                className={`shrink-0 h-12 w-12 rounded-xl ${tones[tone]} flex items-center justify-center`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-lg font-semibold tracking-tight">
                  {title}
                </h2>
                <p className="text-sm text-[hsl(var(--penn-navy))]/80 font-medium leading-snug">
                  {takeaway}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {body}
            </p>
          </article>
        ))}
      </section>

      {/* Disclaimer */}
      <section>
        <div className="glass-card rounded-2xl relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 0% 0%, hsl(var(--penn-navy) / 0.10), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <div className="p-6 sm:p-8 flex gap-4 relative">
            <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
              <Stethoscope className="w-5 h-5" />
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold tracking-tight text-primary">
                Educational, not medical advice
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                These articles are general patient education from the team at
                Penn Home Medical Supply. They aren't a substitute for
                personalized advice from your sleep medicine provider. If
                you're experiencing new or worsening symptoms — daytime
                sleepiness, choking episodes, persistent skin breakdown, or
                changes in how your therapy feels — please contact your
                provider.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Cross-links */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/faq"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="learn-link-faq"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Browse the FAQ
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Quick answers to specific questions on ordering, insurance,
              cleaning, and troubleshooting.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/how-it-works"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="learn-link-how-it-works"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              How Penn Fit works
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A walkthrough of the three-minute fitting flow, with capture
              tips and questionnaire guidance.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4 pt-2">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          When you're ready, we'll fit you in minutes.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Penn Fit uses your camera on-device to recommend the right mask. No
          uploads, no waiting on a callback.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link href="/consent">
            <Button
              size="lg"
              className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Start Fitting Process
            </Button>
          </Link>
          <Link href="/masks">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full glass-panel border-border/60"
            >
              Browse Mask Catalog
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
