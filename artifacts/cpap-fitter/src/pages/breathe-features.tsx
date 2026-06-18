import React, { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Bot,
  BrainCircuit,
  CalendarClock,
  Check,
  CircleDollarSign,
  ClipboardSignature,
  Clock,
  FileStack,
  Gauge,
  Headphones,
  LineChart,
  MessageSquare,
  Mic,
  PhoneCall,
  Plug,
  Receipt,
  RefreshCw,
  ScanFace,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Store,
  TrendingUp,
  Users,
  Video,
  Workflow,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import "./breathe.css";

// Icon-only crop of the CareMetric app icon — NOT the full lockup PNG
// (`caremetric-logo.png`), which bakes a "CareMetric AI" wordmark under the
// icon and collides with the "Breathe" text set beside it in the small nav /
// footer brand slots. Matches the asset used across breathe.tsx.
const LOGO = "/breathe/caremetric-icon.png";

/**
 * Breathe — the full features page.
 *
 * The operator's real question is never "what features do you have?" — it's
 * "why would I switch, and what's it worth to my business?" So this page
 * leads with the answer (hours back, revenue captured, a leaner team),
 * proves it with the complete capability catalog, names the AI workforce
 * that does the work, and only then drops into the role-by-role breakdown.
 * Calls to action are threaded through every section.
 *
 * It reuses the namespaced `breathe.css` design system (every rule scoped
 * under `.breathe-page`) plus the `.bxf-*` blocks at the end of that file.
 * Rendered OUTSIDE the patient storefront <Layout> (mounted in TopRouter),
 * lazy-loaded, and `noindex` for the same tenant-domain reason the homepage
 * is.
 */

/* ════════════════════════ Content ════════════════════════ */

const HERO_STATS: {
  to: number;
  suffix: string;
  decimals?: number;
  label: string;
}[] = [
  { to: 50, suffix: "", label: "staff hours handed back every week" },
  { to: 7, suffix: "", label: "point tools collapsed into one login" },
  { to: 22, suffix: "%", label: "lift in first-pass claim acceptance" },
  { to: 2.5, suffix: "×", decimals: 1, label: "more resupply orders captured" },
];

type Lever = {
  icon: React.ReactNode;
  metric: string;
  unit: string;
  title: string;
  body: string;
  points: string[];
};

const LEVERS: Lever[] = [
  {
    icon: <Clock size={22} />,
    metric: "9+ hrs",
    unit: "per teammate, every week",
    title: "Give every seat its week back",
    body: "Breathe automates the repetitive work in every role — the routine calls, the re-keying, the report-pulling, the chasing — so your people spend the day on patients, not busywork.",
    points: [
      "AI voice agent and chatbot field routine calls, texts and emails 24/7",
      "Claims are scrubbed and submitted automatically — reps work only the exceptions",
      "Reminders, faxes, statements and follow-ups all fire on their own",
    ],
  },
  {
    icon: <TrendingUp size={22} />,
    metric: "2.5×",
    unit: "more resupply orders captured",
    title: "Capture the revenue you leave on the table",
    body: "Every missed replacement window and every preventable denial is recurring revenue walking out the door. Breathe closes both — and keeps booking orders around the clock.",
    points: [
      "Eligibility-aware resupply across your whole panel — no window missed",
      "+22% first-pass claim acceptance, with denials worked by dollars recoverable",
      "The 24/7 voice agent books reorders after hours and on weekends",
    ],
  },
  {
    icon: <Users size={22} />,
    metric: "7 → 1",
    unit: "the whole stack, one platform",
    title: "Grow your panel without growing payroll",
    body: "Stop paying for — and swivel-chairing between — a CRM, a resupply tool, an RCM suite, a telehealth app, an e-sign service and a call center. One platform means far more throughput per person.",
    points: [
      "One platform retires seven point tools and their per-seat licenses",
      "After-hours and peak call volume covered with zero added headcount",
      "Every coordinator handles a bigger panel as AI absorbs the routine load",
    ],
  },
];

type Capability = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const CAPABILITIES: Capability[] = [
  {
    icon: <RefreshCw size={20} />,
    title: "Resupply engine",
    summary: "Never miss a replacement window across your whole panel.",
    points: [
      "Eligibility-aware reminders by SMS, email and voice on the right cadence",
      "One-tap signed reorder links — no login, no friction",
      "Subscriptions, autopay and cart-abandonment recovery",
      "A device-driven “supplies due” worklist built from real machine data",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Revenue cycle and claims",
    summary: "Get paid the first time, faster — end to end.",
    points: [
      "Real-time 270/271 eligibility and automatic re-verification",
      "AI-scrubbed 837P auto-submitted via Office Ally — or any clearinghouse",
      "835/ERA auto-posting and denials ranked by dollars recoverable × win odds",
      "Prior auth, A/R aging, timely-filing and capped-rental modifier rotation",
      "Payer profitability, collections forecast and patient statements",
    ],
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Therapy monitoring and compliance",
    summary: "See who is slipping off therapy before they quit.",
    points: [
      "Nightly adherence pulls from ResMed, Philips and 3B device clouds",
      "CMS 90-day compliance cohorts with at-risk alerts",
      "RT encounters, interventions and provider-ready usage reports",
      "Equipment-recall registry with serial-number matching",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient communications",
    summary: "Every conversation in one inbox, fully logged.",
    points: [
      "Unified SMS, MMS, email and inbound-fax inbox with cases and routing",
      "Canned macros, AI-drafted replies and editable message templates",
      "Bulk campaigns, smart triggers and multi-touch outreach playbooks",
      "Delivery tracking that honors consent, quiet hours and frequency caps",
    ],
  },
  {
    icon: <FileStack size={20} />,
    title: "Intake and documents",
    summary: "Clean, signed paperwork in the door — fast.",
    points: [
      "AI referral intake: faxed packets are read and used to pre-fill a patient",
      "One-click CMN, Rx and agreement generation plus e-signature packets",
      "A provider e-sign portal with full signature tracking",
      "Inbound faxes triaged straight onto the right patient record",
    ],
  },
  {
    icon: <Store size={20} />,
    title: "Branded storefront and fitter",
    summary: "A shop that converts shoppers into patients.",
    points: [
      "On-device AI mask fitting from the phone camera — images never leave it",
      "Catalog, cart, Stripe checkout, subscriptions, returns and reviews",
      "Live insurance benefit estimates before a patient ever pays",
      "Your brand, your domain — patient accounts, tracking and POD photos",
    ],
  },
  {
    icon: <Video size={20} />,
    title: "Telehealth",
    summary: "Face-to-face setups and follow-ups, no friction.",
    points: [
      "Built-in video visits for setups, mask fittings and check-ins",
      "One-tap patient join by text or email — no app to install",
      "Auto-scheduled, reminded and summarized for the chart",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "Analytics and automation",
    summary: "Run the business on live signal, not last month's export.",
    points: [
      "Margin, DSO, LTV/CAC, payer-profitability and acquisition-funnel dashboards",
      "KPI alerts and goal tracking that page you before a number slips",
      "Owner weekly digest, CSR productivity and live staffing load",
      "CSV, PDF and QuickBooks exports plus an outbound webhook feed",
    ],
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "Platform and control",
    summary: "Multi-location, multi-tenant, and you stay in control.",
    points: [
      "Role-based access, granular permissions and admin MFA",
      "Feature flags to switch each surface on at your own pace",
      "Locations, team management and per-tenant branded From addresses",
      "PacWare stays your system of record — fill-only, lossless sync",
    ],
  },
];

type AiCell = {
  icon: React.ReactNode;
  title: string;
  body: string;
  gold?: boolean;
};

const AI_CELLS: AiCell[] = [
  {
    icon: <Mic size={22} />,
    title: "24/7 AI voice agent",
    body: "Answers inbound resupply and status calls, confirms coverage, places the order, and hands your team a transcript, summary and sentiment read.",
    gold: true,
  },
  {
    icon: <Receipt size={22} />,
    title: "AI claims engine",
    body: "Scrubs the 837P, predicts denials before they happen, and ranks the worklist by recoverable dollars × win probability.",
    gold: true,
  },
  {
    icon: <Bot size={22} />,
    title: "Admin copilot",
    body: "An in-app assistant that answers “where do I…?” for any teammate and surfaces the next best action across the console.",
  },
  {
    icon: <MessageSquare size={22} />,
    title: "Storefront chatbot",
    body: "Warm, on-brand answers for patients on the web — plus high-confidence email auto-reply with a clean human hand-off.",
  },
  {
    icon: <FileStack size={22} />,
    title: "AI referral intake",
    body: "Drop in a referral fax and the model extracts the patient and clinical details to pre-fill intake — no manual re-keying.",
  },
  {
    icon: <ScanFace size={22} />,
    title: "On-device mask fitting",
    body: "Facial measurements are computed right in the browser, so patients self-fit from their phone and the image never leaves it.",
    gold: true,
  },
  {
    icon: <Headphones size={22} />,
    title: "AI sleep coach",
    body: "Delivers adherence coaching through the make-or-break first weeks, when most patients quit therapy.",
  },
  {
    icon: <Workflow size={22} />,
    title: "SMS intent triage",
    body: "Classifies every inbound text — confirm, question, complaint, opt-out — and routes it to the right place automatically.",
  },
];

type Impact = "time" | "money" | "revenue";

type RoleFeature = {
  icon: React.ReactNode;
  title: string;
  body: string;
  impacts: { kind: Impact; text: string }[];
};

type RoleBlock = {
  id: string;
  icon: React.ReactNode;
  title: string;
  mission: string;
  hours: number;
  features: RoleFeature[];
};

const IMPACT_META: Record<
  Impact,
  { label: string; short: string; icon: React.ReactNode }
> = {
  time: { label: "Saves time", short: "Time", icon: <Clock size={13} /> },
  money: {
    label: "Cuts cost",
    short: "Cost",
    icon: <CircleDollarSign size={13} />,
  },
  revenue: {
    label: "Grows revenue",
    short: "Revenue",
    icon: <TrendingUp size={13} />,
  },
};

const ROLES: RoleBlock[] = [
  {
    id: "csr",
    icon: <PhoneCall size={22} />,
    title: "Patient Coordinator / CSR",
    mission:
      "Field every patient touch — calls, texts, chats, and emails — without a phone tree backlog or a sticky-note worklist.",
    hours: 11,
    features: [
      {
        icon: <Mic size={20} />,
        title: "24/7 AI voice agent",
        body: "A natural-sounding agent answers inbound resupply and order-status calls around the clock, confirms eligibility, places the order, and leaves your team a transcript, summary, and sentiment read.",
        impacts: [
          {
            kind: "time",
            text: "Routine calls never reach a human — reps only touch exceptions.",
          },
          {
            kind: "money",
            text: "Caller-deflection means fewer agents needed to cover peak and after-hours volume.",
          },
          {
            kind: "revenue",
            text: "No missed call after 5pm is a missed reorder — the agent captures orders 24/7.",
          },
        ],
      },
      {
        icon: <Workflow size={20} />,
        title: "Unified conversations inbox",
        body: "Every SMS, email, and web-chat thread lands in one inbox with canned macros and AI-drafted replies, auto-logged to a complete patient timeline.",
        impacts: [
          {
            kind: "time",
            text: "One screen instead of five apps; no manual note-taking.",
          },
          {
            kind: "money",
            text: "Replaces a separate help-desk / shared-inbox tool license.",
          },
        ],
      },
      {
        icon: <Bot size={20} />,
        title: "Storefront chatbot & email auto-reply",
        body: "A warm, on-brand assistant answers patient questions on the web and over email, sending high-confidence replies automatically and handing off cleanly to a human when it should.",
        impacts: [
          {
            kind: "time",
            text: "Common FAQs are answered before they ever hit the queue.",
          },
          {
            kind: "revenue",
            text: "Instant answers keep shoppers in the funnel instead of abandoning.",
          },
        ],
      },
    ],
  },
  {
    id: "rcm",
    icon: <Receipt size={22} />,
    title: "Billing / RCM Specialist",
    mission:
      "Turn a flat denial queue and manual re-keying into an automated pipeline that gets paid the first time, faster.",
    hours: 14,
    features: [
      {
        icon: <Receipt size={20} />,
        title: "Real-time eligibility (270/271)",
        body: "Coverage is verified and re-verified automatically before an order ships, so claims don't go out against lapsed benefits.",
        impacts: [
          {
            kind: "time",
            text: "No payer-portal logins to check coverage one patient at a time.",
          },
          {
            kind: "money",
            text: "Catching a lapse up front avoids the write-off and the rework.",
          },
        ],
      },
      {
        icon: <Sparkles size={20} />,
        title: "AI claim scrubbing & auto-submission",
        body: "The 837P is scrubbed for errors and missing modifiers, then auto-submitted through the Office Ally clearinghouse — clean claims go out without hand-keying.",
        impacts: [
          {
            kind: "time",
            text: "Submission is automated; specialists review exceptions, not every claim.",
          },
          {
            kind: "revenue",
            text: "Higher first-pass acceptance means cash arrives sooner and DSO drops.",
          },
        ],
      },
      {
        icon: <LineChart size={20} />,
        title: "ERA posting & ranked denials worklist",
        body: "Remittances auto-post, and denials arrive ranked by recoverable dollars × win probability instead of in a flat, first-in queue.",
        impacts: [
          {
            kind: "time",
            text: "No manual payment posting; work the highest-value denials first.",
          },
          {
            kind: "revenue",
            text: "Dollars that used to age out as small denials get worked and recovered.",
          },
        ],
      },
      {
        icon: <ClipboardSignature size={20} />,
        title: "Electronic prior authorization (PAS)",
        body: "FHIR-based prior-auth submission through DaVinci PAS keeps auth requests moving without faxing forms back and forth.",
        impacts: [
          {
            kind: "time",
            text: "Auth requests submit electronically instead of by fax-and-wait.",
          },
          {
            kind: "money",
            text: "Fewer no-auth denials that cost a full appeal cycle to recover.",
          },
        ],
      },
    ],
  },
  {
    id: "clinical",
    icon: <Stethoscope size={22} />,
    title: "Respiratory Therapist / Clinical",
    mission:
      "See exactly who is slipping off therapy and reach them — without pulling reports from three device portals by hand.",
    hours: 9,
    features: [
      {
        icon: <Stethoscope size={20} />,
        title: "Live therapy-cloud monitoring",
        body: "Adherence data pulls nightly from ResMed AirView, Philips Care Orchestrator, and 3B React Health into one prioritized board of who is falling off and who is due.",
        impacts: [
          {
            kind: "time",
            text: "One worklist replaces hours of logging into and exporting from device portals.",
          },
          {
            kind: "revenue",
            text: "Patients kept adherent stay on resupply — protecting recurring revenue.",
          },
        ],
      },
      {
        icon: <Video size={20} />,
        title: "Built-in telehealth visits",
        body: "Launch a video visit for setups, mask fittings, and follow-ups. Patients join from a secure one-tap link by text or email — no app to install.",
        impacts: [
          {
            kind: "time",
            text: "No scheduling tool to juggle; the link is sent from the patient record.",
          },
          {
            kind: "money",
            text: "Replaces a separate telehealth subscription.",
          },
          {
            kind: "revenue",
            text: "Remote setups and check-ins fit more patient touches into the same day.",
          },
        ],
      },
      {
        icon: <Activity size={20} />,
        title: "Coaching prompts & sleep coach",
        body: "Compliance is tracked automatically and the AI sleep coach delivers adherence coaching, so the early weeks — when most patients quit — get covered without manual outreach.",
        impacts: [
          {
            kind: "time",
            text: "Coaching outreach is automated for the first-month drop-off window.",
          },
          {
            kind: "revenue",
            text: "Better early adherence means more patients reach resupply eligibility.",
          },
        ],
      },
    ],
  },
  {
    id: "intake",
    icon: <FileStack size={22} />,
    title: "Intake & Documentation",
    mission:
      "Get clean, signed paperwork in the door fast — without hand-sorting faxes or chasing provider signatures.",
    hours: 10,
    features: [
      {
        icon: <ClipboardSignature size={20} />,
        title: "One-click document generation & e-sign",
        body: "Generate CMNs, prescriptions, and agreements, send e-signature packets, and track provider signatures through the whole paperwork pipeline.",
        impacts: [
          {
            kind: "time",
            text: "Documents are generated and routed automatically, not retyped.",
          },
          {
            kind: "money",
            text: "Replaces a standalone e-signature service.",
          },
        ],
      },
      {
        icon: <FileStack size={20} />,
        title: "AI referral intake & fax triage",
        body: "Sleep studies, referrals, and Rx renewals that arrive by fax are read by AI, extracted to pre-fill a patient, and attached to the right record — instead of landing in a shared pile.",
        impacts: [
          {
            kind: "time",
            text: "Faxes are read and matched to the patient automatically — no re-keying.",
          },
          {
            kind: "revenue",
            text: "Documentation gaps close faster, so orders aren't stuck waiting on paper.",
          },
        ],
      },
      {
        icon: <ScanFace size={20} />,
        title: "On-device AI mask fitting",
        body: "Patients get fitted for the right mask from their phone camera. Facial measurements are computed on-device — images never leave the browser.",
        impacts: [
          {
            kind: "time",
            text: "Self-serve fitting removes a manual sizing step from intake.",
          },
          {
            kind: "revenue",
            text: "Right-first-time fit means fewer returns and remakes eating margin.",
          },
        ],
      },
    ],
  },
  {
    id: "owner",
    icon: <Gauge size={22} />,
    title: "Operations Manager / Owner",
    mission:
      "Run the whole business from one source of truth — and consolidate the stack of point tools you license today.",
    hours: 6,
    features: [
      {
        icon: <LineChart size={20} />,
        title: "Live KPI dashboards & alerts",
        body: "Margin, DSO, LTV/CAC, payer profitability, team throughput, and NPS are live in one place, with KPI alerts that page you before a number becomes a problem.",
        impacts: [
          {
            kind: "time",
            text: "No reconciling spreadsheets across tools to build a weekly number.",
          },
          {
            kind: "revenue",
            text: "Acting on live signal — not last month's export — protects margin.",
          },
        ],
      },
      {
        icon: <RefreshCw size={20} />,
        title: "Eligibility-aware resupply engine",
        body: "Reminders go out by SMS, email, and voice on the right cadence with one-tap reorder links, so no replacement window is missed across the whole panel.",
        impacts: [
          {
            kind: "revenue",
            text: "Capturing every eligible resupply is the single biggest recurring-revenue lever in DME.",
          },
          {
            kind: "time",
            text: "No spreadsheets tracking who is due when.",
          },
        ],
      },
      {
        icon: <Bot size={20} />,
        title: "One platform replaces seven tools",
        body: "CRM, resupply, revenue cycle, clinical monitoring, telehealth, documents, and the call-center layer run on one login — with PacWare staying your system of record.",
        impacts: [
          {
            kind: "money",
            text: "Retire the per-seat licenses for the point tools Breathe replaces.",
          },
          {
            kind: "time",
            text: "No swivel-chair between systems and no exports between them.",
          },
        ],
      },
      {
        icon: <CalendarClock size={20} />,
        title: "Month-to-month, your data stays yours",
        body: "One all-in price, no multi-year lock-in, and your patients, orders, and history are exportable on demand — including back out to PacWare.",
        impacts: [
          {
            kind: "money",
            text: "Predictable, all-in pricing instead of metered per-feature add-ons.",
          },
        ],
      },
    ],
  },
];

const INTEGRATIONS = [
  "ResMed AirView",
  "Philips Care Orchestrator",
  "3B React Health",
  "Office Ally",
  "DaVinci PAS",
  "PacWare",
  "Stripe",
  "Twilio",
  "SendGrid",
  "Telnyx Fax",
  "Anthropic",
  "OpenAI",
  "ElevenLabs",
  "Deepgram",
];

/* ════════════════════════ Page ════════════════════════ */

export function BreatheFeatures() {
  useDocumentTitle(
    "Features — Save Time, Grow Revenue, Run Leaner | Breathe by CareMetric.ai",
    "Every feature of the Breathe DME platform: AI voice, automated resupply, AI-driven revenue cycle, therapy monitoring, telehealth and more — and exactly how each one saves time, grows revenue, and lets a leaner team do more.",
    { schema: "Article" },
  );

  useRevealOnScroll();
  useNoIndex();
  useSmoothScroll();

  return (
    <div className="breathe-page">
      <div className="bx-grain" aria-hidden="true" />
      <Nav />
      <main>
        <Intro />
        <Levers />
        <Capabilities />
        <AiWorkforce />
        <Integrations />
        <Roles />
        <BottomLine />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

/* ───────────────────────── Nav ───────────────────────── */
const NAV_ANCHORS: { href: string; label: string }[] = [
  { href: "#levers", label: "Why switch" },
  { href: "#capabilities", label: "Platform" },
  { href: "#ai", label: "AI" },
  { href: "#roles", label: "By role" },
];

function Nav() {
  return (
    <nav className="bx-nav">
      <div className="bx-shell bx-nav-inner">
        <Link className="bx-brand" href="/breathe">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </Link>
        <div className="bx-nav-links">
          {NAV_ANCHORS.map((a) => (
            <a className="bx-nav-anchor" href={a.href} key={a.href}>
              {a.label}
            </a>
          ))}
          <Link
            className="bx-btn bx-btn-primary bx-btn-sm"
            href="/breathe/signup"
          >
            Create account
          </Link>
        </div>
      </div>
    </nav>
  );
}

/* ───────────────────────── Intro / hero ───────────────────────── */
function Intro() {
  return (
    <header className="bx-section bx-hero" id="top">
      <div className="bx-shell">
        <div className="bxf-intro">
          <Link className="bxf-back bx-reveal in" href="/breathe">
            <ArrowLeft size={15} /> Back to overview
          </Link>
          <span className="bx-eyebrow bx-reveal in">
            <span className="bx-dot" />
            Everything Breathe does — and what it&apos;s worth
          </span>
          <h1 className="bx-h1 bx-reveal in">
            Hours back. Revenue captured.
            <br />
            <span className="grad-em">A leaner team that does more.</span>
          </h1>
          <p className="bx-hero-sub bx-reveal in">
            Breathe is the AI-native operating platform that runs your entire
            DME business — intake, resupply, revenue cycle, clinical monitoring,
            telehealth, and every patient conversation — on one login. Below is
            the full catalog, and exactly why owners switch.
          </p>
          <div className="bx-hero-cta bx-reveal in">
            <Link className="bx-btn bx-btn-primary" href="/breathe/signup">
              Create your account <ArrowRight size={17} />
            </Link>
            <a className="bx-btn bx-btn-ghost" href="/breathe#demo">
              See it live on sample data
            </a>
          </div>
          <div className="bx-hero-trust bx-reveal in">
            <BadgeCheck size={15} color="#54c8ff" />
            Free demo · No call · No credit card · Live on day one
          </div>
        </div>

        <StatBand />
      </div>
    </header>
  );
}

function StatBand() {
  return (
    <div className="bx-stats bx-reveal">
      {HERO_STATS.map((s) => (
        <div className="bx-stat" key={s.label}>
          <div className="bx-stat-num">
            <CountUp to={s.to} suffix={s.suffix} decimals={s.decimals} />
          </div>
          <div className="bx-stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────────── Levers ───────────────────────── */
function Levers() {
  return (
    <section className="bx-section" id="levers">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> Three reasons owners switch
          </span>
          <h2 className="bx-h2">
            It pays for itself <em>three ways at once</em>
          </h2>
          <p className="bx-lede">
            Every feature on this page rolls up to the same three outcomes a DME
            owner actually cares about: time given back, revenue captured, and
            more done by a leaner team. Here is how.
          </p>
        </div>
        <div className="bxf-levers">
          {LEVERS.map((l) => (
            <article className="bxf-lever bx-reveal" key={l.title}>
              <div className="bxf-lever-ic">{l.icon}</div>
              <div className="bxf-lever-metric">
                <span className="n">{l.metric}</span>
                <span className="u">{l.unit}</span>
              </div>
              <h3>{l.title}</h3>
              <p>{l.body}</p>
              <ul className="bxf-lever-list">
                {l.points.map((p) => (
                  <li key={p}>
                    <Check size={15} />
                    {p}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want the dollar figure for your panel?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/roi">
            Open the ROI calculator <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Capabilities ───────────────────────── */
function Capabilities() {
  return (
    <section className="bx-section" id="capabilities">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Workflow size={13} /> Everything it does
          </span>
          <h2 className="bx-h2">One platform runs the entire DME business</h2>
          <p className="bx-lede">
            Resupply, revenue cycle, clinical monitoring, patient communication,
            a branded storefront, telehealth, and an AI workforce — every
            workflow on the same patient record. No exports, no swivel-chair, no
            patients lost between systems.
          </p>
        </div>
        <div className="bx-caps">
          {CAPABILITIES.map((c) => (
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
        <div className="bx-price-cta bx-reveal">
          <span>Want to click through every screen and automation?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/product">
            Explore the full platform <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── AI workforce ───────────────────────── */
function AiWorkforce() {
  return (
    <section className="bx-section" id="ai">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> Your AI workforce
          </span>
          <h2 className="bx-h2">
            AI that does the work — <em>not just the talking</em>
          </h2>
          <p className="bx-lede">
            Breathe puts a whole shift of AI teammates on the floor — answering
            calls, drafting replies, scrubbing claims, reading faxes, fitting
            masks, and coaching patients. Best-in-class models from Anthropic,
            OpenAI, and ElevenLabs are wired in where each is strongest, and
            every one degrades gracefully if a key is unset.
          </p>
        </div>
        <div className="bx-features">
          {AI_CELLS.map((c) => (
            <div
              className={`bx-card bx-reveal${c.gold ? " gold" : ""}`}
              key={c.title}
            >
              <span className="bx-tag">AI</span>
              <div className="bx-card-ico">{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>See the AI workforce run on your data — free.</span>
          <a className="bx-btn bx-btn-gold" href="/breathe#demo">
            Start the free demo <ArrowRight size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Integrations ───────────────────────── */
function Integrations() {
  return (
    <section className="bx-section" id="integrations">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Plug size={13} /> Connected out of the box
          </span>
          <h2 className="bx-h2">It plugs into the tools you already run</h2>
          <p className="bx-lede">
            Device clouds, your clearinghouse, prior-auth, payments, messaging,
            and your billing system of record — connected on day one. Flip each
            one on when you&apos;re ready; a missing credential never breaks the
            app.
          </p>
        </div>
        <div className="bxf-chips bx-reveal">
          {INTEGRATIONS.map((name) => (
            <span className="bxf-chip" key={name}>
              <span className="dot" />
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Roles ───────────────────────── */
function Roles() {
  return (
    <>
      <section className="bx-section" id="roles">
        <div className="bx-shell">
          <div className="bx-section-head center bx-reveal">
            <span className="bx-eyebrow">
              <Users size={13} /> Mapped to your team
            </span>
            <h2 className="bx-h2">
              Every feature, mapped to the seat that uses it
            </h2>
            <p className="bx-lede">
              The honest, role-by-role breakdown: for each person on your team,
              exactly what the platform does — and whether each capability saves
              time, cuts cost, or grows revenue.
            </p>
          </div>
          <Legend />
        </div>
      </section>
      {ROLES.map((r) => (
        <RoleSection key={r.id} role={r} />
      ))}
    </>
  );
}

function Legend() {
  return (
    <div className="bxf-legend bx-reveal">
      <span className="bxf-legend-label">How to read this</span>
      <div className="bxf-legend-keys">
        {(Object.keys(IMPACT_META) as Impact[]).map((k) => (
          <span className={`bxf-impact ${k}`} key={k}>
            {IMPACT_META[k].icon}
            {IMPACT_META[k].label}
          </span>
        ))}
      </div>
    </div>
  );
}

function RoleSection({ role }: { role: RoleBlock }) {
  return (
    <section className="bx-section bxf-role-section" id={role.id}>
      <div className="bx-shell">
        <div className="bxf-role-head bx-reveal">
          <div className="bxf-role-id">
            <span className="bx-card-ico">{role.icon}</span>
            <div>
              <h2 className="bx-h2">{role.title}</h2>
              <p className="bxf-role-mission">{role.mission}</p>
            </div>
          </div>
          <div className="bxf-role-hours">
            <span className="n">{role.hours}</span>
            <span className="u">hrs / week back</span>
          </div>
        </div>

        <div className="bxf-feat-grid">
          {role.features.map((f) => (
            <FeatureCard key={f.title} f={f} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ f }: { f: RoleFeature }) {
  return (
    <article className="bxf-feat bx-reveal">
      <div className="bxf-feat-ic">{f.icon}</div>
      <h3>{f.title}</h3>
      <p>{f.body}</p>
      <ul className="bxf-feat-impacts">
        {f.impacts.map((im) => (
          <li key={im.text}>
            <span className={`bxf-impact ${im.kind}`}>
              {IMPACT_META[im.kind].icon}
              {IMPACT_META[im.kind].short}
            </span>
            <span className="bxf-impact-text">{im.text}</span>
          </li>
        ))}
      </ul>
    </article>
  );
}

/* ───────────────────────── Bottom line ───────────────────────── */
const BOTTOM: { icon: React.ReactNode; k: string; v: string; sub: string }[] = [
  {
    icon: <Clock size={20} />,
    k: "Time",
    v: "50 hrs",
    sub: "handed back across a five-seat team every week, by automating the repetitive work in each role.",
  },
  {
    icon: <CircleDollarSign size={20} />,
    k: "Leaner team",
    v: "7 tools",
    sub: "replaced by one platform — retire the per-seat licenses and cover after-hours volume without adding headcount.",
  },
  {
    icon: <TrendingUp size={20} />,
    k: "Revenue",
    v: "Every window",
    sub: "captured — higher first-pass claims and no missed resupply across the panel.",
  },
];

function BottomLine() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <TrendingUp size={13} /> The bottom line
          </span>
          <h2 className="bx-h2">Time saved. Revenue grown. Team set free.</h2>
          <p className="bx-lede">
            Add up the automations on this page and the platform pays for itself
            three ways at once. Size it for your own panel in the ROI
            calculator.
          </p>
        </div>
        <div className="bxf-bottom">
          {BOTTOM.map((b) => (
            <div className="bxf-bottom-card bx-reveal" key={b.k}>
              <div className="bxf-bottom-ic">{b.icon}</div>
              <div className="bxf-bottom-k">{b.k}</div>
              <div className="bxf-bottom-v">{b.v}</div>
              <p>{b.sub}</p>
            </div>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want the number for your panel?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/roi">
            Open the ROI calculator <ArrowRight size={16} />
          </Link>
        </div>
        <p className="bxf-footnote bx-reveal">
          Figures are illustrative ranges grounded in published DME and
          revenue-cycle benchmarks — directional, not a guarantee. The ROI
          calculator models the range for your own panel and staffing.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Closing CTA ───────────────────────── */
function ClosingCta() {
  return (
    <section className="bx-section" id="demo">
      <div className="bx-shell">
        <div className="bx-cta bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> Ready when you are
          </span>
          <h2>See it run for your team.</h2>
          <p>
            Spin up your own workspace and walk your coordinators, billers, and
            clinicians through every feature above — free, on sample data, no
            call required.
          </p>
          <div className="bx-cta-row">
            <Link className="bx-btn bx-btn-gold" href="/breathe/signup">
              Create your account <ArrowRight size={17} />
            </Link>
            <Link className="bx-btn bx-btn-ghost" href="/breathe/roi">
              Calculate your ROI
            </Link>
          </div>
          <div className="bx-cta-meta">
            <span>
              <BadgeCheck size={13} /> No credit card
            </span>
            <span>
              <Check size={13} /> Sample data only
            </span>
            <span>
              <ArrowRight size={13} /> Live on day one
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Footer ───────────────────────── */
function Footer() {
  return (
    <footer className="bx-footer">
      <div className="bx-shell bx-footer-inner">
        <Link className="bx-brand" href="/breathe">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </Link>
        <p className="bx-footer-note">
          Breathe is the AI-native operating platform for durable medical
          equipment providers, built by CareMetric.ai. HIPAA-eligible
          infrastructure; patient imagery is processed on-device and never
          transmitted.
        </p>
        <div className="bx-brand-sub">
          © {new Date().getFullYear()} CareMetric.ai
        </div>
      </div>
    </footer>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */
/* These mirror the small effects on the Breathe homepage so this
   companion page is fully self-contained (the homepage versions are
   module-private). */

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function CountUp({
  to,
  suffix = "",
  prefix = "",
  decimals = 0,
}: {
  to: number;
  suffix?: string;
  prefix?: string;
  decimals?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      setVal(to);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || done.current) return;
        done.current = true;
        const start = performance.now();
        const dur = 1300;
        const tick = (now: number) => {
          const p = Math.min(1, (now - start) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          setVal(to * eased);
          if (p < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
        io.disconnect();
      },
      { threshold: 0.5 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [to]);

  return (
    <span ref={ref}>
      {prefix}
      {val.toFixed(decimals)}
      {suffix}
    </span>
  );
}

function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, follow";
    document.head.appendChild(meta);
    return () => {
      meta.remove();
    };
  }, []);
}

function useSmoothScroll() {
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const root = document.documentElement;
    const prev = root.style.scrollBehavior;
    root.style.scrollBehavior = "smooth";
    return () => {
      root.style.scrollBehavior = prev;
    };
  }, []);
}

function useRevealOnScroll() {
  useEffect(() => {
    const nodes = Array.from(
      document.querySelectorAll<HTMLElement>(
        ".breathe-page .bx-reveal:not(.in)",
      ),
    );
    if (typeof IntersectionObserver === "undefined") {
      nodes.forEach((n) => n.classList.add("in"));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, []);
}

export default BreatheFeatures;
