import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  BrainCircuit,
  Check,
  Clock,
  FileText,
  Headphones,
  Mic,
  PhoneCall,
  PhoneOutgoing,
  Quote,
  Receipt,
  ShieldCheck,
  Sparkles,
  Waves,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — AI voice agent deep-dive.
 *
 * The marquee differentiator gets its own long-form solution page: how a
 * call actually flows, the multi-vendor stack underneath it (OpenAI
 * Realtime brain, ElevenLabs voice, Deepgram audit transcript, Claude
 * post-call summary), what your team gets handed after every call, and the
 * graceful-degradation posture that keeps a missing vendor key from ever
 * breaking a call. Every claim maps to shipped code under
 * `artifacts/resupply-api/src/lib/voice/*` and `lib/resupply-ai/*`.
 *
 * Reuses the shared chrome (`BreatheShell`, `PageHead`, `ClosingCta`) and
 * the namespaced `.bx-*` design system from `breathe.tsx`/`breathe.css`, so
 * it adds NO new CSS, inherits the apex-gated `noindex`, and is lazy-loaded
 * off the patient-shop bundle.
 */

/* ── How a call flows, end to end ── */
const CALL_FLOW: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  { icon: <PhoneCall size={15} />, label: "Call connects", sub: "in or out" },
  { icon: <BrainCircuit size={15} />, label: "Understands", sub: "real-time" },
  {
    icon: <BadgeCheck size={15} />,
    label: "Confirms coverage",
    sub: "eligibility",
  },
  {
    icon: <Receipt size={15} />,
    label: "Places the order",
    sub: "one-tap",
    gold: true,
  },
  { icon: <FileText size={15} />, label: "Summarizes", sub: "+ sentiment" },
];

function CallFlow() {
  return (
    <section className="bx-section" id="call-flow">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Waves size={13} /> How a call flows
          </span>
          <h2 className="bx-h2">
            A real conversation — that ends in a placed order
          </h2>
          <p className="bx-lede">
            The agent answers your inbound resupply and status calls and places
            outbound reorder and follow-up calls on your own practice line. It
            listens, talks back naturally, confirms the patient&apos;s coverage,
            places the order, and writes the whole thing up — without a person
            on the line.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Mic size={15} /> One call, start to finish
          </div>
          <ol className="bx-claims-flow">
            {CALL_FLOW.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < CALL_FLOW.length - 1 ? (
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

/* ── A live transcript mock (inbound + outbound) ── */
function VoiceDemo() {
  return (
    <section className="bx-section bx-section-tight" id="listen">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Headphones size={13} /> What it sounds like
          </span>
          <h2 className="bx-h2">
            Natural enough that patients just talk to it
          </h2>
          <p className="bx-lede">
            Contractions, backchannels, a beat of empathy, one question at a
            time — the agent is tuned for natural turn-taking, not a phone-tree
            script. Patients can interrupt it mid-sentence and it yields, the
            way a person would.
          </p>
        </div>
        <div className="bx-caps bx-reveal">
          <div className="bx-app-panel bx-voice">
            <div className="bx-app-panel-head">
              <b>
                <PhoneCall size={13} /> Inbound · resupply
              </b>
              <span className="bx-voice-timer">
                <span className="dot" /> on call · 01:48
              </span>
            </div>
            <div className="bx-wave" aria-hidden="true">
              {Array.from({ length: 28 }).map((_, i) => (
                <i key={i} style={{ animationDelay: `${i * 60}ms` }} />
              ))}
            </div>
            <p className="bx-voice-transcript">
              “…of course — let me pull that up. Looks like you&apos;re due for
              cushions and tubing, and your insurance still has you covered.
              Want me to send those out today?”
            </p>
            <div className="bx-voice-action">
              <Check size={13} /> Order placed · eligibility confirmed
            </div>
          </div>
          <div className="bx-app-panel bx-voice">
            <div className="bx-app-panel-head">
              <b>
                <PhoneOutgoing size={13} /> Outbound · check-in
              </b>
              <span className="bx-voice-timer">
                <span className="dot" /> on call · 02:31
              </span>
            </div>
            <div className="bx-wave" aria-hidden="true">
              {Array.from({ length: 28 }).map((_, i) => (
                <i key={i} style={{ animationDelay: `${i * 50}ms` }} />
              ))}
            </div>
            <p className="bx-voice-transcript">
              “Hi Maria, it&apos;s the team at your DME — no rush at all. I
              wanted to check the new mask is feeling comfortable, and see if
              you need anything before your next resupply.”
            </p>
            <div className="bx-voice-action">
              <Check size={13} /> Follow-up logged · sentiment: positive
            </div>
          </div>
        </div>
        <p className="bx-app-caption">
          Illustrative transcript. Sample data shown — no real patient
          information.
        </p>
      </div>
    </section>
  );
}

/* ── The multi-vendor stack ── */
type StackCard = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const STACK: StackCard[] = [
  {
    icon: <BrainCircuit size={20} />,
    title: "The brain — OpenAI Realtime",
    summary: "A speech-to-speech model that reasons in the moment.",
    points: [
      "Understands intent live — no rigid “press 1 for resupply” menu",
      "Knows your products, policies, and the patient's reorder window",
      "Natural turn-taking with caller barge-in, not a one-way script",
    ],
    gold: true,
  },
  {
    icon: <Waves size={20} />,
    title: "The voice — ElevenLabs",
    summary: "Warm, human-sounding speech your brand can tune.",
    points: [
      "Low-latency streaming voice so replies start fast",
      "Voice, stability, and speed are configurable per practice",
      "Falls back to a built-in voice automatically if it's ever down",
    ],
  },
  {
    icon: <FileText size={20} />,
    title: "The record — Deepgram",
    summary: "An audit-grade transcript of every call, in parallel.",
    points: [
      "A second, independent transcript runs alongside the conversation",
      "Captured to the call record on hangup for your own review",
      "Optional — the call works with or without it",
    ],
  },
  {
    icon: <Sparkles size={20} />,
    title: "The write-up — Claude",
    summary: "A structured summary the second the call ends.",
    points: [
      "Outcome, the follow-ups the agent committed to, and next steps",
      "A patient-sentiment read — positive, neutral, concerned, or distressed",
      "A “recommend a human” flag that routes the sensitive calls to a person",
    ],
    gold: true,
  },
];

function VoiceStack() {
  return (
    <section className="bx-section" id="stack">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> Under the hood
          </span>
          <h2 className="bx-h2">
            Best-in-class models, each where it&apos;s strongest
          </h2>
          <p className="bx-lede">
            The agent isn&apos;t one model doing everything badly — it&apos;s
            four specialists working together: a reasoning brain, a human voice,
            an audit-grade transcriber, and a writer that documents the call.
            And if any one of them is ever unavailable, that piece steps aside
            quietly instead of dropping the call.
          </p>
        </div>
        <div className="bx-caps">
          {STACK.map((c) => (
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

/* ── What your team gets after every call ── */
const AFTER: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <Clock size={22} />,
    metric: "24 / 7",
    metricSub: "answered & placed",
    title: "Never a missed call",
    gold: true,
    body: "Nights, weekends, and the lunch-hour rush are covered. An unanswered outbound call is retried on a sensible cadence before a human is ever pulled in.",
  },
  {
    icon: <FileText size={22} />,
    metric: "Every call",
    metricSub: "summarized",
    title: "A write-up, not a recording to re-listen to",
    body: "Your team opens a clean summary — outcome, commitments, next steps — instead of scrubbing through audio. The full transcript is there if they want it.",
  },
  {
    icon: <Headphones size={22} />,
    metric: "Sentiment",
    metricSub: "flagged",
    title: "The hard calls find a person",
    body: "A concerned or distressed patient — or anyone who asks for a human — is flagged and routed to your team, so the moments that need a person get one.",
  },
  {
    icon: <ShieldCheck size={22} />,
    metric: "On-brand",
    metricSub: "your number",
    title: "It's your practice on the line",
    body: "The agent answers and dials on your own number with your branding, and speaks to your products and policies — patients never know it isn't a teammate.",
  },
];

function AfterCall() {
  return (
    <section className="bx-section" id="after-call">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Receipt size={13} /> After every call
          </span>
          <h2 className="bx-h2">Your team starts where the call left off</h2>
          <p className="bx-lede">
            The agent doesn&apos;t just handle the conversation — it hands your
            staff a finished record. No after-call notes to type, no voicemail
            tag, no “what did they say?” The routine calls close themselves; the
            ones that need a person are already flagged.
          </p>
        </div>
        <div className="bx-pillars">
          {AFTER.map((p) => (
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
          Resupply calls are the most repetitive, after-hours-heavy work in a
          DME office — and the orders behind them are your most predictable
          revenue.{" "}
          <Link href="/breathe/roi">
            See what answering all of them is worth →
          </Link>
        </p>
      </div>
    </section>
  );
}

/* ── Manifesto-style reassurance on reliability ── */
function VoiceManifesto() {
  return (
    <section className="bx-section bx-manifesto-section">
      <div className="bx-shell">
        <figure className="bx-manifesto bx-reveal">
          <Quote className="bx-quote-mark" size={40} aria-hidden="true" />
          <blockquote>
            A vendor key going dark should never cost you a patient call. If a
            voice or transcript provider is unavailable, the agent keeps talking
            on its built-in fallback — the conversation never drops.
          </blockquote>
          <figcaption>
            <span>
              <b>Designed to fail soft</b>
              <i>Reliability, by default</i>
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

export function BreatheAiVoice() {
  useDocumentTitle(
    "AI voice agent — Breathe by CareMetric.ai",
    "Breathe's AI voice agent answers inbound resupply calls and places outbound reorder calls on your own line, 24/7 — confirming coverage, placing the order, and handing your team a summary, sentiment read, and transcript. Built on OpenAI Realtime, ElevenLabs, Deepgram, and Claude.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Mic}
        eyebrow="AI voice agent"
        title={
          <>
            The phones, answered —{" "}
            <span className="grad-em">around the clock.</span>
          </>
        }
        sub="A natural-voice AI agent that works your resupply and status calls 24/7 on your own practice line: it confirms coverage, places the order, and writes up every call — so the most repetitive work in your office stops waiting on a person."
      />
      <CallFlow />
      <VoiceDemo />
      <VoiceStack />
      <AfterCall />
      <VoiceManifesto />
      <ClosingCta />
    </BreatheShell>
  );
}
