import { Link } from "wouter";
import {
  ArrowRight,
  Bot,
  CalendarClock,
  CheckCheck,
  FileText,
  Inbox,
  Mail,
  MessageSquare,
  Printer,
  Send,
  ShieldCheck,
  Sparkles,
  Tags,
  Users,
  Workflow,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Communications & automation deep-dive.
 *
 * Patient communications is the pillar that most directly delivers the
 * "saves staff time" half of the pitch, but it only had role bullets and a
 * homepage AiWorkforce section. This page tells the whole story: the unified
 * SMS/MMS/email/inbound-fax inbox, the AI assist layer (macros, AI-drafted
 * replies, SMS intent triage, high-confidence email auto-reply), the
 * automation cadence (templates → triggers → multi-touch playbooks → bulk
 * campaigns), and consent-aware delivery (quiet hours, frequency caps,
 * per-channel opt-out). Grounds claims in shipped functionality
 * (`lib/messaging/*`, `routes/admin/conversations-*`, `bulk-campaigns.ts`,
 * `outreach-playbooks.ts`, `lib/messaging/sms-intent.ts`,
 * `lib/messaging/email-auto-reply.ts`, `lib/telecom/fax-*`).
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system — no new
 * CSS, inherits the apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── The channels that land in one inbox ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const INBOX: Cap[] = [
  {
    icon: <Inbox size={20} />,
    title: "One inbox, every channel",
    summary: "SMS, MMS, email, and inbound fax — in a single thread.",
    points: [
      "Each patient's whole history in one place, fully logged",
      "Cases, assignment, and routing so nothing falls through",
      "No more flipping between a phone, an email client, and a fax pile",
    ],
    gold: true,
  },
  {
    icon: <Tags size={20} />,
    title: "Macros & message templates",
    summary: "Consistent, on-brand answers in one click.",
    points: [
      "Canned macros a CSR drops in by keyword",
      "Editable, branded templates for SMS, email, and fax",
      "Placeholders fill patient, order, and contact details automatically",
    ],
  },
  {
    icon: <Printer size={20} />,
    title: "Fax, finally automated",
    summary: "Rx requests, prior-auth packets, and returns — no fax machine.",
    points: [
      "Outbound faxes sent straight from the patient record",
      "Inbound faxes triaged onto the right patient automatically",
      "Signed documents land where they belong, not in a tray",
    ],
  },
];

function InboxSection() {
  return (
    <section className="bx-section" id="inbox">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Inbox size={13} /> One inbox
          </span>
          <h2 className="bx-h2">Every patient conversation, in one place</h2>
          <p className="bx-lede">
            Patients reach you however they like — text, email, a photo by MMS,
            a faxed form. Breathe funnels all of it into one threaded inbox per
            patient, with cases and routing, so your team stops switching apps
            and starts resolving.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {INBOX.map((c) => (
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

/* ── The AI assist layer ── */
const ASSIST: Cap[] = [
  {
    icon: <Bot size={20} />,
    title: "AI-drafted replies",
    summary: "A ready-to-send answer, grounded in your knowledge.",
    points: [
      "Drafts a reply your CSR can send or tweak in a second",
      "Grounded in your products, policies, and the patient's thread",
      "Turns a blank box into a one-click response",
    ],
  },
  {
    icon: <Workflow size={20} />,
    title: "SMS intent triage",
    summary: "Every inbound text, sorted the moment it lands.",
    points: [
      "Classifies confirm, question, complaint, and opt-out automatically",
      "A YES routes straight to fulfillment; a question routes to a person",
      "Your team stops sorting texts and starts working the ones that matter",
    ],
    gold: true,
  },
  {
    icon: <Mail size={20} />,
    title: "Email auto-reply",
    summary: "Routine emails answered automatically — safely.",
    points: [
      "High-confidence answers sent automatically, day or night",
      "The model reports its confidence; only sure answers go out",
      "Anything order-, account-, or clinical-specific hands off to a human",
    ],
  },
];

function Assist() {
  return (
    <section className="bx-section bx-section-tight" id="assist">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> AI on the keyboard
          </span>
          <h2 className="bx-h2">
            The repetitive replies, handled —{" "}
            <em>with a human on the hard ones</em>
          </h2>
          <p className="bx-lede">
            Most patient messages are variations on the same handful of
            questions. Breathe's AI drafts the answer, sorts every inbound text
            by intent, and auto-replies to the routine emails it's sure about —
            while everything sensitive still routes to a person.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {ASSIST.map((c) => (
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

/* ── Proactive outreach: from a template to a playbook ── */
const OUTREACH: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  { icon: <FileText size={15} />, label: "Templates", sub: "branded copy" },
  {
    icon: <CalendarClock size={15} />,
    label: "Triggers",
    sub: "on patient events",
  },
  { icon: <Workflow size={15} />, label: "Playbooks", sub: "multi-touch" },
  {
    icon: <Users size={15} />,
    label: "Campaigns",
    sub: "to a segment",
    gold: true,
  },
];

function Outreach() {
  return (
    <section className="bx-section" id="outreach">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Send size={13} /> Proactive outreach
          </span>
          <h2 className="bx-h2">
            From a one-off message to a self-running play
          </h2>
          <p className="bx-lede">
            Communication isn't only inbound. Define a branded template, fire it
            on a patient event, chain it into a multi-touch playbook, or send a
            targeted campaign to a whole segment — recalls, reminders, coaching,
            re-engagement — without a person sending each one.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Workflow size={15} /> One message, scaled to your whole panel
          </div>
          <ol className="bx-claims-flow">
            {OUTREACH.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < OUTREACH.length - 1 ? (
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
    icon: <Inbox size={22} />,
    metric: "1 inbox",
    metricSub: "not five apps",
    title: "Hours back on context-switching",
    gold: true,
    body: "One screen for every channel, with the patient's whole history beside it — instead of a phone, an email client, a chat queue, and a fax tray. The repetitive contact that eats a CSR's day stops bouncing between tools.",
  },
  {
    icon: <Bot size={22} />,
    metric: "Drafted",
    metricSub: "& triaged",
    title: "The queue works itself down",
    body: "AI drafts the reply, sorts every text by intent, and auto-answers the routine emails — so your team spends its time on the conversations that actually need a human.",
  },
  {
    icon: <ShieldCheck size={22} />,
    metric: "Consent",
    metricSub: "honored",
    title: "Reach more patients, annoy none",
    body: "Per-channel opt-out, quiet hours, and frequency caps are enforced on every send and delivery is tracked — so you can run proactive outreach at scale without ever becoming a nuisance.",
  },
];

function Outcome() {
  return (
    <section className="bx-section" id="outcome">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CheckCheck size={13} /> What it adds up to
          </span>
          <h2 className="bx-h2">
            Fewer hours on the phones, more patients reached
          </h2>
          <p className="bx-lede">
            Routine patient contact is some of the most repetitive work in a DME
            office. Putting every channel in one place — and letting AI handle
            the predictable parts — gives your team its day back while patients
            get faster answers.
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
          The repetitive calls, texts, and emails that fill a CSR's day are
          exactly what an AI-assisted inbox absorbs — illustrative of the
          staff-time it frees, not a guarantee.{" "}
          <Link href="/breathe/ai-voice">See the AI voice agent</Link> ·{" "}
          <Link href="/breathe/roi">size the time saved →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheCommunications() {
  useDocumentTitle(
    "Patient communications — Breathe by CareMetric.ai",
    "Breathe puts every patient conversation — SMS, MMS, email, inbound fax — in one inbox, with AI-drafted replies, SMS intent triage, high-confidence email auto-reply, and consent-aware bulk campaigns and outreach playbooks. The repetitive contact, handled.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={MessageSquare}
        eyebrow="Communications"
        title={
          <>
            Every conversation in one inbox —{" "}
            <span className="grad-em">most of them, handled.</span>
          </>
        }
        sub="SMS, MMS, email, and inbound fax in a single threaded inbox, with AI that drafts replies, triages every text, and auto-answers the routine emails — plus consent-aware campaigns and playbooks that reach your whole panel without a person sending each one."
      />
      <InboxSection />
      <Assist />
      <Outreach />
      <Outcome />
      <ClosingCta />
    </BreatheShell>
  );
}
