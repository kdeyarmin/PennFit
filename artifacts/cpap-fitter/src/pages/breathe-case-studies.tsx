import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  FileText,
  FlaskConical,
  LineChart,
  Receipt,
  RefreshCw,
  Stethoscope,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";

/**
 * Breathe — Case studies.
 *
 * Two honest halves:
 *  1. INDUSTRY case studies — how AI is applied across the DME workflow
 *     (resupply, revenue cycle, therapy monitoring), grounded in published
 *     industry benchmarks. Each card cites the benchmark it leans on rather
 *     than inventing a customer or a number.
 *  2. A CareMetric Breathe case study that is **explicitly an illustrative,
 *     modeled scenario** — NOT a real customer. CareMetric Breathe is newly
 *     launched; rather than fabricate a logo/quote/metric, this models what a
 *     representative provider can expect from the same benchmarks, and points
 *     to the ROI calculator so a reader can size it on their own numbers.
 *
 * Reuses `breathe.tsx`'s exported `BreatheShell` (nav + footer + demo/contact
 * gates), `PageHead`, and `ClosingCta`, plus the namespaced `.bx-*` design
 * system — so it stays consistent with the rest of /breathe and inherits the
 * apex-gated `noindex` behavior.
 */

type IndustryStudy = {
  icon: ReactNode;
  domain: string;
  title: string;
  situation: string;
  approach: string;
  points: string[];
  source: string;
  gold?: boolean;
};

const INDUSTRY_STUDIES: IndustryStudy[] = [
  {
    icon: <RefreshCw size={20} />,
    domain: "Resupply automation",
    title: "Turning refills into recurring revenue",
    situation:
      "Reactive resupply — waiting for patients to call — captures only about one in five eligible reorders, so the most predictable revenue in DME quietly leaks away.",
    approach:
      "AI reads each patient's eligibility and reorder window, then reaches out on the right channel at the right moment — SMS, email, and a natural-voice AI agent that can confirm and place the reorder 24/7.",
    points: [
      "Eligibility-aware outreach replaces manual call lists",
      "AI voice agents handle routine reorder calls around the clock",
      "One-tap reorder links collapse the order into a single step",
    ],
    source:
      "Industry benchmark: proactive / managed resupply lifts reorder rates from ~20% (reactive) to ~45–50% — roughly 2.5× the capture.",
  },
  {
    icon: <Receipt size={20} />,
    domain: "Revenue cycle · AI",
    title: "Getting paid the first time",
    situation:
      "Initial claim denials average roughly 11–12%, and every reworked claim costs an estimated $25–$118 in staff time — a tax on revenue that scales with volume.",
    approach:
      "AI scrubs each 837P for missing modifiers and documentation before it's filed, runs real-time 270/271 eligibility, and ranks the denials that do happen by recoverable dollars × win-probability.",
    points: [
      "Pre-submission scrubbing pushes first-pass acceptance toward best practice",
      "Real-time eligibility stops claims going out against lapsed coverage",
      "Denial worklists focus staff on the dollars worth chasing",
    ],
    source:
      "Industry benchmark: best-practice first-pass clean-claim rate is 95%+; AI eligibility + scrubbing materially cut the ~11.8% average initial-denial rate.",
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    domain: "Therapy monitoring",
    title: "Keeping patients on therapy",
    situation:
      "About one in three CPAP patients drifts out of adherence, and Medicare requires documented usage (4 hours a night on 21 of 30 days in the first 90) to keep paying — so a silent patient is both a clinical and a billing risk.",
    approach:
      "AI pulls adherence nightly from the device clouds (ResMed, Philips, 3B), normalizes it into one fleet view, and surfaces at-risk patients on a worklist before they quit — with the CMS documentation captured automatically.",
    points: [
      "One adherence worklist across every device cloud",
      "Early-warning flags reach patients before they fall off",
      "CMS 4-hour / 90-day proof documented without manual chart work",
    ],
    source:
      "Industry benchmark: proactive monitoring raises CPAP compliance from the ~50% national average toward ~85%.",
  },
];

function IndustryStudies() {
  return (
    <section className="bx-section" id="industry">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <FileText size={13} /> AI in DME
          </span>
          <h2 className="bx-h2">
            Where AI is already changing the DME workflow
          </h2>
          <p className="bx-lede">
            Three places AI is reshaping durable medical equipment operations —
            each grounded in published industry benchmarks, not invented
            numbers. This is the playbook CareMetric Breathe is built on.
          </p>
        </div>
        <div className="bx-caps">
          {INDUSTRY_STUDIES.map((s) => (
            <article
              className={`bx-cap bx-cs-card bx-reveal${s.gold ? " gold" : ""}`}
              key={s.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{s.icon}</span>
                <div>
                  <span className="bx-cap-tag">{s.domain}</span>
                  <h3>{s.title}</h3>
                </div>
              </div>
              <p className="bx-cap-summary">{s.situation}</p>
              <p className="bx-cap-summary">{s.approach}</p>
              <ul className="bx-cap-list">
                {s.points.map((p) => (
                  <li key={p}>
                    <BadgeCheck size={14} />
                    {p}
                  </li>
                ))}
              </ul>
              <p className="bx-outcome-source">{s.source}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* The modeled CareMetric Breathe scenario. Every figure is a benchmark-based
   projection, labeled as such — not a measured customer result. */
const MODELED: { num: string; label: string; basis: string; gold?: boolean }[] =
  [
    {
      num: "2.5×",
      label: "more resupply orders captured",
      basis: "≈20% reactive → ~50% managed order rate",
    },
    {
      num: "94%",
      label: "first-pass clean-claim rate",
      basis: "from a ~80% typical baseline toward the 95%+ best practice",
      gold: true,
    },
    {
      num: "9+ hrs",
      label: "back per teammate, each week",
      basis: "automation of resupply outreach, scrubbing & posting",
    },
    {
      num: "7 → 1",
      label: "point tools collapsed into one login",
      basis: "resupply, RCM, CRM, telehealth, e-sign, dashboards, IVR",
    },
  ];

function BreatheModeled() {
  return (
    <section className="bx-section" id="breathe-case">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <FlaskConical size={13} /> CareMetric Breathe · illustrative
          </span>
          <h2 className="bx-h2">What it looks like on Breathe</h2>
          <p className="bx-lede">
            CareMetric Breathe runs that entire playbook on one record. Here's a
            modeled look at what it adds up to for a representative provider.
          </p>
        </div>

        <p className="bx-cs-note bx-reveal">
          <FlaskConical size={15} aria-hidden="true" />
          <span>
            <b>Illustrative scenario — not an actual customer.</b> CareMetric
            Breathe is newly launched, so rather than invent a logo, quote, or
            result, the figures below are modeled from the published industry
            benchmarks above and our ROI methodology. Size them on your own
            numbers with the <Link href="/breathe/roi">ROI calculator</Link>.
          </span>
        </p>

        <div className="bx-cs-profile bx-reveal">
          <b>The model</b> — an independent CPAP &amp; DME provider with ~2,500
          active patients and a 6-person team, replacing seven disconnected
          tools with one platform.
        </div>

        <div className="bx-stats bx-reveal">
          {MODELED.map((m) => (
            <div className="bx-stat" key={m.label}>
              <div className={`bx-stat-num${m.gold ? " gold" : ""}`}>
                {m.num}
              </div>
              <div className="bx-stat-label">{m.label}</div>
              <div className="bx-cs-basis">Modeled: {m.basis}</div>
            </div>
          ))}
        </div>

        <p className="bx-stats-note bx-reveal">
          Directional projections, not a guarantee.{" "}
          <Link href="/breathe/roi">Run it on your own numbers →</Link>
        </p>

        <div className="bx-cs-cta bx-reveal">
          <Link className="bx-btn bx-btn-primary" href="/breathe/roi">
            Size the return <LineChart size={16} />
          </Link>
          <Link className="bx-btn bx-btn-ghost" href="/breathe/product">
            See the platform <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function BreatheCaseStudies() {
  useDocumentTitle(
    "Case studies — AI in DME & CareMetric Breathe | Breathe by CareMetric.ai",
    "How AI is reshaping durable medical equipment operations — resupply automation, AI-driven revenue cycle, and therapy-adherence monitoring — grounded in industry benchmarks, plus an illustrative model of the results on CareMetric Breathe.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={FileText}
        eyebrow="Case studies"
        title={
          <>
            AI in DME, <span className="grad-em">in practice.</span>
          </>
        }
        sub="The evidence behind AI-native DME software — sourced industry benchmarks for resupply, revenue cycle, and therapy monitoring — and an illustrative model of what they add up to on CareMetric Breathe."
      />
      <IndustryStudies />
      <BreatheModeled />
      <ClosingCta />
    </BreatheShell>
  );
}

export default BreatheCaseStudies;
