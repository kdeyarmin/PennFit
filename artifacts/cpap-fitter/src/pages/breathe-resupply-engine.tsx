import { Fragment } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  CalendarClock,
  Check,
  ChevronDown,
  Cpu,
  CreditCard,
  Mail,
  MessageSquare,
  MessagesSquare,
  Mic,
  Receipt,
  RefreshCw,
  Repeat,
  ShieldCheck,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  TrendingUp,
  Users,
  Workflow,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Resupply revenue engine deep-dive.
 *
 * Resupply is the single most predictable recurring revenue in DME, and the
 * engine that captures it is Breathe's most differentiated surface. This
 * long-form page tells the whole story — and now goes deep on the multi-channel
 * escalation: the channels (text / email / automated AI call / self-serve chat),
 * the response-or-silence logic that steps to the next channel, and the drip
 * campaigns + smart triggers.
 *
 * Accuracy: the escalation is a TRANSPARENT, CONFIGURABLE RULE SET, not a black
 * box. First-touch channel comes from `resolveOutreachPlan` (patient preference
 * → tenant rules by SKU/payer/tenure → SMS-then-email fallback). The ladder is
 * `["sms","email"]` (+ "voice" when the tenant enables it) in
 * `reminder-escalation.ts`, stepped on non-response with admin-tunable spacing
 * (default 3 days between touches anchored on the latest touch; give up at ~21
 * days; voice dialed up to 2×). A confirm/decline/edit on ANY channel moves the
 * episode out of `outreach_pending`/`awaiting_response`, so all further outreach
 * stops. Replies are read by a keyword router with an AI fallback
 * (`sms/inbound.ts` + `ai-fallback-impl.ts`); email/SMS one-tap links are
 * HMAC-signed (`signed-link-tokens.ts`); voice "reached a live person" is
 * `isVoiceCallConnected`. Drip = CSR-designed playbooks
 * (`outreach-playbook-tick.ts`, day-offset multi-step) + behavioral smart
 * triggers (`smart-trigger-*.ts`). Consent/TCPA 9am–8pm window, DND, 48h quiet
 * period, and per-channel opt-out are enforced in `comm-prefs.ts`.
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system; the only
 * new CSS is the `.bx-ladder` infographic in `breathe.css`. Inherits the
 * apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── The escalation cadence (quick horizontal overview) ── */
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
  { icon: <Mail size={15} />, label: "Follow-up email", sub: "if no reply" },
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
            The engine knows each patient's eligibility and reorder window, then
            escalates only as far as it needs to. A text first; a follow-up
            email if that's quiet; a natural AI phone call that talks them
            through it; and at every step, a one-tap signed link that places the
            order with no login. The moment they say yes — on any channel —
            everything else stops.
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

/* ── Channels: meet patients where they actually reply ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const CHANNELS: Cap[] = [
  {
    icon: <MessageSquare size={20} />,
    title: "Text message",
    summary: "Where most patients reply fastest.",
    points: [
      "A one-tap signed link, or a simple reply — “YES” places the order",
      "Phrased it their own way? The assistant still understands “sure, send them”",
      "STOP, a question, or an address change are read and routed instantly",
    ],
    gold: true,
  },
  {
    icon: <Mail size={20} />,
    title: "Email",
    summary: "A clean confirm / edit / stop in one click.",
    points: [
      "Signed, expiring links — confirm, change supplies, or opt out",
      "A safe two-step click so inbox scanners can't trigger an order",
      "Lands with your branding and From address, not a generic blast",
    ],
  },
  {
    icon: <Mic size={20} />,
    title: "Automated AI phone call",
    summary: "A natural-voice agent that can close the reorder live.",
    points: [
      "Confirms coverage and places the order right on the call",
      "Knows voicemail from a live answer — and tries again if no one picks up",
      "On your own number, after hours and on weekends",
    ],
  },
  {
    icon: <MessagesSquare size={20} />,
    title: "Chat & self-serve",
    summary: "An always-open lane that never waits on outreach.",
    points: [
      "Patients reorder anytime in the storefront chat or their account",
      "The on-brand assistant answers “am I due?” and places the order",
      "One more way to say yes — on the patient's schedule, not yours",
    ],
  },
];

function Channels() {
  return (
    <section className="bx-section" id="channels">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Workflow size={13} /> Every channel
          </span>
          <h2 className="bx-h2">
            Meet each patient on <em>their</em> best channel
          </h2>
          <p className="bx-lede">
            Some patients live in text, some only open email, some want to hear
            a voice, and some would rather just tap “reorder” online. Breathe
            starts on the channel most likely to land for that patient — their
            saved preference, or rules you set by product, payer, or how long
            they've been with you — and reads the response however it comes
            back.
          </p>
        </div>
        <div className="bx-caps">
          {CHANNELS.map((c) => (
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

/* ── The escalation algorithm (the ladder infographic) ── */
const LADDER: {
  icon: React.ReactNode;
  channel: string;
  how: string;
  gold?: boolean;
}[] = [
  {
    icon: <MessageSquare size={18} />,
    channel: "Text message",
    how: "Reply YES, or tap the one-tap reorder link",
  },
  {
    icon: <Mail size={18} />,
    channel: "Email",
    how: "One-tap confirm / edit / stop link",
  },
  {
    icon: <Mic size={18} />,
    channel: "Automated AI call",
    how: "Confirms on the call — redialed once if no answer",
    gold: true,
  },
];

function Escalation() {
  return (
    <section className="bx-section bx-section-tight" id="escalation">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> The escalation logic
          </span>
          <h2 className="bx-h2">
            It reads the response — <em>or the silence</em>
          </h2>
          <p className="bx-lede">
            Here's the part that quietly grows revenue: the engine doesn't fire
            once and forget. It starts on the patient's best channel, and if
            there's no response, it waits a set interval and steps to the next
            channel — text, then email, then a natural AI call. The instant the
            patient confirms on <em>any</em> of them, every remaining touch is
            cancelled. Only after the whole ladder comes up empty does a real
            person get involved — with an alert, not a guess.
          </p>
        </div>

        <div className="bx-ladder bx-reveal">
          <span className="bx-ladder-cap start">
            <CalendarClock size={13} /> Reorder window opens — patient is due
          </span>
          {LADDER.map((s, i) => (
            <Fragment key={s.channel}>
              <div className="bx-ladder-step">
                <div className={`bx-ladder-node${s.gold ? " gold" : ""}`}>
                  <span className="bx-ladder-ic">{s.icon}</span>
                  <span className="bx-ladder-meta">
                    <b>{s.channel}</b>
                    <i>{s.how}</i>
                  </span>
                </div>
                <span className="bx-ladder-exit">
                  <Check size={13} /> Responds → order placed, outreach stops
                </span>
              </div>
              {i < LADDER.length - 1 ? (
                <span className="bx-ladder-gap">
                  <ChevronDown size={14} aria-hidden="true" /> No reply · wait
                  ~3 days
                </span>
              ) : null}
            </Fragment>
          ))}
          <span className="bx-ladder-gap">
            <ChevronDown size={14} aria-hidden="true" /> Still quiet after ~21
            days
          </span>
          <span className="bx-ladder-cap end">
            <Users size={13} /> Handed to your team — with an alert
          </span>
        </div>

        <p className="bx-stats-note bx-reveal">
          <SlidersHorizontal
            size={14}
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          You control the whole sequence: the channels, the spacing (default ~3
          days between touches), how long before it gives up (~21 days), and how
          many times the call tries. Every send honors quiet hours, the legal
          9am–8pm calling window, frequency caps, and opt-out — automatically.{" "}
          <Link href="/breathe/communications">
            See the communications layer →
          </Link>
        </p>
      </div>
    </section>
  );
}

/* ── What's inside the engine ── */
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
    title: "Eligibility-aware refill cadence",
    summary: "Remind on the payer schedule — never auto-ship without consent.",
    points: [
      "CMS-style affirmative confirmation before every refill",
      "Cadence from benefits, not a retail subscription calendar",
      "Patients stay supplied without a patient card on file",
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
    title: "Missed-confirmation recovery",
    summary: "Win back the yes that almost happened.",
    points: [
      "An unanswered reminder escalates text → email → AI voice",
      "One-tap signed reorder links stay valid through the window",
      "Staff see who still needs a human nudge",
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
    <section className="bx-section" id="engine">
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

/* ── Drip campaigns & smart triggers ── */
const DRIP_TIMELINE: { day: string; label: string; gold?: boolean }[] = [
  { day: "Day 0", label: "Welcome / first touch" },
  { day: "Day 3", label: "Helpful nudge" },
  { day: "Day 7", label: "Different angle" },
  { day: "Day 14", label: "Last call", gold: true },
];

function Drip() {
  return (
    <section className="bx-section bx-section-tight" id="drip">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Workflow size={13} /> Drip campaigns & triggers
          </span>
          <h2 className="bx-h2">
            Sequences designed to grow reordering — running on their own
          </h2>
          <p className="bx-lede">
            Beyond the per-patient reorder ladder, you can design multi-touch
            drip campaigns and let behavioral triggers fire on their own — for
            onboarding, win-backs, deductible-reset pushes, or coaching a
            patient who's struggling before they give up on therapy.
          </p>
        </div>

        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Workflow size={15} /> A drip you design once, sent for you
          </div>
          <ol className="bx-claims-flow">
            {DRIP_TIMELINE.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.day}
              >
                <span className="bx-claims-ic">
                  <CalendarClock size={15} />
                </span>
                <span className="bx-claims-meta">
                  <b>{s.day}</b>
                  <i>{s.label}</i>
                </span>
                {i < DRIP_TIMELINE.length - 1 ? (
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

        <div className="bx-caps bx-caps-3" style={{ marginTop: 28 }}>
          <article className="bx-cap bx-reveal">
            <div className="bx-cap-head">
              <span className="bx-cap-ic">
                <Workflow size={20} />
              </span>
              <div>
                <h3>Outreach playbooks</h3>
                <p className="bx-cap-summary">
                  Build the sequence once; it runs for every patient you enroll.
                </p>
              </div>
            </div>
            <ul className="bx-cap-list">
              <li>Step it across days and channels — text, email, or a call</li>
              <li>
                Personalized with the patient's name and your practice name
              </li>
              <li>Pauses for opt-outs and quiet hours, then picks back up</li>
            </ul>
          </article>
          <article className="bx-cap bx-reveal gold">
            <div className="bx-cap-head">
              <span className="bx-cap-ic">
                <Sparkles size={20} />
              </span>
              <div>
                <h3>Smart triggers</h3>
                <p className="bx-cap-summary">
                  Behavioral nudges that fire off real therapy signals.
                </p>
              </div>
            </div>
            <ul className="bx-cap-list">
              <li>High mask leak or low usage flags an at-risk patient</li>
              <li>An automatic, helpful nudge goes out before they quit</li>
              <li>Each patient is nudged once per issue — never doubled up</li>
            </ul>
          </article>
          <article className="bx-cap bx-reveal">
            <div className="bx-cap-head">
              <span className="bx-cap-ic">
                <CreditCard size={20} />
              </span>
              <div>
                <h3>Timed to coverage</h3>
                <p className="bx-cap-summary">
                  Reach patients when an order is most billable.
                </p>
              </div>
            </div>
            <ul className="bx-cap-list">
              <li>Deductible-reset pushes when benefits refresh</li>
              <li>Cart-abandonment recovery for orders that stalled</li>
              <li>Onboarding drips through the make-or-break first weeks</li>
            </ul>
          </article>
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
    "Breathe's resupply engine reaches each patient on their best channel — text, email, automated AI call, or self-serve chat — then reads the response (or the silence) and steps to the next channel until they reorder. Configurable cadence, drip campaigns, smart triggers, and one-tap signed reorder links.",
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
        sub="A behavioral-science engine that knows each patient's eligibility and reorder window — then reaches them on the right channel, reads the response or the silence, and escalates until they reorder. The most predictable revenue in DME, captured on autopilot."
      />
      <Cadence />
      <Channels />
      <Escalation />
      <Engine />
      <Drip />
      <Outcome />
      <ClosingCta />
    </BreatheShell>
  );
}
