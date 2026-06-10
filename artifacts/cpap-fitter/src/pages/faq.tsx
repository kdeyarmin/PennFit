import React, { useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useDocumentMeta } from "@/hooks/use-document-meta";
import { useSearchShortcut } from "@/hooks/use-search-shortcut";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  HelpCircle,
  Sparkles,
  Wind,
  Glasses,
  Receipt,
  Droplets,
  Wrench,
  PhoneCall,
  ArrowRight,
  Search,
  X,
} from "lucide-react";
import { openPennBot } from "@/lib/chat-events";

type FaqEntry = { q: string; a: React.ReactNode };
type FaqSection = {
  id: string;
  title: string;
  blurb: string;
  Icon: React.ComponentType<{ className?: string }>;
  items: FaqEntry[];
};

const sections: FaqSection[] = [
  {
    id: "cpap-basics",
    title: "CPAP Therapy Basics",
    blurb:
      "What CPAP does, who it's for, and what to expect when you're new to therapy.",
    Icon: Wind,
    items: [
      {
        q: "What is CPAP and how does it work?",
        a: (
          <>
            CPAP stands for Continuous Positive Airway Pressure. A small bedside
            machine sends a steady, gentle stream of pressurized room air
            through a hose and mask, which keeps the soft tissues at the back of
            your throat from collapsing while you sleep. That open airway stops
            the breathing pauses that define obstructive sleep apnea.
          </>
        ),
      },
      {
        q: "How do I know if I need CPAP therapy?",
        a: (
          <>
            CPAP is prescribed by a clinician after a sleep study (in a lab or
            at home) confirms obstructive sleep apnea. If you snore loudly, wake
            gasping for air, fall asleep during the day, or your bed partner has
            noticed you stop breathing, ask your primary care provider about a
            sleep study. PennPaps is for patients who already have a
            prescription — we don't diagnose sleep apnea.
          </>
        ),
      },
      {
        q: "Will CPAP cure my sleep apnea?",
        a: (
          <>
            CPAP doesn't cure sleep apnea, but it manages it very effectively
            for most patients while the mask is worn. Think of it the way you'd
            think of glasses for nearsightedness — it works while you're using
            it. Some patients reduce their need for therapy through weight loss,
            positional changes, or surgery, but those are clinical decisions to
            make with your provider.
          </>
        ),
      },
      {
        q: "How long does it take to get used to CPAP?",
        a: (
          <>
            Most patients adapt within two to four weeks. The first few nights
            often feel strange — slightly claustrophobic, mildly noisy, or like
            too much air. The mask matters more than anything else here:
            switching to a better-fitting mask is the single most common fix for
            early CPAP frustration, which is exactly what PennPaps is built to
            help with.
          </>
        ),
      },
      {
        q: "Is CPAP safe to use every night?",
        a: (
          <>
            Yes. CPAP is a low-risk therapy when used as prescribed. The most
            common side effects are dry mouth, nasal congestion, mask marks, or
            air swallowing — and almost all of them respond to mask adjustments,
            humidifier changes, or pressure tuning by your provider. Severe or
            persistent issues should always be reviewed clinically.
          </>
        ),
      },
    ],
  },
  {
    id: "choosing-a-mask",
    title: "Choosing the Right Mask",
    blurb:
      "How to think about mask styles, fit, and what PennPaps recommends for your face shape.",
    Icon: Glasses,
    items: [
      {
        q: "What are the main types of CPAP masks?",
        a: (
          <>
            There are three broad styles: <strong>nasal pillows</strong> (small
            inserts that sit at the nostrils — minimal contact, great for side
            and stomach sleepers), <strong>nasal masks</strong> (a triangular
            cushion over the nose — a good middle ground), and{" "}
            <strong>full-face masks</strong> (covering nose and mouth — best for
            mouth breathers, higher pressures, or congestion). PennPaps
            considers all three and ranks the best matches for your face and
            sleep style.
          </>
        ),
      },
      {
        q: "How do I know which mask style is right for me?",
        a: (
          <>
            The biggest factors are: do you breathe through your mouth at night,
            what pressure has your provider prescribed, do you sleep on your
            side, and do you have facial hair, claustrophobia, or skin
            sensitivities. The PennPaps questionnaire walks you through all of
            these and weights the recommendations accordingly.
          </>
        ),
      },
      {
        q: "What if my recommended mask doesn't fit comfortably?",
        a: (
          <>
            Mask seal and comfort improve with adjustment — most masks have
            multiple cushion sizes, and the headgear straps need a snug-but-not
            -tight fit. If you've adjusted and it still doesn't seal, contact us
            and we'll exchange it for an alternative within the first 60 days at
            no charge.
          </>
        ),
      },
      {
        q: "Can I use the same mask if my face changes (weight, surgery, age)?",
        a: (
          <>
            Significant weight loss or gain, dental work, or facial surgery can
            change how a mask seals. If your mask suddenly leaks more or feels
            wrong, retake the PennPaps scan — your measurements may have shifted
            enough that a different size or style is now a better match.
          </>
        ),
      },
      {
        q: "Do I need a different mask for travel?",
        a: (
          <>
            Most patients travel with the same mask and a portable CPAP. If you
            travel often, ask about quieter, lighter "travel" CPAP units and a
            second mask kit so you don't have to disassemble your home setup.
            Our team can help you put a second mask on order between
            replacements.
          </>
        ),
      },
    ],
  },
  {
    id: "ordering-insurance",
    title: "Ordering, Insurance & Prescriptions",
    blurb:
      "How orders work, what insurance covers, and how prescriptions are handled.",
    Icon: Receipt,
    items: [
      {
        q: "Do I need a prescription to order a CPAP mask?",
        a: (
          <>
            Yes — CPAP masks are FDA-classified prescription medical devices. On
            the order form, you can either confirm we have an existing
            prescription on file for you, or we'll reach out to your sleep
            provider directly to coordinate one. We won't ship without a valid
            prescription.
          </>
        ),
      },
      {
        q: "Will my insurance cover a new mask?",
        a: (
          <>
            Most US insurance plans (Medicare, Medicaid, and most commercial
            insurers) cover CPAP supplies on a regular replacement schedule —
            typically a new mask every three months and replacement cushions and
            headgear monthly. PennPaps will verify your coverage and let you
            know your out-of-pocket cost before shipping.
          </>
        ),
      },
      {
        q: "How long does an order take to arrive?",
        a: (
          <>
            Standard orders ship within 1–3 business days once your prescription
            and insurance are verified. You'll get a tracking number by email.
            Expedited shipping is available on request.
          </>
        ),
      },
      {
        q: "Can I order replacement supplies through PennPaps?",
        a: (
          <>
            Yes, two ways. (1) <strong>Resupply program</strong> — once you're
            an established patient, we'll reach out by SMS, email, or phone when
            you're due for new cushions, headgear, filters, and tubing, and bill
            insurance on the standard replacement schedule. (2){" "}
            <strong>Shop direct</strong> — you can also browse and order
            supplies any time at the{" "}
            <Link
              href="/shop"
              className="text-primary underline-offset-4 hover:underline"
            >
              PennPaps shop
            </Link>{" "}
            on a cash-pay basis (no prescription needed for most consumables
            like filters, tubing, and humidifier chambers). You don't need to
            re-run the fitter for resupply unless your fit has changed.
          </>
        ),
      },
      {
        q: "Do I need a PennPaps account to place an order?",
        a: (
          <>
            No — you can check out as a guest. Creating a free{" "}
            <Link
              href="/account"
              className="text-primary underline-offset-4 hover:underline"
            >
              account
            </Link>{" "}
            simply saves your shipping address and order history so future
            orders are quicker, and gives you a "Reorder" button on past
            purchases. Your account info is used only to fulfill your orders,
            never sold to third parties.
          </>
        ),
      },
      {
        q: "What if my insurance changes?",
        a: (
          <>
            Let our team know as soon as your insurance changes. We'll re-verify
            coverage with the new plan before your next order so there are no
            surprise charges. If a plan change disrupts coverage, we'll discuss
            cash-pay options.
          </>
        ),
      },
    ],
  },
  {
    id: "daily-use",
    title: "Daily Use, Cleaning & Replacement",
    blurb:
      "How to care for your mask and machine so they keep working — and stay sanitary.",
    Icon: Droplets,
    items: [
      {
        q: "How often should I clean my mask?",
        a: (
          <>
            Wipe the cushion <strong>daily</strong> with a damp cloth and mild
            soap (skip alcohol wipes — they degrade the silicone). Wash the
            headgear, frame, and tubing <strong>weekly</strong> in warm soapy
            water and let everything air dry out of direct sunlight. Avoid
            dishwashers, harsh detergents, and bleach.
          </>
        ),
      },
      {
        q: "When should I replace cushions, headgear, and tubing?",
        a: (
          <>
            A common schedule is: <strong>cushions every 2–4 weeks</strong>{" "}
            (silicone slowly degrades and stops sealing well),{" "}
            <strong>headgear every 6 months</strong> (elastic stretches),{" "}
            <strong>tubing every 3 months</strong>, and{" "}
            <strong>filters monthly</strong>. Insurance typically covers this
            cadence — PennPaps's resupply program tracks it for you
            automatically.
          </>
        ),
      },
      {
        q: "What about cleaning my CPAP machine?",
        a: (
          <>
            Empty and rinse the humidifier chamber daily, refill with{" "}
            <strong>distilled water only</strong> (tap water leaves mineral
            deposits and breeds bacteria), and wash the chamber in warm soapy
            water weekly. Wipe the machine exterior with a slightly damp cloth —
            never spray cleaner directly on the device.
          </>
        ),
      },
      {
        q: "Are CPAP cleaning machines (UV / ozone) worth it?",
        a: (
          <>
            The FDA has{" "}
            <strong>cautioned against ozone-based CPAP cleaners</strong> — they
            can damage the mask materials and leave irritating ozone residue.
            Soap and water remains the manufacturer-recommended cleaning method.
            If you want to disinfect periodically, ask us about CPAP-safe wipes.
          </>
        ),
      },
      {
        q: "What if my mask leaves marks on my face?",
        a: (
          <>
            Mask marks usually mean the headgear is too tight or the cushion is
            the wrong size. Loosen the straps until you hear a slight leak, then
            tighten in tiny increments until it stops. If marks persist, it's a
            fit issue — retake the PennPaps scan or contact us for an exchange.
          </>
        ),
      },
    ],
  },
  {
    id: "troubleshooting",
    title: "Troubleshooting Common Issues",
    blurb:
      "Quick fixes for the most common CPAP complaints — and when to call us instead.",
    Icon: Wrench,
    items: [
      {
        q: "My mask is leaking air. What do I do?",
        a: (
          <>
            Most leaks come from one of three things: the cushion is the wrong
            size, the headgear is uneven (one side tighter than the other), or
            the cushion is past its replacement date. Try a fresh cushion first,
            re-seat the mask with both straps balanced, and lie down (not sit)
            when re-checking the seal — masks that seal sitting up often leak
            when you move at night.
          </>
        ),
      },
      {
        q: "I wake up with a dry mouth or stuffy nose.",
        a: (
          <>
            Dry mouth almost always means you're mouth-breathing at night — a
            chin strap or switching from a nasal mask to a full-face mask
            usually solves it. A stuffy nose often responds to turning up the
            heated humidifier, using a saline nasal rinse before bed, or adding
            a heated tubing accessory if you don't already have one.
          </>
        ),
      },
      {
        q: "My CPAP is too loud.",
        a: (
          <>
            Modern CPAPs are quiet — ~26–30 decibels (a whisper). If yours
            sounds louder, check that the air filter isn't clogged, the tubing
            isn't kinked, and the mask isn't whistling from a leak. If the
            machine itself is loud, it may need service — contact us.
          </>
        ),
      },
      {
        q: "I feel like I can't exhale against the pressure.",
        a: (
          <>
            That feeling usually fades within the first week, but if it
            persists, ask your provider about <strong>EPR</strong> (Expiratory
            Pressure Relief) or a switch to a <strong>BiPAP</strong> machine,
            which uses a lower pressure on exhale. These are clinical changes
            that need a prescription update.
          </>
        ),
      },
      {
        q: "I keep taking the mask off in my sleep without remembering.",
        a: (
          <>
            This is almost always a comfort issue — the mask is too tight, the
            cushion is wrong, or the pressure feels too high. Don't push through
            it. Retake the PennPaps scan and contact us; we'll help you switch
            to a better-tolerated style at no extra charge during your first 30
            days.
          </>
        ),
      },
      {
        q: "When should I stop and call PennPaps?",
        a: (
          <>
            Stop using the mask and contact us if you develop persistent skin
            breakdown, an allergic reaction, severe ear pain, or you suspect the
            device itself is malfunctioning. For a sudden change in how your
            sleep apnea feels (much more daytime sleepiness, choking episodes
            returning), contact your sleep provider — that's a therapy issue,
            not a supply issue.
          </>
        ),
      },
    ],
  },
];

/**
 * Walk a React node tree and return its plain-text content.
 * Used by the FAQ search to make answer copy searchable without
 * forcing each entry to ship a parallel `searchText` string.
 * Strings + numbers are stringified, fragments + elements recurse,
 * everything else is dropped (e.g. icons, booleans).
 */
function nodeToText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean")
    return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeToText).join(" ");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return nodeToText(node.props.children);
  }
  return "";
}

interface FaqMatch {
  sectionId: string;
  sectionTitle: string;
  Icon: React.ComponentType<{ className?: string }>;
  index: number;
  q: string;
  a: React.ReactNode;
}

function filterFaqs(query: string): FaqMatch[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];
  const out: FaqMatch[] = [];
  for (const section of sections) {
    section.items.forEach((item, index) => {
      const haystack = `${item.q} ${nodeToText(item.a)}`.toLowerCase();
      if (haystack.includes(q)) {
        out.push({
          sectionId: section.id,
          sectionTitle: section.title,
          Icon: section.Icon,
          index,
          q: item.q,
          a: item.a,
        });
      }
    });
  }
  return out;
}

export function Faq() {
  useDocumentTitle(
    "Frequently asked questions",
    "Answers about CPAP fitting, supplies, prescriptions, insurance, and resupply from Penn Home Medical Supply.",
  );
  useDocumentMeta({
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: sections.flatMap((s) =>
        s.items.map((item) => ({
          "@type": "Question",
          name: item.q,
          acceptedAnswer: {
            "@type": "Answer",
            text: nodeToText(item.a),
          },
        })),
      ),
    },
  });
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();
  const isSearching = trimmed.length > 0;
  // Memoize so a parent re-render (e.g. document title effect) doesn't
  // re-walk every Q&A node tree on each render. Cheap to compute, but
  // the search runs on every keystroke — keep it tight.
  const matches = useMemo(() => filterFaqs(query), [query]);

  // Press "/" anywhere on the page to jump focus into the FAQ
  // search, mirroring the convention used by Slack, GitHub, Discord,
  // et al. The hook ignores the keypress when the user is already
  // typing in another input. Esc inside the input clears it and
  // exits the search-results view in one keystroke.
  useSearchShortcut({
    ref: searchRef,
    onClear: () => setQuery(""),
  });

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <HelpCircle className="w-4 h-4" />
            <span>Answers from PennPaps</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Frequently Asked Questions
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          CPAP Questions, Answered
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Honest, jargon-free answers to the questions our patients ask most —
          covering CPAP basics, choosing a mask, ordering, daily care, and
          common troubleshooting.
        </p>

        {/*
          Inline FAQ search. Filters across every Q&A's question text
          AND its rendered answer body — the answer copy is the long
          tail of useful keyword matches (e.g. "humidifier", "leak",
          "Medicare"). When the input has a non-empty query the
          section index + per-section accordions hide and a flat
          results list takes their place. Empty input restores the
          original grouped layout. Press "/" anywhere on the page to
          jump focus into the input.
        */}
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
              placeholder="Search the FAQ — try “mask leak”, “Medicare”, “cleaning”…"
              aria-label="Search frequently asked questions"
              className="pl-9 pr-20 h-11 bg-white"
              data-testid="faq-search-input"
            />
            {isSearching ? (
              <button
                type="button"
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors"
                aria-label="Clear FAQ search"
                data-testid="faq-search-clear"
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
          {isSearching && (
            <p
              className="mt-2 text-xs text-muted-foreground tabular-nums text-left"
              aria-live="polite"
              data-testid="faq-search-result-count"
            >
              {matches.length === 0
                ? `No matches for “${trimmed}”.`
                : `${matches.length} ${
                    matches.length === 1 ? "match" : "matches"
                  } for “${trimmed}”.`}
            </p>
          )}
          <div className="mt-3 flex items-center justify-center gap-2 text-xs text-muted-foreground">
            <span>Or</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                openPennBot({
                  prefill: trimmed.length > 0 ? trimmed : undefined,
                })
              }
              className="rounded-full gap-1.5 h-7 px-2.5"
              data-testid="faq-ask-pennbot"
            >
              <Sparkles className="w-3 h-3" />
              Ask PennBot
            </Button>
            <span className="hidden sm:inline">— typed answers in seconds</span>
          </div>
        </div>
      </header>

      {/* Section index — quick jump links. Hidden during a search so
          the results take centre stage. */}
      <nav
        aria-label="FAQ sections"
        hidden={isSearching}
        className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3"
      >
        {sections.map(({ id, title, Icon }) => (
          <a
            key={id}
            href={`#${id}`}
            className="glass-card lift-on-hover rounded-xl px-4 py-3 flex items-center gap-3 group"
            data-testid={`faq-section-link-${id}`}
          >
            <div className="h-9 w-9 rounded-lg icon-halo-navy flex items-center justify-center shrink-0">
              <Icon className="w-4 h-4" />
            </div>
            <span className="text-sm font-semibold tracking-tight text-foreground group-hover:text-primary transition-colors">
              {title}
            </span>
          </a>
        ))}
      </nav>

      {/* Search results — flat list across every section. We render
          each match as its own collapsed Accordion (rather than one
          Accordion with many items) because matches from different
          sections shouldn't share single-open behaviour, and a per-
          match Accordion lets us label every result with its source
          section without a custom expander. */}
      {isSearching && (
        <section
          aria-label="FAQ search results"
          className="space-y-3"
          data-testid="faq-search-results"
        >
          {matches.length === 0 ? (
            <div
              className="glass-card rounded-2xl p-6 text-center space-y-3"
              data-testid="faq-search-empty"
            >
              <div className="mx-auto h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center text-[hsl(var(--penn-navy))]">
                <Search className="w-4 h-4" />
              </div>
              <h2 className="text-base font-semibold">No matching answers</h2>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                Try a different keyword, ask{" "}
                <strong className="text-[hsl(var(--penn-navy))]">
                  PennBot
                </strong>{" "}
                in the chat bubble (bottom-right), or{" "}
                <Link
                  href="/learn"
                  className="text-primary underline underline-offset-2"
                >
                  browse the Learn library
                </Link>{" "}
                for longer-form guides.
              </p>
            </div>
          ) : (
            matches.map(({ sectionId, sectionTitle, Icon, index, q, a }) => (
              <div
                key={`${sectionId}-${index}`}
                className="glass-card rounded-2xl p-2 sm:p-4"
                data-testid={`faq-search-match-${sectionId}-${index}`}
              >
                <div className="px-2 pt-2 pb-1 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  <Icon className="w-3.5 h-3.5 text-[hsl(var(--penn-navy))]/70" />
                  {sectionTitle}
                </div>
                <Accordion type="single" collapsible className="w-full">
                  <AccordionItem
                    value={`${sectionId}-${index}`}
                    className="border-border/50 last:border-b-0"
                  >
                    <AccordionTrigger
                      className="text-left text-base font-semibold hover:no-underline hover:text-primary px-2"
                      data-testid={`faq-search-trigger-${sectionId}-${index}`}
                    >
                      {q}
                    </AccordionTrigger>
                    <AccordionContent className="text-muted-foreground leading-relaxed text-sm px-2 pb-4">
                      {a}
                    </AccordionContent>
                  </AccordionItem>
                </Accordion>
              </div>
            ))
          )}
        </section>
      )}

      {/* Sections — full grouped layout. Hidden during search so the
          flat results list takes the page. */}
      {!isSearching &&
        sections.map(({ id, title, blurb, Icon, items }) => (
          <section key={id} id={id} className="space-y-4 scroll-mt-24">
            <div className="flex items-start gap-4">
              <div className="h-12 w-12 rounded-2xl icon-halo-navy flex items-center justify-center shrink-0">
                <Icon className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold tracking-tight">
                  {title}
                </h2>
                <p className="text-muted-foreground">{blurb}</p>
              </div>
            </div>
            <div className="glass-card rounded-2xl p-2 sm:p-4">
              <Accordion type="single" collapsible className="w-full">
                {items.map(({ q, a }, idx) => (
                  <AccordionItem
                    key={q}
                    value={`${id}-${idx}`}
                    className="border-border/50 last:border-b-0"
                  >
                    <AccordionTrigger
                      className="text-left text-base font-semibold hover:no-underline hover:text-primary px-2"
                      data-testid={`faq-trigger-${id}-${idx}`}
                    >
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
        ))}

      {/* Still have questions */}
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
          <div className="p-6 sm:p-8 flex flex-col sm:flex-row gap-5 items-start relative">
            <div className="shrink-0 h-12 w-12 rounded-xl icon-halo-gold flex items-center justify-center">
              <PhoneCall className="w-5 h-5" />
            </div>
            <div className="space-y-2 flex-1">
              <h3 className="text-xl font-semibold tracking-tight">
                Still have questions?
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                PennPaps's care team is available to help with clinical fit,
                insurance, prescriptions, and resupply timing. Anything you
                don't see here, we're happy to answer one-on-one.
              </p>
              <div className="flex flex-wrap gap-3 pt-2">
                <Link href="/learn">
                  <Button
                    variant="outline"
                    className="rounded-full glass-panel border-border/60 gap-2"
                  >
                    Browse educational resources
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
                <Link href="/how-it-works">
                  <Button
                    variant="ghost"
                    className="rounded-full text-muted-foreground hover:text-primary gap-2"
                  >
                    See how PennPaps works
                  </Button>
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4 pt-2">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          Ready when you are.
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          Get fitted for a new mask in about three minutes (your photo never
          leaves your device), or shop CPAP supplies direct.
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
