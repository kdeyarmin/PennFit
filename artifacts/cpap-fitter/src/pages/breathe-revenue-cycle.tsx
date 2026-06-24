import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  BrainCircuit,
  CalendarClock,
  CircleDollarSign,
  CreditCard,
  FileCheck2,
  Gauge,
  Landmark,
  Receipt,
  RefreshCw,
  ScrollText,
  Send,
  TrendingUp,
  Wallet,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Revenue cycle deep-dive ("Get paid").
 *
 * Pulls the money story — currently split across sections on the homepage and
 * product tour — into one definitive page: eligibility → AI claim scrub →
 * 837P submission → 835/ERA posting → ranked denials → prior auth → the
 * patient-pay half (payment plans, autopay, collections, A/R) → payer
 * intelligence (fee schedules, profitability, timely filing). Every capability
 * maps to shipped admin routes (eligibility-checks, billing-batch, denials/
 * appeals, prior-auth-queue, payment-plans, collections-worklist,
 * payer-fee-schedules, payer-profitability, billing-timely-filing) and the
 * Office Ally / Da Vinci PAS integrations.
 *
 * Reuses the shared chrome and `.bx-*` design system — no new CSS, inherits
 * the apex-gated `noindex`, lazy-loaded.
 */

/* ── The claim lifecycle, on one record ── */
const RCM_FLOW: { icon: React.ReactNode; label: string; sub: string }[] = [
  { icon: <BadgeCheck size={18} />, label: "Eligibility", sub: "270 / 271" },
  { icon: <BrainCircuit size={18} />, label: "AI scrub", sub: "pre-submit" },
  { icon: <Send size={18} />, label: "Submit", sub: "837P" },
  { icon: <Landmark size={18} />, label: "Post", sub: "835 / ERA" },
  { icon: <Receipt size={18} />, label: "Work denials", sub: "ranked" },
  { icon: <TrendingUp size={18} />, label: "Reconcile", sub: "to cash" },
];

function Lifecycle() {
  return (
    <section className="bx-section" id="lifecycle">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <RefreshCw size={13} /> The claim lifecycle
          </span>
          <h2 className="bx-h2">
            From eligibility to posted cash — <em>on one record</em>
          </h2>
          <p className="bx-lede">
            The whole claim lifecycle runs on the same patient data, with no
            re-keying between screens. Specialists review the exceptions; the
            platform does the eligibility check, the scrubbing, the submission,
            the posting, and the prioritizing.
          </p>
        </div>
        <div className="bx-pipeline bx-reveal">
          <div className="bx-pipeline-line">
            <span className="bx-pipeline-pulse" />
          </div>
          <ol className="bx-pipeline-nodes">
            {RCM_FLOW.map((s) => (
              <li className="bx-pipe-node" key={s.label}>
                <span className="bx-pipe-dot">{s.icon}</span>
                <span className="bx-pipe-label">{s.label}</span>
                <span className="bx-pipe-idx">{s.sub}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ── Inside the AI claims engine ── */
const SCRUB_FLOW: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  { icon: <FileCheck2 size={15} />, label: "Build 837P", sub: "from the order" },
  { icon: <BrainCircuit size={15} />, label: "Scrub", sub: "modifiers + docs", gold: true },
  { icon: <BadgeCheck size={15} />, label: "Predict denials", sub: "before filing" },
  { icon: <Send size={15} />, label: "Auto-submit", sub: "Office Ally / any" },
];

function ClaimsEngine() {
  return (
    <section className="bx-section bx-section-tight" id="scrub">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> AI claims engine
          </span>
          <h2 className="bx-h2">Clean the first time, not the third</h2>
          <p className="bx-lede">
            Every 837P is scrubbed for missing modifiers and documentation
            before it&apos;s filed, checked against live eligibility, and the
            denials it predicts get fixed up front. Submit automatically through
            the built-in Office Ally connection, or download the 837P for the
            clearinghouse you already use — either way, ERAs post back and
            reconcile on their own.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <BrainCircuit size={15} /> Inside the AI claims engine
          </div>
          <ol className="bx-claims-flow">
            {SCRUB_FLOW.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < SCRUB_FLOW.length - 1 ? (
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
      </div>
    </section>
  );
}

/* ── Insurance worklists ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const INSURANCE: Cap[] = [
  {
    icon: <BadgeCheck size={20} />,
    title: "Eligibility & coverage discovery",
    summary: "Stop filing against coverage that lapsed.",
    points: [
      "Instant 270/271 eligibility before a patient ever pays",
      "Automatic re-verification so a mid-episode payer change is caught",
      "Surfaces secondary and COB coverage your patients didn't know they had",
    ],
  },
  {
    icon: <Send size={20} />,
    title: "Claims & submission",
    summary: "AI-scrubbed 837P, out the door automatically.",
    points: [
      "Auto-built from the order — no manual claim keying",
      "Submit via the built-in Office Ally connection or any clearinghouse",
      "835/ERA auto-posting reconciles payments back to the order",
    ],
    gold: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Denials & appeals",
    summary: "Work the dollars worth chasing, in order.",
    points: [
      "Denials ranked by recoverable dollars × win probability",
      "Reason-coded worklist with appeal tracking and re-submission",
      "Trending by payer and code to fix the systemic leaks",
    ],
  },
  {
    icon: <ScrollText size={20} />,
    title: "Prior authorization",
    summary: "Electronic PA, not a fax-and-wait.",
    points: [
      "Electronic prior auth via Da Vinci PAS, status tracked in one place",
      "Auto-renewal before an authorization quietly expires",
      "Request forms pre-filled from the patient's own record",
    ],
  },
];

function Insurance() {
  return (
    <section className="bx-section" id="insurance">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <FileCheck2 size={13} /> The insurance side
          </span>
          <h2 className="bx-h2">Every claim, worked to paid</h2>
          <p className="bx-lede">
            Eligibility, submission, posting, denials, and prior auth — the four
            places DME revenue leaks — all on the same patient record, so your
            billing team finds and works the dollars a legacy system writes off.
          </p>
        </div>
        <div className="bx-caps">
          {INSURANCE.map((c) => (
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

/* ── The patient-pay half ── */
const PATIENT_PAY: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <Wallet size={22} />,
    metric: "Plans",
    metricSub: "& autopay",
    title: "Payment plans that pay you on schedule",
    gold: true,
    body: "High-ticket balances convert when patients can split them. Stored-card autopay charges each installment on time and retries a failed charge — no manual dunning, no write-offs you never see coming.",
  },
  {
    icon: <CreditCard size={22} />,
    metric: "A/R ↓",
    metricSub: "aged & worked",
    title: "Collections that run themselves",
    body: "An aged-A/R worklist drives escalating, on-brand SMS and email on a schedule, offers a plan past a threshold, and flags the accounts worth handing to an agency — so receivables stop sitting at 60 and 90 days.",
  },
  {
    icon: <ScrollText size={22} />,
    metric: "Bill-hold",
    metricSub: "until clean",
    title: "No surprise patient invoices",
    body: "While a claim is still pending, the balance is held off the patient automatically — so you bill the patient only their real responsibility, after insurance clears. Fewer disputes, fewer refunds.",
  },
  {
    icon: <Receipt size={22} />,
    metric: "Statements",
    metricSub: "clear & paid",
    title: "Statements patients understand",
    body: "Each statement shows the service, what insurance paid, and what's owed — emailed and downloadable from the patient portal, with a one-tap link to pay or start a plan.",
  },
];

function PatientPay() {
  return (
    <section className="bx-section" id="patient-pay">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Wallet size={13} /> The other half of revenue
          </span>
          <h2 className="bx-h2">
            Patient-pay is half your money — <em>collect it too</em>
          </h2>
          <p className="bx-lede">
            Most DME software stops at the insurance claim and leaves patient
            balances to a spreadsheet and a phone call. Breathe runs the
            patient-pay side with the same automation: plans, autopay,
            collections, and clear statements — so the cash you&apos;ve earned
            actually lands.
          </p>
        </div>
        <div className="bx-pillars">
          {PATIENT_PAY.map((p) => (
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
      </div>
    </section>
  );
}

/* ── Payer intelligence ── */
const PAYER: Cap[] = [
  {
    icon: <Gauge size={20} />,
    title: "Payer profitability",
    summary: "Know which payers and products actually make money.",
    points: [
      "Contracted fee schedules imported and matched to every line",
      "Product- and payer-level margin, trended over time",
      "Spot the loss-leaders and the payers worth renegotiating",
    ],
  },
  {
    icon: <CalendarClock size={20} />,
    title: "Timely filing & rentals",
    summary: "Never lose a paid claim to the calendar.",
    points: [
      "Per-payer timely-filing deadlines tracked with alerts before they pass",
      "Capped-rental modifier rotation handled across the rental term",
      "A/R aging and collections forecast on the same live data",
    ],
    gold: true,
  },
];

function Payer() {
  return (
    <section className="bx-section bx-section-tight" id="payer">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Gauge size={13} /> Payer intelligence
          </span>
          <h2 className="bx-h2">Run the business on margin, not guesswork</h2>
          <p className="bx-lede">
            Getting paid is one thing; knowing whether it was worth it is
            another. Breathe maps every payment back to your contracted rates so
            you can see real margin by payer and product — and never lose a clean
            claim to a missed deadline.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {PAYER.map((c) => (
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
        <p className="bx-stats-note bx-reveal">
          Initial DME denials average roughly 11–12%, and every reworked claim
          costs an estimated $25–$118 in staff time. Cutting that is the fastest
          revenue you&apos;ll find.{" "}
          <Link href="/breathe/roi">
            Size it on your own numbers →
          </Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheRevenueCycle() {
  useDocumentTitle(
    "Get paid — the Breathe revenue cycle by CareMetric.ai",
    "Breathe runs the whole DME revenue cycle on one record: instant eligibility, AI-scrubbed 837P claims, 835/ERA auto-posting, ranked denials, electronic prior auth, plus the patient-pay half — payment plans, autopay, collections, and payer profitability.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={CircleDollarSign}
        eyebrow="Get paid"
        title={
          <>
            Every dollar you&apos;ve earned —{" "}
            <span className="grad-em">actually collected.</span>
          </>
        }
        sub="Instant eligibility, AI-scrubbed claims, auto-posted ERAs, and ranked denials — plus the patient-pay half most software ignores: plans, autopay, and collections. The whole revenue cycle on one patient record."
      />
      <Lifecycle />
      <ClaimsEngine />
      <Insurance />
      <PatientPay />
      <Payer />
      <ClosingCta />
    </BreatheShell>
  );
}
