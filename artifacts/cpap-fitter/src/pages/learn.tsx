import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { LearnVideoLibrary } from "@/components/learn-video-library";
import { NewsletterSignup } from "@/components/newsletter-signup";
import { useDocumentTitle } from "@/hooks/use-document-title";
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
  Settings2,
  Droplets,
  Repeat,
  ShieldCheck,
  Sunrise,
  LifeBuoy,
  ClipboardList,
  AlertTriangle,
} from "lucide-react";

type Category =
  | "basics"
  | "equipment"
  | "care"
  | "living"
  | "concerns"
  | "team";

type Article = {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  takeaway: string;
  body: React.ReactNode;
  tone: "navy" | "gold";
  category: Category;
};

const categoryMeta: Record<
  Category,
  { eyebrow: string; title: string; caption: string }
> = {
  basics: {
    eyebrow: "Foundations",
    title: "The Basics",
    caption:
      "What sleep apnea is, how CPAP solves it, and why treating it changes more than just sleep.",
  },
  equipment: {
    eyebrow: "Fit",
    title: "Choosing Your Equipment",
    caption:
      "Mask styles, sleep position, and the tradeoffs that decide whether a mask works for your face.",
  },
  care: {
    eyebrow: "Hygiene",
    title: "Daily Care & Maintenance",
    caption:
      "Cleaning routines and replacement cadences — the small habits that keep therapy hygienic and effective.",
  },
  living: {
    eyebrow: "Habits",
    title: "Living with Therapy",
    caption:
      "Building the nightly habit, sleeping with a partner, and traveling without breaking your routine.",
  },
  concerns: {
    eyebrow: "Honest answers",
    title: "Common Concerns & When It Feels Hard",
    caption:
      "The objections we hear most often — and the specific fixes for the discomforts that drive people to quit too early.",
  },
  team: {
    eyebrow: "Coordination",
    title: "Working with Your Care Team",
    caption:
      "How PennPaps and your sleep medicine provider divide responsibilities so you don't have to be the messenger.",
  },
};

const CATEGORY_ORDER: Category[] = [
  "basics",
  "equipment",
  "care",
  "living",
  "concerns",
  "team",
];

const articles: Article[] = [
  // ── Foundations ────────────────────────────────────────────────
  {
    Icon: Moon,
    title: "What is Sleep Apnea?",
    takeaway:
      "Repeated breathing pauses during sleep — common, treatable, and often invisible to the patient.",
    tone: "navy",
    category: "basics",
    body: (
      <>
        Obstructive sleep apnea (OSA) happens when the soft tissues in the back
        of your throat relax during sleep and block your airway, causing
        breathing pauses (apneas) and shallow breaths (hypopneas) — sometimes
        hundreds of times a night. Each pause briefly drops your blood oxygen,
        jolts your nervous system out of deep sleep, and prevents the
        restorative rest your body needs. Over time, untreated OSA is linked to
        high blood pressure, heart disease, stroke risk, daytime accidents, and
        worsened diabetes. The good news: it's one of the most treatable sleep
        disorders we know of.
      </>
    ),
  },
  {
    Icon: Wind,
    title: "How CPAP Works",
    takeaway:
      "A bedside machine delivers a steady, gentle pressure that holds your airway open all night.",
    tone: "navy",
    category: "basics",
    body: (
      <>
        Your CPAP machine takes in room air, gently pressurizes it (often with
        optional warmed humidification), and sends it through a hose and mask.
        That continuous pressure acts like an air splint — keeping your throat
        from collapsing as you breathe in and out. You're not breathing for the
        machine; the machine is just keeping the door open. Modern CPAPs are
        quiet (~26 dB, quieter than a whisper), compact, and automatically
        adjust to your breathing pattern.
      </>
    ),
  },
  {
    Icon: Heart,
    title: "Why Treatment Matters",
    takeaway:
      "Treating sleep apnea improves daytime energy, blood pressure, mood, and long-term cardiovascular health.",
    tone: "gold",
    category: "basics",
    body: (
      <>
        Patients who use CPAP consistently report sharper morning focus, less
        daytime sleepiness, fewer headaches, and dramatically better sleep
        quality for their bed partner. Long-term, controlled studies link
        consistent CPAP use to lower blood pressure, fewer cardiovascular
        events, better blood sugar control in diabetics, and reduced risk of
        motor vehicle accidents. The therapy only works while you're using it —
        which is why getting a comfortable, well-fitting mask is the single
        biggest predictor of whether you'll stick with treatment.
      </>
    ),
  },

  // ── Choosing Your Equipment ────────────────────────────────────
  {
    Icon: Glasses,
    title: "Understanding Mask Styles",
    takeaway:
      "Three broad styles — nasal pillows, nasal masks, and full-face — each suited to different sleepers.",
    tone: "navy",
    category: "equipment",
    body: (
      <>
        <strong>Nasal pillows</strong> are minimal — small silicone tips that
        sit just inside the nostrils. They're light, low-contact, and ideal for
        side sleepers and patients with claustrophobia, but deliver less
        pressure stability at higher settings. <strong>Nasal masks</strong>{" "}
        cover only the nose with a triangular cushion — a comfortable middle
        ground for most patients. <strong>Full-face masks</strong> cover both
        nose and mouth — the right call if you're a mouth-breather, run high
        pressures, or struggle with chronic congestion. PennPaps weighs all
        three against your face shape and questionnaire answers before
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
    category: "equipment",
    body: (
      <>
        If you sleep on your side, a bulky full-face mask will dig into the
        pillow and break its seal at every roll — nasal pillows or a slim nasal
        mask is almost always the better choice. Stomach sleepers face the same
        constraint and benefit from minimal-contact styles. Back sleepers can
        wear any mask comfortably, so the decision comes down to whether you
        mouth-breathe and what pressure you're prescribed. PennPaps's
        questionnaire asks about position so we don't recommend a mask that'll
        fight your favorite sleeping pose.
      </>
    ),
  },

  // ── Daily Care ─────────────────────────────────────────────────
  {
    Icon: Droplets,
    title: "Cleaning Your CPAP",
    takeaway:
      "Daily wipe of the cushion, weekly soap-and-water for the mask, monthly chamber soak — simple, no special gadgets.",
    tone: "navy",
    category: "care",
    body: (
      <>
        A clean CPAP isn't a deep-clean ritual — it's a few small habits.{" "}
        <strong>Daily:</strong> empty leftover water from the humidifier and let
        the chamber air-dry. Wipe the mask cushion with a soft damp cloth or a
        CPAP wipe to remove face oils. <strong>Weekly:</strong> take the mask
        apart and hand-wash the cushion, frame, and headgear in warm water with
        mild dish soap — no scented soaps, no bleach, no alcohol, all of which
        break down silicone and void the warranty. Rinse thoroughly and air-dry.
        Wash the tubing the same way and hang it to drip-dry.{" "}
        <strong>Monthly:</strong> swap your filter, give the water chamber a
        vinegar-and-water soak (1:1 for 30 minutes), then rinse. Skip the UV
        sanitizers and ozone "cleaners" — the FDA has cautioned against them and
        they can damage equipment without proven benefit over routine soap and
        water.
      </>
    ),
  },
  {
    Icon: CalendarClock,
    title: "Replacement Schedule",
    takeaway:
      "Cushions every 2–4 weeks, headgear every 6 months, tubing every 3 months, filters monthly.",
    tone: "gold",
    category: "care",
    body: (
      <>
        CPAP supplies wear out faster than you'd think. Silicone cushions
        gradually lose their shape and seal, headgear elastic stretches, tubing
        collects mineral deposits, and filters trap dust. Most US insurance
        plans cover replacements on a roughly:{" "}
        <em>
          cushions every 2–4 weeks, headgear every 6 months, tubing every 3
          months, filters monthly
        </em>{" "}
        cadence. PennPaps's resupply program tracks your schedule and reaches
        out when you're due — you don't have to remember.
      </>
    ),
  },

  // ── Living with Therapy ────────────────────────────────────────
  {
    Icon: Sunrise,
    title: "What to Expect: The First Two Weeks",
    takeaway:
      "An adjustment period is normal — most patients hit their stride between night 7 and night 21.",
    tone: "navy",
    category: "living",
    body: (
      <>
        The first nights with CPAP almost always feel strange. Your face is
        wearing something new, your bedroom has a new sound profile, and your
        brain is processing "is this safe to sleep with?" Plan for it.{" "}
        <strong>Nights 1–3:</strong> wear the mask 30 minutes during the day
        (reading, watching TV) before you ever sleep with it on — it builds the
        "oh, that's just my mask" familiarity faster than white-knuckling it
        through bedtime. <strong>Nights 4–10:</strong> many patients experience
        a deeper-sleep "rebound" and may sleep more than usual as the body
        catches up on years of fragmented sleep. That's a good sign.{" "}
        <strong>Nights 11–21:</strong> the mask starts to feel normal, you wake
        up clearer-headed, and the morning improvements compound. If you're past
        three weeks and still struggling, the mask probably isn't right for you
        — message us and we'll re-fit you.
      </>
    ),
  },
  {
    Icon: Repeat,
    title: "Building a Consistent Routine",
    takeaway:
      "The biggest predictor of long-term benefit is wearing it nightly — including naps, weekends, and travel.",
    tone: "gold",
    category: "living",
    body: (
      <>
        CPAP only works while it's on. Aim for every sleep session, every night
        — including naps and weekends. Even a few nights off early on can
        re-introduce the daytime fatigue and partner- disturbing snoring you
        signed up to fix. A few tactics that help: keep the machine on the same
        nightstand every night so it becomes part of your bedtime cue, plug it
        in <em>before</em> you brush your teeth so it's ready when you are, keep
        a backup cushion in your nightstand for the inevitable weak-strap night,
        and pack the travel bag the day before any trip so you don't "forget" to
        bring it. Insurance compliance windows (typically 4 hours/night, 70% of
        nights, in the first 90 days) exist precisely because consistency is
        what makes the therapy clinically effective.
      </>
    ),
  },
  {
    Icon: Users,
    title: "Sleeping Together with CPAP",
    takeaway:
      "Modern CPAPs are nearly silent and most bed partners sleep better, not worse.",
    tone: "navy",
    category: "living",
    body: (
      <>
        Patients often worry their CPAP will disturb a bed partner — the reverse
        is usually true. Modern CPAPs run quieter than a ceiling fan, and
        eliminating snoring and gasping pauses makes the bedroom calmer, not
        louder. The most common partner complaints are mask air leaks (a fit
        issue we can solve) and the sound of the heated humidifier (turn it down
        or off). If a partner is sensitive to the hose movement, a hose hanger
        above the bed keeps it out of the way. Patients also report renewed
        intimacy once both partners are sleeping deeply through the night —
        chronic exhaustion is its own relationship strain.
      </>
    ),
  },
  {
    Icon: Plane,
    title: "Traveling with CPAP",
    takeaway:
      "CPAP machines fly free as medical equipment — pack smart and bring distilled water plans.",
    tone: "gold",
    category: "living",
    body: (
      <>
        CPAP machines do not count toward your carry-on allowance on US airlines
        and almost all international carriers — bring it in addition to your
        carry-on. TSA may ask you to remove it from its bag at security. For
        longer trips, pack a backup mask cushion, a spare filter, and your
        prescription (in case airport security or a hotel asks). Since tap water
        varies, plan for distilled water at your destination or skip the
        humidifier for a few nights — your therapy still works without it.
      </>
    ),
  },

  // ── Common Concerns ────────────────────────────────────────────
  {
    Icon: ShieldCheck,
    title: "Common Concerns & Myths",
    takeaway:
      "Most resistance to CPAP comes from outdated fears — modern equipment and modern fitting practices solve almost all of them.",
    tone: "navy",
    category: "concerns",
    body: (
      <>
        A few of the objections we hear most often, and what's actually true.{" "}
        <em>"It's claustrophobic"</em> — nasal pillows weigh less than a pair of
        glasses and don't cover your face at all; most claustrophobia complaints
        disappear with the right mask style.{" "}
        <em>"I'll become dependent on it"</em> — CPAP is a treatment, not a
        drug. It works while you wear it; your body doesn't lose the ability to
        breathe on its own. <em>"It's noisy"</em> — modern machines run at ~26
        dB, quieter than a whisper and quieter than your own breathing.{" "}
        <em>"I only need it on bad nights"</em> — apnea events happen every
        night you sleep on your back without therapy, whether you feel it the
        next day or not. <em>"I should lose weight first"</em> — losing weight
        can reduce apnea severity in some patients, but you need restorative
        sleep to have the energy to exercise and the hormonal balance to lose
        weight. Treating apnea makes weight loss easier, not the other way
        around.
      </>
    ),
  },
  {
    Icon: LifeBuoy,
    title: "When CPAP Feels Hard",
    takeaway:
      "Mask leaks, dry mouth, congestion, and pressure intolerance all have specific fixes — don't quit, adjust.",
    tone: "gold",
    category: "concerns",
    body: (
      <>
        Almost every adherence problem traces back to one of four issues, all
        fixable. <strong>Mask leaks:</strong> usually a fit problem (wrong size
        or worn-out cushion) or a sleeping-position mismatch — we'll re-measure
        and try a different style. <strong>Dry mouth or sore throat:</strong>{" "}
        turn up the heated humidifier, or if you're a mouth-breather wearing a
        nasal mask, switch to full-face. <strong>Nasal congestion:</strong>{" "}
        humidification helps, and your provider can prescribe a nasal steroid.
        Don't skip CPAP nights because you're stuffy — that often makes the next
        morning worse. <strong>Pressure feels too strong:</strong> turn on the
        "ramp" feature so the machine starts low and builds up over 20–45
        minutes while you fall asleep; ask your provider whether an APAP
        (auto-adjusting) setting would suit you better. The point: adherence
        problems are signals, not verdicts. Tell us what's happening and we'll
        iterate until it works.
      </>
    ),
  },

  // ── Working with Your Care Team ────────────────────────────────
  {
    Icon: Stethoscope,
    title: "Working With Your Sleep Provider",
    takeaway:
      "Your prescription, pressure setting, and clinical changes come from your provider — supplies come from us.",
    tone: "navy",
    category: "team",
    body: (
      <>
        PennPaps handles the equipment side: mask fitting, ordering, insurance
        verification, and resupply. Your sleep medicine provider handles the
        clinical side: diagnosing apnea, prescribing CPAP, setting your
        pressure, and adjusting therapy if symptoms change. The two work
        together — we'll coordinate prescriptions and pressure changes with your
        provider's office on your behalf, so you don't have to be the messenger
        between us.
      </>
    ),
  },
];

const tones = {
  navy: "icon-halo-navy",
  gold: "icon-halo-gold",
} as const;

const articlesByCategory = CATEGORY_ORDER.map((category) => ({
  category,
  meta: categoryMeta[category],
  items: articles.filter((a) => a.category === category),
}));

export function Learn() {
  useDocumentTitle(
    "Learn — CPAP guides",
    "Plain-English CPAP guides from Penn Home Medical Supply: sleep apnea basics, mask choice, cleaning, building a routine, common objections, replacement schedules, and what to expect on therapy.",
  );
  return (
    <div className="container max-w-5xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <BookOpen className="w-4 h-4" />
            <span>Patient Education from PennPaps</span>
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
          Short, plain-language guides on sleep apnea, CPAP basics, mask choice,
          cleaning, building a nightly routine, and the common concerns that
          keep people from sticking with therapy — written by the same team that
          fits you.
        </p>
      </header>

      {/*
        Above-the-fold Virtual Mask Fitter CTA. The same call-to-action
        also lives at the very bottom of this page, but with 700+ lines
        of educational content in between, the bottom placement was
        effectively invisible to most readers. This banner sits right
        under the hero so anyone landing on /learn sees the primary
        action before they start scrolling, while still leaving the
        long-form content available for shoppers who want to read first.
      */}
      <section
        aria-label="Virtual Mask Fitter"
        className="relative overflow-hidden rounded-3xl border border-[hsl(var(--penn-gold))]/40 bg-gradient-to-br from-[hsl(var(--penn-navy))] via-[hsl(var(--penn-navy))] to-[#0d2a5c] text-white px-6 py-7 md:px-10 md:py-9 shadow-xl"
        data-testid="learn-fitter-cta"
      >
        {/* Soft gold halo in the upper-right for visual interest */}
        <div
          aria-hidden
          className="pointer-events-none absolute -top-16 -right-16 h-56 w-56 rounded-full bg-[hsl(var(--penn-gold))]/25 blur-3xl"
        />
        <div className="relative flex flex-col md:flex-row md:items-center gap-6">
          <div className="shrink-0 h-14 w-14 rounded-2xl bg-[hsl(var(--penn-gold))]/20 ring-1 ring-[hsl(var(--penn-gold))]/40 flex items-center justify-center">
            <Sparkles className="w-7 h-7 text-[hsl(var(--penn-gold))]" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))]">
              On-device · 3 minutes · No sign-up
            </p>
            <h2 className="mt-1 text-2xl md:text-3xl font-bold tracking-tight">
              Try the Virtual Mask Fitter
            </h2>
            <p className="mt-2 text-sm md:text-base text-white/80 leading-relaxed max-w-2xl">
              Skip the guesswork — we&rsquo;ll match your face to the right mask
              from a quick on-device capture and a few questions. Your photo
              never leaves your phone.
            </p>
          </div>
          <div className="shrink-0 flex flex-col sm:flex-row md:flex-col gap-2 md:min-w-[200px]">
            <Link href="/consent">
              <Button
                size="lg"
                className="w-full h-12 rounded-full bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] hover:bg-[hsl(var(--penn-gold))]/90 font-semibold gap-2 shadow-md"
                data-testid="learn-fitter-cta-start"
              >
                Start the fitter
                <ArrowRight className="w-4 h-4" />
              </Button>
            </Link>
            <Link href="/how-it-works">
              <Button
                size="sm"
                variant="ghost"
                className="w-full h-9 rounded-full text-white/85 hover:text-white hover:bg-white/10 text-xs"
                data-testid="learn-fitter-cta-how"
              >
                How it works
              </Button>
            </Link>
          </div>
        </div>
      </section>

      {/* Journey stages — four entry points that route readers to the
          right starting article based on where they are. Distinct from
          the in-page section nav below: this jumps OUT of the hub to
          deep articles, the section nav stays on the hub. */}
      <section className="space-y-6">
        <div className="text-center space-y-2">
          <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[hsl(var(--penn-gold))]">
            Find your starting point
          </span>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-primary">
            Where are you in this?
          </h2>
          <p className="text-sm md:text-base text-muted-foreground max-w-2xl mx-auto leading-relaxed">
            Patients arrive at this page in four different places. Jump straight
            to the article that matches yours.
          </p>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            {
              href: "/learn/sleep-apnea-quiz",
              Icon: ClipboardList,
              stage: "Stage 01",
              title: "Just curious",
              body: "Wondering if you might have it",
              cta: "Take the quiz",
            },
            {
              href: "/learn/sleep-apnea-explained",
              Icon: Stethoscope,
              stage: "Stage 02",
              title: "Just diagnosed",
              body: "Got your AHI, need to know what's next",
              cta: "Start here",
            },
            {
              href: "/learn/first-two-weeks",
              Icon: Sunrise,
              stage: "Stage 03",
              title: "First weeks",
              body: "Adjusting to nightly therapy",
              cta: "Survive the start",
            },
            {
              href: "/learn/cleaning-routine",
              Icon: Heart,
              stage: "Stage 04",
              title: "Living with it",
              body: "Long-term care and routine",
              cta: "Day-to-day care",
            },
          ].map(({ href, Icon, stage, title, body, cta }, idx) => (
            <Link
              key={title}
              href={href}
              className={
                idx === 0
                  ? "glass-card-tech lift-on-hover rounded-2xl p-5 relative overflow-hidden flex flex-col text-left group"
                  : "glass-card lift-on-hover rounded-2xl p-5 flex flex-col text-left group"
              }
              data-testid={`learn-stage-${title.toLowerCase().replace(/\s+/g, "-")}`}
            >
              {idx === 0 && <span className="scan-line" aria-hidden="true" />}
              <div className="relative z-10">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center mb-3 icon-halo-gold">
                  <Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
                  {stage}
                </div>
                <h3 className="text-base font-bold tracking-tight mb-1.5">
                  {title}
                </h3>
                <p className="text-xs text-muted-foreground leading-relaxed mb-3">
                  {body}
                </p>
                <span className="inline-flex items-center gap-1 text-xs font-semibold text-primary group-hover:gap-1.5 transition-all mt-auto">
                  {cta}
                  <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                </span>
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Section nav — anchors so the page is scannable when long */}
      <nav
        aria-label="Topics on this page"
        className="glass-panel rounded-2xl px-4 py-3 flex flex-wrap gap-x-5 gap-y-2 justify-center text-sm"
        data-testid="learn-section-nav"
      >
        {articlesByCategory.map(({ category, meta }) => (
          <a
            key={category}
            href={`#section-${category}`}
            className="text-[hsl(var(--penn-navy))]/80 hover:text-primary font-medium transition-colors"
            data-testid={`learn-nav-${category}`}
          >
            {meta.title}
          </a>
        ))}
      </nav>

      {/* Phase C.2 — short-form video library. Sits above the
          article grids because video plays better as a first-pass
          scan ("60-90 seconds") than long-form reading does. */}
      <LearnVideoLibrary />

      {/* Sectioned article grids */}
      {articlesByCategory.map(({ category, meta, items }) => (
        <section
          key={category}
          id={`section-${category}`}
          className="space-y-6 scroll-mt-24"
          data-testid={`learn-section-${category}`}
        >
          <div className="space-y-2 text-center md:text-left">
            <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[hsl(var(--penn-gold))]">
              {meta.eyebrow}
            </span>
            <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-primary">
              {meta.title}
            </h2>
            <p className="text-sm md:text-base text-muted-foreground max-w-2xl leading-relaxed mx-auto md:mx-0">
              {meta.caption}
            </p>
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            {items.map(({ Icon, title, takeaway, body, tone }) => (
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
                    <h3 className="text-lg font-semibold tracking-tight">
                      {title}
                    </h3>
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
          </div>
        </section>
      ))}

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
                PennPaps. They aren't a substitute for personalized advice from
                your sleep medicine provider. If you're experiencing new or
                worsening symptoms — daytime sleepiness, choking episodes,
                persistent skin breakdown, or changes in how your therapy feels
                — please contact your provider.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Deep-dive guides — long-form, share-friendly articles covering
          the disease, the therapy, the benefits, and living with it.
          Built to be passed around to friends and family, not just read
          once. Twelve articles grouped visually but not categorized to
          keep the page from feeling like an org chart. */}
      <section className="space-y-6">
        <div className="space-y-2 text-center md:text-left">
          <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[hsl(var(--penn-gold))]">
            Deep-dive guides
          </span>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-primary">
            Long-form reading you can share.
          </h2>
          <p className="text-sm md:text-base text-muted-foreground max-w-2xl leading-relaxed mx-auto md:mx-0">
            Twelve in-depth articles on what sleep apnea is, what untreated
            apnea costs your body, what treatment actually feels like, how the
            therapy works, and real life with a mask. Each has a built-in share
            button for passing to a partner, parent, or friend.
          </p>
        </div>
        {/* Featured: the 101 mega-landing */}
        <Link
          href="/sleep-apnea-101"
          className="glass-card-tech lift-on-hover rounded-2xl p-6 relative overflow-hidden flex items-start gap-4 group"
          data-testid="learn-link-deep-101"
        >
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10 flex items-start gap-4 w-full">
            <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
              <BookOpen className="w-6 h-6" />
            </div>
            <div className="space-y-1 flex-1 min-w-0">
              <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-1">
                Start here · the complete primer
              </div>
              <h3 className="text-lg md:text-xl font-bold tracking-tight group-hover:text-primary transition-colors">
                Sleep apnea 101 — everything you need to know
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                The mega-page that organizes the whole library by topic and
                journey stage. If you only read one thing on PennPaps, read
                this.
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1 shrink-0" />
          </div>
        </Link>

        <div className="grid gap-4 sm:grid-cols-2">
          {[
            {
              href: "/learn/sleep-apnea-explained",
              Icon: Moon,
              title: "What sleep apnea really is",
              body: "OSA, CSA, mixed apnea — what each one actually is, how it happens, and who's most at risk.",
              testid: "learn-link-deep-sleep-apnea-explained",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/health-risks",
              Icon: AlertTriangle,
              title: "The hidden cost of leaving it alone",
              body: "The cardiovascular, metabolic, cognitive, and daily-safety risks of untreated sleep apnea.",
              testid: "learn-link-deep-health-risks",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/pap-therapy-benefits",
              Icon: Sunrise,
              title: "What treatment actually feels like",
              body: "The benefits of PAP therapy on a real timeline — week one, month one, quarter one, year one.",
              testid: "learn-link-deep-benefits",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/how-pap-works",
              Icon: Wind,
              title: "How PAP therapy actually works",
              body: "The pneumatic-splint mechanism, what cmH₂O means, exhalation relief, and the numbers your machine tracks.",
              testid: "learn-link-deep-how-pap-works",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/therapy-types",
              Icon: Activity,
              title: "CPAP vs APAP vs BiPAP vs ASV",
              body: "The four therapy modes explained — what each does, who it's prescribed for, and how your physician picks.",
              testid: "learn-link-deep-therapy-types",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/sleep-apnea-heart-health",
              Icon: Heart,
              title: "Sleep apnea is a cardiovascular disease",
              body: "How sleep apnea drives hypertension, AFib, stroke, and heart failure — and why cardiology now screens for it.",
              testid: "learn-link-deep-heart-health",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/first-two-weeks",
              Icon: Sunrise,
              title: "Surviving the first two weeks",
              body: "The biggest dropout window. A day-by-day, week-by-week guide to the adjustment period.",
              testid: "learn-link-deep-first-two-weeks",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/traveling-with-cpap",
              Icon: Plane,
              title: "Traveling with CPAP",
              body: "TSA, hotels, camping, international power. Practical answers for the manual's blind spots.",
              testid: "learn-link-deep-traveling",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/cleaning-routine",
              Icon: Droplets,
              title: "The cleaning routine",
              body: "Daily, weekly, monthly — what to wipe, soak, and replace. Plus what NOT to use.",
              testid: "learn-link-deep-cleaning",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/myths-debunked",
              Icon: AlertTriangle,
              title: "10 myths debunked",
              body: "Ten things people get wrong about CPAP and sleep apnea — and the honest answer to each.",
              testid: "learn-link-deep-myths",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/insurance-guide",
              Icon: ShieldCheck,
              title: "The insurance & coverage guide",
              body: "Medicare, Medicaid, commercial, HSA/FSA, cash-pay. What's covered, what's required, what's cheaper.",
              testid: "learn-link-deep-insurance",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/glossary",
              Icon: BookOpen,
              title: "The CPAP glossary",
              body: "Every acronym and term you'll meet — AHI, EPR, IPAP/EPAP, RDI, RERA, prior auth. Searchable.",
              testid: "learn-link-deep-glossary",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/sleep-apnea-women",
              Icon: Moon,
              title: "Sleep apnea in women",
              body: "Women present with insomnia, fatigue, and mood symptoms — not the textbook loud-snoring profile. Diagnosed 5–8 years late on average.",
              testid: "learn-link-deep-women",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/sleep-apnea-diabetes",
              Icon: Activity,
              title: "Sleep apnea & diabetes",
              body: "70% of T2D patients have undiagnosed OSA. Treating one moves the other — A1C improves measurably on adherent therapy.",
              testid: "learn-link-deep-diabetes",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/sleep-apnea-mental-health",
              Icon: AlertTriangle,
              title: "Sleep apnea & mental health",
              body: "The dense overlap with depression, anxiety, PTSD, and the brain-fog symptom cluster — and what treatment moves.",
              testid: "learn-link-deep-mental-health",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/pediatric-sleep-apnea",
              Icon: Users,
              title: "Pediatric sleep apnea",
              body: "Children with OSA look hyperactive, not sleepy. Why the symptoms are different, and what parents should flag at the pediatric visit.",
              testid: "learn-link-deep-pediatric",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/sleep-apnea-seniors",
              Icon: Heart,
              title: "Sleep apnea in older adults",
              body: "Prevalence climbs sharply with age — and so do the cognitive, cardiovascular, and falls stakes. Medicare-friendly framing.",
              testid: "learn-link-deep-seniors",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/partner-guide",
              Icon: Heart,
              title: "The bed partner's guide",
              body: "If your partner snores loudly enough you've thought about earplugs — this is the article for you. How to bring it up, what to expect.",
              testid: "learn-link-deep-partner",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/talking-to-a-loved-one",
              Icon: Users,
              title: "Talking to a loved one",
              body: "Five scripts — what works, what backfires — when you need to suggest someone get tested for sleep apnea.",
              testid: "learn-link-deep-talking",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/dry-mouth",
              Icon: Droplets,
              title: "Fixing CPAP dry mouth",
              body: "The #1 comfort complaint. Three causes (humidifier, mouth breathing, heated tubing) and the order to try them.",
              testid: "learn-link-deep-dry-mouth",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/cpap-bloating",
              Icon: Wind,
              title: "CPAP bloating & gas",
              body: "Aerophagia — when CPAP gives you stomach distension. Four fixes from positional changes to pressure setting tweaks.",
              testid: "learn-link-deep-bloating",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/mask-leaks",
              Icon: Wind,
              title: "Fixing mask leaks",
              body: "Where the leak is tells you how to fix it — bridge, side, mouth, or top (where vents are supposed to leak).",
              testid: "learn-link-deep-leaks",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/cpap-claustrophobia",
              Icon: LifeBuoy,
              title: "Claustrophobia & anxiety",
              body: "A structured desensitization protocol that works in 5-7 days for almost everyone. Plus what to do mid-night.",
              testid: "learn-link-deep-claustro",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/nasal-congestion",
              Icon: Droplets,
              title: "Nasal congestion on CPAP",
              body: "Four causes — usually dry air, sometimes allergies, occasionally sleep position. Plus a 5-tip quick-wins list.",
              testid: "learn-link-deep-congestion",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/reading-your-sleep-report",
              Icon: BookOpen,
              title: "Reading your sleep study report",
              body: "What AHI, RDI, ODI, T90, and the rest of the acronyms actually mean — and what to ask your sleep doctor about.",
              testid: "learn-link-deep-sleep-report",
              tone: "icon-halo-navy",
            },
            {
              href: "/learn/sleep-hygiene",
              Icon: Moon,
              title: "Sleep hygiene + CPAP",
              body: "Six evidence-based habits that compound with PAP therapy. Cool room, constant wake-time, no caffeine after 2pm.",
              testid: "learn-link-deep-hygiene",
              tone: "icon-halo-gold",
            },
            {
              href: "/learn/cpap-and-weight-loss",
              Icon: Activity,
              title: "CPAP and weight loss",
              body: "Untreated sleep apnea makes weight loss measurably harder. The four metabolic headwinds CPAP removes.",
              testid: "learn-link-deep-weight-loss",
              tone: "icon-halo-navy",
            },
          ].map(({ href, Icon, title, body, testid, tone }) => (
            <Link
              key={href}
              href={href}
              className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
              data-testid={testid}
            >
              <div
                className={`shrink-0 h-11 w-11 rounded-xl ${tone} flex items-center justify-center`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-1 flex-1 min-w-0">
                <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
                  {title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {body}
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1 shrink-0" />
            </Link>
          ))}
        </div>
      </section>

      {/* Newsletter signup — capture readers who finished the library and
          aren't ready to commit to ordering yet. Gold-trimmed tech card
          so it doesn't compete with the disclaimer or final CTA below. */}
      <NewsletterSignup />

      {/* Cross-links */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group sm:col-span-2"
          data-testid="learn-link-sleep-apnea-quiz"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <ClipboardList className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Take the sleep apnea self-screener
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Eight quick questions based on the validated STOP-BANG clinical
              screener. Get a risk band and a clear, physician- focused next
              step — no diagnosis, no sales pitch.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
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
          href="/learn/device-setup"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="learn-link-device-setup"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Settings2 className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Set up your CPAP or BiPAP
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Step-by-step new-patient guide — unboxing, first night, daily
              care, and fixes for the most common first-week issues.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/replacement-schedule"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="learn-link-replacement-schedule"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <CalendarClock className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Full replacement schedule
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Per-item cadences for cushions, tubing, filters, headgear, and
              chambers — plus the warning signs you're overdue.
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
              How PennPaps works
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              A walkthrough of every part of PennPaps — the fitter, the shop,
              customer accounts, and how resupply works.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4 pt-2">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          When you're ready, we're here.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          New to CPAP? Get matched to the right mask with our on-device fitter.
          Already have your machine? Reorder cushions, filters, and tubing
          direct from the shop.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link href="/consent">
            <Button
              size="lg"
              className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow gap-2"
            >
              <Sparkles className="w-4 h-4" />
              Get fitted for a mask
            </Button>
          </Link>
          <Link href="/shop">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full glass-panel border-border/60"
            >
              Shop CPAP supplies
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
