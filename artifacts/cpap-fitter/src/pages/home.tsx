import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { ScanFace, ClipboardList, Zap, Shield, PlayCircle, ArrowRight, Sparkles, BookOpen, HelpCircle, Compass } from "lucide-react";

export function Home() {
  return (
    <div className="flex flex-col items-center max-w-6xl mx-auto w-full px-4 py-16 md:py-28">
      {/* Hero */}
      <div className="text-center max-w-4xl mb-20 animate-shimmer-in">
        <div className="flex justify-center mb-6">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel pulse-soft text-primary text-sm font-medium shadow-sm">
            <Shield className="w-4 h-4" />
            <span>100% Private On-Device Processing</span>
          </div>
        </div>

        <div className="flex justify-center mb-5">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Penn Home Medical Supply · PennPaps.com
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>

        <h1 className="text-display text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight mb-6 leading-[1.05]">
          <span className="text-gradient-brand">Your perfect CPAP mask,</span>
          <br />
          <span className="text-foreground/90">in minutes.</span>
        </h1>

        <p className="text-lg md:text-xl text-muted-foreground leading-relaxed mb-10 max-w-2xl mx-auto">
          <span className="font-semibold text-foreground">PennPaps.com</span> is the online sizing,
          ordering, and resupply service from{" "}
          <span className="font-semibold text-foreground">Penn Home Medical Supply</span>.
          Our clinical-grade fitting tool uses your device's camera to measure your facial
          structure securely, then matches you with the ideal mask from our catalog.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <Link href="/consent">
            <Button
              size="lg"
              className="h-14 px-8 text-base font-semibold rounded-full btn-primary-glow group"
            >
              Start Fitting Process
              <ArrowRight className="w-5 h-5 ml-1 transition-transform group-hover:translate-x-0.5" />
            </Button>
          </Link>
          <Button asChild size="lg" variant="outline" className="h-14 px-6 text-base rounded-full glass-panel gap-2 border-border/60 hover:border-primary/40 transition">
            <a href="/penn-fit-tutorial/" target="_blank" rel="noopener noreferrer">
              <PlayCircle className="w-5 h-5" />
              Watch the tutorial
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          </Button>
          <Link href="/how-it-works">
            <Button size="lg" variant="ghost" className="h-14 px-6 text-base rounded-full text-muted-foreground hover:text-primary">
              How it works
            </Button>
          </Link>
        </div>

        {/* Trust line */}
        <div className="mt-10 flex items-center justify-center gap-3 text-xs text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-[hsl(var(--penn-gold))]" />
          <span>Trusted clinical workflow · No image upload · ~3-minute fitting</span>
        </div>
      </div>

      {/* Feature grid */}
      <div className="grid md:grid-cols-3 gap-6 w-full animate-shimmer-in" style={{ animationDelay: "120ms" }}>
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

      {/* Subtle stat strip */}
      <div className="mt-20 w-full grid grid-cols-1 sm:grid-cols-3 gap-4 animate-shimmer-in" style={{ animationDelay: "240ms" }}>
        {[
          { v: "~3 min", l: "Average fitting time" },
          { v: "19", l: "Masks in our catalog" },
          { v: "100%", l: "On-device processing" },
        ].map(({ v, l }) => (
          <div key={l} className="glass-panel rounded-xl px-5 py-4">
            <div className="text-2xl md:text-3xl font-bold tracking-tight text-gradient-brand">{v}</div>
            <div className="text-xs text-muted-foreground mt-1 uppercase tracking-wider">{l}</div>
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
              body: "A walkthrough of the three-minute fitting flow, plus tips for the most accurate face capture.",
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
