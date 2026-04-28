import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  CalendarClock,
  Sparkles,
  Activity,
  ShieldCheck,
  Wallet,
  AlertTriangle,
  CheckCircle2,
  Bell,
  ArrowRight,
  Info,
  Stethoscope,
} from "lucide-react";

type ScheduleRow = {
  item: string;
  insuranceCadence: string;
  manufacturerCadence: string;
  why: string;
};

const schedule: ScheduleRow[] = [
  {
    item: "Mask cushion / nasal pillows",
    insuranceCadence: "Every 2 weeks – 1 month",
    manufacturerCadence: "Monthly",
    why: "Direct skin contact — facial oils break down silicone, the seal hardens and starts to leak.",
  },
  {
    item: "Mask frame & headgear clips",
    insuranceCadence: "Every 3 months",
    manufacturerCadence: "Every 3–6 months",
    why: "Plastic stress-fractures from daily strap tension; clips lose grip.",
  },
  {
    item: "Headgear (straps)",
    insuranceCadence: "Every 6 months",
    manufacturerCadence: "Every 6 months",
    why: "Elastic stretches, fit gets sloppy, you over-tighten and end up with red marks.",
  },
  {
    item: "Chinstrap",
    insuranceCadence: "Every 6 months",
    manufacturerCadence: "Every 6 months",
    why: "Same elastic fatigue as headgear; stops holding your jaw closed.",
  },
  {
    item: "Standard tubing",
    insuranceCadence: "Every 3 months",
    manufacturerCadence: "Every 3 months",
    why: "Bacterial and mold buildup inside the tube; micro-tears cause pressure leaks.",
  },
  {
    item: "Heated tubing",
    insuranceCadence: "Every 3 months",
    manufacturerCadence: "Every 3 months",
    why: "Same as standard, plus heating element fatigue. Replace as a unit.",
  },
  {
    item: "Disposable filters (white/paper)",
    insuranceCadence: "Every 2 weeks",
    manufacturerCadence: "Every 2 weeks (sooner if dusty)",
    why: "Trap dust, pet dander, and pollen. A clogged filter makes your motor work harder.",
  },
  {
    item: "Reusable filters (gray foam)",
    insuranceCadence: "Every 6 months",
    manufacturerCadence: "Every 6 months (rinse weekly)",
    why: "Even with washing, foam degrades and loses filtration.",
  },
  {
    item: "Humidifier water chamber",
    insuranceCadence: "Every 6 months",
    manufacturerCadence: "Every 6 months",
    why: "Mineral scaling from tap water clouds plastic and hosts bacteria. Replace, don't scrub.",
  },
  {
    item: "CPAP machine",
    insuranceCadence: "Every 5 years",
    manufacturerCadence: "Every 5 years",
    why: "Most insurance benefit cycles allow a full machine replacement at 5 years; older units lose pressure precision.",
  },
];

type Reason = {
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  body: string;
  tone: "navy" | "gold";
};

const reasons: Reason[] = [
  {
    Icon: ShieldCheck,
    tone: "navy",
    title: "Hygiene & infection risk",
    body: "Cushions and tubing are a warm, moist environment in direct contact with your airway. Old supplies grow bacteria, mold, and biofilm — a real driver of sinus infections, sore throats, and pneumonia in CPAP users.",
  },
  {
    Icon: Activity,
    tone: "gold",
    title: "Therapy actually works",
    body: "A leaky cushion lets prescribed pressure escape, dropping the effective pressure your airway sees. Many patients don't realize their AHI has crept up because the mask is the problem, not the machine.",
  },
  {
    Icon: Sparkles,
    tone: "navy",
    title: "Comfort & adherence",
    body: "A fresh cushion seals on first try; a worn one gets over-tightened, causing red marks, leaks, and 3 a.m. mask-rip-off moments. Replacing on schedule is the cheapest way to keep using your therapy.",
  },
  {
    Icon: Wallet,
    tone: "gold",
    title: "Insurance pays for it",
    body: "If you have a CPAP benefit, your plan already covers replacement supplies on a defined cadence — usually with no out-of-pocket cost. Skipping the cycle isn't saving money; it's leaving covered care on the table.",
  },
];

const overdueSigns = [
  "You've started waking up with a dry mouth or congestion you didn't have before.",
  "Your mask leaks audibly even after you re-seat it.",
  "The cushion silicone feels sticky, hardened, or shiny instead of soft and matte.",
  "Headgear straps don't hold tension — you're cinching them tighter than usual.",
  "There are visible mineral deposits, cloudiness, or pink/black film inside the tubing or chamber.",
  "Filters look gray, brown, or fuzzy with dust.",
  "Your machine is louder than it used to be (often a clogged filter).",
  "It's been more than 90 days since the last delivery and you're not sure when the next one is due.",
];

const tones: Record<Reason["tone"], string> = {
  navy: "icon-halo-navy",
  gold: "icon-halo-gold",
};

export function ReplacementSchedule() {
  return (
    <main className="container mx-auto max-w-5xl px-4 md:px-6 py-12 md:py-16 space-y-12">
      {/* Hero */}
      <header className="text-center space-y-4">
        <div className="inline-flex items-center justify-center h-16 w-16 rounded-2xl glass-card">
          <CalendarClock className="w-7 h-7 text-primary" />
        </div>
        <p className="text-xs uppercase tracking-[0.22em] text-muted-foreground">
          PennPaps · Patient Education
        </p>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand">
          When to replace your CPAP supplies
        </h1>
        <p className="text-muted-foreground text-base md:text-lg max-w-2xl mx-auto leading-relaxed">
          CPAP supplies wear out faster than most patients realize. Here's the
          full schedule we follow — what to replace, how often, and why it
          matters for your therapy, your health, and your insurance benefit.
        </p>
      </header>

      {/* Why it matters */}
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            Why timely replacement matters
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {reasons.map(({ Icon, title, body, tone }) => (
            <article
              key={title}
              className="glass-card lift-on-hover rounded-2xl p-6 flex gap-4"
            >
              <div
                className={`shrink-0 h-12 w-12 rounded-xl ${tones[tone]} flex items-center justify-center`}
              >
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-1.5">
                <h3 className="font-semibold tracking-tight text-base">
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

      {/* Schedule */}
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            The replacement schedule
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>

        {/* Desktop: table */}
        <div className="hidden md:block glass-card rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-[hsl(var(--penn-navy)/0.06)] text-left text-xs uppercase tracking-wider text-[hsl(var(--penn-navy))]/80">
                <th className="py-4 px-5 font-semibold">Item</th>
                <th className="py-4 px-5 font-semibold">
                  Insurance cadence
                </th>
                <th className="py-4 px-5 font-semibold">
                  Manufacturer guidance
                </th>
                <th className="py-4 px-5 font-semibold">Why</th>
              </tr>
            </thead>
            <tbody>
              {schedule.map((row, i) => (
                <tr
                  key={row.item}
                  className={
                    i % 2 === 0
                      ? "bg-transparent"
                      : "bg-[hsl(var(--penn-navy)/0.02)]"
                  }
                >
                  <td className="py-4 px-5 font-medium text-primary align-top">
                    {row.item}
                  </td>
                  <td className="py-4 px-5 text-muted-foreground align-top whitespace-nowrap">
                    {row.insuranceCadence}
                  </td>
                  <td className="py-4 px-5 text-muted-foreground align-top whitespace-nowrap">
                    {row.manufacturerCadence}
                  </td>
                  <td className="py-4 px-5 text-muted-foreground align-top leading-relaxed">
                    {row.why}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Mobile: cards */}
        <div className="md:hidden grid gap-4">
          {schedule.map((row) => (
            <article
              key={row.item}
              className="glass-card rounded-2xl p-5 space-y-3"
            >
              <h3 className="font-semibold text-primary tracking-tight">
                {row.item}
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  Insurance
                </dt>
                <dd className="text-foreground/90">{row.insuranceCadence}</dd>
                <dt className="text-xs uppercase tracking-wider text-muted-foreground">
                  Mfr.
                </dt>
                <dd className="text-foreground/90">
                  {row.manufacturerCadence}
                </dd>
              </dl>
              <p className="text-sm text-muted-foreground leading-relaxed pt-1 border-t border-border/40">
                {row.why}
              </p>
            </article>
          ))}
        </div>

        <p className="text-xs text-muted-foreground text-center max-w-3xl mx-auto leading-relaxed">
          Cadences shown reflect typical Medicare and commercial insurance
          allowances in the United States. Your specific plan may differ —
          Penn Home Medical Supply verifies your benefit before each shipment.
        </p>
      </section>

      {/* Overdue checklist */}
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            Signs you're overdue
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="glass-card rounded-2xl p-6 sm:p-8 relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 100% 0%, hsl(var(--penn-gold) / 0.10), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <div className="relative space-y-4">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                If any of these sound familiar, you're due for resupply.
                None of them are emergencies — but they're real signs your
                therapy is being undermined.
              </p>
            </div>
            <ul className="grid sm:grid-cols-2 gap-x-6 gap-y-3 pt-2">
              {overdueSigns.map((sign) => (
                <li key={sign} className="flex gap-3 text-sm">
                  <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0 text-[hsl(var(--penn-gold))]" />
                  <span className="text-muted-foreground leading-relaxed">
                    {sign}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* Two paths: insurance vs out-of-pocket */}
      <section className="space-y-5">
        <div className="flex items-center gap-3">
          <div className="h-px flex-1 bg-border/60" />
          <h2 className="text-sm font-semibold tracking-[0.18em] uppercase text-muted-foreground">
            Two ways to stay on schedule
          </h2>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="grid md:grid-cols-2 gap-5">
          <article className="glass-card rounded-2xl p-6 space-y-3">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <h3 className="font-semibold tracking-tight text-primary">
                Through your insurance
              </h3>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              We verify your benefit, request the prescription if needed,
              and ship on the cadence your plan covers — usually with no
              out-of-pocket cost. Approval typically takes 3–5 business
              days for the first shipment.
            </p>
            <p className="text-xs text-muted-foreground/80 italic">
              Best for: routine resupply on the standard cycle.
            </p>
          </article>
          <article className="glass-card rounded-2xl p-6 space-y-3 flex flex-col">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <Wallet className="w-5 h-5" />
              </div>
              <h3 className="font-semibold tracking-tight text-primary">
                Pay direct &amp; ship now
              </h3>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Need a replacement before your insurance cycle resets? Ran
              out on a trip? Want extras your plan won't cover? Pay by
              card and we'll ship — no prescription, no insurance
              paperwork.
            </p>
            <p className="text-xs text-muted-foreground/80 italic">
              Best for: mid-cycle replacements, accessories, and travel
              kits.
            </p>
            <div className="pt-2 mt-auto">
              <Link href="/shop">
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="schedule-shop-cta"
                >
                  Browse the shop <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
                </Button>
              </Link>
            </div>
          </article>
        </div>
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
                Replacement schedules above reflect typical insurance and
                manufacturer guidance. They aren't a substitute for advice
                from your sleep medicine provider. If your therapy feels
                different — new leaks, mask sores, daytime sleepiness —
                please reach out to your provider in addition to your
                supplier.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center space-y-5 pt-2">
        <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-gradient-brand">
          Stop tracking it yourself.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto leading-relaxed">
          Sign up once and Penn Home Medical Supply will text or email you when each item
          is due — no calendar reminders, no guessing, no stale supplies.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link href="/consent">
            <Button
              size="lg"
              className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow gap-2"
              data-testid="schedule-cta-order"
            >
              <Bell className="w-4 h-4" />
              Set up resupply reminders
            </Button>
          </Link>
          <Link href="/learn">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full gap-2"
              data-testid="schedule-cta-learn"
            >
              <Info className="w-4 h-4" />
              Back to Learn
              <ArrowRight className="w-4 h-4" />
            </Button>
          </Link>
        </div>
      </section>
    </main>
  );
}
