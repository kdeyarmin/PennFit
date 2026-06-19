import { Link } from "wouter";
import {
  Activity,
  ArrowRight,
  BookOpen,
  BrainCircuit,
  FileStack,
  Layers,
  PhoneCall,
  Receipt,
  RefreshCw,
  Sparkles,
  Stethoscope,
  Users,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  BreatheShell,
  CapCard,
  type Capability,
  ClosingCta,
  PageHead,
} from "./breathe";
import "./breathe.css";

/**
 * Breathe — DME Platform 101.
 *
 * Category education for the prospect who doesn't yet know software like this
 * exists. It defines the category in plain language, tallies what running a
 * DME on fragmented point tools quietly costs, shows what one native platform
 * changes, names who it's for, and demystifies the jargon. The goal is to
 * teach the buyer the category — not to pitch features (that's the rest of
 * the site).
 *
 * Reuses the namespaced `breathe.css` design system and the shared chrome /
 * capability card exported from `breathe.tsx`. Rendered outside the patient
 * <Layout>, lazy-loaded, `noindex` (via <BreatheShell/>).
 */

/* ───────────────── What it is ───────────────── */
function CategoryIntro() {
  return (
    <section className="bx-section" id="category">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The category
          </span>
          <h2 className="bx-h2">What is a DME operating platform?</h2>
        </div>
        <div className="bx-learn-lead bx-reveal">
          <p>
            A DME operating platform is the single system that runs a
            durable-medical-equipment business end to end — taking in patients,
            verifying coverage, fitting and selling equipment, keeping people on
            therapy, billing the claim, and growing the recurring resupply
            revenue that follows. One login, one patient record, one place where
            the whole operation lives.
          </p>
          <p>
            Most DME companies don&apos;t run one. They run six or seven
            disconnected tools that were never designed to talk to each other —
            and spend real money, every day, moving patients between them by
            hand. If you didn&apos;t know a platform like this existed, that&apos;s
            because the category is new: it was only possible to build once AI
            could do the work the extra staff used to.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── The cost of fragmentation ───────────────── */
const FRAGMENT_COST: Capability[] = [
  {
    icon: <FileStack size={20} />,
    title: "Re-keying & exports",
    summary: "Staff time spent moving data instead of helping patients.",
    points: [
      "The same patient typed into three or four systems",
      "Nightly CSV exports to keep tools in sync",
      "Mistakes introduced at every hand-off",
    ],
  },
  {
    icon: <RefreshCw size={20} />,
    title: "Missed resupply windows",
    summary: "The most predictable revenue in DME, left on the table.",
    points: [
      "Eligibility dates buried in a separate tool",
      "Reorder reminders that never go out on time",
      "Replacement windows that quietly slip",
    ],
    gold: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Preventable denials",
    summary: "Most DME denials are rework, not bad luck.",
    points: [
      "Missing documentation caught after filing",
      "Eligibility checked too late, or not at all",
      "Denials worked from a flat queue, not by value",
    ],
  },
  {
    icon: <Users size={20} />,
    title: "Patients lost between systems",
    summary: "Nobody owns the patient end to end.",
    points: [
      "Therapy data in one place, orders in another",
      "At-risk patients invisible until they quit",
      "No single timeline of what happened, when",
    ],
  },
];

function FragmentedCost() {
  return (
    <section className="bx-section" id="cost">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Layers size={13} /> The hidden cost
          </span>
          <h2 className="bx-h2">What running on point tools really costs</h2>
          <p className="bx-lede">
            Fragmentation isn&apos;t just a software inconvenience. It shows up
            as denied claims, missed resupply revenue, and staff hours that
            never reach a patient — month after month.
          </p>
        </div>
        <div className="bx-caps">
          {FRAGMENT_COST.map((c) => (
            <CapCard c={c} key={c.title} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────── What one platform changes ───────────────── */
const POINT_TOOLS: string[] = [
  "A separate login for every job",
  "CSVs and exports to move a patient between tools",
  "Numbers that never quite agree across systems",
  "At-risk patients spotted late, if at all",
  "Nobody owns the patient end to end",
];

const ONE_PLATFORM: string[] = [
  "One login, one patient record",
  "Intake → resupply → claims on a single timeline",
  "Live numbers the whole team trusts",
  "AI surfaces who's slipping, early",
  "Every workflow reads and writes the same data",
];

function OnePlatformChanges() {
  return (
    <section className="bx-section" id="changes">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> The shift
          </span>
          <h2 className="bx-h2">What one native platform changes</h2>
          <p className="bx-lede">
            The difference isn&apos;t a longer feature list — it&apos;s that
            everything happens on one record, so the work that used to fall
            between tools simply doesn&apos;t fall anymore.
          </p>
        </div>
        <div className="bx-vs bx-reveal">
          <article className="bx-vs-col bx-vs-legacy">
            <header>
              <span className="bx-vs-kicker">On point tools</span>
              <h3>Six or seven systems</h3>
            </header>
            <ul className="bx-vs-list">
              {POINT_TOOLS.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </article>
          <div className="bx-vs-divider" aria-hidden="true">
            <span>vs</span>
          </div>
          <article className="bx-vs-col bx-vs-native">
            <header>
              <span className="bx-vs-kicker">On Breathe</span>
              <h3>One operating platform</h3>
            </header>
            <ul className="bx-vs-list bx-vs-list-good">
              {ONE_PLATFORM.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Who it's for ───────────────── */
const PERSONAS: Capability[] = [
  {
    icon: <Activity size={20} />,
    title: "Owners & operators",
    summary: "Run the business on live signal, not last month's export.",
    points: [
      "One source of truth across the whole operation",
      "Margin, DSO, and growth in real time",
      "Grow resupply without adding headcount",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Billing & RCM",
    summary: "Get paid the first time, faster.",
    points: [
      "Eligibility, scrubbing, submission & posting automated",
      "Denials ranked by recoverable dollars",
      "Prior auth and A/R in the same place",
    ],
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Respiratory therapists",
    summary: "See who's slipping before they quit therapy.",
    points: [
      "One adherence worklist across every device cloud",
      "CMS 90-day cohorts tracked automatically",
      "Telehealth visits with one-tap patient join",
    ],
  },
  {
    icon: <PhoneCall size={20} />,
    title: "Patient coordinators",
    summary: "Spend time on people, not phone trees.",
    points: [
      "AI voice agent fields routine calls 24/7",
      "Every SMS, email & fax in one inbox",
      "Touches auto-logged — no manual notes",
    ],
  },
];

function WhoItsFor() {
  return (
    <section className="bx-section" id="who">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Users size={13} /> Who it&apos;s for
          </span>
          <h2 className="bx-h2">One platform, every seat on the team</h2>
          <p className="bx-lede">
            The same patient record reads differently for each role — but
            it&apos;s the same record, so the whole team is finally looking at
            one truth.
          </p>
        </div>
        <div className="bx-caps">
          {PERSONAS.map((c) => (
            <CapCard c={c} key={c.title} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Glossary ───────────────── */
const GLOSSARY: { term: string; def: string }[] = [
  {
    term: "AHI",
    def: "Apnea-Hypopnea Index — the number of breathing interruptions per hour of sleep. Lower is better; a rising AHI on therapy is an early sign something needs attention.",
  },
  {
    term: "CMS 90/30 rule",
    def: "Medicare's adherence test: a new PAP patient must use the device at least 4 hours a night on at least 21 of any 30 consecutive days in the first 90, or the rental claim is denied.",
  },
  {
    term: "Resupply window",
    def: "The interval after which a patient is eligible for fresh mask cushions, tubing, and filters. Catching it on time is the most predictable recurring revenue in DME.",
  },
  {
    term: "837P",
    def: "The standard electronic professional claim format. Breathe scrubs it clean before it files, so it gets paid the first time.",
  },
  {
    term: "ERA / 835",
    def: "Electronic Remittance Advice — the payer's response showing what was paid and adjusted. Breathe posts it back automatically and reconciles it to the claim.",
  },
  {
    term: "Prior authorization",
    def: "A payer's advance approval before certain equipment ships. Breathe can route it electronically via FHIR (Da Vinci PAS) instead of by fax.",
  },
];

function Glossary() {
  return (
    <section className="bx-section" id="glossary">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BookOpen size={13} /> Plain-language primer
          </span>
          <h2 className="bx-h2">The jargon, demystified</h2>
          <p className="bx-lede">
            A few terms you&apos;ll hear in every DME conversation — and what
            they actually mean for your business.
          </p>
        </div>
        <dl className="bx-glossary bx-reveal">
          {GLOSSARY.map((g) => (
            <div className="bx-glossary-item" key={g.term}>
              <dt className="bx-glossary-term">{g.term}</dt>
              <dd className="bx-glossary-def">{g.def}</dd>
            </div>
          ))}
        </dl>
        <div className="bx-price-cta bx-reveal">
          <span>Ready to see it run the whole operation?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/product">
            Tour the platform <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function BreatheLearn() {
  useDocumentTitle(
    "DME Platform 101 — Breathe by CareMetric.ai",
    "New to all-in-one DME software? Learn what a DME operating platform is, what running on fragmented point tools really costs, and what changes when one native platform runs the whole business.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={BrainCircuit}
        eyebrow="DME Platform 101"
        title={
          <>
            What a DME operating platform{" "}
            <span className="grad-em">actually is.</span>
          </>
        }
        sub="Most DME businesses run on six or seven disconnected tools that were never meant to talk to each other. Here's what that quietly costs — and what changes when one native platform runs the whole operation."
      />
      <CategoryIntro />
      <FragmentedCost />
      <OnePlatformChanges />
      <WhoItsFor />
      <Glossary />
      <ClosingCta />
    </BreatheShell>
  );
}

export default BreatheLearn;
