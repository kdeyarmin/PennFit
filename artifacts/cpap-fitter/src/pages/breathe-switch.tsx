import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BrainCircuit,
  Database,
  GitBranch,
  MessageSquare,
  Repeat,
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
 */

type SwitchConfig = {
  slug: string;
  /** The competitor's display name, used nominatively in copy + <title>. */
  name: string;
  /** One-line framing shown in the page sub-header. */
  sub: string;
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
    body: "Move in with a CSV and move out the same way. A fill-only roster import means nothing you already have gets overwritten, and you can export on demand — no lock-in, no hostage data.",
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient channels, built in",
    body: "SMS, voice, email, fax, telehealth video, and a branded storefront ship in one platform — not stitched together from a separate telephony vendor and an e-sign tool.",
  },
];

const SWITCH_PAGES: Record<string, SwitchConfig> = {
  brightree: {
    slug: "brightree",
    name: "Brightree",
    sub: "Keep every patient, claim, and reorder — and trade a decades-old billing core for one AI-native platform that runs the whole resupply business. Here's what changes, line by line, and how the move works.",
    reasons: COMMON_REASONS,
  },
  bonafide: {
    slug: "bonafide",
    name: "Bonafide",
    sub: "Move your roster in with a CSV and run resupply, revenue cycle, clinical monitoring, and the storefront on one record — with the AI doing the repetitive work. Here's what changes, line by line, and how the move works.",
    reasons: COMMON_REASONS,
  },
  nikohealth: {
    slug: "nikohealth",
    name: "NikoHealth",
    sub: "Step up to an AI-native platform where the voice agent, claim scrubbing, and mask fitting are built in — not on the roadmap. Here's what changes, line by line, and how the move works.",
    reasons: COMMON_REASONS,
  },
};

function SwitchPage({ cfg }: { cfg: SwitchConfig }) {
  useDocumentTitle(
    `Switch from ${cfg.name} to Breathe — Breathe by CareMetric.ai`,
    `Thinking of leaving ${cfg.name}? See how Breathe compares feature by feature, why teams move to an AI-native, single-record DME platform, and how a CSV-first migration gets you live on day one.`,
  );
  return (
    <BreatheShell>
      <PageHead
        icon={GitBranch}
        eyebrow={`Switch from ${cfg.name}`}
        title={
          <>
            Leave {cfg.name} behind.{" "}
            <span className="grad-em">Keep your patients.</span>
          </>
        }
        sub={cfg.sub}
      />

      <section className="bx-section">
        <div className="bx-shell">
          <div className="bx-section-head center bx-reveal">
            <span className="bx-eyebrow">
              <ArrowRight size={13} /> Why teams move
            </span>
            <h2 className="bx-h2">What changes when you switch</h2>
            <p className="bx-lede">
              The same work, run by a platform that was built AI-first on a
              single patient record — so your team works exceptions instead of
              stitching tools together.
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

      <Comparison />
      <WhyDifferent />
      <Onboarding />
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

export default BreatheSwitchBrightree;
