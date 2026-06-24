import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Cpu,
  CreditCard,
  Mail,
  MessageSquare,
  Mic,
  Receipt,
  RefreshCw,
  Repeat,
  ShieldCheck,
  ShoppingCart,
  Sparkles,
  TrendingUp,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Resupply revenue engine deep-dive.
 *
 * Resupply is the single most predictable recurring revenue in DME, and the
 * engine that captures it is Breathe's most differentiated surface — but on
 * the homepage it's only one section. This long-form page tells the whole
 * story: why reactive resupply leaks, the eligibility-aware escalation
 * cadence (text → email → AI voice call → one-tap reorder), and the engine
 * capabilities underneath it. Grounds claims in shipped functionality
 * (`worker/jobs/reminders.ts`, `lib/reminders/*`, signed-link HMAC,
 * subscriptions/autopay, cart-abandonment, the device-driven supplies-due
 * worklist, and consent / quiet-hours / frequency-cap handling).
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system — no new
 * CSS, inherits the apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── The escalation cadence ── */
const CADENCE: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  {
    icon: <CalendarClock size={15} />,
    label: "Window opens",
    sub: "eligibility-aware",
  },
  {
    icon: <MessageSquare size={15} />,
    label: "A friendly text",
    sub: "first touch",
  },
  { icon: <Mail size={15} />, label: "Follow-up email", sub: "if needed" },
  { icon: <Mic size={15} />, label: "AI voice call", sub: "talks it through" },
  {
    icon: <Receipt size={15} />,
    label: "One-tap reorder",
    sub: "no login",
    gold: true,
  },
];

function Cadence() {
  return (
    <section className="bx-section" id="cadence">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <RefreshCw size={13} /> How it reaches them
          </span>
          <h2 className="bx-h2">
            The right nudge, the right moment — <em>until they reorder</em>
          </h2>
          <p className="bx-lede">
            The engine reasons over each patient's eligibility and reorder
            window, then escalates only as far as it needs to. A text first; a
            follow-up email if that's quiet; a natural AI phone call that talks
            them through it; and at every step, a one-tap signed link that
            places the order with no login. An unanswered call retries before
            anyone on your team is ever pulled in.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Sparkles size={15} /> One reorder window, escalated intelligently
          </div>
          <ol className="bx-claims-flow">
            {CADENCE.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < CADENCE.length - 1 ? (
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

/* ── What's inside the engine ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const ENGINE: Cap[] = [
  {
    icon: <BadgeCheck size={20} />,
    title: "Eligibility-aware timing",
    summary: "Reach each patient exactly when they're due — and covered.",
    points: [
      "Reorder windows computed per component, not a blanket 90-day blast",
      "Reads coverage so you don't prompt a reorder insurance won't pay",
      "Behavioral-science timing — the moment most likely to convert",
    ],
    gold: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "One-tap signed reorder links",
    summary: "Reply YES, tap, or just say yes — no login, no friction.",
    points: [
      "Short-lived signed links in every SMS and email",
      "Confirm by text reply, a single tap, or out loud on the AI call",
      "The order is placed against the right supplies automatically",
    ],
  },
  {
    icon: <Repeat size={20} />,
    title: "Subscriptions & autopay",
    summary: "Turn a reorder into a standing relationship.",
    points: [
      "Optional subscriptions for patients who'd rather set and forget",
      "Stored-card autopay so a due reorder doesn't wait on payment",
      "Patients stay supplied without ever thinking about it",
    ],
  },
  {
    icon: <Cpu size={20} />,
    title: "Device-driven supplies-due worklist",
    summary: "Built from real machine data, not a guess.",
    points: [
      "Therapy-cloud data flags who's genuinely due across your fleet",
      "One worklist instead of three manufacturer portals",
      "The engine works the list so your team works the exceptions",
    ],
  },
  {
    icon: <ShoppingCart size={20} />,
    title: "Cart-abandonment recovery",
    summary: "Win back the orders that almost happened.",
    points: [
      "A left-behind cart triggers a branded recovery message",
      "One-tap link back to a pre-filled checkout",
      "Revenue you'd otherwise lose, recovered with zero staff effort",
    ],
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "Consent, quiet hours & caps",
    summary: "Persistent without ever being a pest.",
    points: [
      "Per-channel opt-out honored automatically",
      "Quiet hours and frequency caps respected on every touch",
      "Patients feel looked after, not spammed",
    ],
  },
];

function Engine() {
  return (
    <section className="bx-section bx-section-tight" id="engine">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> Inside the engine
          </span>
          <h2 className="bx-h2">A reasoning system, not a reminder blast</h2>
          <p className="bx-lede">
            Most "resupply software" is a calendar that texts everyone on day
            90. Breathe's engine reasons about each patient — eligibility,
            device data, channel, and timing — and makes reordering a single
            tap. That's the difference between chasing patients and capturing
            them.
          </p>
        </div>
        <div className="bx-caps">
          {ENGINE.map((c) => (
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

/* ── What it adds up to ── */
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
    metric: "2.5×",
    metricSub: "more orders captured",
    title: "Reactive capture, roughly tripled",
    gold: true,
    body: "Waiting for patients to call captures about one in five eligible reorders. Proactive, managed resupply lifts that toward half — and the engine runs it on autopilot across your whole panel.",
  },
  {
    icon: <RefreshCw size={22} />,
    metric: "Set",
    metricSub: "& forget",
    title: "Recurring revenue without the busywork",
    body: "No spreadsheets of who's due, no call lists, no missed replacement windows. The engine handles the cadence; your team only touches the exceptions it escalates.",
  },
  {
    icon: <CreditCard size={22} />,
    metric: "Jan 1",
    metricSub: "deductible reset",
    title: "Timed to the calendar that matters",
    body: "When deductibles reset, the engine nudges patients to reorder while coverage is freshest — capturing revenue at exactly the moment it's most billable.",
  },
];

function Outcome() {
  return (
    <section className="bx-section" id="outcome">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <TrendingUp size={13} /> What it adds up to
          </span>
          <h2 className="bx-h2">
            The most predictable revenue in DME, captured
          </h2>
          <p className="bx-lede">
            Resupply is recurring by nature — the only question is how much of
            it you actually capture. The engine's job is to make that number as
            close to "all of it" as your eligibility allows, without adding
            headcount.
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
          Industry benchmark: proactive / managed resupply lifts reorder capture
          from ~20% (reactive) to roughly 45–50% — illustrative, not a
          guarantee.{" "}
          <Link href="/breathe/roi">Size it on your own panel →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheResupplyEngine() {
  useDocumentTitle(
    "Resupply engine — Breathe by CareMetric.ai",
    "Breathe's proprietary resupply engine reasons over each patient's eligibility and reorder window, then escalates text → email → AI voice call with one-tap signed reorder links — capturing the most predictable recurring revenue in DME, automatically.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={RefreshCw}
        eyebrow="Resupply engine"
        title={
          <>
            Turn every refill into{" "}
            <span className="grad-em">recurring revenue.</span>
          </>
        }
        sub="A proprietary, behavioral-science engine that reasons over each patient's eligibility and reorder window — then reaches them on the right channel, at the right moment, with a one-tap reorder. The most predictable revenue in DME, captured on autopilot."
      />
      <Cadence />
      <Engine />
      <Outcome />
      <ClosingCta />
    </BreatheShell>
  );
}
