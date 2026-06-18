import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import {
  type LucideIcon,
  Activity,
  ArrowRight,
  ArrowUpRight,
  BadgeCheck,
  Bot,
  BrainCircuit,
  CalendarClock,
  Check,
  ChevronDown,
  CircleDollarSign,
  ClipboardSignature,
  Cpu,
  Database,
  FileStack,
  Gauge,
  GitBranch,
  Headphones,
  KeyRound,
  LineChart,
  Lock,
  Menu,
  MessageSquare,
  Mic,
  Minus,
  Network,
  PhoneCall,
  Plug,
  Quote,
  Radio,
  Receipt,
  RefreshCw,
  ScanFace,
  Server,
  ShieldCheck,
  Sparkles,
  Stethoscope,
  Store,
  TrendingUp,
  Video,
  Waypoints,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import "./breathe.css";

// Icon-only crop of the CareMetric app icon. The full lockup PNG
// (`caremetric-logo.png`) bakes a "CareMetric AI" wordmark UNDER the icon;
// squished into the small square brand slots it turned illegible and
// collided with the "Breathe" text we render beside it. Every on-page
// lockup pairs this square icon with separately-set brand text, so the
// wordmark version is never the right asset here.
const LOGO = "/breathe/caremetric-icon.png";

/**
 * Breathe — the public marketing / showcase homepage for the DME
 * operating platform built by CareMetric.ai.
 *
 * This is a self-contained surface: it renders OUTSIDE the patient
 * storefront <Layout> (mounted directly in TopRouter) with its own dark
 * "command center" chrome, and every style lives in the namespaced
 * `breathe.css` so nothing here can clobber the storefront/admin token
 * systems. Lazy-loaded, so its CSS + this component never weigh on the
 * patient-shop initial bundle.
 *
 * Art direction (2026 rebuild): editorial-meets-command-center. A
 * distinctive optical serif (Fraunces) carries the display voice over a
 * refined grotesque (Hanken) body, on the brand's deep-navy luminance —
 * a look no legacy DME vendor has. Both fonts are SELF-HOSTED woff2 in
 * /public/fonts so the page stays same-origin (the app's CSP forbids
 * third-party font CDNs).
 */
/**
 * Shared chrome for every Breathe marketing page — the dark page shell,
 * sticky nav, footer, and the reveal / no-index / smooth-scroll effects.
 * The story used to live on one very long single-scroll page; it is now
 * split into nav-aligned routes (Product, Compare, ROI, Pricing, Security)
 * so each page stays short and focused. Every page renders its own slice of
 * sections inside this shell.
 */
function BreatheShell({ children }: { children: React.ReactNode }) {
  useRevealOnScroll();
  useNoIndex();
  useSmoothScroll();
  useInitialHashScroll();

  return (
    <div className="breathe-page">
      <div className="bx-grain" aria-hidden="true" />
      <Nav />
      <main>{children}</main>
      <Footer />
    </div>
  );
}

/**
 * Compact header for the inner pages: eyebrow, H1, and a lede — so each
 * split-out page has its own title and context instead of opening cold on
 * a content section.
 */
function PageHead({
  icon: Icon,
  eyebrow,
  title,
  sub,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: React.ReactNode;
  sub: string;
}) {
  return (
    <header className="bx-section bx-pagehead" id="top">
      <div className="bx-shell">
        <span className="bx-eyebrow bx-reveal in">
          <Icon size={13} />
          {eyebrow}
        </span>
        <h1 className="bx-pagehead-title bx-reveal in">{title}</h1>
        <p className="bx-pagehead-sub bx-reveal in">{sub}</p>
      </div>
    </header>
  );
}

/* Landing — the elevator pitch: hero, integrations, what it replaces, CTA. */
export function BreatheHome() {
  useDocumentTitle(
    "Breathe — The DME Operating Platform by CareMetric.ai",
    "Breathe is the AI-native operating platform for durable medical equipment companies: patient CRM, resupply automation, revenue-cycle, therapy monitoring, telehealth, and an AI voice agent in one system.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <Hero />
      <IntegrationsStrip />
      <Lifecycle />
      <Capabilities />
      <Replaces />
      <PricingHome />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Product tour — how the platform runs the whole DME lifecycle. */
export function BreatheProduct() {
  useDocumentTitle(
    "Product tour — Breathe by CareMetric.ai",
    "See how Breathe runs the entire DME lifecycle in one system: intake, the resupply engine, revenue cycle, clinical monitoring, and the AI voice agent.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Workflow}
        eyebrow="Product tour"
        title={
          <>
            One platform for the{" "}
            <span className="grad-em">whole lifecycle.</span>
          </>
        }
        sub="From the first intake call to the last reconciled claim — see the console, the automations, and the AI that run a modern DME business."
      />
      <Lifecycle />
      <DayInLife />
      <ProductShowcase />
      <Features />
      <RevenueCycle />
      <AiBento />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Compare — how Breathe stacks up against legacy DME software, by role. */
export function BreatheCompare() {
  useDocumentTitle(
    "How Breathe compares — Breathe by CareMetric.ai",
    "How Breathe compares to legacy DME software, and how much time it gives back to every role on your team.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={BrainCircuit}
        eyebrow="Compare"
        title={
          <>
            Built AI-native, <span className="grad-em">not bolted on.</span>
          </>
        }
        sub="Legacy DME systems bolt modules onto decades-old cores. See the line-by-line difference — and what it means for each person on your team."
      />
      <Comparison />
      <WhyDifferent />
      <Roles />
      <ClosingCta />
    </BreatheShell>
  );
}

/* ROI — the interactive calculator. */
export function BreatheRoi() {
  useDocumentTitle(
    "ROI calculator — Breathe by CareMetric.ai",
    "Estimate what Breathe is worth to your DME business: staff time recovered, revenue-cycle recovery, resupply growth, and the point tools it replaces.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={LineChart}
        eyebrow="ROI"
        title={
          <>
            Size the <span className="grad-em">return.</span>
          </>
        }
        sub="Estimate what Breathe gives back on your own numbers — staff hours, revenue-cycle recovery, resupply growth, and the seven point tools you stop paying for."
      />
      <Roi />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Pricing — how it's priced, and how migration works. */
export function BreathePricing() {
  useDocumentTitle(
    "Pricing — Breathe by CareMetric.ai",
    "One platform, one price. How Breathe is priced, and how a guided migration gets your DME business live in weeks.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={CircleDollarSign}
        eyebrow="Pricing"
        title={
          <>
            Priced like <span className="grad-em">one platform.</span>
          </>
        }
        sub="No per-module upsells, no surprise line items — and a guided migration that gets you live in weeks, not quarters."
      />
      <Pricing />
      <Onboarding />
      <ClosingCta />
    </BreatheShell>
  );
}

/* Security — posture, the why behind it, and the FAQ. */
export function BreatheSecurity() {
  useDocumentTitle(
    "Security — Breathe by CareMetric.ai",
    "Breathe's security posture: HIPAA-eligible infrastructure, on-device patient imaging, and the principles behind the platform.",
  );
  return (
    <BreatheShell>
      <PageHead
        icon={ShieldCheck}
        eyebrow="Security"
        title={
          <>
            Patient trust, <span className="grad-em">engineered in.</span>
          </>
        }
        sub="HIPAA-eligible infrastructure, on-device patient imaging, and a least-privilege posture — the questions your compliance team will ask, answered."
      />
      <Security />
      <Manifesto />
      <Faq />
      <ClosingCta />
    </BreatheShell>
  );
}

/* ───────────────────────── Nav ───────────────────────── */
const NAV_LINKS: { href: string; label: string }[] = [
  { href: "/breathe/product", label: "Product" },
  { href: "/breathe/compare", label: "Compare" },
  { href: "/breathe/roi", label: "ROI" },
  { href: "/breathe/pricing", label: "Pricing" },
  { href: "/breathe/security", label: "Security" },
];

function Nav() {
  const [loc] = useLocation();
  const [open, setOpen] = useState(false);
  // Close the mobile menu on any route change so it never lingers open.
  useEffect(() => {
    setOpen(false);
  }, [loc]);
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
          {NAV_LINKS.map((l) => (
            <Link
              className={"bx-nav-anchor" + (loc === l.href ? " is-active" : "")}
              href={l.href}
              key={l.href}
            >
              {l.label}
            </Link>
          ))}
          <a className="bx-btn bx-btn-primary bx-btn-sm" href="#demo">
            Request a demo
          </a>
        </div>
        <button
          type="button"
          className="bx-nav-toggle"
          aria-label={open ? "Close menu" : "Open menu"}
          aria-expanded={open}
          aria-controls="bx-nav-mobile"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>
      {open ? (
        <div className="bx-nav-mobile" id="bx-nav-mobile">
          <div className="bx-shell bx-nav-mobile-inner">
            {NAV_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={
                  "bx-nav-mobile-link" + (loc === l.href ? " is-active" : "")
                }
                onClick={() => setOpen(false)}
              >
                {l.label}
              </Link>
            ))}
            <a
              className="bx-btn bx-btn-primary bx-nav-mobile-demo"
              href="#demo"
              onClick={() => setOpen(false)}
            >
              Request a demo
            </a>
          </div>
        </div>
      ) : null}
    </nav>
  );
}

/* ───────────────────────── Hero ───────────────────────── */
function Hero() {
  const onMove = (e: React.MouseEvent<HTMLElement>) => {
    if (prefersReducedMotion()) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width - 0.5) * 2;
    const py = ((e.clientY - r.top) / r.height - 0.5) * 2;
    e.currentTarget.style.setProperty("--px", px.toFixed(3));
    e.currentTarget.style.setProperty("--py", py.toFixed(3));
  };
  const onLeave = (e: React.MouseEvent<HTMLElement>) => {
    e.currentTarget.style.setProperty("--px", "0");
    e.currentTarget.style.setProperty("--py", "0");
  };
  return (
    <header
      className="bx-section bx-hero"
      id="top"
      onMouseMove={onMove}
      onMouseLeave={onLeave}
    >
      <div className="bx-shell">
        <div className="bx-hero-grid">
          <div className="bx-hero-copy">
            <span className="bx-eyebrow bx-reveal in">
              <span className="bx-dot" />
              The AI-native platform for DME
            </span>
            <h1 className="bx-h1 bx-reveal in">
              Run your entire DME
              <br />
              business on <span className="grad-em">one breath.</span>
            </h1>
            <p className="bx-hero-sub bx-reveal in">
              Breathe unifies intake, resupply, revenue cycle, clinical
              monitoring, and patient communication into a single AI-native
              system — so your team stops stitching seven tools together and
              starts caring for patients.
            </p>
            <div className="bx-hero-cta bx-reveal in">
              <a className="bx-btn bx-btn-primary" href="#demo">
                Request a demo <ArrowRight size={17} />
              </a>
              <a className="bx-btn bx-btn-ghost" href="#capabilities">
                See what it does
              </a>
            </div>
            <div className="bx-hero-trust bx-reveal in">
              <BadgeCheck size={15} color="#54c8ff" />
              HIPAA-eligible · SOC&nbsp;2-aligned posture · On-device patient
              imaging
            </div>
          </div>

          <div className="bx-orb-wrap bx-reveal in">
            <div className="bx-orb-aura" aria-hidden="true" />
            <div className="bx-orb">
              <div className="bx-orb-ring r3" />
              <div className="bx-orb-ring r2" />
              <div className="bx-orb-ring" />
              <div className="bx-orb-core">
                <img className="bx-orb-logo" src={LOGO} alt="CareMetric AI" />
              </div>
              <div className="bx-orb-chip c1">
                <span className="ico">
                  <Mic size={15} />
                </span>
                AI voice agent · live
              </div>
              <div className="bx-orb-chip c2">
                <span className="ico">
                  <Receipt size={15} />
                </span>
                Claim auto-submitted
              </div>
              <div className="bx-orb-chip c3">
                <span className="ico gold">
                  <RefreshCw size={15} />
                </span>
                Resupply reorder placed
              </div>
            </div>
          </div>
        </div>

        <StatBand />
      </div>
    </header>
  );
}

const STATS: { num: number; suffix: string; prefix?: string; label: string }[] =
  [
    { num: 7, suffix: "", label: "point tools replaced by one platform" },
    { num: 38, suffix: "%", label: "less time per resupply order" },
    { num: 22, suffix: "%", label: "lift in first-pass claim acceptance" },
    { num: 9, suffix: "+ hrs", label: "saved per staff member each week" },
  ];

function StatBand() {
  return (
    <div className="bx-stats bx-reveal">
      {STATS.map((s) => (
        <div className="bx-stat" key={s.label}>
          <div className="bx-stat-num">
            <CountUp to={s.num} prefix={s.prefix} suffix={s.suffix} />
          </div>
          <div className="bx-stat-label">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

/* ───────────────────── Integrations strip ───────────────────── */
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
];

function IntegrationsStrip() {
  return (
    <section className="bx-integrations bx-reveal" aria-label="Integrations">
      <div className="bx-shell">
        <p className="bx-integrations-label">
          <Plug size={13} /> Connected to the device clouds, clearinghouses, and
          billing systems you already run
        </p>
        {/* The marquee duplicates the list for the animation, so it is
            aria-hidden; this visually-hidden list exposes the partner
            names to assistive tech exactly once. */}
        <ul className="bx-sr-only">
          {INTEGRATIONS.map((name) => (
            <li key={name}>{name}</li>
          ))}
        </ul>
      </div>
      <div className="bx-marquee" aria-hidden="true">
        <div className="bx-marquee-track">
          {[...INTEGRATIONS, ...INTEGRATIONS].map((name, i) => (
            <span className="bx-marquee-item" key={`${name}-${i}`}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Replaces strip ───────────────────────── */
const REPLACED = [
  "Resupply software",
  "Billing / RCM suite",
  "Patient CRM",
  "Telehealth app",
  "Document & e-sign",
  "Therapy dashboards",
  "Call-center IVR",
];

function Replaces() {
  return (
    <div className="bx-shell bx-replace bx-reveal">
      <div className="bx-replace-label">One login instead of seven</div>
      <div className="bx-replace-row">
        {REPLACED.map((r) => (
          <span className="bx-replace-pill" key={r}>
            <s>{r}</s>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ───────────────────────── Lifecycle pipeline ───────────────────────── */
const LIFECYCLE: { icon: React.ReactNode; label: string }[] = [
  { icon: <PhoneCall size={18} />, label: "Intake" },
  { icon: <BadgeCheck size={18} />, label: "Eligibility" },
  { icon: <ScanFace size={18} />, label: "Mask fitting" },
  { icon: <Receipt size={18} />, label: "Order" },
  { icon: <RefreshCw size={18} />, label: "Fulfillment" },
  { icon: <Stethoscope size={18} />, label: "Monitoring" },
  { icon: <CalendarClock size={18} />, label: "Resupply" },
  { icon: <LineChart size={18} />, label: "Revenue" },
];

function Lifecycle() {
  return (
    <section className="bx-section bx-lifecycle-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Waypoints size={13} /> The whole lifecycle
          </span>
          <h2 className="bx-h2">One continuous workflow, end to end</h2>
          <p className="bx-lede">
            From the first intake call to the last reconciled claim, every stage
            of the DME lifecycle runs on the same data — no exports, no
            swivel-chair, no patients lost between systems.
          </p>
        </div>
        <div className="bx-pipeline bx-reveal">
          <div className="bx-pipeline-line">
            <span className="bx-pipeline-pulse" />
          </div>
          <ol className="bx-pipeline-nodes">
            {LIFECYCLE.map((s, i) => (
              <li className="bx-pipe-node" key={s.label}>
                <span className="bx-pipe-dot">{s.icon}</span>
                <span className="bx-pipe-label">{s.label}</span>
                <span className="bx-pipe-idx">{`0${i + 1}`}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── A day on Breathe ───────────────────────── */
/*
 * The concrete "what does it actually do" story — one operating day told
 * as the events the platform handles on its own, from before the team
 * logs in to the owner's end-of-day read. Every beat maps to shipped
 * functionality (nightly therapy sync, the resupply worklist, the AI
 * voice agent, the unified inbox + email auto-reply, Office Ally
 * submission + ERA posting, the therapy board + video visits, AI referral
 * intake + CMN drafting, and the live owner dashboards/KPI alerts).
 */
const DAY: {
  icon: React.ReactNode;
  time: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <RefreshCw size={20} />,
    time: "Before anyone logs in",
    title: "The day builds itself overnight",
    body: "The nightly sync pulls adherence from ResMed, Philips, and 3B; the resupply engine assembles an eligibility-ranked worklist; and the AI voice agent has already answered after-hours calls and booked the reorders behind them.",
  },
  {
    icon: <MessageSquare size={20} />,
    time: "8:30 AM",
    title: "Coordinators open one inbox",
    body: "SMS, email, and inbound faxes are already triaged to the right patient. High-confidence email questions were answered automatically overnight; the rest wait as drafts, so reps start on exceptions instead of a backlog.",
  },
  {
    icon: <Receipt size={20} />,
    time: "10:00 AM",
    title: "Billing works dollars, not a queue",
    body: "Clean 837P claims auto-submit through Office Ally, this morning's ERAs auto-post, and the denials worklist is already ranked by recoverable dollars × win probability — the biggest recoveries first.",
    gold: true,
  },
  {
    icon: <Video size={20} />,
    time: "1:00 PM",
    title: "Clinical reaches the right patients",
    body: "The therapy board surfaces three patients slipping in their first month. An RT launches a video visit with a one-tap link — no scheduling tool, no app for the patient to install.",
  },
  {
    icon: <FileStack size={20} />,
    time: "3:00 PM",
    title: "New business walks in by fax",
    body: "A referral fax arrives; AI extracts the patient and clinical details and pre-fills intake. The CMN drafts from therapy data and routes for e-signature — the order moves without anyone re-keying paper.",
    gold: true,
  },
  {
    icon: <LineChart size={20} />,
    time: "End of day",
    title: "The owner sees the real number",
    body: "Margin, DSO, and collections are live — not a month-old export. A KPI alert already flagged the one payer trending toward trouble, while the rest of the business ran itself.",
  },
];

function DayInLife() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CalendarClock size={13} /> A day on Breathe
          </span>
          <h2 className="bx-h2">What the platform does while you work</h2>
          <p className="bx-lede">
            The same operating day, told as the work the system handles on its
            own — so your team spends the hours on patients, not on stitching
            tools together.
          </p>
        </div>
        <ol className="bx-day bx-reveal">
          {DAY.map((d) => (
            <li className={`bx-day-item${d.gold ? " gold" : ""}`} key={d.time}>
              <span className="bx-day-dot">{d.icon}</span>
              <div className="bx-day-body">
                <span className="bx-day-time">{d.time}</span>
                <h3>{d.title}</h3>
                <p>{d.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/* ───────────────────────── Product showcase ───────────────────────── */
const SIDE_NAV: { icon: React.ReactNode; label: string; active?: boolean }[] = [
  { icon: <Gauge size={15} />, label: "Today", active: true },
  { icon: <Activity size={15} />, label: "Patients" },
  { icon: <RefreshCw size={15} />, label: "Resupply" },
  { icon: <Receipt size={15} />, label: "Claims" },
  { icon: <MessageSquare size={15} />, label: "Conversations" },
  { icon: <Stethoscope size={15} />, label: "Therapy" },
  { icon: <Video size={15} />, label: "Telehealth" },
  { icon: <LineChart size={15} />, label: "Analytics" },
];

const KPIS: {
  icon: React.ReactNode;
  label: string;
  value: string;
  delta: string;
  gold?: boolean;
}[] = [
  {
    icon: <RefreshCw size={15} />,
    label: "Resupply due",
    value: "248",
    delta: "+12 today",
  },
  {
    icon: <Receipt size={15} />,
    label: "First-pass claims",
    value: "94%",
    delta: "+3.1 pts",
  },
  {
    icon: <LineChart size={15} />,
    label: "Collected MTD",
    value: "$182.4k",
    delta: "on pace",
    gold: true,
  },
  {
    icon: <Stethoscope size={15} />,
    label: "At-risk patients",
    value: "37",
    delta: "−8 this wk",
  },
];

const WORKLIST: {
  initials: string;
  device: string;
  status: string;
  tone: "eligible" | "verify" | "auto" | "hold";
}[] = [
  {
    initials: "J·M",
    device: "AirSense 11",
    status: "Due now",
    tone: "eligible",
  },
  {
    initials: "R·K",
    device: "DreamStation 2",
    status: "Verify Rx",
    tone: "verify",
  },
  {
    initials: "S·P",
    device: "AirCurve VAuto",
    status: "Reorder placed",
    tone: "auto",
  },
  {
    initials: "T·W",
    device: "3B Luna G3",
    status: "Due now",
    tone: "eligible",
  },
  {
    initials: "D·L",
    device: "AirSense 10",
    status: "Awaiting Rx",
    tone: "hold",
  },
];

const DENIALS: { reason: string; amount: string; pct: number }[] = [
  { reason: "Prior auth missing", amount: "$4,210", pct: 100 },
  { reason: "Invalid HCPCS modifier", amount: "$1,980", pct: 47 },
  { reason: "Eligibility lapse", amount: "$1,140", pct: 27 },
];

const SPARK = [34, 41, 38, 50, 46, 58, 55, 67, 74, 70, 86, 96];

function Sparkline() {
  const w = 240;
  const h = 54;
  const pad = 5;
  const max = Math.max(...SPARK);
  const min = Math.min(...SPARK);
  const pts = SPARK.map((v, i) => {
    const x = pad + (i / (SPARK.length - 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
    return [x, y] as const;
  });
  const line = pts
    .map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1]!;
  const first = pts[0]!;
  const area = `${line} L${last[0].toFixed(1)} ${h} L${first[0].toFixed(1)} ${h} Z`;
  return (
    <svg
      className="bx-spark"
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="bxSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bx-cyan)" stopOpacity="0.36" />
          <stop offset="100%" stopColor="var(--bx-cyan)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#bxSparkFill)" />
      <path
        d={line}
        fill="none"
        stroke="var(--bx-cyan)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      <circle cx={last[0]} cy={last[1]} r="2.6" fill="var(--bx-mint)" />
    </svg>
  );
}

function ProductShowcase() {
  return (
    <section className="bx-section" id="product">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Cpu size={13} /> The command center
          </span>
          <h2 className="bx-h2">Your whole operation, on one screen</h2>
          <p className="bx-lede">
            Every queue, every claim, every conversation, and a live AI voice
            agent — in one console your team actually wants to work in.
          </p>
        </div>

        <div className="bx-app-frame bx-reveal">
          {/* Decorative illustrative UI — hidden from assistive tech so the
              sample sidebar/worklist text is not announced as real content
              (the section heading + caption convey the message). */}
          <div className="bx-app" aria-hidden="true">
            <div className="bx-app-top">
              <span className="bx-app-dots">
                <i />
                <i />
                <i />
              </span>
              <span className="bx-app-url">
                <Lock size={11} /> app.cmbreathe.com/admin/today
              </span>
              <span className="bx-app-live">
                <span className="dot" /> Live
              </span>
            </div>

            <div className="bx-app-body">
              <aside className="bx-app-side">
                <div className="bx-app-brand">
                  <img src={LOGO} alt="" />
                  <b>Breathe</b>
                </div>
                <nav className="bx-app-nav">
                  {SIDE_NAV.map((n) => (
                    <span
                      className={`bx-app-navitem${n.active ? " active" : ""}`}
                      key={n.label}
                    >
                      {n.icon}
                      {n.label}
                    </span>
                  ))}
                </nav>
                <div className="bx-app-pilot">
                  <Bot size={14} />
                  <span>
                    <b>CareMetric Copilot</b>
                    <i>AI copilot · ready</i>
                  </span>
                </div>
              </aside>

              <div className="bx-app-main">
                <div className="bx-app-head">
                  <div>
                    <div className="bx-app-hello">Good morning, Maria</div>
                    <div className="bx-app-sub">
                      Tuesday · 248 patients due this week
                    </div>
                  </div>
                  <div className="bx-app-search">
                    <span>Search patients, orders, claims…</span>
                    <kbd>⌘K</kbd>
                  </div>
                </div>

                <div className="bx-app-kpis">
                  {KPIS.map((k) => (
                    <div
                      className={`bx-app-kpi${k.gold ? " gold" : ""}`}
                      key={k.label}
                    >
                      <span className="bx-app-kpi-ic">{k.icon}</span>
                      <span className="bx-app-kpi-label">{k.label}</span>
                      <span className="bx-app-kpi-val">{k.value}</span>
                      <span className="bx-app-kpi-delta">{k.delta}</span>
                    </div>
                  ))}
                </div>

                <div className="bx-app-cols">
                  <div className="bx-app-panel">
                    <div className="bx-app-panel-head">
                      <b>Resupply worklist</b>
                      <span>Eligibility-ranked</span>
                    </div>
                    <ul className="bx-worklist">
                      {WORKLIST.map((w) => (
                        <li key={w.initials}>
                          <span className="bx-avatar">{w.initials}</span>
                          <span className="bx-worklist-meta">
                            <b>{w.device}</b>
                            <i>Resupply window open</i>
                          </span>
                          <span className={`bx-pill ${w.tone}`}>
                            {w.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>

                  <div className="bx-app-stack">
                    <div className="bx-app-panel bx-voice">
                      <div className="bx-app-panel-head">
                        <b>
                          <Mic size={13} /> AI voice agent
                        </b>
                        <span className="bx-voice-timer">
                          <span className="dot" /> on call · 02:14
                        </span>
                      </div>
                      <div className="bx-wave" aria-hidden="true">
                        {Array.from({ length: 28 }).map((_, i) => (
                          <i
                            key={i}
                            style={{ animationDelay: `${i * 60}ms` }}
                          />
                        ))}
                      </div>
                      <p className="bx-voice-transcript">
                        “…confirming your mask cushion and tubing for this
                        month&apos;s resupply — I have you all set.”
                      </p>
                      <div className="bx-voice-action">
                        <Check size={13} /> Order #80432 placed · eligibility
                        confirmed
                      </div>
                    </div>

                    <div className="bx-app-panel bx-denials">
                      <div className="bx-app-panel-head">
                        <b>Denials by $ recoverable</b>
                        <span>worklist</span>
                      </div>
                      {DENIALS.map((d) => (
                        <div className="bx-denial" key={d.reason}>
                          <span className="bx-denial-k">{d.reason}</span>
                          <span className="bx-denial-v">{d.amount}</span>
                          <span className="bx-denial-bar">
                            <i style={{ width: `${d.pct}%` }} />
                          </span>
                        </div>
                      ))}
                    </div>

                    <div className="bx-app-panel bx-collections">
                      <div className="bx-app-panel-head">
                        <b>
                          <TrendingUp size={13} /> Collections
                        </b>
                        <span>last 7 days</span>
                      </div>
                      <Sparkline />
                      <div className="bx-collections-foot">
                        <span className="amt">$1.21M collected</span>
                        <span className="up">
                          <TrendingUp size={11} /> 8.4%
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div className="bx-app-glow" aria-hidden="true" />
        </div>
        <p className="bx-app-caption">
          Illustrative interface. Sample data shown — no real patient
          information.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Features ───────────────────────── */
type Feature = {
  icon: React.ReactNode;
  title: string;
  body: string;
  tag?: string;
  gold?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: <Mic size={22} />,
    title: "AI Voice Agent",
    body: "A natural-sounding agent answers resupply calls, confirms eligibility, and books orders 24/7 — then leaves a structured summary and sentiment read for your team.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <RefreshCw size={22} />,
    title: "Resupply Automation",
    body: "Eligibility-aware reminders go out by SMS, email, and voice on the right cadence, with one-tap reorder links. No spreadsheets, no missed replacement windows.",
  },
  {
    icon: <Receipt size={22} />,
    title: "Revenue Cycle + AI Claims",
    body: "Real-time 270/271 eligibility, AI claim scrubbing, auto-submission of the 837P, and a denials worklist ranked by recoverable dollars × win probability.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <Stethoscope size={22} />,
    title: "Therapy Monitoring",
    body: "Pulls adherence data straight from ResMed, Philips, and 3B device clouds and surfaces exactly who is falling off therapy — and who is due for resupply.",
  },
  {
    icon: <Workflow size={22} />,
    title: "Unified Conversations",
    body: "Every SMS, email, and chat thread in one inbox with canned replies and AI-drafted responses, auto-logged to a complete patient timeline.",
  },
  {
    icon: <Video size={22} />,
    title: "Built-in Telehealth",
    body: "Launch a video visit for setups, mask fittings, and follow-ups. Patients join from a secure link by text or email — no app to install, nothing to schedule twice.",
  },
  {
    icon: <ClipboardSignature size={22} />,
    title: "Documents & e-Sign",
    body: "Generate CMNs, prescriptions, and agreements, send e-signature packets, triage inbound faxes, and track provider signatures — the whole paperwork pipeline.",
  },
  {
    icon: <ScanFace size={22} />,
    title: "On-Device AI Mask Fitting",
    body: "Patients get fitted for the right mask from their phone camera. Facial measurements are computed on-device — images never leave the browser.",
    tag: "AI",
    gold: true,
  },
  {
    icon: <LineChart size={22} />,
    title: "Analytics & KPIs",
    body: "Margin, DSO, LTV/CAC, payer profitability, team throughput, and NPS — live, with KPI alerts that page you before a number becomes a problem.",
  },
  {
    icon: <Store size={22} />,
    title: "Branded Storefront & Shop",
    body: "Your own CPAP storefront with catalog, cart, Stripe checkout, subscriptions, returns, and reviews — plus live insurance benefit estimates before a patient pays.",
  },
  {
    icon: <Workflow size={22} />,
    title: "Automation & Rules",
    body: "Smart triggers and routing rules fire the right outreach the moment an event happens, while KPI alerts and goal tracking keep leadership ahead of every number.",
  },
  {
    icon: <FileStack size={22} />,
    title: "AI Referral Intake",
    body: "Drop in a referral fax and AI extracts the patient and clinical details to pre-fill intake — no manual re-keying, and the paperwork pipeline takes it from there.",
    tag: "AI",
    gold: true,
  },
];

function Features() {
  return (
    <section className="bx-section" id="platform">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The platform
          </span>
          <h2 className="bx-h2">Every workflow in the DME lifecycle</h2>
          <p className="bx-lede">
            From the first intake call to the last reconciled claim, Breathe
            runs the work — and the AI does the parts that used to eat your
            team&apos;s day.
          </p>
        </div>
        <div className="bx-features">
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.title} f={f} delay={i * 60} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ f, delay }: { f: Feature; delay: number }) {
  const onMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    e.currentTarget.style.setProperty("--mx", `${e.clientX - r.left}px`);
    e.currentTarget.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div
      className={`bx-card bx-reveal${f.gold ? " gold" : ""}`}
      style={{ transitionDelay: `${delay}ms` }}
      onMouseMove={onMove}
    >
      {f.tag ? <span className="bx-tag">{f.tag}</span> : null}
      <div className="bx-card-ico">{f.icon}</div>
      <h3>{f.title}</h3>
      <p>{f.body}</p>
    </div>
  );
}

/* ───────────────────────── AI bento ───────────────────────── */
type Ai = {
  icon: React.ReactNode;
  title: string;
  body: string;
  span?: boolean;
  wave?: boolean;
};

const AI_CELLS: Ai[] = [
  {
    icon: <Mic size={20} />,
    title: "Voice agent that closes the loop",
    body: "Answers inbound resupply and status calls, confirms coverage, places the order, and hands your team a transcript, summary, and sentiment read.",
    span: true,
    wave: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Claims intelligence",
    body: "Scrubs the 837P, predicts denials, and ranks the worklist by recoverable dollars.",
  },
  {
    icon: <ScanFace size={20} />,
    title: "On-device mask fitting",
    body: "Facial measurements computed in the browser — the image never leaves the phone.",
  },
  {
    icon: <Bot size={20} />,
    title: "CareMetric Copilot",
    body: "An in-app assistant that answers “where do I…?” and surfaces the next best action for staff.",
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Storefront chatbot",
    body: "Warm, on-brand answers for patients on the web and over email — with clean human hand-off.",
  },
  {
    icon: <Headphones size={20} />,
    title: "Sleep coach & SMS triage",
    body: "Adherence coaching plus intent classification that routes every inbound text correctly.",
  },
];

function AiBento() {
  return (
    <section className="bx-section" id="ai">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> Intelligence, built in
          </span>
          <h2 className="bx-h2">
            AI that does the work — <em>not just the talking</em>
          </h2>
          <p className="bx-lede">
            Best-in-class models from Anthropic, OpenAI, and ElevenLabs are
            wired into the product where each is strongest — and every one
            degrades gracefully when a key is unset.
          </p>
        </div>
        <div className="bx-bento">
          {AI_CELLS.map((c) => (
            <div
              className={`bx-bento-cell${c.span ? " span" : ""}`}
              key={c.title}
            >
              <div className="bx-bento-ic">{c.icon}</div>
              <h3>{c.title}</h3>
              <p>{c.body}</p>
              {c.wave ? (
                <div className="bx-bento-wave" aria-hidden="true">
                  {Array.from({ length: 40 }).map((_, i) => (
                    <i key={i} style={{ animationDelay: `${i * 45}ms` }} />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Revenue cycle deep-dive ───────────────────────── */
/*
 * The RCM drill-down for the product tour — DME lives or dies on getting
 * paid, so the claims pipeline gets its own section. The flow steps and
 * worklist cards map to the real Office Ally EDI path (270/271, 837P,
 * 999/277CA, 835/ERA) plus the shipped A/R worklists (prior auth via
 * Da Vinci PAS, secondary/COB, capped rentals, timely filing, statements,
 * payer profitability). Reuses .bx-pipeline + .bx-caps so no new CSS.
 */
const RCM_FLOW: { icon: React.ReactNode; label: string; sub: string }[] = [
  { icon: <BadgeCheck size={18} />, label: "Eligibility", sub: "270 / 271" },
  { icon: <Sparkles size={18} />, label: "AI scrub", sub: "pre-flight" },
  { icon: <Receipt size={18} />, label: "Submit", sub: "837P" },
  { icon: <FileStack size={18} />, label: "Acknowledge", sub: "999 / 277CA" },
  { icon: <CircleDollarSign size={18} />, label: "Post", sub: "835 / ERA" },
  { icon: <TrendingUp size={18} />, label: "Denials", sub: "ranked by $" },
  { icon: <LineChart size={18} />, label: "A/R", sub: "aging & forecast" },
];

const RCM_WORKLISTS: Capability[] = [
  {
    icon: <ClipboardSignature size={20} />,
    title: "Electronic prior auth",
    summary: "FHIR submission through Da Vinci PAS, with SLA tracking.",
    points: [
      "Submit auth requests electronically, not by fax-and-wait",
      "Missed / at-risk SLA worklist with renewal tracking",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Secondary & COB",
    summary: "Roll the primary's leftover balance to the secondary payer.",
    points: [
      "Coordination-of-benefits worklist",
      "Patient responsibility calculated automatically",
    ],
  },
  {
    icon: <CalendarClock size={20} />,
    title: "Capped rentals",
    summary: "13- and 36-month Medicare cycles, handled.",
    points: [
      "Cycle tracking with KH / KI / KX modifier rotation",
      "Advance-notice automation before each cycle turns",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "A/R & timely filing",
    summary: "Nothing ages out or misses a filing window.",
    points: [
      "0 / 30 / 60 / 90 aging buckets",
      "Days-left-to-file countdown + collections forecast",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient statements",
    summary: "Send balances by email or SMS — compliantly.",
    points: [
      "Signed statement links delivered to the patient",
      "Consent- and quiet-hours-aware sending",
    ],
  },
  {
    icon: <CircleDollarSign size={20} />,
    title: "Payer profitability",
    summary: "Net yield by payer: billed → allowed → collected.",
    points: [
      "Denial rate and DSO broken out per payer",
      "Margin reported net of captured product cost",
    ],
  },
];

function RevenueCycle() {
  return (
    <section className="bx-section" id="revenue-cycle">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Revenue cycle, in depth
          </span>
          <h2 className="bx-h2">
            Get paid the first time — <em>automated end to end</em>
          </h2>
          <p className="bx-lede">
            From real-time eligibility to posted cash, the whole claim lifecycle
            runs on the same patient record. Specialists review exceptions; the
            platform does the keying, the submission, the posting, and the
            prioritizing.
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

        <div className="bx-caps" style={{ marginTop: 56 }}>
          {RCM_WORKLISTS.map((c) => (
            <article className="bx-cap bx-reveal" key={c.title}>
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

/* ───────────────────────── Capabilities ───────────────────────── */
/*
 * The plain-language answer to "what does this software actually do?" —
 * the real product surface grouped into eight capability areas, each with
 * concrete sub-features. This is the homepage's core explainer; the
 * /breathe/product Features grid and the /breathe/features role page go
 * deeper. Copy is grounded in shipped functionality (resupply engine,
 * Office Ally RCM, therapy-cloud monitoring, the AI workforce, storefront,
 * telehealth, analytics), not aspiration.
 */
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
      "Eligibility-aware reminders by SMS, email & voice",
      "One-tap signed reorder links — no login, no friction",
      "Subscriptions, autopay & cart-abandonment recovery",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Revenue cycle & claims",
    summary: "Get paid the first time, faster — end to end.",
    points: [
      "Real-time 270/271 eligibility & re-verification",
      "AI-scrubbed 837P auto-submitted via Office Ally",
      "835/ERA auto-posting + denials ranked by $ recoverable",
      "Prior auth, A/R aging, timely-filing & capped rentals",
    ],
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Therapy monitoring",
    summary: "See who's slipping off therapy before they quit.",
    points: [
      "Nightly ResMed, Philips & 3B adherence pulls",
      "CMS 90-day compliance cohorts & RT interventions",
      "Provider-ready usage reports & recall tracking",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Patient communications",
    summary: "Every conversation in one inbox, fully logged.",
    points: [
      "Unified SMS, MMS, email & inbound-fax inbox",
      "Cases, routing rules, macros & message templates",
      "Bulk campaigns, alerts & cadence playbooks",
    ],
  },
  {
    icon: <BrainCircuit size={20} />,
    title: "AI workforce",
    summary: "AI that does the work — not just the talking.",
    points: [
      "24/7 voice agent confirms coverage & places orders",
      "Storefront chatbot + high-confidence email auto-reply",
      "Referral auto-intake from faxes, post-call summaries",
      "An in-app admin copilot for your whole team",
    ],
    gold: true,
  },
  {
    icon: <ScanFace size={20} />,
    title: "Storefront & fitter",
    summary: "A branded shop that converts shoppers to patients.",
    points: [
      "On-device AI mask fitting from the phone camera",
      "Catalog, cart, Stripe checkout, returns & reviews",
      "Live insurance benefit estimates before checkout",
    ],
  },
  {
    icon: <Video size={20} />,
    title: "Telehealth",
    summary: "Face-to-face setups and follow-ups, no friction.",
    points: [
      "Built-in video visits for setups, fittings & check-ins",
      "One-tap patient join by text or email — no app",
      "Scheduled, reminded & summarized automatically",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "Analytics & automation",
    summary: "Run the business on live signal, not last month's export.",
    points: [
      "Margin, DSO, LTV/CAC & payer-profitability dashboards",
      "KPI alerts, goal tracking & live staffing load",
      "Smart triggers, rules & CSV / PDF / QuickBooks export",
    ],
  },
];

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
          <span>Want the full tour — every screen and automation?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/product">
            Explore the platform <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Comparison ───────────────────────── */
type Cell = "yes" | "no" | "partial";
type CompareRow = {
  label: string;
  sub?: string;
  breathe: Cell;
  cols: Cell[];
  text?: { breathe: string; cols: string[] };
};

const COMPETITORS = ["Brightree", "Bonafide", "NikoHealth"];

const COMPARE_ROWS: CompareRow[] = [
  {
    label: "All-in-one platform",
    sub: "CRM · resupply · RCM · clinical · telehealth",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "AI voice agent for inbound calls",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "AI claim scrubbing & denial prediction",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "On-device AI mask fitting",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Multi-channel resupply (SMS · email · voice)",
    breathe: "yes",
    cols: ["partial", "yes", "partial"],
  },
  {
    label: "Built-in telehealth video visits",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Live therapy-cloud monitoring",
    sub: "ResMed · Philips · 3B",
    breathe: "yes",
    cols: ["partial", "partial", "no"],
  },
  {
    label: "Electronic prior authorization",
    sub: "FHIR · Da Vinci PAS",
    breathe: "yes",
    cols: ["partial", "no", "partial"],
  },
  {
    label: "Built-in branded storefront & shop",
    sub: "catalog · cart · checkout",
    breathe: "yes",
    cols: ["partial", "partial", "no"],
  },
  {
    label: "AI referral intake from faxes",
    breathe: "yes",
    cols: ["no", "no", "no"],
  },
  {
    label: "Owner analytics",
    sub: "margin · DSO · LTV/CAC",
    breathe: "yes",
    cols: ["partial", "partial", "partial"],
  },
  {
    label: "Modern, unified UI",
    breathe: "yes",
    cols: ["no", "partial", "yes"],
  },
  {
    label: "Transparent, month-to-month pricing",
    breathe: "yes",
    cols: ["no", "no", "partial"],
  },
  {
    label: "Typical implementation",
    breathe: "yes",
    cols: ["no", "partial", "partial"],
    text: {
      breathe: "Weeks",
      cols: ["Months", "Weeks–months", "Weeks–months"],
    },
  },
];

function CompareMark({ v }: { v: Cell }) {
  if (v === "yes")
    return (
      <span className="bx-yes">
        <Check size={18} strokeWidth={2.6} />
      </span>
    );
  if (v === "partial") return <span className="bx-partial">partial</span>;
  return (
    <span className="bx-no">
      <Minus size={17} />
    </span>
  );
}

function Comparison() {
  return (
    <section className="bx-section" id="compare">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> How Breathe compares
          </span>
          <h2 className="bx-h2">One platform vs. a stack of point tools</h2>
          <p className="bx-lede">
            Legacy DME software bolts modules onto decades-old cores. Breathe
            was built AI-first, so the intelligence is in the product — not in
            the add-on you license separately.
          </p>
        </div>

        <div className="bx-compare-wrap bx-reveal">
          <div className="bx-compare-scroll">
            <table className="bx-compare">
              <thead>
                <tr>
                  <th />
                  <th className="bx-col-breathe">
                    <span className="bx-compare-brand">
                      <img src={LOGO} alt="" />
                      <b>Breathe</b>
                    </span>
                  </th>
                  {COMPETITORS.map((c) => (
                    <th
                      key={c}
                      className="bx-other"
                      style={{ textAlign: "center" }}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {COMPARE_ROWS.map((row) => (
                  <tr key={row.label}>
                    <td className="bx-row-label">
                      {row.label}
                      {row.sub ? <span>{row.sub}</span> : null}
                    </td>
                    <td className="bx-col-breathe">
                      {row.text ? (
                        <strong style={{ color: "#6ff0c2" }}>
                          {row.text.breathe}
                        </strong>
                      ) : (
                        <CompareMark v={row.breathe} />
                      )}
                    </td>
                    {row.cols.map((c, i) => (
                      <td className="bx-other" key={i}>
                        {row.text ? row.text.cols[i] : <CompareMark v={c} />}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <p className="bx-compare-foot">
          Comparison reflects publicly described capabilities of each product as
          of 2026 and is provided for illustration. All marks are property of
          their respective owners.
        </p>
      </div>
    </section>
  );
}

/* ───────────────────────── Why it's different ───────────────────────── */
/*
 * The "why the table looks like that" payoff — the three structural
 * choices behind every checkmark above. Reuses the .bx-caps card grid.
 */
const DIFFERENCES: Capability[] = [
  {
    icon: <BrainCircuit size={20} />,
    title: "AI in the core, not an add-on",
    summary: "Intelligence ships in the product — never licensed separately.",
    points: [
      "Voice agent, claim scrubbing, and mask fitting are built in",
      "No bolt-on module to buy to get the AI",
    ],
    gold: true,
  },
  {
    icon: <Database size={20} />,
    title: "One patient record, not seven integrations",
    summary: "Every workflow reads and writes the same data.",
    points: [
      "Intake → resupply → claims → clinical on one timeline",
      "No exports, no swivel-chair, no patients lost between tools",
    ],
  },
  {
    icon: <CircleDollarSign size={20} />,
    title: "Priced like one platform",
    summary: "Transparent, month-to-month — and your data stays yours.",
    points: [
      "No per-module upsells or multi-year lock-in",
      "Export on demand, including back out to PacWare",
    ],
  },
];

function WhyDifferent() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> The difference, in three ideas
          </span>
          <h2 className="bx-h2">Why the table looks like that</h2>
          <p className="bx-lede">
            Those checkmarks aren&apos;t a longer feature list — they come from
            three structural choices a decades-old core can&apos;t retrofit.
          </p>
        </div>
        <div className="bx-caps bx-caps-3">
          {DIFFERENCES.map((c) => (
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

/* ───────────────────────── Roles ───────────────────────── */
type Role = {
  icon: React.ReactNode;
  title: string;
  hours: number;
  why: string;
  drivers: string[];
};

const ROLES: Role[] = [
  {
    icon: <PhoneCall size={20} />,
    title: "Patient Coordinator / CSR",
    hours: 11,
    why: "The AI voice agent and chatbot field routine resupply calls and FAQs around the clock, so reps only touch the conversations that need a human.",
    drivers: [
      "24/7 AI voice agent handles inbound resupply & status calls",
      "Unified inbox with AI-drafted email replies and canned macros",
      "Timelines auto-log every touch — no manual note-taking",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Billing / RCM Specialist",
    hours: 14,
    why: "Eligibility, scrubbing, submission, and posting are automated end-to-end, and denials arrive pre-ranked by recoverable dollars instead of in a flat queue.",
    drivers: [
      "Automated 270/271 eligibility & re-verification",
      "AI scrubs and auto-submits clean 837P claims",
      "ERA auto-posting + denials worklist ranked by $ recoverable",
    ],
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Respiratory Therapist / Clinical",
    hours: 9,
    why: "Adherence boards pull from the device clouds and surface exactly who is slipping, replacing hours of manual report-pulling with a prioritized worklist.",
    drivers: [
      "Live ResMed / Philips / 3B adherence monitoring",
      "Telehealth visits with secure one-tap patient join links",
      "Automated compliance tracking & coaching prompts",
    ],
  },
  {
    icon: <FileStack size={20} />,
    title: "Intake & Documentation",
    hours: 10,
    why: "CMNs, prescriptions, and agreements are generated and routed for e-signature automatically, and inbound faxes are triaged instead of hand-sorted.",
    drivers: [
      "One-click document generation (CMN / Rx / agreements)",
      "E-signature packets with automatic status tracking",
      "Inbound fax triage for sleep studies & Rx renewals",
    ],
  },
  {
    icon: <Activity size={20} />,
    title: "Operations Manager / Owner",
    hours: 6,
    why: "Every number lives in one system with KPI alerts, so leadership stops reconciling spreadsheets across tools and starts acting on live signal.",
    drivers: [
      "Real-time margin, DSO, LTV/CAC and payer dashboards",
      "KPI alerts that page you before a metric slips",
      "Team throughput & goals in a single source of truth",
    ],
  },
];

function Roles() {
  const maxHours = Math.max(...ROLES.map((r) => r.hours));
  return (
    <section className="bx-section" id="roles">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Activity size={13} /> Time back, by role
          </span>
          <h2 className="bx-h2">Hours returned to every seat on the team</h2>
          <p className="bx-lede">
            These aren&apos;t vague &ldquo;productivity gains.&rdquo; Each
            estimate maps to specific Breathe automations that remove a
            recurring manual task from someone&apos;s week.
          </p>
        </div>
        <div className="bx-roles">
          {ROLES.map((r) => (
            <div className="bx-role bx-reveal" key={r.title}>
              <div className="bx-role-hours">
                <div className="n">{r.hours}</div>
                <div className="u">hrs / week</div>
                <div className="bar">
                  <i style={{ width: `${(r.hours / maxHours) * 100}%` }} />
                </div>
              </div>
              <div>
                <div className="bx-card-ico" style={{ marginBottom: 14 }}>
                  {r.icon}
                </div>
                <h3>{r.title}</h3>
                <p>{r.why}</p>
                <ul>
                  {r.drivers.map((d) => (
                    <li key={d}>{d}</li>
                  ))}
                </ul>
              </div>
            </div>
          ))}
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want every feature mapped to the seat that uses it?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/features">
            See what the software does, by role <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── ROI calculator ───────────────────────── */
/*
 * Illustrative, transparent model. Every coefficient is a stated,
 * conservative assumption shown to the operator — this is a directional
 * estimate, not a quote.
 */
const ROI = {
  // Labor: hours saved per staff per week (sum of role automations, blended
  // and discounted) × loaded hourly cost × 52.
  hoursPerStaffWeek: 9,
  loadedHourly: 34,
  // Revenue cycle: incremental net collections per active patient/yr from
  // higher first-pass acceptance + worked denials.
  rcmPerPatient: 16,
  // Resupply growth: incremental annual margin per active patient from
  // automated, eligibility-aware reorder outreach.
  resupplyPerPatient: 21,
  // Tool consolidation: retired point-tool licenses, per staff seat/yr.
  toolsPerStaff: 1500,
};

function computeRoi(patients: number, staff: number) {
  const labor = Math.round(
    staff * ROI.hoursPerStaffWeek * ROI.loadedHourly * 52,
  );
  const rcm = Math.round(patients * ROI.rcmPerPatient);
  const resupply = Math.round(patients * ROI.resupplyPerPatient);
  const tools = Math.round(staff * ROI.toolsPerStaff);
  const total = labor + rcm + resupply + tools;
  return { labor, rcm, resupply, tools, total };
}

function money(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function Roi() {
  const [patients, setPatients] = useState(5000);
  const [staff, setStaff] = useState(12);
  const r = useMemo(() => computeRoi(patients, staff), [patients, staff]);

  const lines: { k: string; v: number; gold?: boolean }[] = [
    { k: "Staff time automated", v: r.labor },
    { k: "Revenue-cycle recovery", v: r.rcm },
    { k: "Resupply revenue growth", v: r.resupply, gold: true },
    { k: "Retired software licenses", v: r.tools },
  ];
  const max = Math.max(...lines.map((l) => l.v));

  return (
    <section className="bx-section" id="roi">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <LineChart size={13} /> Total cost savings
          </span>
          <h2 className="bx-h2">What Breathe is worth to your business</h2>
          <p className="bx-lede">
            Move the sliders to your size. The model adds up labor automation,
            revenue-cycle recovery, resupply growth, and the point tools Breathe
            replaces.
          </p>
        </div>

        <div className="bx-roi bx-reveal">
          <div className="bx-roi-panel bx-roi-controls">
            <h3>Your DME, roughly</h3>
            <p>Two inputs. Drag to match your operation.</p>

            <div className="bx-field">
              <div className="bx-field-top">
                <label htmlFor="bx-patients">Active patients</label>
                <span className="val">{patients.toLocaleString("en-US")}</span>
              </div>
              <input
                id="bx-patients"
                className="bx-range"
                type="range"
                min={500}
                max={25000}
                step={500}
                value={patients}
                onChange={(e) => setPatients(Number(e.target.value))}
              />
            </div>

            <div className="bx-field">
              <div className="bx-field-top">
                <label htmlFor="bx-staff">Staff members</label>
                <span className="val">{staff}</span>
              </div>
              <input
                id="bx-staff"
                className="bx-range"
                type="range"
                min={3}
                max={60}
                step={1}
                value={staff}
                onChange={(e) => setStaff(Number(e.target.value))}
              />
            </div>

            <p className="bx-roi-disclaimer">
              Assumptions (per year): {ROI.hoursPerStaffWeek} hrs/week saved per
              staff at {money(ROI.loadedHourly)}/hr loaded;{" "}
              {money(ROI.rcmPerPatient)} RCM recovery and{" "}
              {money(ROI.resupplyPerPatient)} resupply margin per active
              patient; {money(ROI.toolsPerStaff)}/seat in retired licenses.
              Directional estimate, not a quote.
            </p>
          </div>

          <div className="bx-roi-panel bx-roi-result">
            <div className="bx-roi-total-label">Estimated annual impact</div>
            <div className="bx-roi-total">{money(r.total)}</div>
            <div className="bx-roi-total-sub">
              ≈ {money(r.total / 12)} every month back in the business.
            </div>

            <div className="bx-roi-breakdown">
              {lines.map((l) => (
                <div
                  className={`bx-roi-line${l.gold ? " gold" : ""}`}
                  key={l.k}
                >
                  <span className="k">{l.k}</span>
                  <span className="v">{money(l.v)}</span>
                  <span className="track">
                    <i
                      style={{ width: `${Math.max(6, (l.v / max) * 100)}%` }}
                    />
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Pricing ───────────────────────── */
// Canonical platform catalog, mirrored from the billing seed in migration
// 0362 (resupply.billing_plans / billing_addons). Launch/Growth/Scale are
// is_public=true so their prices are shown; Enterprise is is_custom, so it
// shows "Custom" and never the internal number. Keep in sync if the seed
// prices change.
const PLANS: {
  name: string;
  price: string;
  cadence: string;
  setup: string;
  blurb: string;
  highlights: string[];
  featured?: boolean;
}[] = [
  {
    name: "Launch",
    price: "$799",
    cadence: "/mo",
    setup: "+ $2,500 one-time onboarding",
    blurb: "Branded storefront and core resupply automation for a small DME.",
    highlights: [
      "5 staff seats · 500 active patients · 1 location",
      "Branded CPAP storefront + mask fitter",
      "Shop, cart, checkout, and order tracking",
      "Resupply reminders + subscription tracking",
    ],
  },
  {
    name: "Growth",
    price: "$1,899",
    cadence: "/mo",
    setup: "+ $5,000 one-time onboarding",
    blurb:
      "Full resupply operations, outreach, documents, and billing worklists.",
    highlights: [
      "15 seats · 3,000 patients · 3 locations",
      "Everything in Launch",
      "Bulk campaigns, patient packets + e-signature",
      "Eligibility, prior auth, CMN/DIF, and A/R worklists",
    ],
    featured: true,
  },
  {
    name: "Scale",
    price: "$3,999",
    cadence: "/mo",
    setup: "+ $10,000 one-time onboarding",
    blurb:
      "Multi-location automation, analytics, and AI controls at higher volume.",
    highlights: [
      "40 seats · 10,000 patients · 10 locations",
      "Everything in Growth",
      "Advanced financial, funnel, and LTV/CAC analytics",
      "Automation rules, Control Center, bot playground",
    ],
  },
  {
    name: "Enterprise",
    price: "Custom",
    cadence: "",
    setup: "Contracted volume + SLA",
    blurb:
      "For high-volume DME operations needing custom integration and support.",
    highlights: [
      "Everything in Scale",
      "Custom integration + migration plan",
      "Advanced security and account controls",
      "Dedicated success manager + priority SLA",
    ],
  },
];

// ── Live pricing from the platform billing catalog ──────────────────
// The super-admin edits plan + add-on prices in the platform portal and
// they land here with no redeploy (GET /api/platform/pricing). Fail-soft:
// a missing/empty response falls back to the static PLANS / ADDON_GROUPS
// copy in this file.
interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  monthlyPriceCents: number | null;
  onboardingFeeCents: number | null;
  isCustom: boolean;
  allowances: Record<string, number>;
  features: string[];
}
interface PublicAddon {
  code: string;
  name: string;
  category: string | null;
  description: string | null;
  recurringPriceCents: number | null;
  oneTimeMinCents: number | null;
  oneTimeMaxCents: number | null;
  unitLabel: string | null;
}
interface PublicPricing {
  plans: PublicPlan[];
  addons: PublicAddon[];
}

function usePublicPricing(): PublicPricing | null {
  const [data, setData] = useState<PublicPricing | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/pricing", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        const b = body as { plans?: unknown; addons?: unknown } | null;
        const plans = b?.plans;
        if (Array.isArray(plans) && plans.length > 0) {
          setData({
            plans: plans as PublicPlan[],
            addons: Array.isArray(b?.addons)
              ? (b!.addons as PublicAddon[])
              : [],
          });
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return data;
}

function dollars(cents: number): string {
  const v = cents / 100;
  // Whole dollars render without decimals ("$799"); fractional amounts
  // keep cents ("$799.50") so we never misstate a non-round price.
  return Number.isInteger(v)
    ? `$${v.toLocaleString("en-US")}`
    : `$${v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
}

type PlanCard = (typeof PLANS)[number];

function liveToPlanCards(plans: PublicPlan[]): PlanCard[] {
  return plans.map((p) => ({
    name: p.name,
    // Custom/Enterprise tiers never show a concrete public price — even if
    // a negotiated amount is stored, the marketing page says "Custom".
    price: p.isCustom
      ? "Custom"
      : p.monthlyPriceCents == null
        ? "Contact us"
        : dollars(p.monthlyPriceCents),
    cadence: p.isCustom || p.monthlyPriceCents == null ? "" : "/mo",
    setup: p.isCustom
      ? "Contracted volume + SLA"
      : p.onboardingFeeCents != null && p.onboardingFeeCents > 0
        ? `+ ${dollars(p.onboardingFeeCents)} one-time onboarding`
        : "Onboarding included",
    blurb: p.description ?? "",
    highlights: p.features.slice(0, 6),
    featured: p.code.toLowerCase() === "growth",
  }));
}

const ADDON_GROUPS: {
  group: string;
  items: { name: string; price: string }[];
}[] = [
  {
    group: "Premium modules",
    items: [
      { name: "AI voice agent / IVR", price: "$499/mo" },
      { name: "Advanced billing automation", price: "$699/mo" },
      { name: "Advanced analytics suite", price: "$399/mo" },
      { name: "Multi-location management", price: "$499/mo" },
      { name: "Fax automation", price: "$199/mo" },
      { name: "Dedicated success manager", price: "$1,000/mo" },
    ],
  },
  {
    group: "Capacity",
    items: [
      { name: "Additional staff seat", price: "$49/mo" },
      { name: "Active-patient block (+500)", price: "$99/mo" },
      { name: "Additional location", price: "$199/mo" },
      { name: "Extra storage (+100 GB)", price: "$25/mo" },
    ],
  },
  {
    group: "Usage bundles",
    items: [
      { name: "SMS / email bundle (1,000)", price: "$50" },
      { name: "AI text bundle (1,000)", price: "$40" },
      { name: "Claims / eligibility bundle (1,000)", price: "$75" },
    ],
  },
  {
    group: "Integrations & one-time",
    items: [
      { name: "Additional therapy-cloud vendor", price: "$299/mo" },
      { name: "Custom integration", price: "from $5,000" },
      { name: "Data migration package", price: "$2,500–$15,000" },
      { name: "Custom domain + branding setup", price: "$500" },
    ],
  },
];

const ADDON_CATEGORY_LABELS: Record<string, string> = {
  premium: "Premium modules",
  capacity: "Capacity",
  usage: "Usage bundles",
  integration: "Integrations & one-time",
  one_time: "Integrations & one-time",
};

function addonPrice(a: PublicAddon): string {
  if (a.recurringPriceCents != null)
    return `${dollars(a.recurringPriceCents)}/mo`;
  if (
    a.oneTimeMinCents != null &&
    a.oneTimeMaxCents != null &&
    a.oneTimeMaxCents !== a.oneTimeMinCents
  )
    return `${dollars(a.oneTimeMinCents)}–${dollars(a.oneTimeMaxCents)}`;
  if (a.oneTimeMinCents != null) return `from ${dollars(a.oneTimeMinCents)}`;
  return "—";
}

function liveToAddonGroups(addons: PublicAddon[]): typeof ADDON_GROUPS {
  const order: string[] = [];
  const byLabel = new Map<string, { name: string; price: string }[]>();
  for (const a of addons) {
    const label = ADDON_CATEGORY_LABELS[a.category ?? ""] ?? "Add-ons";
    if (!byLabel.has(label)) {
      byLabel.set(label, []);
      order.push(label);
    }
    byLabel.get(label)!.push({ name: a.name, price: addonPrice(a) });
  }
  return order.map((group) => ({ group, items: byLabel.get(group)! }));
}

/** The four subscription packages. Reused on the landing page + pricing page.
 *  `cards` defaults to the static PLANS but is fed live catalog data by the
 *  Pricing section when the public pricing endpoint responds. */
function PricingPlans({ cards = PLANS }: { cards?: PlanCard[] }) {
  return (
    <div className="bx-plan-grid">
      {cards.map((p) => (
        <div
          className={"bx-plan bx-reveal" + (p.featured ? " featured" : "")}
          key={p.name}
        >
          {p.featured ? (
            <span className="bx-plan-badge">Most popular</span>
          ) : null}
          <div className="bx-plan-name">{p.name}</div>
          <div className="bx-plan-price">
            <span className="bx-plan-amt">{p.price}</span>
            {p.cadence ? (
              <span className="bx-plan-cadence">{p.cadence}</span>
            ) : null}
          </div>
          <div className="bx-plan-setup">{p.setup}</div>
          <p className="bx-plan-blurb">{p.blurb}</p>
          <ul className="bx-plan-list">
            {p.highlights.map((h) => (
              <li key={h}>
                <Check size={15} />
                {h}
              </li>
            ))}
          </ul>
          <a
            className={
              "bx-btn bx-btn-sm " +
              (p.featured ? "bx-btn-primary" : "bx-btn-ghost")
            }
            href="#demo"
          >
            {p.price === "Custom" ? "Talk to sales" : "Request a demo"}
          </a>
        </div>
      ))}
    </div>
  );
}

/** The à la carte add-on catalog, grouped by category. `groups` defaults
 *  to the static ADDON_GROUPS but is fed live catalog data by the Pricing
 *  section when the public pricing endpoint responds. */
function PricingAddons({
  groups = ADDON_GROUPS,
}: {
  groups?: typeof ADDON_GROUPS;
}) {
  return (
    <div className="bx-addons bx-reveal">
      <div className="bx-addons-head">
        <Plug size={15} /> Add-ons — license only what you need
      </div>
      <div className="bx-addon-groups">
        {groups.map((g) => (
          <div className="bx-addon-group" key={g.group}>
            <div className="bx-addon-group-name">{g.group}</div>
            {g.items.map((it) => (
              <div className="bx-addon-row" key={it.name}>
                <span className="bx-addon-name">{it.name}</span>
                <span className="bx-addon-price">{it.price}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/* Full pricing — packages + the complete add-on catalog. Tiers + add-on
   prices are driven by the live billing catalog (/api/platform/pricing)
   when available, falling back to the static PLANS / ADDON_GROUPS copy. */
function Pricing() {
  const live = usePublicPricing();
  const cards = live ? liveToPlanCards(live.plans) : PLANS;
  const groups =
    live && live.addons.length > 0
      ? liveToAddonGroups(live.addons)
      : ADDON_GROUPS;
  return (
    <section className="bx-section" id="pricing">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Pricing
          </span>
          <h2 className="bx-h2">
            Pick a package, <em>add only what you need</em>
          </h2>
          <p className="bx-lede">
            Transparent subscription tiers sized to your patient base —
            month-to-month, with onboarding and migration included and your data
            always exportable (back out to PacWare too). License premium modules
            à la carte.
          </p>
        </div>
        <PricingPlans cards={cards} />
        <PricingAddons groups={groups} />
        <div className="bx-price-cta bx-reveal">
          <span>Not sure which package fits?</span>
          <a className="bx-btn bx-btn-primary" href="#demo">
            Get a tailored quote <ArrowRight size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}

/* Landing-page pricing — packages up front with an add-ons teaser; the full
   catalog lives on /breathe/pricing. */
function PricingHome() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <CircleDollarSign size={13} /> Pricing
          </span>
          <h2 className="bx-h2">
            One platform, <em>packaged for your size</em>
          </h2>
          <p className="bx-lede">
            Subscription tiers sized to your patient base — month-to-month, with
            onboarding and migration included. Add premium modules only when you
            need them.
          </p>
        </div>
        <PricingPlans />
        <div className="bx-addons-teaser bx-reveal">
          <Plug size={15} />
          <span>
            Plus à la carte add-ons — AI voice agent, advanced billing
            automation, extra seats, locations, and more.
          </span>
          <Link className="bx-addons-teaser-link" href="/breathe/pricing">
            See full pricing &amp; add-ons <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Security ───────────────────────── */
const SECURITY: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <ScanFace size={20} />,
    title: "On-device patient imaging",
    body: "Camera frames for mask fitting never leave the browser — only numeric measurements are transmitted. Nothing image-derived is ever logged.",
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "HIPAA-eligible infrastructure",
    body: "Every AI and communications vendor in the stack is HIPAA-eligible, and patient data flows through a SOC 2-aligned posture.",
  },
  {
    icon: <KeyRound size={20} />,
    title: "Least-privilege access",
    body: "Granular, permission-gated admin roles mean each teammate sees only what their job requires — enforced at every route.",
  },
  {
    icon: <Database size={20} />,
    title: "PHI minimization",
    body: "Order payloads and patient images are treated as world-readable and kept out of application logs by design, not by policy alone.",
  },
  {
    icon: <Server size={20} />,
    title: "Tenant isolation",
    body: "Multi-tenant by architecture: your brand, sending domain, and patient data are cleanly separated from every other operator.",
  },
  {
    icon: <Network size={20} />,
    title: "Encrypted in transit",
    body: "Same-origin, strict-CSP delivery with TLS everywhere — no third-party trackers or font CDNs reaching into patient sessions.",
  },
];

function Security() {
  return (
    <section className="bx-section" id="security">
      <div className="bx-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <Lock size={13} /> Trust &amp; security
          </span>
          <h2 className="bx-h2">Built for PHI from the first line of code</h2>
          <p className="bx-lede">
            Patient privacy isn&apos;t a settings page — it&apos;s an
            architectural invariant. The hard rules are enforced in the
            codebase, not left to operator discipline.
          </p>
        </div>
        <div className="bx-sec-grid">
          {SECURITY.map((s) => (
            <div className="bx-sec-card bx-reveal" key={s.title}>
              <div className="bx-sec-ic">{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Onboarding / migration ───────────────────────── */
const STEPS: {
  icon: React.ReactNode;
  n: string;
  title: string;
  body: string;
}[] = [
  {
    icon: <Database size={20} />,
    n: "01",
    title: "Import your world",
    body: "Patient roster, device-cloud connections, and billing data come over from PacWare CSVs and your therapy clouds. The import is fill-only — an existing value is never overwritten.",
  },
  {
    icon: <Plug size={20} />,
    n: "02",
    title: "Configure & connect",
    body: "Wire up your payers, clearinghouse, brand, From address, and reminder cadences. Turn AI surfaces on one feature flag at a time, at your pace.",
  },
  {
    icon: <Zap size={20} />,
    n: "03",
    title: "Go live, white-glove",
    body: "Your team starts in a console they grasp in minutes. We stay on the line through the first resupply run and the first claim batch.",
  },
];

function Onboarding() {
  return (
    <section className="bx-section">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <GitBranch size={13} /> Migration
          </span>
          <h2 className="bx-h2">Switch in weeks, not quarters</h2>
          <p className="bx-lede">
            Moving off legacy DME software is the scariest part — so we made it
            the easiest. Your data comes with you, and nothing you already have
            gets clobbered.
          </p>
        </div>
        <div className="bx-steps">
          {STEPS.map((s) => (
            <div className="bx-step bx-reveal" key={s.n}>
              <span className="bx-step-n">{s.n}</span>
              <div className="bx-step-ic">{s.icon}</div>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── Manifesto ───────────────────────── */
function Manifesto() {
  return (
    <section className="bx-section bx-manifesto-section">
      <div className="bx-shell">
        <figure className="bx-manifesto bx-reveal">
          <Quote className="bx-quote-mark" size={40} aria-hidden="true" />
          <blockquote>
            DME software was built for billing departments. We built Breathe for
            patients — and for the people who care for them.
          </blockquote>
          <figcaption>
            <img src={LOGO} alt="" />
            <span>
              <b>The CareMetric.ai team</b>
              <i>Why we built Breathe</i>
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ───────────────────────── FAQ ───────────────────────── */
const FAQ: { q: string; a: React.ReactNode }[] = [
  {
    q: "Will it work with our billing system?",
    a: "Yes. Breathe exchanges patient and worklist data with PacWare over CSV, submits 837P claims through the Office Ally clearinghouse, and posts ERAs back automatically. PacWare stays your system of record for the warehouse; Breathe runs the resupply and revenue engine on top.",
  },
  {
    q: "How long does implementation take?",
    a: "Most operators are live in weeks, not quarters. Your roster and history import as a fill-only sync — new patients are added and blank fields are filled, but an existing value is never overwritten — so there is no risky big-bang cutover.",
  },
  {
    q: "Is our patient data safe?",
    a: "Privacy is architectural. Mask-fitting images are processed on-device and never transmitted, order payloads and images are kept out of application logs by design, admin access is least-privilege and permission-gated, and every AI vendor in the stack is HIPAA-eligible.",
  },
  {
    q: "Does the AI replace my staff?",
    a: "No — it removes the repetitive work so your team can do the human parts. The voice agent leaves a summary for review, claims are scrubbed before a person approves them, and the admin copilot always confirms before it sends anything. People stay in the loop.",
  },
  {
    q: "Which device clouds do you support?",
    a: "ResMed AirView, Philips Care Orchestrator, and 3B React Health today, with adherence pulled nightly and surfaced as a prioritized worklist of who is slipping and who is due.",
  },
  {
    q: "Do we own our data?",
    a: "Always. Your patients, orders, and history are yours — exportable on demand, including back out to PacWare. No lock-in, no hostage data.",
  },
];

function Faq() {
  return (
    <section className="bx-section" id="faq">
      <div className="bx-shell bx-faq-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <MessageSquare size={13} /> Questions
          </span>
          <h2 className="bx-h2">What DME owners ask us first</h2>
          <p className="bx-lede">
            Straight answers on the things that actually decide a switch —
            integrations, migration risk, security, and what the AI does and
            does not do.
          </p>
        </div>
        <div className="bx-faq bx-reveal">
          {FAQ.map((f) => (
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

/* ───────────────────────── Closing CTA ───────────────────────── */
function ClosingCta() {
  return (
    <section className="bx-section" id="demo">
      <div className="bx-shell">
        <div className="bx-cta bx-reveal">
          <span className="bx-eyebrow">
            <Sparkles size={13} /> Ready when you are
          </span>
          <h2>Give your team room to breathe.</h2>
          <p>
            See Breathe run a live resupply order, scrub a claim, and book a
            telehealth visit in one walkthrough — tailored to your payers and
            your patients.
          </p>
          <div className="bx-cta-row">
            <a
              className="bx-btn bx-btn-gold"
              href="mailto:hello@caremetric.ai?subject=Breathe%20demo%20request"
            >
              Request a demo <ArrowRight size={17} />
            </a>
            <Link className="bx-btn bx-btn-ghost" href="/breathe/product">
              Explore the platform
            </Link>
          </div>
          <div className="bx-cta-meta">
            <span>
              <Radio size={13} /> No commitment
            </span>
            <span>
              <Check size={13} /> Tailored to your payers
            </span>
            <span>
              <ArrowUpRight size={13} /> Live in weeks
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
      <nav className="bx-shell bx-footer-nav" aria-label="Breathe pages">
        {NAV_LINKS.map((l) => (
          <Link className="bx-footer-link" href={l.href} key={l.href}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="bx-footer-admin">
        <Link
          href="/platform"
          className="bx-footer-admin-link"
          data-testid="breathe-super-admin-login"
        >
          <Lock size={13} aria-hidden="true" />
          Super admin login
        </Link>
      </div>
    </footer>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */

/**
 * Marks this page `noindex` while it is mounted. pennpaps.com is
 * reserved for the first tenant (Penn Home Medical Supply); Breathe is
 * a separate-brand CareMetric.ai marketing surface, so it must not be
 * indexed under the tenant domain. The tag is removed on unmount so it
 * never leaks onto the tenant's own pages during SPA navigation.
 */
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

/**
 * True when the user has asked the OS to minimize non-essential motion.
 * Centralizes the check shared by the scroll, count-up, and hero-parallax
 * effects so they all honor the preference identically.
 */
function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/**
 * Enables smooth anchor scrolling for the in-page nav while Breathe is
 * mounted, restoring the prior value on unmount so it never leaks onto
 * other SPA routes. Skipped entirely under prefers-reduced-motion.
 */
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

/**
 * Scrolls to the URL hash target on mount. A deep link / cross-page
 * navigation like `/breathe#roi` would otherwise land at the top of the
 * page, because this surface is lazy-loaded — the browser's native hash
 * jump fires before the React content (and the `#roi` section) has
 * mounted. We retry on a few animation frames until the target exists,
 * then scroll to it (honoring prefers-reduced-motion). No hash, or a
 * hash that never resolves, is a silent no-op.
 */
function useInitialHashScroll() {
  useEffect(() => {
    const hash = window.location.hash;
    if (!hash || hash === "#" || hash === "#top") return;
    let frame = 0;
    let tries = 0;
    const tryScroll = () => {
      let el: Element | null;
      try {
        el = document.querySelector(hash);
      } catch {
        return; // malformed selector — nothing to do
      }
      if (el) {
        el.scrollIntoView({
          behavior: prefersReducedMotion() ? "auto" : "smooth",
          block: "start",
        });
        return;
      }
      if (tries++ < 60) frame = requestAnimationFrame(tryScroll);
    };
    frame = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(frame);
  }, []);
}

/**
 * Adds an `.in` class to every `.bx-reveal` element as it scrolls into
 * view, driving the staggered fade-up. Falls back to "everything
 * visible" when IntersectionObserver is unavailable.
 */
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

/**
 * Counts from 0 to `to` once the element scrolls into view. Respects
 * prefers-reduced-motion by jumping straight to the final value.
 */
function CountUp({
  to,
  suffix = "",
  prefix = "",
}: {
  to: number;
  suffix?: string;
  prefix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [val, setVal] = useState(0);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion()) {
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
          setVal(Math.round(to * eased));
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
      {val}
      {suffix}
    </span>
  );
}

export default BreatheHome;
