import React, { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useSearchShortcut } from "@/hooks/use-search-shortcut";
import { openPennBot } from "@/lib/chat-events";
import {
  LifeBuoy,
  Search,
  X,
  Sparkles,
  ArrowRight,
  ScanFace,
  PackageCheck,
  ShoppingCart,
  Truck,
  UserCircle,
  BellRing,
  ShieldCheck,
  RotateCcw,
  HelpCircle,
  PhoneCall,
  KeyRound,
  Heart,
} from "lucide-react";
import { SUPPORT_PHONE_DISPLAY, SUPPORT_PHONE_E164 } from "@/lib/contact";

/**
 * Help Center hub.
 *
 * Distinct from /learn (medical patient education about sleep apnea) and
 * /faq (quick clinical Q&A): this is task-oriented, "how do I use this
 * feature" documentation — each topic links to a step-by-step guide with
 * screenshots under /help/*. Topics are grouped into categories and the
 * whole set is searchable from the hero.
 */

type HelpTopic = {
  href: string;
  Icon: React.ComponentType<{ className?: string }>;
  title: string;
  blurb: string;
  /** Extra keywords folded into the search haystack. */
  keywords?: string;
  tone: "navy" | "gold";
};

type HelpCategory = {
  id: string;
  eyebrow: string;
  title: string;
  caption: string;
  topics: HelpTopic[];
};

const categories: HelpCategory[] = [
  {
    id: "getting-started",
    eyebrow: "Start here",
    title: "Getting Started",
    caption:
      "Find the right mask and understand how PennPaps matches it to your face.",
    topics: [
      {
        href: "/help/find-your-mask",
        Icon: ScanFace,
        title: "Find your mask with the Virtual Fitter",
        blurb:
          "Run the 3-minute on-device face scan and read your ranked recommendations.",
        keywords: "fitter scan camera measure measurements recommendation",
        tone: "gold",
      },
      {
        href: "/help/place-an-order",
        Icon: PackageCheck,
        title: "Order your recommended mask",
        blurb:
          "Turn a recommendation into an order — shipping, insurance, and prescription.",
        keywords: "order checkout prescription insurance submit",
        tone: "navy",
      },
    ],
  },
  {
    id: "shopping",
    eyebrow: "Shop & orders",
    title: "Shopping & Orders",
    caption:
      "Buy supplies direct, check out, and follow your package to the door.",
    topics: [
      {
        href: "/help/shop-and-checkout",
        Icon: ShoppingCart,
        title: "Shop supplies & check out",
        blurb:
          "Browse cushions, filters, and tubing, add to cart, and pay securely.",
        keywords: "shop cart buy purchase cushion filter tubing checkout pay",
        tone: "navy",
      },
      {
        href: "/help/track-your-order",
        Icon: Truck,
        title: "Track your order",
        blurb:
          "Look up any order by reference and email and watch its delivery status.",
        keywords: "track shipping delivery status reference where is my order",
        tone: "gold",
      },
      {
        href: "/help/save-to-wishlist",
        Icon: Heart,
        title: "Save favorites & reorder",
        blurb:
          "Save products to your wishlist and reorder past purchases in one tap.",
        keywords: "wishlist save favorite reorder repeat buy again heart",
        tone: "navy",
      },
      {
        href: "/help/returns-and-refunds",
        Icon: RotateCcw,
        title: "Returns, exchanges & refunds",
        blurb:
          "Start a return and use the 60-day comfort guarantee on your mask.",
        keywords: "return refund exchange comfort guarantee money back",
        tone: "navy",
      },
    ],
  },
  {
    id: "account",
    eyebrow: "Your account",
    title: "Your Account",
    caption: "Sign in, save your details, and manage billing in one place.",
    topics: [
      {
        href: "/help/create-an-account",
        Icon: UserCircle,
        title: "Create an account & sign in",
        blurb:
          "Set up a free account to save addresses and reorder in one tap.",
        keywords: "account sign in sign up register password login profile",
        tone: "gold",
      },
      {
        href: "/help/reset-password",
        Icon: KeyRound,
        title: "Reset your password",
        blurb: "Locked out? Get a secure reset link and choose a new password.",
        keywords: "password reset forgot locked out sign in login recover",
        tone: "navy",
      },
      {
        href: "/help/resupply-reminders",
        Icon: BellRing,
        title: "Set up resupply reminders",
        blurb:
          "Choose how we remind you when cushions, filters, and tubing are due.",
        keywords: "reminders resupply replacement schedule sms email notify",
        tone: "navy",
      },
    ],
  },
  {
    id: "insurance",
    eyebrow: "Coverage",
    title: "Insurance & Costs",
    caption:
      "Estimate what you'll pay and understand how prescriptions are handled.",
    topics: [
      {
        href: "/help/insurance-estimate",
        Icon: ShieldCheck,
        title: "Get an insurance estimate",
        blurb:
          "Enter your plan and see your projected out-of-pocket cost in seconds.",
        keywords:
          "insurance estimate cost out of pocket medicare coverage deductible price",
        tone: "gold",
      },
    ],
  },
];

const allTopics: HelpTopic[] = categories.flatMap((c) => c.topics);

const tones = {
  navy: "icon-halo-navy",
  gold: "icon-halo-gold",
} as const;

function TopicCard({ topic }: { topic: HelpTopic }) {
  const { href, Icon, title, blurb, tone } = topic;
  return (
    <Link
      href={href}
      className="glass-card lift-on-hover rounded-2xl p-5 flex items-start gap-4 group"
      data-testid={`help-topic-${href.split("/").pop()}`}
    >
      <div
        className={`shrink-0 h-11 w-11 rounded-xl ${tones[tone]} flex items-center justify-center`}
      >
        <Icon className="w-5 h-5" />
      </div>
      <div className="space-y-1 flex-1 min-w-0">
        <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
          {title}
        </h3>
        <p className="text-sm text-muted-foreground leading-relaxed">{blurb}</p>
      </div>
      <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1 shrink-0" />
    </Link>
  );
}

export function Help() {
  useDocumentTitle(
    "Help Center",
    "Step-by-step guides for every PennPaps feature: the Virtual Mask Fitter, ordering, the supply shop, order tracking, accounts, resupply reminders, insurance estimates, and returns.",
  );
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;

  const matches = useMemo(() => {
    const q = trimmed.toLowerCase();
    if (!q) return [];
    return allTopics.filter((t) =>
      `${t.title} ${t.blurb} ${t.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [trimmed]);

  useSearchShortcut({
    ref: searchRef,
    onClear: () => setQuery(""),
  });

  return (
    <div className="container max-w-5xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <LifeBuoy className="w-4 h-4" />
            <span>PennPaps Help Center</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              How everything works
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          How can we help?
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Short, screenshot-by-screenshot guides for every part of PennPaps —
          the Virtual Mask Fitter, ordering and checkout, tracking, your
          account, resupply reminders, insurance estimates, and returns.
        </p>

        {/* Search */}
        <div className="max-w-xl mx-auto pt-2">
          <div className="relative">
            <Search
              className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none"
              aria-hidden="true"
            />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search help — try “track order”, “insurance”, “reminders”…"
              aria-label="Search the Help Center"
              className="pl-9 pr-20 h-11 bg-white"
              data-testid="help-search-input"
            />
            {isSearching ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                aria-label="Clear search"
                data-testid="help-search-clear"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <kbd
                aria-hidden="true"
                className="hidden sm:inline-flex absolute right-2 top-1/2 -translate-y-1/2 items-center justify-center h-6 min-w-6 px-1.5 rounded border border-border/60 bg-secondary/40 text-[11px] font-mono font-semibold text-muted-foreground"
                title="Press / to search"
              >
                /
              </kbd>
            )}
          </div>
          {isSearching ? (
            <p
              className="mt-2 text-xs text-muted-foreground tabular-nums text-left"
              aria-live="polite"
              data-testid="help-search-result-count"
            >
              {matches.length === 0
                ? `No guides match “${trimmed}”.`
                : `${matches.length} ${
                    matches.length === 1 ? "guide" : "guides"
                  } match “${trimmed}”.`}
            </p>
          ) : null}
        </div>
      </header>

      {/* Search results */}
      {isSearching ? (
        <section
          aria-label="Search results"
          className="space-y-3"
          data-testid="help-search-results"
        >
          {matches.length === 0 ? (
            <div className="glass-card rounded-2xl p-6 text-center space-y-3">
              <div className="mx-auto h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center">
                <Search className="w-4 h-4" />
              </div>
              <h2 className="text-base font-semibold">No matching guides</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Try a different keyword, ask{" "}
                <strong className="text-[hsl(var(--penn-navy))]">
                  PennBot
                </strong>{" "}
                in the chat bubble, or{" "}
                <Link
                  href="/faq"
                  className="text-primary underline underline-offset-2"
                >
                  browse the FAQ
                </Link>
                .
              </p>
            </div>
          ) : (
            <div className="grid sm:grid-cols-2 gap-3">
              {matches.map((topic) => (
                <TopicCard key={topic.href} topic={topic} />
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
          {/* Popular shortcuts */}
          <section
            aria-label="Popular guides"
            className="grid grid-cols-2 lg:grid-cols-4 gap-4"
          >
            {[
              {
                href: "/help/find-your-mask",
                Icon: ScanFace,
                label: "Find your mask",
              },
              {
                href: "/help/track-your-order",
                Icon: Truck,
                label: "Track an order",
              },
              {
                href: "/help/resupply-reminders",
                Icon: BellRing,
                label: "Resupply reminders",
              },
              {
                href: "/help/insurance-estimate",
                Icon: ShieldCheck,
                label: "Insurance estimate",
              },
            ].map(({ href, Icon, label }) => (
              <Link
                key={href}
                href={href}
                className="glass-card-tech lift-on-hover rounded-2xl p-5 relative overflow-hidden flex flex-col items-start gap-3 group"
                data-testid={`help-popular-${href.split("/").pop()}`}
              >
                <span className="scan-line" aria-hidden="true" />
                <div className="relative z-10 flex flex-col gap-3">
                  <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                    <Icon className="w-5 h-5" />
                  </div>
                  <span className="text-sm font-bold tracking-tight group-hover:text-primary transition-colors">
                    {label}
                  </span>
                </div>
              </Link>
            ))}
          </section>

          {/* Categories */}
          {categories.map((cat) => (
            <section
              key={cat.id}
              id={cat.id}
              className="space-y-5 scroll-mt-24"
              data-testid={`help-category-${cat.id}`}
            >
              <div className="space-y-1.5">
                <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[hsl(var(--penn-gold))]">
                  {cat.eyebrow}
                </span>
                <h2 className="text-display text-2xl md:text-3xl font-bold tracking-tight text-primary">
                  {cat.title}
                </h2>
                <p className="text-sm md:text-base text-muted-foreground max-w-2xl leading-relaxed">
                  {cat.caption}
                </p>
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                {cat.topics.map((topic) => (
                  <TopicCard key={topic.href} topic={topic} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {/* Cross-links to FAQ / Learn */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/faq"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="help-link-faq"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <HelpCircle className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Browse the FAQ
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Quick answers about CPAP therapy, masks, cleaning, and
              troubleshooting.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/learn"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="help-link-learn"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Sparkles className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Read the Learn library
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Plain-language guides on sleep apnea, therapy, and living with
              CPAP.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </section>

      {/* Contact CTA */}
      <section className="text-center space-y-4 pt-2">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          Can&apos;t find it? Just ask.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          PennBot answers most questions instantly, and our care team is a phone
          call away for anything that needs a human.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Button
            type="button"
            size="lg"
            onClick={() => openPennBot()}
            className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow gap-2"
            data-testid="help-cta-pennbot"
          >
            <Sparkles className="w-4 h-4" />
            Ask PennBot
          </Button>
          <a href={`tel:${SUPPORT_PHONE_E164}`}>
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full glass-panel border-border/60 gap-2"
            >
              <PhoneCall className="w-4 h-4" />
              {SUPPORT_PHONE_DISPLAY}
            </Button>
          </a>
        </div>
      </section>
    </div>
  );
}
