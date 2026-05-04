import React from "react";
import { Link } from "wouter";
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
  UserCircle2,
} from "lucide-react";
import { HomeStatusBanner } from "@/components/home-status-banner";
import { TrustSignalStrip } from "@/components/trust-signal-strip";

export function Home() {
  // Empty title keeps the static index.html title (already optimal
  // for the landing page); the hook is still called so the canonical
  // gets stamped at https://pennpaps.com/.
  useDocumentTitle("");
  return (
    <div className="flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-10 md:py-28">
      <HomeStatusBanner />
      {/* Hero */}
      <div className="text-center max-w-4xl mb-12 md:mb-16 animate-shimmer-in">
        <div className="flex justify-center mb-5">
          <span className="status-pill" data-testid="home-tech-pill">
            On-device computer vision · HIPAA-aligned · Penn Home Medical Supply
          </span>
        </div>

        <h1 className="text-display text-4xl sm:text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-5 md:mb-6 leading-[1.08] sm:leading-[1.05]">
          <span className="text-gradient-tech">Your CPAP, made simple.</span>
          <br />
          <span className="text-foreground/90">Fit. Shop. Resupply.</span>
        </h1>

        <p className="text-base sm:text-lg md:text-xl text-muted-foreground leading-relaxed mb-8 md:mb-10 max-w-2xl mx-auto">
          <span className="font-semibold text-foreground">PennPaps.com</span> is
          the online CPAP storefront from{" "}
          <span className="font-semibold text-foreground">
            Penn Home Medical Supply
          </span>{" "}
          — your local DME team. Get clinically matched to the right mask, order
          cushions, filters, and tubing direct, and let us keep your resupply on
          schedule.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/consent">
            <Button
              size="lg"
              className="h-14 px-8 text-base font-semibold rounded-full btn-primary-glow group"
              data-testid="home-cta-fit"
            >
              Get fitted for a mask
              <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-0.5" />
            </Button>
          </Link>
          <Link href="/shop">
            <Button
              size="lg"
              variant="outline"
              className="h-14 px-6 text-base rounded-full glass-panel gap-2 border-border/60 hover:border-primary/40 transition"
              data-testid="home-cta-shop"
            >
              <ShoppingBag className="w-5 h-5" />
              Shop CPAP supplies
            </Button>
          </Link>
          {/* "Watch the tutorial" button removed in the Task #37
              consolidation along with the standalone pennpaps-tutorial
              artifact. Patients now see the inline how-it-works copy
              and animated step rail on /how-it-works instead. */}
        </div>
      </div>

      {/* Trust-signal strip — live aggregate review rating + static brand promises */}
      <TrustSignalStrip />

      {/* Three ways to use PennPaps — surfaces shop + accounts alongside the fitter */}
      <div
        className="w-full mb-20 animate-shimmer-in"
        style={{ animationDelay: "60ms" }}
      >
        <div className="text-center mb-8">
          <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
            Three ways to start
          </h2>
        </div>
        <div className="grid sm:grid-cols-3 gap-5">
          {[
            {
              href: "/consent",
              Icon: ScanFace,
              title: "Get fitted",
              body: "New mask? Use your camera to measure your face on-device, then we match you with the right style and size.",
              cta: "Start the fitter",
              testid: "home-path-fit",
              halo: "icon-halo-navy",
            },
            {
              href: "/shop",
              Icon: ShoppingBag,
              title: "Shop direct",
              body: "Already know what you need? Order cushions, filters, tubing, headgear, and bundles — cash-pay, ships fast.",
              cta: "Browse the shop",
              testid: "home-path-shop",
              halo: "icon-halo-gold",
            },
            {
              href: "/account",
              Icon: UserCircle2,
              title: "Your account",
              body: "Sign in to save your shipping address and card, see past orders, and reorder in one tap.",
              cta: "Open my account",
              testid: "home-path-account",
              halo: "icon-halo-navy",
            },
          ].map(({ href, Icon, title, body, cta, testid, halo }) => (
            <Link
              key={href}
              href={href}
              className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col items-start text-left group"
              data-testid={testid}
            >
              <div
                className={`relative h-12 w-12 rounded-2xl flex items-center justify-center mb-4 ${halo}`}
              >
                <Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-lg font-semibold tracking-tight mb-2">
                {title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 flex-1">
                {body}
              </p>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all">
                {cta}
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>

      {/* Section heading scopes the feature grid to the fitter specifically */}
      <div
        className="w-full text-center mb-8 animate-shimmer-in"
        style={{ animationDelay: "100ms" }}
      >
        <div className="flex justify-center mb-3">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              The Mask Fitter
            </span>
            <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-foreground/90">
          A clinical-grade fitting, in about three minutes.
        </h2>
        <p className="text-muted-foreground leading-relaxed max-w-2xl mx-auto mt-3">
          If you're new or your current mask isn't sealing right, our fitter is
          the fastest way to a mask that actually works.
        </p>
      </div>

      {/* Feature grid */}
      <div
        className="grid md:grid-cols-3 gap-6 w-full animate-shimmer-in"
        style={{ animationDelay: "120ms" }}
      >
        {[
          {
            Icon: ScanFace,
            title: "Secure Scan",
            body: "We measure your face using your camera. The image never leaves your device, ensuring total privacy.",
          },
          {
            Icon: ClipboardList,
            title: "Quick Assessment",
            body: "Answer a few simple questions about your sleep habits and preferences to refine the match.",
          },
          {
            Icon: Zap,
            title: "Instant Match",
            body: "Get personalized mask recommendations backed by clinical reasoning and precise measurements.",
          },
        ].map(({ Icon, title, body }, i) => (
          <div
            key={title}
            className="glass-card lift-on-hover rounded-2xl p-7 flex flex-col items-start text-left group"
          >
            <div className="relative h-14 w-14 rounded-2xl flex items-center justify-center mb-5 icon-halo-navy">
              <Icon className="w-6 h-6" strokeWidth={2} />
            </div>
            <div className="flex items-baseline gap-2 mb-2">
              <span className="text-xs font-mono text-[hsl(var(--penn-gold))]/80 tracking-widest">
                0{i + 1}
              </span>
              <h3 className="text-xl font-semibold tracking-tight">{title}</h3>
            </div>
            <p className="text-muted-foreground leading-relaxed">{body}</p>
          </div>
        ))}
      </div>

      {/* Subtle stat strip — mixes fitter-specific stats with shop signal */}
      <div
        className="mt-20 w-full grid grid-cols-1 sm:grid-cols-3 gap-4 animate-shimmer-in"
        style={{ animationDelay: "240ms" }}
      >
        {[
          { v: "~3 min", l: "Average fitting time" },
          { v: "100%", l: "On-device face capture" },
          { v: "Direct", l: "From your local DME" },
        ].map(({ v, l }) => (
          <div key={l} className="glass-card-tech rounded-xl px-5 py-4">
            <div className="text-2xl md:text-3xl font-bold tracking-tight text-gradient-tech font-mono">
              {v}
            </div>
            <div className="text-[10px] text-muted-foreground mt-1 uppercase tracking-[0.22em]">
              {l}
            </div>
          </div>
        ))}
      </div>

      {/* More resources — directs customers to FAQ + Learn + How It Works */}
      <div
        className="mt-24 w-full animate-shimmer-in"
        style={{ animationDelay: "360ms" }}
      >
        <div className="text-center max-w-2xl mx-auto mb-10 space-y-3">
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                More Resources
              </span>
              <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
          </div>
          <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-foreground/90">
            New to CPAP, or just have questions?
          </h2>
          <p className="text-muted-foreground leading-relaxed">
            Browse plain-language guides on sleep apnea and CPAP therapy, or
            jump straight to specific answers about ordering, insurance, mask
            care, and troubleshooting.
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-5">
          {[
            {
              href: "/learn",
              Icon: BookOpen,
              title: "Patient education",
              body: "Short, jargon-free articles on what CPAP does, why it matters, and how to live comfortably with therapy.",
              cta: "Browse Learn",
              testid: "home-resource-learn",
              halo: "icon-halo-navy",
            },
            {
              href: "/faq",
              Icon: HelpCircle,
              title: "Frequently asked questions",
              body: "Direct answers to the questions our patients ask most — from prescriptions to mask leaks.",
              cta: "Open the FAQ",
              testid: "home-resource-faq",
              halo: "icon-halo-gold",
            },
            {
              href: "/how-it-works",
              Icon: Compass,
              title: "How PennPaps works",
              body: "A walkthrough of every part of PennPaps — the fitter, the shop, customer accounts, and how resupply works.",
              cta: "See the walkthrough",
              testid: "home-resource-how-it-works",
              halo: "icon-halo-navy",
            },
          ].map(({ href, Icon, title, body, cta, testid, halo }) => (
            <Link
              key={href}
              href={href}
              className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col items-start text-left group"
              data-testid={testid}
            >
              <div
                className={`relative h-12 w-12 rounded-2xl flex items-center justify-center mb-4 ${halo}`}
              >
                <Icon className="w-5 h-5" strokeWidth={2} />
              </div>
              <h3 className="text-lg font-semibold tracking-tight mb-2">
                {title}
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed mb-4 flex-1">
                {body}
              </p>
              <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary group-hover:gap-2 transition-all">
                {cta}
                <ArrowRight className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
