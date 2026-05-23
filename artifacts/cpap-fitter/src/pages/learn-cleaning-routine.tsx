import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Droplets,
  CalendarClock,
  Sparkles,
  AlertTriangle,
  Sun,
  Sunrise,
  Sunset,
  ShieldCheck,
  Beaker,
  CalendarDays,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Task = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  what: string;
  how: string;
  why: string;
};

const dailyTasks: Task[] = [
  {
    Icon: Sunrise,
    what: "Wipe the cushion",
    how: "30 seconds with a baby wipe (alcohol-free) or a warm soapy washcloth. Air-dry on the bedside table.",
    why: "Removes facial oils that break down silicone and cause overnight leaks within 2-3 weeks.",
  },
  {
    Icon: Sun,
    what: "Empty the humidifier chamber",
    how: "Pour out unused water in the morning. Don't leave standing water all day.",
    why: "Standing water grows biofilm faster than most patients believe — even with distilled water.",
  },
  {
    Icon: Sunset,
    what: "Refill with distilled water before bed",
    how: "Distilled water only — not tap, not bottled spring water. Fill to the line, not above.",
    why: "Tap water leaves mineral scale that ruins the heating element. Spring water has minerals too.",
  },
];

const weeklyTasks: Task[] = [
  {
    Icon: Beaker,
    what: "Wash the mask, hose, and chamber",
    how: "Warm water + a drop of mild dish soap (unscented). Rinse thoroughly. Air-dry away from direct sunlight.",
    why: "Weekly wash extends cushion life by 30-50% compared to wipe-only patients in our data.",
  },
  {
    Icon: Droplets,
    what: "Soak headgear straps",
    how: "Hand-wash in cool water with mild detergent — no machine wash, no dryer. Squeeze (don't wring) and air-dry flat.",
    why: "Sweat and skin oils break down the elastic. Washed weekly, headgear lasts 6+ months; unwashed, it's stretched out in 6-8 weeks.",
  },
  {
    Icon: ShieldCheck,
    what: "Check the air filter",
    how: "Pop out the fine-particle filter and inspect. Disposable filters get replaced every 30 days regardless; reusable foam filters get rinsed.",
    why: "A clogged filter forces the motor harder and adds noise. Some machines de-rate pressure when a filter is excessively dirty.",
  },
];

const monthlyTasks: Task[] = [
  {
    Icon: CalendarDays,
    what: "Replace the cushion or nasal pillows",
    how: "Pop on the new cushion. Old one goes in the trash — they're not designed to be deep-cleaned indefinitely.",
    why: "Cushion silicone loses memory after 30-90 days depending on type. A lazy seal causes leaks long before you notice it visually.",
  },
  {
    Icon: CalendarDays,
    what: "Replace disposable filters",
    how: "Swap in fresh fine-particle filters (and the secondary pollen filter if your machine has one).",
    why: "Disposable filters lose efficiency in 30 days even when they look clean. Insurance ships them on this cadence for a reason.",
  },
  {
    Icon: CalendarClock,
    what: "Deep-clean the humidifier chamber",
    how: "Equal parts white vinegar and distilled water; soak for 30 minutes. Rinse three times. Air-dry overnight.",
    why: "Even with distilled water, organics from your breath collect in the chamber. Monthly descale prevents pink-film buildup.",
  },
];

const dontList = [
  {
    nope: "CPAP cleaning machines (SoClean, Lumin, ozone/UV devices)",
    why: "FDA-issued a public health notification about ozone-based CPAP cleaners in 2020 due to respiratory injury risk. Soap and water work better.",
  },
  {
    nope: "Vinegar on the mask cushion",
    why: "Vinegar breaks down medical-grade silicone over time. It's fine for the humidifier chamber but not the parts that touch your face.",
  },
  {
    nope: "Dishwasher cycles for any component",
    why: "Heat warps plastic frames and humidifier chambers permanently. The temperature inside a dishwasher is way above the 130°F cap most manufacturers specify.",
  },
  {
    nope: "Bleach, harsh detergents, scented soaps",
    why: "Anything that lingers on the silicone or in the chamber gets inhaled all night. Use unscented mild dish soap only.",
  },
];

export function LearnCleaningRoutine() {
  useDocumentTitle(
    "The CPAP cleaning routine — daily, weekly, monthly",
    "Exactly how to clean your CPAP mask, hose, humidifier, and filters — the cadence, the products, and the steps to skip. Plus what NOT to use.",
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
        <span className="text-foreground/85">The cleaning routine</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Living with therapy · 7 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          The cleaning routine, honestly.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          A CPAP that&apos;s cleaned consistently lasts longer, seals better,
          and doesn&apos;t become a low-grade infection risk in month three.
          The good news: the real routine is about 90 seconds a day and 10
          minutes a week. Most of what you&apos;ve read online is either
          marketing or fear.
        </p>
      </header>

      {/* The schedule overview */}
      <section className="w-full mb-12">
        <div className="hero-card overflow-hidden">
          <div className="relative z-10 p-7 md:p-9 text-center">
            <div className="text-[10px] font-mono uppercase tracking-[0.22em] text-white/70 mb-3">
              The honest cadence
            </div>
            <div className="grid grid-cols-3 gap-6">
              <div>
                <div className="text-display text-3xl md:text-4xl font-bold text-white mb-1">
                  90s
                </div>
                <div className="text-xs uppercase tracking-wider text-white/70">
                  Daily
                </div>
              </div>
              <div>
                <div className="text-display text-3xl md:text-4xl font-bold text-white mb-1">
                  10 min
                </div>
                <div className="text-xs uppercase tracking-wider text-white/70">
                  Weekly
                </div>
              </div>
              <div>
                <div className="text-display text-3xl md:text-4xl font-bold text-white mb-1">
                  20 min
                </div>
                <div className="text-xs uppercase tracking-wider text-white/70">
                  Monthly
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Daily */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <Sunrise className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Daily · 90 seconds
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The single most important habit for long-term mask comfort. Skip
          this and your cushion fails by month two.
        </p>
        <div className="space-y-4">
          {dailyTasks.map((t, i) => (
            <article
              key={t.what}
              className={
                i === 0
                  ? "glass-card-tech rounded-2xl p-5 md:p-6 relative overflow-hidden"
                  : "glass-card rounded-2xl p-5 md:p-6"
              }
            >
              {i === 0 && <span className="scan-line" aria-hidden="true" />}
              <div className="relative z-10 grid md:grid-cols-[auto_1fr] gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <t.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div>
                  <h3 className="text-base font-bold tracking-tight mb-1.5">
                    {t.what}
                  </h3>
                  <p className="text-sm text-foreground/85 leading-relaxed mb-2">
                    <span className="font-semibold text-[hsl(var(--penn-gold-deep))]">
                      How:{" "}
                    </span>
                    {t.how}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    <span className="font-semibold">Why: </span>
                    {t.why}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Weekly */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <CalendarClock className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Weekly · 10 minutes
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Pick a day — most patients do Sunday mornings, paired with the
          weekend distilled-water restock.
        </p>
        <div className="space-y-4">
          {weeklyTasks.map((t) => (
            <article
              key={t.what}
              className="glass-card rounded-2xl p-5 md:p-6"
            >
              <div className="grid md:grid-cols-[auto_1fr] gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
                  <t.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div>
                  <h3 className="text-base font-bold tracking-tight mb-1.5">
                    {t.what}
                  </h3>
                  <p className="text-sm text-foreground/85 leading-relaxed mb-2">
                    <span className="font-semibold text-[hsl(var(--penn-navy))]">
                      How:{" "}
                    </span>
                    {t.how}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    <span className="font-semibold">Why: </span>
                    {t.why}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* Monthly */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
            <CalendarDays className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Monthly · 20 minutes
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          Calendar it. Set a recurring phone reminder. Our resupply program
          ships you fresh cushions and filters automatically when
          insurance allows — this section is for everything else.
        </p>
        <div className="space-y-4">
          {monthlyTasks.map((t) => (
            <article
              key={t.what}
              className="glass-card rounded-2xl p-5 md:p-6"
            >
              <div className="grid md:grid-cols-[auto_1fr] gap-4">
                <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                  <t.Icon className="w-5 h-5" strokeWidth={2} />
                </div>
                <div>
                  <h3 className="text-base font-bold tracking-tight mb-1.5">
                    {t.what}
                  </h3>
                  <p className="text-sm text-foreground/85 leading-relaxed mb-2">
                    <span className="font-semibold text-[hsl(var(--penn-gold-deep))]">
                      How:{" "}
                    </span>
                    {t.how}
                  </p>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    <span className="font-semibold">Why: </span>
                    {t.why}
                  </p>
                </div>
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* What NOT to do */}
      <section className="w-full mb-12">
        <div className="flex items-center gap-3 mb-5">
          <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-navy">
            <AlertTriangle className="w-5 h-5" strokeWidth={2} />
          </div>
          <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            What NOT to clean it with.
          </h2>
        </div>
        <p className="text-muted-foreground leading-relaxed mb-5">
          The four things online forums recommend most often that you should
          actually skip.
        </p>
        <div className="grid sm:grid-cols-2 gap-4">
          {dontList.map(({ nope, why }) => (
            <div
              key={nope}
              className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5"
            >
              <div className="flex items-start gap-2.5 mb-2">
                <AlertTriangle className="w-4 h-4 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                <div className="font-semibold tracking-tight text-foreground/90 text-sm">
                  {nope}
                </div>
              </div>
              <p className="text-xs text-foreground/85 leading-relaxed ml-6">
                {why}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* Product shortcut */}
      <section className="w-full mb-12">
        <div className="glass-panel rounded-2xl p-6 md:p-7">
          <div className="grid md:grid-cols-[1fr_auto] gap-5 items-center">
            <div>
              <Badge
                variant="outline"
                className="mb-3 chip-tier-standard border-0 font-medium"
              >
                <Sparkles className="w-3 h-3 mr-1.5" /> Shortcut
              </Badge>
              <h3 className="text-lg font-bold tracking-tight mb-2">
                What we actually stock for cleaning.
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Pre-moistened CPAP mask wipes (alcohol-free, citrus-free),
                replacement disposable filters, and gallon jugs of distilled
                water — everything on this page, in one place. Insurance
                covers most of it on the resupply cadence.
              </p>
            </div>
            <Button
              variant="outline"
              className="h-11 px-6 rounded-full glass-card hover:border-primary/40 self-start md:self-center shrink-0"
              asChild
            >
              <Link href="/shop">
                Shop cleaning supplies
                <ArrowRight className="w-4 h-4 ml-1.5" />
              </Link>
            </Button>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/cleaning-routine"
          title="The CPAP cleaning routine — daily, weekly, monthly"
          blurb="Honest cleaning schedule for CPAP — what to wipe, soak, and replace, plus the four products to avoid. About 90 seconds a day."
          testIdPrefix="share-cleaning"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/replacement-schedule"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <CalendarClock className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              Replacement schedules
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Per-part cadences for cushions, headgear, tubing, filters.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn/first-two-weeks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Sunrise className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The first two weeks
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              How to survive the adjustment period without quitting.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/shop")}
          data-testid="cleaning-cta-shop"
        >
          Shop replacement supplies
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only. If you develop new respiratory symptoms,
        persistent sinus infections, or skin reactions, talk to your
        physician — your cleaning routine may not be the issue.
      </p>
    </div>
  );
}
