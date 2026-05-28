import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  ScanFace,
  ClipboardList,
  Zap,
  ArrowRight,
  BookOpen,
  HelpCircle,
  Compass,
  ShoppingBag,
  Sparkles,
  UserCircle2,
} from "lucide-react";
import { HomeStatusBanner } from "@/components/home-status-banner";
import { TrustSignalStrip } from "@/components/trust-signal-strip";
import { openPennBot } from "@/lib/chat-events";

/**
 * Renders the PennPaps landing page with hero, trust signals, featured paths, and resource tiles.
 *
 * The component builds the full Home page UI and wires primary CTAs for fitting, shopping, and account flows;
 * it also calls the application document-title hook to stamp the canonical URL and exposes a PennBot launch control.
 *
 * @returns The React element for the Home (landing) page.
 */
export function Home() {
  // Empty title keeps the static index.html title (already optimal
  // for the landing page); the hook is still called so the canonical
  // gets stamped at https://pennpaps.com/.
  useDocumentTitle("");
  const [, navigate] = useLocation();
  return (
    <>
      <div className="relative z-10 flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-8 md:py-14">
        <HomeStatusBanner />

      {/* Hero — light editorial card. Pearl surface, navy ink
          display type, a single thin gold hairline along the
          bottom edge as the lone chromatic accent. Solid navy
          primary CTA, ghost outline secondary. */}
      <section className="hero-card hero-card-editorial w-full mb-14 md:mb-20 animate-shimmer-in">
        <div className="relative z-10 text-center max-w-5xl mx-auto px-6 py-14 md:px-12 md:py-24">
          <div className="hero-eyebrow" aria-hidden="true">
            <span className="hero-eyebrow-rule" />
            <span className="hero-eyebrow-mark" />
            <span>Penn Home Medical Supply &middot; CPAP Care</span>
            <span className="hero-eyebrow-mark" />
            <span className="hero-eyebrow-rule" />
          </div>
          <h1 className="text-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-6 md:mb-7 leading-[1.08] sm:leading-[1.05] text-foreground">
            Your CPAP, made{" "}
            <span className="hero-headline-italic">simple</span>.
            <br />
            <span className="hero-headline-swoosh">Fit. Shop. Resupply.</span>
          </h1>

          <p className="text-base sm:text-lg md:text-xl text-muted-foreground leading-relaxed mb-9 md:mb-11 max-w-2xl mx-auto">
            <span className="font-semibold text-foreground">PennPaps.com</span>{" "}
            is the online CPAP storefront from{" "}
            <span className="font-semibold text-foreground">
              Penn Home Medical Supply
            </span>{" "}
            — your local DME team. Get clinically matched to the right mask,
            order cushions, filters, and tubing direct, and let us keep your
            resupply on schedule.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
            <Button
              size="lg"
              className="h-14 px-8 text-base font-semibold rounded-full group"
              data-testid="home-cta-fit"
              onClick={() => navigate("/consent")}
            >
              Get fitted for a mask
              <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-0.5" />
            </Button>
            <Button
              size="lg"
              variant="outline"
              className="h-14 px-6 text-base rounded-full gap-2"
              data-testid="home-cta-shop"
              onClick={() => navigate("/shop")}
            >
              <ShoppingBag className="w-5 h-5" />
              Shop CPAP supplies
            </Button>
          </div>
          <button
            type="button"
            onClick={() => openPennBot()}
            className="mt-5 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            data-testid="home-ask-pennbot"
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>Or ask PennBot anything</span>
          </button>
        </div>
      </section>

      {/* Trust-signal strip — live aggregate review rating + static brand promises */}
      <TrustSignalStrip />

      {/* Animated aurora hairline — visual rhythm break before the
          asymmetric featured section. */}
      <div
        className="w-full max-w-4xl aurora-divider-live"
        aria-hidden="true"
      />

      {/* Featured fitter showcase — the old "three ways" grid + feature
          grid + stat strip are consolidated into a single asymmetric
          layout. The featured card carries the tech language (cyan rim,
          scan-line, mono numerals, gradient title) while the side stack
          gives shop + account parity without competing for attention. */}
      <div
        className="w-full mt-12 md:mt-16 mb-20 md:mb-24 grid grid-cols-1 lg:grid-cols-5 gap-5 animate-shimmer-in"
        style={{ animationDelay: "60ms" }}
      >
        <Link
          href="/consent"
          className="lg:col-span-3 glass-card-tech lift-on-hover rounded-2xl p-7 md:p-9 relative overflow-hidden flex flex-col text-left group"
          data-testid="home-path-fit"
        >
          <span className="scan-line" aria-hidden="true" />

          <div className="flex items-center justify-between mb-6 relative z-10">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-6 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-[11px] font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-gold-deep))]">
                The Mask Fitter
              </span>
            </div>
            <span className="text-[10px] font-mono text-muted-foreground tracking-[0.18em] uppercase">
              ~3 min · live
            </span>
          </div>

          <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight mb-3 relative z-10">
            <span className="text-gradient-tech">Clinical-grade fitting,</span>
            <br />
            <span className="text-foreground/90">in about three minutes.</span>
          </h2>

          <p className="text-muted-foreground leading-relaxed mb-7 max-w-md relative z-10">
            Computer-vision face capture runs entirely in your browser. We turn
            millimeter measurements into a clinically-reasoned mask match — no
            images ever leave your device.
          </p>

          {/* Inline numbered process rail — replaces the old uniform
              3-card "feature grid" with a denser, more diagrammatic
              sequence. Cyan connector lines echo the scan-line. */}
          <ol className="grid grid-cols-3 gap-3 mb-7 relative z-10">
            {[
              { Icon: ScanFace, t: "Secure scan" },
              { Icon: ClipboardList, t: "Quick assessment" },
              { Icon: Zap, t: "Instant match" },
            ].map(({ Icon, t }, i) => (
              <li key={t} className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-mono text-[hsl(var(--penn-gold-deep))] tracking-[0.22em]">
                    0{i + 1}
                  </span>
                  <span className="h-px flex-1 bg-gradient-to-r from-[hsl(var(--penn-gold))]/45 to-transparent" />
                </div>
                <div className="flex items-center gap-2">
                  <Icon
                    className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]/80 shrink-0"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  <span className="text-xs font-semibold text-foreground/85 leading-tight">
                    {t}
                  </span>
                </div>
              </li>
            ))}
          </ol>

          <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all relative z-10 mt-auto">
            Start the fitter
            <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
          </span>
        </Link>

        {/* Side stack — compact, list-style cards for the secondary
            paths. Different visual language from the featured card. */}
        <div className="lg:col-span-2 flex flex-col gap-5">
          <Link
            href="/shop"
            className="glass-card lift-on-hover rounded-2xl p-6 flex-1 flex flex-col text-left group"
            data-testid="home-path-shop"
          >
            <div className="flex items-start gap-4 mb-3">
              <div className="relative h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 icon-halo-gold">
                <ShoppingBag className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-tight mb-1">
                  Shop direct
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Cushions, filters, tubing, headgear, and bundles —
                  cash-pay, ships in 1–3 business days.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all mt-auto">
              Browse the shop
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>

          <Link
            href="/account"
            className="glass-card lift-on-hover rounded-2xl p-6 flex-1 flex flex-col text-left group"
            data-testid="home-path-account"
          >
            <div className="flex items-start gap-4 mb-3">
              <div className="relative h-12 w-12 rounded-2xl flex items-center justify-center shrink-0 icon-halo-navy">
                <UserCircle2 className="w-5 h-5" strokeWidth={2} />
              </div>
              <div className="min-w-0">
                <h3 className="text-lg font-semibold tracking-tight mb-1">
                  Your account
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Save shipping and cards, see past orders, and reorder in
                  one tap.
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all mt-auto">
              Open my account
              <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        </div>
      </div>

      {/* Resources — compacted from three large uniform cards into a
          single 3-tile glass panel. Lower visual weight than before so
          it reads as a footer-adjacent navigation aid rather than a
          fourth feature section. */}
      <div
        className="w-full animate-shimmer-in"
        style={{ animationDelay: "180ms" }}
      >
        <div className="text-center max-w-2xl mx-auto mb-8 space-y-3">
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                More Resources
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            New to CPAP, or just have questions?
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Browse plain-language guides, jump straight to ordering and
            insurance answers, or take a walkthrough of how PennPaps works.
          </p>
        </div>

        <div className="glass-panel rounded-2xl p-2 sm:p-3">
          <div className="grid sm:grid-cols-3 gap-1 sm:gap-2">
            {[
              {
                href: "/learn",
                Icon: BookOpen,
                title: "Patient education",
                cta: "Browse Learn",
                testid: "home-resource-learn",
                halo: "icon-halo-navy",
              },
              {
                href: "/faq",
                Icon: HelpCircle,
                title: "Frequently asked questions",
                cta: "Open the FAQ",
                testid: "home-resource-faq",
                halo: "icon-halo-gold",
              },
              {
                href: "/how-it-works",
                Icon: Compass,
                title: "How PennPaps works",
                cta: "See the walkthrough",
                testid: "home-resource-how-it-works",
                halo: "icon-halo-navy",
              },
            ].map(({ href, Icon, title, cta, testid, halo }) => (
              <Link
                key={href}
                href={href}
                className="rounded-xl p-4 flex items-center gap-3 hover:bg-white/55 transition group"
                data-testid={testid}
              >
                <div
                  className={`relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 ${halo}`}
                >
                  <Icon className="w-4 h-4" strokeWidth={2} />
                </div>
                <div className="flex flex-col flex-1 min-w-0">
                  <span className="text-sm font-semibold tracking-tight truncate">
                    {title}
                  </span>
                  <span className="inline-flex items-center gap-1 text-xs text-primary group-hover:gap-1.5 transition-all">
                    {cta}
                    <ArrowRight className="w-3 h-3 transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </div>
    </>
  );
}
