import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BrainCircuit,
  Check,
  Database,
  GitBranch,
  LineChart,
  MessageSquare,
  Repeat,
  ScanFace,
  ShieldAlert,
  Workflow,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import {
  BreatheShell,
  ClosingCta,
  Comparison,
  Onboarding,
  PageHead,
  WhyDifferent,
} from "./breathe";
import { FitterCompare } from "./breathe-mask-fitting";

/**
 * Breathe — "Switch from <competitor>" landing pages.
 *
 * High-intent migration pages for operators already shopping to leave a
 * legacy DME suite. Each is a thin, honest wrapper around the shared
 * marketing system: a competitor-specific headline + "why teams move" grid,
 * then the SAME Comparison table, WhyDifferent explainer, and Onboarding
 * migration steps the rest of /breathe uses — so the claims stay consistent
 * and sourced (the comparison's own footnote covers "publicly described
 * capabilities… all marks property of their owners").
 *
 * The copy never disparages a named product; it states what changes when you
 * move to an AI-native, single-record platform. Competitor names are used
 * only nominatively (to describe the migration), and the page reuses
 * `BreatheShell` so it inherits the apex-gated `noindex` + canonical/OG
 * behavior automatically.
 *
 * Two variants, because two different products get shopped against us:
 *  - `kind: "platform"` — a legacy DME suite you would MIGRATE off (Brightree,
 *    Bonafide, NikoHealth). Headline is "leave X behind, keep your patients",
 *    and the page renders the platform-level `Comparison`.
 *  - `kind: "fitter"` — a point-solution AI mask fitter that sits BESIDE your
 *    DME suite rather than replacing it (SleepGlad, now the AI-fitting layer
 *    inside VGM Total Sleep Services). "Leave X behind" would be wrong copy:
 *    there is no patient roster to migrate, so the framing is "you already
 *    believe in AI fitting — here is the same moment done deeper, on the
 *    platform that runs the rest of the program." Leads with `FitterCompare`
 *    (imported from the mask-fitting deep-dive, so the fitting claims live in
 *    exactly one place) and then still shows the platform `Comparison` — the
 *    fitting argument first, the "and it runs the rest of the business"
 *    argument second. It also skips `WhyDifferent` / `Onboarding`, which are
 *    migration copy with nothing to migrate here.
 */

type SwitchConfig = {
  slug: string;
  /**
   * Which story this page tells — a platform migration, or a point-solution
   * fitter you are already running alongside a suite. See the module comment.
   */
  kind?: "platform" | "fitter";
  /** The competitor's display name, used nominatively in copy + <title>. */
  name: string;
  /** One-line framing shown in the page sub-header. */
  sub: string;
  /**
   * The competitor-specific "what teams moving from <name> most often want"
   * list. Framed as the SWITCHER's goals (not unverifiable claims about the
   * competitor's product), so each page speaks to that incumbent's audience
   * without disparaging a named product.
   */
  wants: string[];
  /** The honest "what changes when you move" cards. */
  reasons: { icon: ReactNode; title: string; body: string }[];
};

// The four reasons are Breathe's structural strengths, framed as what a
// switching team gains — shared across every competitor page so the message
// stays consistent. Only the headline/sub differ per competitor.
const COMMON_REASONS: SwitchConfig["reasons"] = [
  {
    icon: <BrainCircuit size={20} />,
    title: "AI that's in the product, not an add-on",
    body: "A 24/7 voice agent that books reorders, claim scrubbing that predicts denials, and on-device mask fitting — built in, not licensed as a separate module on top.",
  },
  {
    icon: <Database size={20} />,
    title: "One patient record, end to end",
    body: "Intake, resupply, claims, clinical, and the storefront read and write the same data. No exports, no re-keying between screens, no patients lost between bolted-on tools.",
  },
  {
    icon: <Repeat size={20} />,
    title: "Your data comes with you",
    body: "Move in with a spreadsheet (CSV) and move out the same way. A safe import only fills in blanks and never overwrites what you already have, and you can export on demand — no lock-in, no hostage data.",
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient channels, built in",
    body: "SMS, voice, email, fax, telehealth video, and a branded storefront ship in one platform — not stitched together from a separate telephony vendor and an e-sign tool.",
  },
];

// The fitter variant's reasons. Framed as what a team ALREADY sold on AI
// fitting gains by running it inside the platform — never as a claim about
// what the other product does or doesn't do internally (the comparison table
// carries those, sourced and hedged).
const FITTER_REASONS: SwitchConfig["reasons"] = [
  {
    icon: <ShieldAlert size={20} />,
    title: "Safety filters first, ranks second",
    body: "Contraindications and therapy compatibility remove a mask from consideration before anything is scored, so no stock level, margin, or formulary preference can score its way past them. Magnetic-implant screening covers the household, and offers the magnet-free version of the same mask first.",
  },
  {
    icon: <ScanFace size={20} />,
    title: "The image never leaves the phone",
    body: "Measurement runs in the patient's own browser and only the numbers come back — a claim about how the software is built, not a retention policy you have to take on faith. It is also the easiest privacy answer your staff will ever give a nervous patient.",
  },
  {
    icon: <LineChart size={20} />,
    title: "Your refit rate, not ours",
    body: "We don't market an accuracy percentage. You get the dashboard instead: refit rate, recommendation acceptance, the reasons your team overrode it, scan quality, and how long a flagged fitting waited — measured on your own patients, split by where the fitting started.",
  },
  {
    icon: <Workflow size={20} />,
    title: "The fitting is a step, not a subscription",
    body: "The recommendation lands on the same record that runs resupply, billing, clinical monitoring, and the storefront — so it becomes an order, a claim, and a reorder cadence without an export. One vendor, one login, one patient timeline.",
  },
];

const SWITCH_PAGES: Record<string, SwitchConfig> = {
  sleepglad: {
    slug: "sleepglad",
    kind: "fitter",
    name: "SleepGlad",
    sub: "You already believe a phone camera beats a tape measure and a drawer of sample masks — that argument is over, and you won. The question now is what happens after the recommendation: what the engine does with the awkward cases, what you can prove a year later, and whether the fitting is a tool you license or a step in the business you already run.",
    wants: [
      "The fitting moment to stay fast and self-serve — nobody wants to go back to staff-run fittings and a drawer of sample masks",
      "A recommendation they can defend clinically, not just a mask name from a black box",
      "The result to land where the work actually happens — the order, the claim, and the reorder cadence",
    ],
    reasons: FITTER_REASONS,
  },
  brightree: {
    slug: "brightree",
    name: "Brightree",
    sub: "Keep every patient, claim, and reorder — and trade a decades-old billing core for one AI-native platform that runs the whole resupply business. Here's what changes, line by line, and how the move works.",
    wants: [
      "A modern, single-screen workflow instead of swivel-chairing between separately-licensed modules",
      "Resupply and patient outreach that are native to the platform — not layered on top of a billing core",
      "AI that books reorders and scrubs claims built in, without paying for another add-on",
    ],
    reasons: COMMON_REASONS,
  },
  bonafide: {
    slug: "bonafide",
    name: "Bonafide",
    sub: "Move your roster in with a spreadsheet (CSV) and run resupply, revenue cycle, clinical monitoring, and the storefront on one record — with the AI doing the repetitive work. Here's what changes, line by line, and how the move works.",
    wants: [
      "Billing/RCM, clinical monitoring, and a branded storefront on the same record as resupply",
      "One platform to run instead of resupply in one tool and claims in another",
      "A 24/7 AI voice agent and claim scrubbing working that same patient data",
    ],
    reasons: COMMON_REASONS,
  },
  nikohealth: {
    slug: "nikohealth",
    name: "NikoHealth",
    sub: "Step up to an AI-native platform where the voice agent, claim scrubbing, and mask fitting are built in — not on the roadmap. Here's what changes, line by line, and how the move works.",
    wants: [
      "AI that's shipping today — voice agent, claim scrubbing, on-device mask fitting — not on a roadmap",
      "A proven resupply engine with eligibility-aware, multi-channel outreach",
      "Deep revenue-cycle worklists — denials by recoverable dollars, prior auth, secondary/COB — in the box",
    ],
    reasons: COMMON_REASONS,
  },
};

function SwitchPage({ cfg }: { cfg: SwitchConfig }) {
  const isFitter = cfg.kind === "fitter";
  useDocumentTitle(
    isFitter
      ? `${cfg.name} alternative — clinical mask fitting on Breathe`
      : `Switch from ${cfg.name} to Breathe — Breathe by CareMetric.ai`,
    isFitter
      ? `Comparing ${cfg.name} with Breathe? See the fitting engine head to head: safety as a hard filter rather than a score penalty, an image that never leaves the patient's phone, millimetre size bands, a fit report naming what was ruled out and why — on the platform that also runs resupply, billing, and the storefront.`
      : `Thinking of leaving ${cfg.name}? See how Breathe compares feature by feature, why teams move to an AI-native, single-record DME platform, and how a spreadsheet (CSV) import gets you live on day one.`,
  );
  return (
    <BreatheShell>
      <PageHead
        icon={isFitter ? ScanFace : GitBranch}
        eyebrow={
          isFitter ? `${cfg.name} vs. Breathe` : `Switch from ${cfg.name}`
        }
        title={
          isFitter ? (
            <>
              Keep the fitting.{" "}
              <span className="grad-em">Get the whole program.</span>
            </>
          ) : (
            <>
              Leave {cfg.name} behind.{" "}
              <span className="grad-em">Keep your patients.</span>
            </>
          )
        }
        sub={cfg.sub}
      />

      <section className="bx-section bx-section-tight">
        <div className="bx-shell">
          <div className="bx-switch-wants bx-reveal">
            <h2 className="bx-switch-wants-title">
              {isFitter
                ? `Teams comparing ${cfg.name} with us want the same three things`
                : `Most teams leaving ${cfg.name} want the same three things`}
            </h2>
            <ul className="bx-switch-wants-list">
              {cfg.wants.map((w) => (
                <li key={w}>
                  <Check size={16} aria-hidden="true" />
                  {w}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section className="bx-section">
        <div className="bx-shell">
          <div className="bx-section-head center bx-reveal">
            <span className="bx-eyebrow">
              <ArrowRight size={13} /> Why teams move
            </span>
            <h2 className="bx-h2">
              {isFitter
                ? "What changes when the fitter is part of the platform"
                : "What changes when you switch"}
            </h2>
            <p className="bx-lede">
              {isFitter
                ? "The same two-minute patient experience — with a clinical engine underneath it, a record you can defend afterwards, and a recommendation that turns into an order without an export."
                : "The same work, run by a platform that was built AI-first on a single patient record — so your team works exceptions instead of stitching tools together."}
            </p>
          </div>
          <div className="bx-caps">
            {cfg.reasons.map((r) => (
              <article className="bx-cap bx-reveal" key={r.title}>
                <div className="bx-cap-head">
                  <span className="bx-cap-ic">{r.icon}</span>
                  <div>
                    <h3>{r.title}</h3>
                  </div>
                </div>
                <p className="bx-cap-summary" style={{ marginTop: 4 }}>
                  {r.body}
                </p>
              </article>
            ))}
          </div>
          <div className="bx-price-cta bx-reveal">
            <span>See it on your own data before you move a thing.</span>
            <Link className="bx-btn bx-btn-primary" href="/breathe/signup">
              Create your account <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {isFitter ? (
        <>
          <FitterCompare />
          <Comparison />
        </>
      ) : (
        <>
          <Comparison />
          <WhyDifferent />
          <Onboarding />
        </>
      )}
      <ClosingCta />
    </BreatheShell>
  );
}

export function BreatheSwitchBrightree() {
  return <SwitchPage cfg={SWITCH_PAGES.brightree!} />;
}
export function BreatheSwitchBonafide() {
  return <SwitchPage cfg={SWITCH_PAGES.bonafide!} />;
}
export function BreatheSwitchNikohealth() {
  return <SwitchPage cfg={SWITCH_PAGES.nikohealth!} />;
}
export function BreatheVsSleepGlad() {
  return <SwitchPage cfg={SWITCH_PAGES.sleepglad!} />;
}

export default BreatheSwitchBrightree;
