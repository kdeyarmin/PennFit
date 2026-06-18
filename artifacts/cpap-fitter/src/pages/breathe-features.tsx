import React, { useEffect } from "react";
import { Link } from "wouter";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  CircleDollarSign,
  Bot,
  CalendarClock,
  ClipboardSignature,
  Clock,
  FileStack,
  LineChart,
  Mic,
  PhoneCall,
  Receipt,
  RefreshCw,
  ScanFace,
  Sparkles,
  Stethoscope,
  TrendingUp,
  Video,
  Workflow,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import "./breathe.css";

const LOGO = "/breathe/caremetric-logo.png";

/**
 * Breathe — "What the software does", broken down by role.
 *
 * A dedicated companion page to the `/breathe` marketing homepage that
 * answers the operator's real question: "for each seat on my team, what
 * does this actually do, and how does it save me time, cut my costs, or
 * grow my revenue?" The homepage's Roles section is a teaser; this page
 * is the full, role-by-role catalog.
 *
 * It reuses the namespaced `breathe.css` design system (every rule scoped
 * under `.breathe-page`) plus a small `.bxf-*` block at the end of that
 * file for the impact-tagged feature cards. Rendered OUTSIDE the patient
 * storefront <Layout> (mounted in TopRouter), lazy-loaded, and `noindex`
 * for the same tenant-domain reason the homepage is.
 */

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
  money: { label: "Cuts cost", short: "Cost", icon: <CircleDollarSign size={13} /> },
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
        title: "Inbound fax triage",
        body: "Sleep studies and Rx renewals that arrive by fax are triaged and attached to the right patient instead of landing in a shared pile.",
        impacts: [
          {
            kind: "time",
            text: "Faxes are sorted to the patient automatically — no manual matching.",
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
    icon: <Activity size={22} />,
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

export function BreatheFeatures() {
  useDocumentTitle(
    "What Breathe Does, by Role — Time, Cost & Revenue | CareMetric.ai",
    "A role-by-role breakdown of the Breathe DME platform: exactly which features each seat on your team uses, and how each one saves time, cuts cost, or grows revenue.",
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
        <Legend />
        {ROLES.map((r) => (
          <RoleSection key={r.id} role={r} />
        ))}
        <BottomLine />
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
        <Link className="bx-brand" href="/breathe">
          <img src={LOGO} alt="CareMetric AI" />
          <span>
            <span className="bx-brand-name">Breathe</span>
            <span className="bx-brand-sub">by CareMetric.ai</span>
          </span>
        </Link>
        <div className="bx-nav-links">
          {ROLES.map((r) => (
            <a className="bx-nav-anchor" href={`#${r.id}`} key={r.id}>
              {r.title.split(" / ")[0]}
            </a>
          ))}
          <a className="bx-btn bx-btn-primary bx-btn-sm" href="#demo">
            Request a demo
          </a>
        </div>
      </div>
    </nav>
  );
}

/* ───────────────────────── Intro ───────────────────────── */
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
            What the software does
          </span>
          <h1 className="bx-h1 bx-reveal in">
            Every feature, mapped to the{" "}
            <span className="grad-em">seat that uses it.</span>
          </h1>
          <p className="bx-hero-sub bx-reveal in">
            Breathe is the AI-native operating platform that runs the entire DME
            lifecycle. Below is the honest breakdown: for each role on your team,
            exactly what the platform does — and whether each capability saves
            time, cuts cost, or grows revenue.
          </p>
          <div className="bx-hero-cta bx-reveal in">
            <a className="bx-btn bx-btn-primary" href="#demo">
              Request a demo <ArrowRight size={17} />
            </a>
            <a className="bx-btn bx-btn-ghost" href="#csr">
              Jump to the roles
            </a>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ───────────────────────── Legend ───────────────────────── */
function Legend() {
  return (
    <div className="bx-shell">
      <div className="bxf-legend bx-reveal">
        <span className="bxf-legend-label">How to read this page</span>
        <div className="bxf-legend-keys">
          {(Object.keys(IMPACT_META) as Impact[]).map((k) => (
            <span className={`bxf-impact ${k}`} key={k}>
              {IMPACT_META[k].icon}
              {IMPACT_META[k].label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────────── Role section ───────────────────────── */
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
    v: "9+ hrs",
    sub: "saved per staff member every week, by automating the repetitive work in each role.",
  },
  {
    icon: <CircleDollarSign size={20} />,
    k: "Cost",
    v: "7 tools",
    sub: "replaced by one platform — retire the per-seat licenses you stack today.",
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
          <h2 className="bx-h2">Time saved. Cost cut. Revenue grown.</h2>
          <p className="bx-lede">
            Add up the role-by-role automations above and the platform pays for
            itself three ways at once. Size it for your panel in the ROI
            calculator on the overview page.
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
          <Link className="bx-btn bx-btn-primary" href="/breathe#roi">
            Open the ROI calculator <ArrowRight size={16} />
          </Link>
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
          <h2>See it run for your team.</h2>
          <p>
            We&apos;ll walk your coordinators, billers, and clinicians through
            the exact features above — tailored to your payers and your patient
            panel.
          </p>
          <div className="bx-cta-row">
            <a
              className="bx-btn bx-btn-gold"
              href="mailto:hello@caremetric.ai?subject=Breathe%20demo%20request"
            >
              Request a demo <ArrowRight size={17} />
            </a>
            <Link className="bx-btn bx-btn-ghost" href="/breathe">
              Back to the overview
            </Link>
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
