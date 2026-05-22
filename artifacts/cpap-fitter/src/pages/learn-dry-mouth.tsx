import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Droplets,
  Sparkles,
  AlertTriangle,
  Wind,
  Settings2,
  Activity,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";
import { TableOfContents } from "@/components/table-of-contents";

const tocItems = [
  { slug: "why-it-happens", label: "Why it happens" },
  { slug: "humidifier", label: "Fix #1 — your humidifier" },
  { slug: "mouth-breathing", label: "Fix #2 — mouth breathing" },
  { slug: "heated-tube", label: "Fix #3 — heated tubing" },
  { slug: "when-to-call", label: "When to call us" },
];

const fixes = [
  {
    Icon: Droplets,
    title: "Step 1 — Bump the humidifier",
    body: "The fastest fix. Set your humidifier one level higher than default — most patients land on 3-4 out of 5. If you wake up parched, go higher. If you wake up to condensation in the hose, drop one level and add a heated tube.",
    badge: "Try this first",
  },
  {
    Icon: Wind,
    title: "Step 2 — Check for mouth breathing",
    body: "If you start the night with your mouth closed but wake up with it open, therapy air is escaping through your mouth all night — leaving the rest of your airway bone-dry. A chin strap or a switch to a full-face mask resolves this.",
    badge: "Most common true cause",
  },
  {
    Icon: Activity,
    title: "Step 3 — Add heated tubing",
    body: "Heated tubing keeps the air at body temperature all the way to the mask, preventing condensation (rainout) while maintaining higher humidification. Insurance typically covers heated tubing for documented dry-mouth complaints.",
    badge: "If humidifier alone isn't enough",
  },
];

export function LearnDryMouth() {
  useDocumentTitle(
    "Fixing CPAP dry mouth",
    "Dry mouth is the most common CPAP comfort complaint and one of the easiest to fix. Three solutions in order of likelihood — humidifier, mouth breathing, heated tubing.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 max-w-6xl mx-auto w-full px-4 py-8 md:py-14">
      <div className="lg:grid lg:grid-cols-[1fr_14rem] lg:gap-10">
        <article className="min-w-0">
          {/* Breadcrumb */}
          <div className="mb-6 text-sm text-muted-foreground">
            <Link href="/learn" className="hover:text-primary transition-colors">
              Learn
            </Link>
            <span className="mx-2">/</span>
            <span className="text-foreground/85">Fixing dry mouth</span>
          </div>

          {/* Header */}
          <header className="mb-8">
            <div className="inline-flex items-center gap-3 mb-4">
              <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Troubleshooting · 5 min read
              </span>
            </div>
            <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
              Waking up parched.
            </h1>
            <p className="text-lg text-muted-foreground leading-relaxed">
              Dry mouth is the single most common CPAP comfort complaint —
              and one of the easiest to fix. Three causes drive almost every
              case. Here&apos;s how to walk through them in order.
            </p>
          </header>

          {/* Mobile ToC */}
          <TableOfContents items={tocItems} testIdPrefix="dry-mouth-toc" />

          {/* Why */}
          <section id="why-it-happens" className="mb-10 scroll-mt-24">
            <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90 mb-4">
              Why it happens.
            </h2>
            <p className="text-muted-foreground leading-relaxed mb-3">
              CPAP air is drier than room air for two reasons: it moves
              faster (any moving air evaporates moisture more aggressively),
              and it&apos;s usually drawn through a fine-particle filter
              that strips humidity. If your humidifier setting is too low
              for the room you sleep in, or if you&apos;re leaking air out
              your mouth all night, you&apos;ll wake up with sandpaper
              tongue.
            </p>
            <p className="text-muted-foreground leading-relaxed">
              Almost every fix falls into one of three buckets. Try them in
              the order below — the cheapest, simplest one resolves most
              cases in one or two nights.
            </p>
          </section>

          {/* Three fixes */}
          <section className="mb-10 space-y-5">
            {fixes.map((f, i) => (
              <article
                key={f.title}
                id={
                  i === 0
                    ? "humidifier"
                    : i === 1
                      ? "mouth-breathing"
                      : "heated-tube"
                }
                className={
                  i === 0
                    ? "glass-card-tech rounded-2xl p-6 relative overflow-hidden scroll-mt-24"
                    : "glass-card rounded-2xl p-6 scroll-mt-24"
                }
              >
                {i === 0 && <span className="scan-line" aria-hidden="true" />}
                <div className="relative z-10">
                  <div className="flex items-start gap-4 mb-3">
                    <div className="relative h-11 w-11 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                      <f.Icon className="w-5 h-5" strokeWidth={2} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <Badge
                        variant="outline"
                        className="mb-1.5 text-[10px] chip-tier-premium border-0 font-medium"
                      >
                        {f.badge}
                      </Badge>
                      <h3 className="text-lg md:text-xl font-bold tracking-tight text-foreground/90">
                        {f.title}
                      </h3>
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {f.body}
                  </p>
                </div>
              </article>
            ))}
          </section>

          {/* When to call */}
          <section id="when-to-call" className="mb-10 scroll-mt-24">
            <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
                <div>
                  <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                    When to call us (or your doctor)
                  </div>
                  <p className="text-sm text-foreground/85 leading-relaxed">
                    If you&apos;ve maxed your humidifier, ruled out mouth
                    breathing, added a heated tube, and you&apos;re still
                    waking parched — talk to us about a mask change, or to
                    your doctor about whether your prescribed pressure
                    needs a look. Persistent dry mouth despite the standard
                    fixes is worth a second pair of eyes.
                  </p>
                </div>
              </div>
            </div>
          </section>

          {/* Share */}
          <div className="mb-8">
            <ShareArticle
              path="/learn/dry-mouth"
              title="Fixing CPAP dry mouth"
              blurb="Dry mouth is the #1 CPAP comfort complaint and one of the easiest to fix — usually a humidifier setting, sometimes mouth breathing, occasionally heated tubing. Walk-through in 5 minutes."
              testIdPrefix="share-dry-mouth"
            />
          </div>

          {/* Cross-links */}
          <div className="grid md:grid-cols-2 gap-4 mb-8">
            <Link
              href="/learn/mask-leaks"
              className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
            >
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <Wind className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
                  Mask leaks
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Bridge leaks, side leaks, mouth leaks — the visual diagnosis
                  and what to do.
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
            </Link>
            <Link
              href="/learn/nasal-congestion"
              className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
            >
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                <Settings2 className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
                  Nasal congestion on CPAP
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Allergies, humidifier settings, and when to switch mask
                  styles.
                </p>
              </div>
              <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
            </Link>
          </div>

          {/* CTA */}
          <div className="text-center">
            <Badge
              variant="outline"
              className="mb-4 chip-tier-premium border-0 font-medium"
            >
              <Sparkles className="w-3 h-3 mr-1.5" /> Shop the fix
            </Badge>
            <Button
              size="lg"
              className="h-12 px-7 rounded-full btn-primary-glow group"
              onClick={() => navigate("/shop")}
              data-testid="dry-mouth-cta-shop"
            >
              Shop chin straps &amp; heated tubing
              <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
            </Button>
          </div>

          <p className="text-xs text-muted-foreground/80 leading-relaxed mt-10 max-w-2xl mx-auto text-center">
            Educational content only. Don&apos;t change pressure settings
            on your own; humidifier and tubing changes are safe to adjust.
          </p>
        </article>

        {/* Desktop ToC — second grid column. The inline render above
            handles the mobile collapsible card; this one handles the
            sticky right rail at lg+ via the component's own hidden /
            lg:block classes. */}
        <div className="hidden lg:block">
          <TableOfContents items={tocItems} testIdPrefix="dry-mouth-toc-desktop" />
        </div>
      </div>
    </div>
  );
}
