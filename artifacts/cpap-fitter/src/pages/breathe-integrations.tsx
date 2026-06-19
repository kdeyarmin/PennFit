import { Link } from "wouter";
import {
  ArrowRight,
  BrainCircuit,
  ChevronDown,
  Network,
  Plug,
  Workflow,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Integrations.
 *
 * The centerpiece of the marketing site: the story a DME owner feels every
 * day. Today their patients live in three disconnected device clouds (ResMed
 * AirView, Philips Care Orchestrator, 3B's React Health) — three logins,
 * three exports, the same patient re-keyed three times. Breathe compiles all
 * of them into one fleet view, then runs AI monitoring that surfaces at-risk
 * patients EARLY so they stay compliant and issues get fixed faster. The page
 * then covers the payer/billing connectors (Office Ally, Da Vinci PAS,
 * PacWare).
 *
 * Reuses the namespaced `breathe.css` design system (every rule scoped under
 * `.breathe-page`) and the shared chrome exported from `breathe.tsx`.
 * Rendered OUTSIDE the patient storefront <Layout> (mounted in TopRouter),
 * lazy-loaded, and `noindex` (inherited from <BreatheShell/>) for the same
 * tenant-domain reason the homepage is.
 */

/* ───────────────── Today: the portal sprawl ───────────────── */
const SPRAWL: { mark: string; sub: string }[] = [
  { mark: "ResMed", sub: "AirView" },
  { mark: "Philips", sub: "Care Orchestrator" },
  { mark: "3B Medical", sub: "React Health" },
];

function LoginSprawl() {
  return (
    <section className="bx-section" id="sprawl">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Plug size={13} /> Today
          </span>
          <h2 className="bx-h2">Three portals. Three logins. One patient.</h2>
          <p className="bx-lede">
            Most DME companies run more than one CPAP manufacturer — and each
            one ships its own cloud. So your respiratory therapist signs into
            three separate systems, pulls three separate reports, and stitches
            the picture together by hand.
          </p>
        </div>
        <div className="bx-sprawl bx-reveal">
          {SPRAWL.map((s) => (
            <article className="bx-sprawl-node" key={s.mark}>
              <span className="bx-sprawl-mark">{s.mark}</span>
              <span className="bx-sprawl-sub">{s.sub}</span>
              <span className="bx-sprawl-tag">separate login</span>
            </article>
          ))}
        </div>
        <p className="bx-sprawl-foot">
          No shared record. No cross-cloud view. The patient quietly drifting
          out of compliance in one portal is invisible in the other two.
        </p>
      </div>
    </section>
  );
}

/* ───────────────── Breathe: one compiled fleet ───────────────── */
type FleetRow = {
  name: string;
  source: string;
  usage: string;
  ahi: string;
  leak: string;
  p95: string;
  status: string;
  tone: "ok" | "warn" | "info";
};

const FLEET_ROWS: FleetRow[] = [
  {
    name: "M. Alvarez",
    source: "AirView",
    usage: "6h 12m",
    ahi: "3.1",
    leak: "12",
    p95: "9.4",
    status: "Compliant",
    tone: "ok",
  },
  {
    name: "R. Okafor",
    source: "Care Orchestrator",
    usage: "2h 40m",
    ahi: "8.7",
    leak: "31",
    p95: "11.2",
    status: "At risk",
    tone: "warn",
  },
  {
    name: "S. Patel",
    source: "React Health",
    usage: "—",
    ahi: "—",
    leak: "—",
    p95: "—",
    status: "No data 7d",
    tone: "info",
  },
  {
    name: "J. Nguyen",
    source: "AirView",
    usage: "5h 02m",
    ahi: "4.4",
    leak: "9",
    p95: "8.8",
    status: "Compliant",
    tone: "ok",
  },
  {
    name: "D. Brooks",
    source: "Care Orchestrator",
    usage: "3h 18m",
    ahi: "12.0",
    leak: "18",
    p95: "10.1",
    status: "High AHI",
    tone: "warn",
  },
];

function UnifiedFleetView() {
  return (
    <section className="bx-section" id="fleet">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Network size={13} /> One screen
          </span>
          <h2 className="bx-h2">Every patient, every night — compiled</h2>
          <p className="bx-lede">
            Breathe pulls each device cloud nightly and normalizes it into one
            model, so usage, AHI, leak, and pressure sit on a single screen and
            a single patient record — whichever manufacturer the machine came
            from.
          </p>
        </div>
        <div className="bx-fleet-wrap bx-reveal">
          <table className="bx-fleet">
            <thead>
              <tr>
                <th>Patient</th>
                <th>Source</th>
                <th>Usage</th>
                <th>AHI</th>
                <th>Leak</th>
                <th>P95</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {FLEET_ROWS.map((r) => (
                <tr key={r.name}>
                  <td className="bx-fleet-name">{r.name}</td>
                  <td>
                    <span className="bx-fleet-chip">{r.source}</span>
                  </td>
                  <td>{r.usage}</td>
                  <td>{r.ahi}</td>
                  <td>{r.leak}</td>
                  <td>{r.p95}</td>
                  <td>
                    <span className={`bx-fleet-status is-${r.tone}`}>
                      {r.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="bx-fleet-foot">
          Sample data, illustrative. Usage shown per night, leak in L/min, P95
          pressure in cmH₂O; compliance follows the CMS 90/30 rule (≥ 21 nights
          of ≥ 4 hours in any 30-day window).
        </p>
      </div>
    </section>
  );
}

/* ───────────────── AI early warning ───────────────── */
const ALERT_STEPS: { idx: string; title: string; body: string }[] = [
  {
    idx: "1",
    title: "Nightly sync",
    body: "Every active device link across all three clouds is pulled and normalized into one model — usage, AHI, leak, pressure, supply windows.",
  },
  {
    idx: "2",
    title: "Adherence scored",
    body: "A daily scan scores each patient against the CMS 90-day setup window and rolling adherence targets — not just a pass/fail at day 90.",
  },
  {
    idx: "3",
    title: "Risk ranked",
    body: "A fleet scan flags threshold crossings and ranks who needs attention first, so the worklist leads with the patients most likely to quit.",
  },
  {
    idx: "4",
    title: "Acted on early",
    body: "A CSR alert or a one-tap telehealth visit goes out while there's still time to recover the patient — not after the compliance window has closed.",
  },
];

const ALERT_TAGS: { label: string; tone: "risk" | "warn" | "info" }[] = [
  { label: "compliance_risk", tone: "risk" },
  { label: "setup_at_risk", tone: "risk" },
  { label: "high_ahi", tone: "warn" },
  { label: "high_leak", tone: "warn" },
  { label: "usage_decline", tone: "warn" },
  { label: "low_usage", tone: "warn" },
  { label: "no_recent_data", tone: "info" },
  { label: "send_failure", tone: "info" },
  { label: "no_response", tone: "info" },
];

function AiEarlyWarning() {
  return (
    <section className="bx-section" id="early-warning">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> AI monitoring
          </span>
          <h2 className="bx-h2">It catches problems early — not at the audit</h2>
          <p className="bx-lede">
            A unified fleet is only half the value. Breathe watches it for you,
            every night, and turns the data into a ranked worklist of exactly
            who is slipping — so a recoverable patient becomes an action item
            instead of a denied rental three months later.
          </p>
        </div>
        <div className="bx-alertline bx-reveal">
          {ALERT_STEPS.map((s) => (
            <article className="bx-alert-node" key={s.idx}>
              <span className="bx-alert-idx">{s.idx}</span>
              <div className="bx-alert-body">
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </article>
          ))}
        </div>
        <div className="bx-alert-tags bx-reveal">
          <span className="bx-alert-tags-label">
            Signals the scan raises automatically
          </span>
          <div className="bx-alert-tags-row">
            {ALERT_TAGS.map((t) => (
              <span className={`bx-alert-tag is-${t.tone}`} key={t.label}>
                {t.label}
              </span>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── Connector grids ───────────────── */
type IntItem = {
  mark: string;
  tag: string;
  sub: string;
  points: string[];
  gold?: boolean;
};

function IntCard({ d }: { d: IntItem }) {
  return (
    <article className={`bx-intcard bx-reveal${d.gold ? " gold" : ""}`}>
      <header className="bx-intcard-head">
        <span className="bx-intcard-mark">{d.mark}</span>
        <span className="bx-intcard-tag">{d.tag}</span>
      </header>
      <p className="bx-intcard-sub">{d.sub}</p>
      <ul className="bx-cap-list">
        {d.points.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </article>
  );
}

const DEVICE_CLOUDS: IntItem[] = [
  {
    mark: "ResMed",
    tag: "AirView",
    sub: "AirSense / AirCurve fleet",
    points: [
      "Nightly usage minutes, AHI & leak rate",
      "P95 therapy pressure & device settings",
      "Supply-eligibility windows by component",
      "Rolling 30-day CMS compliance summary",
    ],
  },
  {
    mark: "Philips",
    tag: "Care Orchestrator",
    sub: "Respironics DreamStation",
    points: [
      "Same unified per-night therapy model",
      "Usage, AHI, leak & pressure normalized",
      "Mask, tubing & filter replacement windows",
      "Mapped to the same patient record",
    ],
    gold: true,
  },
  {
    mark: "3B Medical",
    tag: "React Health",
    sub: "Luna G3 · iCode Connect",
    points: [
      "Luna G3 therapy nights pulled nightly",
      "Adherence ranked beside the other clouds",
      "Device settings & supply tracking",
      "One fleet, one worklist, one record",
    ],
  },
];

function DeviceCloudGrid() {
  return (
    <section className="bx-section" id="device-clouds">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Network size={13} /> Therapy clouds
          </span>
          <h2 className="bx-h2">The manufacturer clouds Breathe unifies</h2>
          <p className="bx-lede">
            Breathe reads from each cloud with your own credentials — rotated at
            call time, fail-soft if a vendor is down — and never replaces the
            portal. It compiles, it doesn&apos;t take over.
          </p>
        </div>
        <div className="bx-intgrid">
          {DEVICE_CLOUDS.map((d) => (
            <IntCard d={d} key={d.mark} />
          ))}
        </div>
      </div>
    </section>
  );
}

const PAYER_SYSTEMS: IntItem[] = [
  {
    mark: "Office Ally",
    tag: "Clearinghouse",
    sub: "EDI over SFTP",
    points: [
      "837P claims, AI-scrubbed before they file",
      "835 / ERA auto-posting & reconciliation",
      "270 / 271 real-time eligibility",
      "276 / 277 & 277CA claim status",
    ],
  },
  {
    mark: "Da Vinci PAS",
    tag: "Prior auth",
    sub: "FHIR electronic PA",
    points: [
      "FHIR PAS bundles built per payer & plan",
      "Submitted and tracked to a decision",
      "Approval / denial reasons parsed back in",
    ],
    gold: true,
  },
  {
    mark: "PacWare",
    tag: "Billing",
    sub: "Legacy CSV exchange",
    points: [
      "Fill-only patient import — never overwrites",
      "Resupply-due worklist export with a verify step",
      "Formula-injection-guarded, lossless round-trip",
      "Your warehouse system of record stays yours",
    ],
  },
];

function PayerBillingGrid() {
  return (
    <section className="bx-section" id="payer-billing">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Workflow size={13} /> Payers & billing
          </span>
          <h2 className="bx-h2">The rest of the stack, connected too</h2>
          <p className="bx-lede">
            Claims, remittances, eligibility, and prior authorization move
            through the systems you already use — and your legacy billing system
            stays the system of record, with data flowing both ways.
          </p>
        </div>
        <div className="bx-intgrid">
          {PAYER_SYSTEMS.map((d) => (
            <IntCard d={d} key={d.mark} />
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────── FAQ ───────────────── */
const INT_FAQ: { q: string; a: string }[] = [
  {
    q: "Do you replace my device portals?",
    a: "No — Breathe augments them. AirView, Care Orchestrator, and React Health stay exactly as they are; Breathe reads from them nightly and compiles a single fleet view on top, so your team stops signing into three places to answer one question about a patient.",
  },
  {
    q: "How does connecting a cloud work?",
    a: "Each tenant connects its own vendor credentials, stored per-organization and read at call time — so rotating a secret takes effect immediately, with no redeploy. A connector that isn't configured simply reports unavailable in the admin console; it never blocks the rest of the platform from running.",
  },
  {
    q: "What happens if a manufacturer cloud is down?",
    a: "The sync is fail-soft. A vendor outage skips that one adapter for the night and resumes on the next run, while the rest of the fleet keeps updating. A third-party hiccup never takes your console offline.",
  },
  {
    q: "Can I get my billing data back out?",
    a: "Always. PacWare stays your system of record for the warehouse, and Breathe exchanges patient and resupply-due data with it over CSV — with a verify step and formula-injection guarding — so the round-trip is lossless and your data is never held hostage.",
  },
];

function IntegrationsFaq() {
  return (
    <section className="bx-section" id="integrations-faq">
      <div className="bx-shell bx-faq-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Plug size={13} /> Integration questions
          </span>
          <h2 className="bx-h2">How the connections actually work</h2>
          <p className="bx-lede">
            The questions an RT and an IT lead ask before they trust one system
            to watch the whole fleet.
          </p>
        </div>
        <div className="bx-faq bx-reveal">
          {INT_FAQ.map((f) => (
            <details className="bx-faq-item" key={f.q}>
              <summary>
                <span>{f.q}</span>
                <ChevronDown className="bx-faq-chev" size={18} />
              </summary>
              <div className="bx-faq-a">{f.a}</div>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

export function BreatheIntegrations() {
  useDocumentTitle(
    "Integrations — Breathe by CareMetric.ai",
    "Breathe unifies your CPAP manufacturer clouds — ResMed AirView, Philips Care Orchestrator, and 3B React Health — into one fleet view, then uses AI to flag at-risk patients early. Plus Office Ally claims, Da Vinci PAS prior auth, and PacWare billing.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Network}
        eyebrow="Integrations"
        title={
          <>
            Three device clouds. One fleet.{" "}
            <span className="grad-em">Zero swivel-chair.</span>
          </>
        }
        sub="Your patients live in ResMed AirView, Philips Care Orchestrator, and 3B's React Health portal — three logins, three exports, the same patient re-keyed three times. Breathe compiles all of them into one fleet view, then watches it for you."
      />
      <LoginSprawl />
      <UnifiedFleetView />
      <AiEarlyWarning />
      <DeviceCloudGrid />
      <PayerBillingGrid />
      <IntegrationsFaq />
      <div className="bx-section bx-section-tight">
        <div className="bx-shell">
          <div className="bx-price-cta bx-reveal">
            <span>
              New to platforms like this? Start with the category, in plain
              language.
            </span>
            <Link className="bx-btn bx-btn-ghost" href="/breathe/why">
              DME Platform 101 <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </div>
      <ClosingCta />
    </BreatheShell>
  );
}

export default BreatheIntegrations;
