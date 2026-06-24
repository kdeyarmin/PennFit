import { Link } from "wouter";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BellRing,
  CalendarCheck,
  ClipboardList,
  Gauge,
  Headphones,
  HeartPulse,
  ShieldAlert,
  Stethoscope,
  TrendingUp,
  Video,
  Waves,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Clinical & therapy monitoring deep-dive.
 *
 * The integrations page tells the *data* story (unifying ResMed / Philips / 3B
 * into one fleet view); this page is the *clinical action* story: catch
 * patients slipping off therapy before they quit, intervene, and document CMS
 * compliance — protecting both outcomes and the recurring revenue that depends
 * on adherence. Grounds claims in shipped functionality (clinical alerts &
 * escalation in `lib/alerts/*` + `routes/admin/alerts.ts`, CMS 90-day adherence
 * cohorts in `adherence-predictions.ts`, RT encounters & usage reports,
 * coaching plans in `coaching-plans.ts`, the AI sleep coach, built-in
 * telehealth visits, and the equipment-recall registry in
 * `equipment-recalls.ts`).
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system — no new
 * CSS, inherits the apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── Monitor → alert → intervene ── */
const FLOW: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  { icon: <Waves size={15} />, label: "Pull nightly", sub: "all devices" },
  { icon: <Gauge size={15} />, label: "Score adherence", sub: "vs CMS 90/30" },
  {
    icon: <AlertTriangle size={15} />,
    label: "Rank risk",
    sub: "who's slipping",
  },
  {
    icon: <HeartPulse size={15} />,
    label: "Intervene early",
    sub: "before they quit",
    gold: true,
  },
];

function Flow() {
  return (
    <section className="bx-section" id="flow">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Activity size={13} /> How it watches
          </span>
          <h2 className="bx-h2">
            See who&apos;s slipping — <em>before they quit</em>
          </h2>
          <p className="bx-lede">
            About one in three CPAP patients drifts out of adherence, and a
            silent patient is both a clinical risk and a billing one. Breathe
            pulls therapy data nightly from every manufacturer system, scores
            each patient against the CMS window, ranks who&apos;s at risk, and
            puts them on a worklist while there&apos;s still time to act.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Stethoscope size={15} /> One fleet, watched every night
          </div>
          <ol className="bx-claims-flow">
            {FLOW.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < FLOW.length - 1 ? (
                  <ArrowRight
                    className="bx-claims-arrow"
                    size={15}
                    aria-hidden="true"
                  />
                ) : null}
              </li>
            ))}
          </ol>
        </div>
        <p className="bx-stats-note bx-reveal">
          The unified fleet view that feeds all of this — ResMed AirView,
          Philips Care Orchestrator, and 3B React Health on one screen — is on
          the <Link href="/breathe/integrations">integrations page</Link>. This
          page is what your clinical team does with it.
        </p>
      </div>
    </section>
  );
}

/* ── The clinical toolkit ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const TOOLKIT: Cap[] = [
  {
    icon: <ClipboardList size={20} />,
    title: "Live adherence worklist",
    summary: "Who's due, who's drifting — ranked, not buried.",
    points: [
      "Nightly usage, AHI, leak and pressure across every device brand",
      "At-risk patients surfaced first, not lost in a flat list",
      "One board instead of three manufacturer portals",
    ],
    gold: true,
  },
  {
    icon: <BellRing size={20} />,
    title: "Clinical alerts & escalation",
    summary: "Thresholds that page the right person automatically.",
    points: [
      "Low usage, high AHI, missed nights, and recalls trip an alert",
      "Auto-escalates to a respiratory therapist when a threshold is crossed",
      "The intervention is documented on the patient timeline",
    ],
  },
  {
    icon: <CalendarCheck size={20} />,
    title: "CMS 90-day compliance",
    summary: "The documentation Medicare requires, captured automatically.",
    points: [
      "Tracks the 4-hours-on-21-of-30-nights setup window per patient",
      "Compliance cohorts with at-risk flags before day 90 closes",
      "Provider-ready usage reports without manual exports",
    ],
  },
  {
    icon: <Headphones size={20} />,
    title: "Coaching plans & sleep coach",
    summary: "Support through the weeks patients are most likely to quit.",
    points: [
      "RT-defined coaching plans that message patients on a schedule",
      "An AI sleep coach answers comfort and adherence questions 24/7",
      "Engagement tracked so you know what's landing",
    ],
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "RT encounters & interventions",
    summary: "Every clinical touch, on one record.",
    points: [
      "Log assessments, interventions, and outcomes per patient",
      "A full therapy timeline attributed to the staff member",
      "Provider-ready usage reports generated from the same data",
    ],
  },
  {
    icon: <ShieldAlert size={20} />,
    title: "Equipment-recall registry",
    summary: "Match a recall to the exact patients affected.",
    points: [
      "Serial-number matching against your device fleet",
      "Targeted outreach to only the affected patients",
      "A documented trail of who was notified, and when",
    ],
  },
];

function Toolkit() {
  return (
    <section className="bx-section bx-section-tight" id="toolkit">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <HeartPulse size={13} /> The clinical toolkit
          </span>
          <h2 className="bx-h2">
            Everything an RT needs to keep patients on therapy
          </h2>
          <p className="bx-lede">
            Monitoring is only useful if you can act on it. Breathe gives your
            clinical team the worklist, the alerts, the coaching, the
            documentation, and the recall tracking — all on the same patient
            record the rest of the platform runs on.
          </p>
        </div>
        <div className="bx-caps">
          {TOOLKIT.map((c) => (
            <article
              className={`bx-cap bx-reveal${c.gold ? " gold" : ""}`}
              key={c.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{c.icon}</span>
                <div>
                  <h3>{c.title}</h3>
                  <p className="bx-cap-summary">{c.summary}</p>
                </div>
              </div>
              <ul className="bx-cap-list">
                {c.points.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── Built-in telehealth ── */
function Telehealth() {
  return (
    <section className="bx-section" id="telehealth">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Video size={13} /> Built-in telehealth
          </span>
          <h2 className="bx-h2">Face-to-face care, no extra app</h2>
          <p className="bx-lede">
            Setups, mask fittings, and follow-ups happen over built-in video.
            The patient joins from a one-tap link by text or email — nothing to
            install — and the visit is scheduled, reminded, and summarized to
            the chart automatically. It replaces a separate telehealth
            subscription and fits more patient touches into the same day.
          </p>
        </div>
      </div>
    </section>
  );
}

/* ── Outcome ── */
const OUTCOME: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <TrendingUp size={22} />,
    metric: "85%",
    metricSub: "compliance",
    title: "Adherence, well above the norm",
    gold: true,
    body: "Live outreach has been shown to lift CPAP compliance from a ~50% national average toward 85%. Catching at-risk patients early — instead of at the failed 90-day check — is what moves the number.",
  },
  {
    icon: <HeartPulse size={22} />,
    metric: "Stay",
    metricSub: "on therapy",
    title: "Retention is a clinical outcome",
    body: "A patient kept comfortable and compliant stays on therapy — which keeps them eligible, supplied, and reordering. Better care and recurring revenue are the same line on this page.",
  },
  {
    icon: <CalendarCheck size={22} />,
    metric: "CMS",
    metricSub: "documented",
    title: "Compliance you don't have to chase",
    body: "The 90-day documentation Medicare requires is captured as patients use their devices — so a clinical win doesn't turn into a billing problem later.",
  },
];

function Outcome() {
  return (
    <section className="bx-section" id="outcome">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Gauge size={13} /> What it adds up to
          </span>
          <h2 className="bx-h2">
            Better outcomes and protected revenue, together
          </h2>
          <p className="bx-lede">
            In DME, keeping patients on therapy is both the right thing to do
            and the engine of recurring revenue. The clinical toolkit is built
            to do both at once — without adding clinical headcount.
          </p>
        </div>
        <div className="bx-pillars">
          {OUTCOME.map((p) => (
            <article
              className={`bx-pillar bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-pillar-top">
                <span className="bx-pillar-ic">{p.icon}</span>
                <span className="bx-pillar-metric">
                  <b>{p.metric}</b>
                  <small>{p.metricSub}</small>
                </span>
              </div>
              <h3 className="bx-pillar-title">{p.title}</h3>
              <p className="bx-pillar-body">{p.body}</p>
            </article>
          ))}
        </div>
        <p className="bx-stats-note bx-reveal">
          Industry benchmark: live monitoring and outreach raised CPAP
          compliance from the ~50% national average toward 85% — illustrative,
          not a guarantee.{" "}
          <Link href="/breathe/roi">See what adherence is worth →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheClinical() {
  useDocumentTitle(
    "Clinical & therapy monitoring — Breathe by CareMetric.ai",
    "Breathe pulls therapy data nightly from ResMed, Philips, and 3B, scores each patient against the CMS window, and surfaces who's slipping before they quit — with clinical alerts, RT encounters, coaching plans, an AI sleep coach, built-in telehealth, and equipment-recall tracking.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Stethoscope}
        eyebrow="Clinical & therapy"
        title={
          <>
            Keep patients on therapy —{" "}
            <span className="grad-em">and on the books.</span>
          </>
        }
        sub="Nightly adherence from every device brand, scored against the CMS window and ranked by risk — plus the alerts, coaching, telehealth, and recall tracking your clinical team needs to act before a patient quits. Better outcomes and protected recurring revenue, on one record."
      />
      <Flow />
      <Toolkit />
      <Telehealth />
      <Outcome />
      <ClosingCta />
    </BreatheShell>
  );
}
