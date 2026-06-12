import React, { useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { openPennBot } from "@/lib/chat-events";
import { useCompanyContact } from "@/lib/contact";
import {
  ChevronRight,
  Clock,
  Sparkles,
  PhoneCall,
  ArrowRight,
  Lightbulb,
  LifeBuoy,
  Printer,
  ListChecks,
  Info,
  AlertTriangle,
  CheckCircle2,
  ThumbsUp,
  ThumbsDown,
  Compass,
} from "lucide-react";

export type HelpStep = {
  /** Short imperative title, e.g. "Open the shop". */
  title: string;
  /** The instruction prose. */
  body: React.ReactNode;
  /**
   * Optional granular click-by-click actions rendered as a tight ordered
   * list under the prose — the literal "do this, then this" sequence.
   */
  substeps?: React.ReactNode[];
  /** Optional <Screenshot> for this step. */
  shot?: React.ReactNode;
  /** Optional gold "Tip" callout — a helpful shortcut or best practice. */
  tip?: React.ReactNode;
  /** Optional blue "Note" callout — clarifying context. */
  note?: React.ReactNode;
  /** Optional amber "Heads up" callout — something to avoid or watch for. */
  warning?: React.ReactNode;
};

export type HelpFaq = { q: string; a: React.ReactNode };
export type HelpRelated = { href: string; label: string; blurb: string };

type HelpArticleShellProps = {
  /** Small uppercase category label above the title. */
  eyebrow: string;
  title: string;
  /** One-paragraph summary shown under the title. */
  intro: React.ReactNode;
  Icon: React.ComponentType<{ className?: string }>;
  /** Estimated read/do time, e.g. "3 min". */
  minutes: string;
  /**
   * Optional one- or two-sentence "quick answer" surfaced in a highlighted
   * callout above the steps — for readers who just want the gist.
   */
  summary?: React.ReactNode;
  /** Optional "what you'll need before you start" checklist. */
  prerequisites?: React.ReactNode[];
  steps: HelpStep[];
  faqs?: HelpFaq[];
  related?: HelpRelated[];
  /** Optional "do this next" continuation that chains guides into a journey. */
  next?: { href: string; label: string; blurb: string };
  /** SEO meta description for <head>. */
  metaDescription: string;
  /** Optional id prefix for data-testids (defaults from title slug). */
  testIdPrefix?: string;
};

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Shared callout used for per-step tip / note / warning blocks. */
function Callout({
  variant,
  children,
}: {
  variant: "tip" | "note" | "warning";
  children: React.ReactNode;
}) {
  const config = {
    tip: {
      Icon: Lightbulb,
      label: "Tip",
      wrap: "border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/[0.08]",
      accent: "text-[hsl(var(--penn-gold-deep))]",
    },
    note: {
      Icon: Info,
      label: "Note",
      wrap: "border-[hsl(var(--penn-navy))]/25 bg-[hsl(var(--penn-navy))]/[0.05]",
      accent: "text-[hsl(var(--penn-navy))]",
    },
    warning: {
      Icon: AlertTriangle,
      label: "Heads up",
      wrap: "border-amber-400/50 bg-amber-50",
      accent: "text-amber-700",
    },
  }[variant];
  const { Icon, label, wrap, accent } = config;
  return (
    <div className={`flex gap-3 rounded-xl border px-4 py-3 ${wrap}`}>
      <Icon
        className={`w-4 h-4 shrink-0 mt-0.5 ${accent}`}
        aria-hidden="true"
      />
      <p className="text-sm text-foreground/80 leading-relaxed">
        <span className={`font-semibold ${accent}`}>{label}: </span>
        {children}
      </p>
    </div>
  );
}

/**
 * "Was this helpful?" feedback affordance. Stays entirely client-side (no
 * tracking backend): a thumbs-up just thanks the reader, a thumbs-down opens
 * PennBot pre-filled with the article topic so a confused reader is routed
 * straight to a human-grade answer instead of hitting a dead end.
 */
function HelpfulWidget({ title, prefix }: { title: string; prefix: string }) {
  const [answer, setAnswer] = useState<null | "yes" | "no">(null);

  if (answer === "yes") {
    return (
      <p
        className="inline-flex items-center gap-2 text-sm font-medium text-[hsl(var(--penn-navy))]"
        data-testid={`help-feedback-thanks-${prefix}`}
      >
        <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
        Thanks for the feedback!
      </p>
    );
  }
  if (answer === "no") {
    return (
      <p
        className="text-sm text-muted-foreground"
        data-testid={`help-feedback-followup-${prefix}`}
      >
        Sorry this didn&apos;t do the trick — we&apos;ve opened PennBot so you
        can ask in your own words.
      </p>
    );
  }
  return (
    <div
      className="flex flex-wrap items-center gap-3"
      data-testid={`help-feedback-${prefix}`}
    >
      <span className="text-sm font-medium text-foreground/80">
        Was this helpful?
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setAnswer("yes")}
          className="rounded-full glass-panel border-border/60 gap-1.5"
          data-testid={`help-feedback-yes-${prefix}`}
        >
          <ThumbsUp className="w-3.5 h-3.5" />
          Yes
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            setAnswer("no");
            openPennBot({
              prefill: `I need help with: ${title}`,
            });
          }}
          className="rounded-full glass-panel border-border/60 gap-1.5"
          data-testid={`help-feedback-no-${prefix}`}
        >
          <ThumbsDown className="w-3.5 h-3.5" />
          No
        </Button>
      </div>
    </div>
  );
}

/**
 * Shared scaffold for every step-by-step Help Center article. Keeps the
 * breadcrumb, hero, quick-answer + prerequisites blocks, numbered-step
 * rhythm (with optional substeps and tip/note/warning callouts), screenshot
 * placement, mini-FAQ, "was this helpful?" + "still stuck?" blocks, a
 * "do this next" continuation, and the related-links grid identical across
 * articles so an individual page only supplies its content.
 */
export function HelpArticleShell({
  eyebrow,
  title,
  intro,
  Icon,
  minutes,
  summary,
  prerequisites,
  steps,
  faqs,
  related,
  next,
  metaDescription,
  testIdPrefix,
}: HelpArticleShellProps) {
  const contact = useCompanyContact();
  useDocumentTitle(title, metaDescription);
  const prefix = testIdPrefix ?? slugify(title);

  return (
    <div
      className="container max-w-3xl mx-auto px-4 py-10 md:py-12 space-y-12 animate-shimmer-in"
      data-testid={`help-article-${prefix}`}
    >
      {/* Breadcrumb */}
      <nav
        aria-label="Breadcrumb"
        className="flex items-center gap-1.5 text-sm text-muted-foreground"
      >
        <Link
          href="/help"
          className="hover:text-primary transition-colors font-medium"
          data-testid="help-breadcrumb-home"
        >
          Help Center
        </Link>
        <ChevronRight className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        <span className="text-foreground/80 font-medium truncate">{title}</span>
      </nav>

      {/* Hero */}
      <header className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="shrink-0 h-12 w-12 rounded-2xl icon-halo-navy flex items-center justify-center">
              <Icon className="w-6 h-6" />
            </div>
            <span className="text-xs font-semibold uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))]">
              {eyebrow}
            </span>
          </div>
          {/* Print — help articles are commonly printed or saved as PDF to
              follow along away from the screen. Hidden in print output. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => window.print()}
            className="rounded-full text-muted-foreground hover:text-primary gap-1.5 print:hidden"
            data-testid={`help-print-${prefix}`}
          >
            <Printer className="w-4 h-4" />
            <span className="hidden sm:inline">Print</span>
          </Button>
        </div>
        <h1 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand leading-[1.1]">
          {title}
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">{intro}</p>
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground pt-1">
          <span className="inline-flex items-center gap-1.5 glass-panel rounded-full px-3 py-1">
            <Clock className="w-3.5 h-3.5" aria-hidden="true" />
            {minutes}
          </span>
          <span className="inline-flex items-center gap-1.5 glass-panel rounded-full px-3 py-1">
            {steps.length} steps
          </span>
        </div>
      </header>

      {/* Quick answer */}
      {summary ? (
        <section
          className="rounded-2xl border border-[hsl(var(--penn-gold))]/40 bg-[hsl(var(--penn-gold))]/[0.08] p-5"
          data-testid={`help-summary-${prefix}`}
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-[hsl(var(--penn-gold-deep))] mb-1.5">
            Quick answer
          </h2>
          <p className="text-[15px] text-foreground/85 leading-relaxed">
            {summary}
          </p>
        </section>
      ) : null}

      {/* What you'll need */}
      {prerequisites && prerequisites.length > 0 ? (
        <section
          className="glass-card rounded-2xl p-5"
          data-testid={`help-prereqs-${prefix}`}
        >
          <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            <ListChecks
              className="w-4 h-4 text-[hsl(var(--penn-navy))]"
              aria-hidden="true"
            />
            What you&apos;ll need
          </h2>
          <ul className="space-y-2">
            {prerequisites.map((item, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm">
                <CheckCircle2
                  className="w-4 h-4 text-[hsl(var(--penn-navy))] shrink-0 mt-0.5"
                  aria-hidden="true"
                />
                <span className="text-foreground/80 leading-relaxed">
                  {item}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* In this guide — jump links */}
      {steps.length > 2 ? (
        <nav
          aria-label="Steps in this guide"
          className="glass-card rounded-2xl p-5"
          data-testid={`help-toc-${prefix}`}
        >
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground mb-3">
            In this guide
          </h2>
          <ol className="space-y-2">
            {steps.map((step, i) => (
              <li key={step.title}>
                <a
                  href={`#step-${i + 1}`}
                  className="group flex items-center gap-3 text-sm text-foreground/80 hover:text-primary transition-colors"
                >
                  <span className="shrink-0 h-6 w-6 rounded-full bg-[hsl(var(--penn-navy))]/8 text-[hsl(var(--penn-navy))] text-xs font-bold flex items-center justify-center group-hover:bg-[hsl(var(--penn-gold))]/25 transition-colors">
                    {i + 1}
                  </span>
                  <span className="font-medium">{step.title}</span>
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      {/* Steps */}
      <ol className="space-y-12">
        {steps.map((step, i) => (
          <li
            key={step.title}
            id={`step-${i + 1}`}
            className="scroll-mt-24 grid grid-cols-[auto_1fr] gap-x-4 gap-y-4"
            data-testid={`help-step-${prefix}-${i + 1}`}
          >
            <div className="flex flex-col items-center gap-2">
              <span className="shrink-0 h-10 w-10 rounded-full bg-[hsl(var(--penn-navy))] text-white text-base font-bold flex items-center justify-center shadow-sm">
                {i + 1}
              </span>
              {i < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="flex-1 w-px bg-gradient-to-b from-[hsl(var(--penn-navy))]/20 to-transparent"
                />
              ) : null}
            </div>
            <div className="space-y-4 pb-2 min-w-0">
              <h3 className="text-xl font-semibold tracking-tight pt-1.5">
                {step.title}
              </h3>
              <div className="text-[15px] text-muted-foreground leading-relaxed space-y-3">
                {step.body}
              </div>
              {step.substeps && step.substeps.length > 0 ? (
                <ol className="space-y-2 rounded-xl bg-[hsl(var(--penn-navy))]/[0.03] border border-border/50 p-4">
                  {step.substeps.map((sub, si) => (
                    <li key={si} className="flex items-start gap-3 text-sm">
                      <span className="shrink-0 h-5 w-5 rounded-full bg-white border border-[hsl(var(--penn-navy))]/25 text-[hsl(var(--penn-navy))] text-[11px] font-bold flex items-center justify-center mt-0.5">
                        {String.fromCharCode(97 + si)}
                      </span>
                      <span className="text-foreground/80 leading-relaxed">
                        {sub}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : null}
              {step.shot ? <div className="pt-1">{step.shot}</div> : null}
              {step.note ? <Callout variant="note">{step.note}</Callout> : null}
              {step.tip ? <Callout variant="tip">{step.tip}</Callout> : null}
              {step.warning ? (
                <Callout variant="warning">{step.warning}</Callout>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {/* Mini-FAQ */}
      {faqs && faqs.length > 0 ? (
        <section className="space-y-4" data-testid={`help-faq-${prefix}`}>
          <h2 className="text-2xl font-semibold tracking-tight">
            Questions about this
          </h2>
          <div className="glass-card rounded-2xl p-2 sm:p-4">
            <Accordion type="single" collapsible className="w-full">
              {faqs.map(({ q, a }, idx) => (
                <AccordionItem
                  key={q}
                  value={`${prefix}-faq-${idx}`}
                  className="border-border/50 last:border-b-0"
                >
                  <AccordionTrigger className="text-left text-base font-semibold hover:no-underline hover:text-primary px-2">
                    {q}
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground leading-relaxed text-sm px-2 pb-4">
                    {a}
                  </AccordionContent>
                </AccordionItem>
              ))}
            </Accordion>
          </div>
        </section>
      ) : null}

      {/* Do this next */}
      {next ? (
        <section
          aria-label="Next step"
          className="relative overflow-hidden rounded-2xl border border-[hsl(var(--penn-gold))]/40 bg-gradient-to-br from-[hsl(var(--penn-navy))] to-[#0d2a5c] text-white p-6"
          data-testid={`help-next-${prefix}`}
        >
          <div
            aria-hidden
            className="pointer-events-none absolute -top-12 -right-12 h-40 w-40 rounded-full bg-[hsl(var(--penn-gold))]/25 blur-3xl"
          />
          <Link
            href={next.href}
            className="relative flex items-center gap-4 group"
            data-testid={`help-next-link-${prefix}`}
          >
            <div className="shrink-0 h-11 w-11 rounded-xl bg-[hsl(var(--penn-gold))]/20 ring-1 ring-[hsl(var(--penn-gold))]/40 flex items-center justify-center">
              <Compass className="w-5 h-5 text-[hsl(var(--penn-gold))]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[hsl(var(--penn-gold))]">
                Do this next
              </div>
              <div className="text-lg font-bold tracking-tight">
                {next.label}
              </div>
              <p className="text-sm text-white/80 leading-relaxed">
                {next.blurb}
              </p>
            </div>
            <ArrowRight className="w-5 h-5 text-[hsl(var(--penn-gold))] shrink-0 transition-transform group-hover:translate-x-1" />
          </Link>
        </section>
      ) : null}

      {/* Was this helpful? + Still stuck? */}
      <section>
        <div className="glass-card rounded-2xl relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 100% 0%, hsl(var(--penn-gold) / 0.18), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <div className="p-6 sm:p-8 space-y-5 relative">
            <div className="flex flex-col sm:flex-row gap-5 items-start">
              <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
                <LifeBuoy className="w-5 h-5" />
              </div>
              <div className="space-y-2 flex-1">
                <h3 className="text-xl font-semibold tracking-tight">
                  Still stuck?
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed">
                  Ask PennBot for a typed answer in seconds, or call our care
                  team — real people who fit masks and handle insurance every
                  day.
                </p>
                <div className="flex flex-wrap gap-3 pt-2">
                  <Button
                    type="button"
                    onClick={() => openPennBot()}
                    className="rounded-full btn-primary-glow gap-2"
                    data-testid={`help-ask-pennbot-${prefix}`}
                  >
                    <Sparkles className="w-4 h-4" />
                    Ask PennBot
                  </Button>
                  <a href={`tel:${contact.phoneE164}`}>
                    <Button
                      variant="outline"
                      className="rounded-full glass-panel border-border/60 gap-2"
                    >
                      <PhoneCall className="w-4 h-4" />
                      {contact.phoneDisplay}
                    </Button>
                  </a>
                </div>
              </div>
            </div>
            <div className="pt-4 border-t border-border/40">
              <HelpfulWidget title={title} prefix={prefix} />
            </div>
          </div>
        </div>
      </section>

      {/* Related */}
      {related && related.length > 0 ? (
        <section className="space-y-4">
          <h2 className="text-2xl font-semibold tracking-tight">
            Related help
          </h2>
          <div className="grid sm:grid-cols-2 gap-3">
            {related.map(({ href, label, blurb }) => (
              <Link
                key={href}
                href={href}
                className="glass-card lift-on-hover rounded-2xl p-5 flex items-start gap-3 group"
                data-testid={`help-related-${slugify(label)}`}
              >
                <div className="space-y-1 flex-1 min-w-0">
                  <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
                    {label}
                  </h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {blurb}
                  </p>
                </div>
                <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-0.5 shrink-0" />
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {/* Back to hub */}
      <div className="pt-2">
        <Link
          href="/help"
          className="inline-flex items-center gap-2 text-sm font-medium text-primary hover:gap-3 transition-all"
          data-testid="help-back-to-hub"
        >
          <ArrowRight className="w-4 h-4 rotate-180" aria-hidden="true" />
          Back to the Help Center
        </Link>
      </div>
    </div>
  );
}
