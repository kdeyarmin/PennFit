import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  BrainCircuit,
  Check,
  ClipboardSignature,
  FileStack,
  LineChart,
  Mic,
  Minus,
  PhoneCall,
  Receipt,
  RefreshCw,
  ScanFace,
  Sparkles,
  Stethoscope,
  Video,
  Workflow,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import "./breathe.css";

const LOGO = "/breathe/caremetric-logo.png";

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
 */
export function Breathe() {
  useDocumentTitle(
    "Breathe — The DME Operating Platform by CareMetric.ai",
    "Breathe is the AI-native operating platform for durable medical equipment companies: patient CRM, resupply automation, revenue-cycle, therapy monitoring, telehealth, and an AI voice agent in one system.",
    { schema: "Article" },
  );

  useRevealOnScroll();
  useNoIndex();

  return (
    <div className="breathe-page">
      <Nav />
      <main>
        <Hero />
        <Replaces />
        <Features />
        <Comparison />
        <Roles />
        <Roi />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

/* ───────────────────────── Nav ───────────────────────── */
function Nav() {
  return (
    <nav className="bx-nav">
      <div className="bx-shell bx-nav-inner">
        <a className="bx-brand" href="#top">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </a>
        <div className="bx-nav-links">
          <a className="bx-nav-anchor" href="#platform">
            Platform
          </a>
          <a className="bx-nav-anchor" href="#compare">
            Compare
          </a>
          <a className="bx-nav-anchor" href="#roles">
            Time saved
          </a>
          <a className="bx-nav-anchor" href="#roi">
            ROI
          </a>
          <a className="bx-btn bx-btn-primary" href="#demo">
            Request a demo
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ───────────────────────── Hero ───────────────────────── */
function Hero() {
  return (
    <header className="bx-section bx-hero" id="top">
      <div className="bx-shell">
        <div className="bx-hero-grid">
          <div className="bx-reveal in">
            <span className="bx-eyebrow">
              <span className="bx-dot" />
              The AI-native platform for DME
            </span>
            <h1 className="bx-h1">
              Run your entire DME
              <br />
              business on <span className="grad">one breath.</span>
            </h1>
            <p className="bx-hero-sub">
              Breathe unifies intake, resupply, revenue cycle, clinical
              monitoring, and patient communication into a single AI-native
              system — so your team stops stitching tools together and starts
              caring for patients.
            </p>
            <div className="bx-hero-cta">
              <a className="bx-btn bx-btn-primary" href="#demo">
                Request a demo <ArrowRight size={17} />
              </a>
              <a className="bx-btn bx-btn-ghost" href="#roi">
                Calculate your savings
              </a>
            </div>
            <div className="bx-hero-trust">
              <BadgeCheck size={15} color="#54c8ff" />
              HIPAA-eligible · SOC 2 posture · Built on CareMetric.ai
            </div>
          </div>

          <div className="bx-orb-wrap bx-reveal in">
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
    label: "Modern, unified UI",
    breathe: "yes",
    cols: ["no", "partial", "yes"],
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
            your patient panel.
          </p>
          <div className="bx-cta-row">
            <a
              className="bx-btn bx-btn-gold"
              href="mailto:hello@caremetric.ai?subject=Breathe%20demo%20request"
            >
              Request a demo <ArrowRight size={17} />
            </a>
            <a className="bx-btn bx-btn-ghost" href="#platform">
              Explore the platform
            </a>
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
        <a className="bx-brand" href="#top">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </a>
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
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
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

export default Breathe;
