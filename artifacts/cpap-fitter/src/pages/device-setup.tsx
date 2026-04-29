import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  BookOpen,
  Package,
  Plug,
  Droplets,
  Cable,
  Power,
  Wind,
  Bed,
  Sparkles,
  Sun,
  CalendarDays,
  CalendarClock,
  AlertCircle,
  Stethoscope,
  Phone,
  ArrowRight,
  CheckCircle2,
  Settings2,
} from "lucide-react";

type SetupStep = {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: React.ReactNode;
};

const setupSteps: SetupStep[] = [
  {
    Icon: Package,
    title: "Unpack and inventory the box",
    body: (
      <>
        Lay everything out and confirm you have: the device itself, the heated
        humidifier chamber, the air hose (heated or standard), your prescribed
        mask with headgear, the power cord and brick, a spare disposable
        filter, and the user manual or quick-start card. If anything looks
        damaged or is missing, set it aside and call us before plugging in.
      </>
    ),
  },
  {
    Icon: Bed,
    title: "Choose the right spot",
    body: (
      <>
        Place the machine on a stable, flat surface <strong>lower than your
        mattress</strong> — typically a nightstand. Keeping it below the mask
        prevents condensation ("rainout") from running back down the hose.
        Leave at least 4 inches of clearance behind the air intake, keep it
        away from heat vents, fans, curtains, and pets, and make sure a
        grounded outlet is within reach so the cord isn't strained.
      </>
    ),
  },
  {
    Icon: Droplets,
    title: "Fill the humidifier — distilled water preferred",
    body: (
      <>
        Slide out the humidifier chamber and fill to the marked maximum line
        with <strong>distilled water</strong>. Tap, filtered, and bottled
        spring water can leave mineral scale on the chamber and heater
        plate over time, so distilled is the long-term standard. If you
        run out for a night or two, keep using your therapy with whatever
        water you have on hand and replenish distilled as soon as you can.
        Reseat the chamber until it clicks. Empty and refill every
        morning — never leave standing water for the next night.
      </>
    ),
  },
  {
    Icon: Cable,
    title: "Connect the hose",
    body: (
      <>
        Twist one end of the hose onto the air outlet on the back or side of
        the machine until snug — it should rotate freely without falling off.
        Connect the other end to the short connector elbow on your mask.
        Heated tubing has a small electrical pin that lines up with a slot on
        the outlet — never force it in the wrong orientation.
      </>
    ),
  },
  {
    Icon: Plug,
    title: "Plug in and power on",
    body: (
      <>
        Connect the power brick to the machine first, then to the wall.
        Press the power button or touch the screen to wake it. Your
        prescription pressure was pre-loaded by our team — you don't need to
        change anything in the clinical menu. The first screen will show
        date, time, and humidifier setting; that's it.
      </>
    ),
  },
  {
    Icon: Settings2,
    title: "Set ramp and humidity",
    body: (
      <>
        Most patients start with <strong>Ramp = 20 minutes</strong> (the
        machine begins at a low pressure and climbs to your prescribed level
        gradually — exact starting pressure depends on the device and your
        prescription) and <strong>Humidity</strong> in the middle of the
        scale (often 4 or 5 on a 1–8 dial). If you wake up with a dry
        mouth, raise humidity by one step. If you see water beads in the
        hose, lower humidity by one step or add a hose cover. These are
        usually the only two settings patients ever need to touch — check
        your device's manual for the exact menu names.
      </>
    ),
  },
  {
    Icon: Wind,
    title: "Put on the mask and start therapy",
    body: (
      <>
        Sit upright in bed first. Slip the mask on, then bring the top straps
        over your head and adjust them <em>before</em> the bottom straps.
        Snug, never tight — you should be able to slide a finger under any
        strap. Lie down, breathe normally through your nose (or nose and
        mouth if full-face), and the machine will detect your first breath
        and start delivering air. Done.
      </>
    ),
  },
];

type Issue = {
  Icon: React.ComponentType<{ className?: string }>;
  problem: string;
  fix: React.ReactNode;
};

const troubleshooting: Issue[] = [
  {
    Icon: AlertCircle,
    problem: "Mask leaks air around the edges",
    fix: (
      <>
        Don't tighten further — overtight straps actually <em>break</em> the
        seal by pulling the cushion off-shape. Pull the mask away from your
        face an inch, then settle it back down so the cushion can re-inflate
        against your skin. If it still leaks at the bridge of the nose, you
        may need a smaller cushion size; at the chin, a larger one. Reach
        out and we'll swap it.
      </>
    ),
  },
  {
    Icon: AlertCircle,
    problem: "Dry mouth in the morning",
    fix: (
      <>
        You're likely opening your mouth during sleep with a nasal mask. Try
        a chinstrap first (it gently keeps the jaw closed). If that's not
        enough, a full-face mask is the right answer — it delivers the
        pressure regardless of mouth position. Bumping humidity up one step
        also helps.
      </>
    ),
  },
  {
    Icon: AlertCircle,
    problem: "Stuffy or congested nose",
    fix: (
      <>
        Increase humidity by one step and consider adding a heated hose if
        you don't have one — cold air drying out the airway is the most
        common cause. A saline nasal spray 30 minutes before bed helps.
        Persistent congestion lasting more than two weeks deserves a call to
        your prescriber to rule out allergies or sinusitis.
      </>
    ),
  },
  {
    Icon: AlertCircle,
    problem: "Pressure feels too strong",
    fix: (
      <>
        Make sure ramp is on — it drops you to a lower starting pressure
        for the first 20 minutes so you fall asleep before full pressure
        kicks in. If your device has an exhale-relief feature (ResMed calls
        it EPR; Philips calls it Flex), your prescriber may have already
        configured it; ask before turning it on or changing the level
        yourself. If pressure still feels wrong after a week, call us
        before adjusting clinical settings.
      </>
    ),
  },
  {
    Icon: AlertCircle,
    problem: "Stomach bloating or burping (aerophagia)",
    fix: (
      <>
        You're swallowing air. Sleeping on your side instead of your back
        usually fixes it within a few nights. If it persists, your pressure
        may be set higher than you actually need — call your prescriber and
        we'll arrange a setting review with them.
      </>
    ),
  },
  {
    Icon: AlertCircle,
    problem: "Claustrophobia or panic when masked up",
    fix: (
      <>
        Practice during the day. Wear just the mask (no machine) for 10–15
        minutes while reading or watching TV for a few days, then add the
        hose with the machine running but stay sitting up. Build to wearing
        it the full night. This desensitizes the response and is the single
        biggest predictor of long-term success.
      </>
    ),
  },
];

export function DeviceSetup() {
  useDocumentTitle(
    "Setting up your CPAP",
    "Step-by-step CPAP setup guide: unbox, fill the humidifier, fit your mask, set ramp/pressure, and start your first night of therapy.",
  );
  return (
    <div className="container max-w-5xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <BookOpen className="w-4 h-4" />
            <span>New-Patient Setup Guide</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              CPAP &amp; BiPAP
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Set Up Your Device, Step by Step
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          A plain-language walkthrough — from opening the box on day one to
          comfortable, consistent therapy. Works for ResMed, Philips
          Respironics, Fisher &amp; Paykel, and React Health CPAPs and
          BiPAPs.
        </p>

        {/* Quick jump nav */}
        <nav
          aria-label="Setup guide sections"
          className="flex flex-wrap justify-center gap-2 pt-2"
        >
          {[
            { href: "#setup", label: "7-Step Setup" },
            { href: "#first-night", label: "Your First Night" },
            { href: "#care", label: "Daily Care" },
            { href: "#troubleshooting", label: "Troubleshooting" },
            { href: "#bipap", label: "BiPAP Notes" },
            { href: "#help", label: "When to Call" },
          ].map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-xs font-medium px-3 py-1.5 rounded-full glass-panel text-muted-foreground hover:text-primary transition-colors"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </header>

      {/* 7-step setup */}
      <section id="setup" className="space-y-5 scroll-mt-24">
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
            The 7-Step Initial Setup
          </h2>
          <span className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            ~10 minutes
          </span>
        </div>
        <div className="grid gap-4">
          {setupSteps.map(({ Icon, title, body }, i) => (
            <article
              key={title}
              className="glass-card lift-on-hover rounded-2xl p-6 flex gap-5"
            >
              <div className="shrink-0 flex flex-col items-center gap-2">
                <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <span className="text-xs font-mono font-semibold text-[hsl(var(--penn-gold))]">
                  {String(i + 1).padStart(2, "0")}
                </span>
              </div>
              <div className="space-y-2 flex-1">
                <h3 className="text-lg font-semibold tracking-tight">
                  {title}
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {body}
                </p>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* First night */}
      <section id="first-night" className="space-y-5 scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Your First Night
        </h2>
        <div className="grid md:grid-cols-3 gap-4">
          {[
            {
              Icon: Power,
              title: "Power on early",
              body: "Turn the machine on a few minutes before bed if your device supports humidifier preheat — the first breath will feel warmer and less dry.",
            },
            {
              Icon: Wind,
              title: "Use the ramp",
              body: "Press the ramp button when you lie down. It starts you at a lower pressure (often around 4 cmH₂O on adult CPAPs) and climbs to your prescribed pressure over the ramp window — most patients fall asleep before they ever feel full pressure.",
            },
            {
              Icon: Bed,
              title: "Breathe normally",
              body: "Don't try to breathe with the machine — just breathe. Open mouth (with full-face) or only through your nose (nasal/pillows). The machine syncs to you, not the other way around.",
            },
          ].map(({ Icon, title, body }) => (
            <article
              key={title}
              className="glass-card lift-on-hover rounded-2xl p-6 space-y-3"
            >
              <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <Icon className="w-5 h-5" />
              </div>
              <h3 className="font-semibold tracking-tight">{title}</h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {body}
              </p>
            </article>
          ))}
        </div>

        <div className="glass-card rounded-2xl p-6 sm:p-8 flex gap-4 items-start">
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="space-y-2">
            <h3 className="font-semibold tracking-tight text-primary">
              Realistic first-week expectations
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Night one is rarely perfect. Most patients need 5–10 nights to
              settle in — small mask adjustments, finding the right humidity
              level, learning to fall asleep with the sensation. If you can
              get four hours per night that first week, you're on track.
              Don't quit because of one bad night; call us and we'll
              troubleshoot.
            </p>
          </div>
        </div>
      </section>

      {/* Care */}
      <section id="care" className="space-y-5 scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Daily, Weekly, Monthly Care
        </h2>
        <div className="grid md:grid-cols-3 gap-4">
          <article className="glass-card lift-on-hover rounded-2xl p-6 space-y-3">
            <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
              <Sun className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">Every morning</h3>
            <ul className="text-sm text-muted-foreground leading-relaxed space-y-1.5 list-disc list-inside">
              <li>Empty water from the humidifier chamber</li>
              <li>Wipe the mask cushion with a CPAP wipe or damp microfiber</li>
              <li>Drape the hose over a towel rod or chair to air-dry</li>
            </ul>
          </article>
          <article className="glass-card lift-on-hover rounded-2xl p-6 space-y-3">
            <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
              <CalendarDays className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">Once a week</h3>
            <ul className="text-sm text-muted-foreground leading-relaxed space-y-1.5 list-disc list-inside">
              <li>Hand-wash the cushion, frame, and headgear in warm water with a drop of mild dish soap (no scented or antibacterial soaps — they degrade silicone)</li>
              <li>Air-dry away from direct sunlight</li>
              <li>Wipe the outside of the machine with a damp cloth</li>
            </ul>
          </article>
          <article className="glass-card lift-on-hover rounded-2xl p-6 space-y-3">
            <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
              <CalendarClock className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">Once a month</h3>
            <ul className="text-sm text-muted-foreground leading-relaxed space-y-1.5 list-disc list-inside">
              <li>Hand-wash the hose end-to-end with warm soapy water; rinse well; hang to dry</li>
              <li>Replace the disposable filter (or rinse the reusable one)</li>
              <li>Inspect cushion and headgear for stretching, tears, or discoloration — order replacements if you see any</li>
            </ul>
          </article>
        </div>
        <p className="text-sm text-muted-foreground text-center">
          For the full per-item replacement schedule (cushion, tubing,
          chamber, filters, headgear), see the{" "}
          <Link
            href="/learn/replacement-schedule"
            className="text-primary font-medium underline-offset-4 hover:underline"
          >
            replacement schedule guide
          </Link>
          .
        </p>
      </section>

      {/* Troubleshooting */}
      <section id="troubleshooting" className="space-y-5 scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          Common First-Week Issues — and Fixes
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          {troubleshooting.map(({ Icon, problem, fix }) => (
            <article
              key={problem}
              className="glass-card lift-on-hover rounded-2xl p-6 space-y-3"
            >
              <div className="flex items-start gap-3">
                <div className="shrink-0 h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <h3 className="font-semibold tracking-tight pt-1.5">
                  {problem}
                </h3>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {fix}
              </p>
            </article>
          ))}
        </div>
      </section>

      {/* BiPAP */}
      <section id="bipap" className="space-y-5 scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          BiPAP-Specific Notes
        </h2>
        <div className="glass-card rounded-2xl p-6 sm:p-8 space-y-4">
          <p className="text-sm text-muted-foreground leading-relaxed">
            BiPAP (also called BiLevel) machines deliver <strong>two</strong>{" "}
            pressures — a higher one when you breathe in (IPAP) and a lower
            one when you breathe out (EPAP). They're typically prescribed
            when CPAP pressure would be too high to tolerate, or for
            specific conditions like COPD overlap, neuromuscular disorders,
            or central sleep apnea. The setup steps above are
            identical — same humidifier, same hose, same mask, same daily
            care. A few specific differences:
          </p>
          <ul className="text-sm text-muted-foreground leading-relaxed space-y-2 list-disc list-inside">
            <li>
              <strong>Exhale relief is the difference between IPAP and EPAP.</strong>{" "}
              Your prescriber set both pressures directly, so most BiPAP
              users do not need to add any additional exhale-relief
              feature. If you think you need more (or less) help on
              exhale, call us — don't adjust it on your own.
            </li>
            <li>
              <strong>Ramp behaves differently.</strong> Ramp on a BiPAP
              typically raises both IPAP and EPAP together while keeping
              the gap constant. Some devices also offer an "Auto-Start"
              option that begins therapy as soon as you breathe in — check
              your manual for what's available on your model.
            </li>
            <li>
              <strong>Mask choice matters more.</strong> Higher inspiratory
              pressures push harder against the seal — many BiPAP patients
              do best with a full-face mask or a well-fitted nasal mask.
              Nasal pillows can work too, but seal becomes harder to
              maintain as IPAP climbs; if you're leaking, ask us about a
              different style.
            </li>
            <li>
              <strong>Stick with your prescription.</strong> Never change
              IPAP, EPAP, or backup rate yourself. If anything feels off,
              call us and we'll coordinate a setting review with your
              prescriber.
            </li>
          </ul>
        </div>
      </section>

      {/* When to call */}
      <section id="help" className="space-y-5 scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-semibold tracking-tight">
          When to Call Us — and When to Call Your Doctor
        </h2>
        <div className="grid md:grid-cols-2 gap-4">
          <article className="glass-card rounded-2xl p-6 space-y-3">
            <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
              <Phone className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">Call Penn Home Medical Supply for</h3>
            <ul className="text-sm text-muted-foreground leading-relaxed space-y-1.5 list-disc list-inside">
              <li>Equipment that arrived damaged or doesn't power on</li>
              <li>Mask leaks you can't resolve in a few nights</li>
              <li>A different cushion size or mask style</li>
              <li>Replacement filters, tubing, headgear, or chambers</li>
              <li>Insurance, billing, or shipping questions</li>
            </ul>
          </article>
          <article className="glass-card rounded-2xl p-6 space-y-3">
            <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
              <Stethoscope className="w-5 h-5" />
            </div>
            <h3 className="font-semibold tracking-tight">Call your sleep doctor for</h3>
            <ul className="text-sm text-muted-foreground leading-relaxed space-y-1.5 list-disc list-inside">
              <li>Pressure that still feels wrong after a week of ramp</li>
              <li>New or worsening daytime sleepiness despite consistent use</li>
              <li>Choking, gasping, or central apneas you notice on your data</li>
              <li>Persistent congestion or sinus pain &gt; 2 weeks</li>
              <li>Skin breakdown that doesn't heal between nights</li>
            </ul>
          </article>
        </div>

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
                This guide is general patient education. It is not a
                substitute for your prescriber's instructions or the user
                manual that came with your specific device. If anything in
                your setup or therapy doesn't match this guide, follow your
                prescriber and the manufacturer's manual — and call us if
                you're unsure.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Cross-links + CTA */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/faq"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="setup-link-faq"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              FAQ
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Quick answers on insurance, shipping, prescriptions, and care.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/shop"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="setup-link-shop"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Order replacement supplies
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Cushions, hoses, filters, headgear, and chambers — direct cash
              pricing or insurance.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </section>
    </div>
  );
}
