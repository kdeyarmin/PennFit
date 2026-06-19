import React, { useEffect } from "react";
import { Link } from "wouter";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ClipboardCheck,
  ClipboardSignature,
  CreditCard,
  Database,
  Headphones,
  HelpCircle,
  Lock,
  Mail,
  PhoneCall,
  Receipt,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Stethoscope,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useNoIndexExceptApex } from "@/hooks/use-noindex-except-apex";
import "./breathe.css";

// Icon-only crop of the CareMetric app icon — matches the asset used across
// the rest of the /breathe marketing pages (see breathe-features.tsx).
const LOGO = "/breathe/caremetric-icon.png";

/**
 * Breathe — the FAQ page.
 *
 * The marquee question an operator asks before anything else is "is this
 * compliant with Medicare and the major payers?" — so that question leads the
 * page with a full, honest answer: the compliance-critical work Breathe
 * automates so the right thing happens by default, paired with a plain note
 * about what stays the provider's own responsibility. The remaining sections
 * explain the rest of the software (security, billing, resupply, AI, setup).
 *
 * Reuses the namespaced `breathe.css` design system (every rule scoped under
 * `.breathe-page`, including the `.bx-faq*` accordion blocks). Rendered
 * OUTSIDE the patient storefront <Layout> (mounted in TopRouter), lazy-loaded,
 * and `noindex` for the same tenant-domain reason the rest of /breathe is.
 *
 * Honesty guardrails (see CLAUDE.md "Hard rules"): the platform is described
 * as **HIPAA-eligible infrastructure**, never "HIPAA-certified." Breathe does
 * NOT ship the in-app compliance domains that were deliberately retired
 * (BAA inventory, OIG/LEIE screening, staff-training records, tamper-evident
 * audit log, accreditation attestation, etc.) — so this page does not claim
 * them. It claims only the real payer rails: 270/271 eligibility, AI-scrubbed
 * 837P via the clearinghouse, 835/ERA posting, DaVinci PAS prior auth, CMS
 * adherence documentation, and eligibility-aware resupply cadence.
 */

/* ════════════════════════ Content ════════════════════════ */

type CompliancePillar = {
  icon: React.ReactNode;
  title: string;
  body: string;
  gold?: boolean;
};

// The substance behind the marquee answer — every item maps to a capability
// that already ships on the platform (mirrors the claims on /breathe and
// /breathe/features), framed around what makes a Medicare/payer claim clean.
const COMPLIANCE_PILLARS: CompliancePillar[] = [
  {
    icon: <BadgeCheck size={20} />,
    title: "Eligibility verified before you bill",
    body: "Real-time 270/271 eligibility checks — and automatic re-verification — confirm a patient's coverage is active before an order ships, so claims never go out against lapsed benefits.",
    gold: true,
  },
  {
    icon: <Receipt size={20} />,
    title: "Clean claims in the payer's own format",
    body: "Every claim is assembled as a standard 837P, AI-scrubbed for missing modifiers and documentation, then auto-submitted through the Office Ally clearinghouse — or downloaded for any clearinghouse you already use. The 835/ERA posts back automatically.",
    gold: true,
  },
  {
    icon: <CalendarClock size={20} />,
    title: "Medicare cycles and resupply windows enforced",
    body: "The resupply engine is eligibility-aware: it tracks each payer's replacement schedule so supplies are reordered on cadence — not too early to bill — and handles the 13- and 36-month Medicare capped-rental cycles and modifier rotation for you.",
    gold: true,
  },
  {
    icon: <ClipboardCheck size={20} />,
    title: "Refill confirmation documented on every order",
    body: "CMS never lets recurring supplies auto-ship — before each refill the patient has to affirmatively confirm they're still using the device and that their supply is running low. Breathe asks for that on every channel (text, email, and the AI voice agent) and records it as an audit-grade attestation on the chart, so the refill documentation a payer asks for is captured by default.",
    gold: true,
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Adherence documentation, captured automatically",
    body: "Nightly adherence pulls from ResMed, Philips, and 3B device clouds document the Medicare 4-hour rule and the 90-day compliance window automatically — the usage proof payers require to keep paying for therapy.",
  },
  {
    icon: <ClipboardSignature size={20} />,
    title: "Prior auth and signed paperwork on file",
    body: "Electronic prior authorization through DaVinci PAS keeps auth requests moving, while one-click CMN/Rx generation, e-signature packets, and proof-of-delivery photos keep the supporting documentation attached to the right patient record.",
  },
  {
    icon: <RefreshCw size={20} />,
    title: "Coordination of benefits and denials",
    body: "Secondary-payer balances roll over for coordination of benefits, timely-filing is tracked, and denials surface ranked by recoverable dollars so nothing quietly ages out of the filing window.",
  },
];

type FaqItem = { q: string; a: React.ReactNode };
type FaqGroup = {
  id: string;
  icon: React.ReactNode;
  eyebrow: string;
  title: string;
  lede: string;
  items: FaqItem[];
};

const FAQ_GROUPS: FaqGroup[] = [
  {
    id: "compliance",
    icon: <ShieldCheck size={13} />,
    eyebrow: "Medicare & payers",
    title: "Compliance, Medicare & payers",
    lede: "The details behind the headline answer above — eligibility, claim formats, documentation, and where responsibility sits.",
    items: [
      {
        q: "Does Breathe guarantee I'll be compliant?",
        a: (
          <>
            No software can promise that — and any vendor that does is selling
            you something. What Breathe guarantees is that the{" "}
            <strong>compliance-critical steps happen by default</strong>:
            coverage is checked before you bill, claims go out in the payer's
            required format with the right modifiers, resupply only fires inside
            the allowed window, and the adherence and delivery documentation is
            captured automatically. Your accreditation (e.g. ACHC), your state
            licensure, your payer contracts, and your internal policies remain
            yours to hold — Breathe is built to make following them the path of
            least resistance, not to replace them.
          </>
        ),
      },
      {
        q: "Which payers does it work with?",
        a: "Breathe bills Medicare, Medicaid, and commercial payers through standard EDI. Eligibility uses the 270/271 transaction, claims are submitted as 837P, and remittances post from the 835/ERA — the same standards every major payer accepts. Submission runs through the Office Ally clearinghouse out of the box, and you can download the 837P to file through any clearinghouse you already contract with.",
      },
      {
        q: "How does it handle the Medicare CPAP compliance rules?",
        a: "Adherence data is pulled nightly from ResMed, Philips, and 3B device clouds, so the Medicare 4-hour usage rule and the 90-day compliance window are documented automatically. At-risk patients surface on a worklist before they fall off therapy, which protects both the patient and your ability to keep billing for their supplies.",
      },
      {
        q: "Does it stop me from billing resupply too early?",
        a: "Yes. The resupply engine is eligibility-aware — it knows each payer's replacement schedule and only assembles a 'due' worklist when a patient is actually inside the allowed window. That keeps you from filing claims that would be denied for being early, while making sure no eligible reorder is missed.",
      },
      {
        q: "How do you meet the CMS DMEPOS refill documentation rule?",
        a: "The CMS refill requirement (Program Integrity Manual Ch. 5) says recurring supplies can't be auto-shipped: before each refill you must contact the patient, document that they confirmed they're still using the item and that their supply is running low, and not ship too early. Breathe does all three — nothing ships without an affirmative confirmation, every reminder (text, email, and the AI voice agent) asks the patient to confirm continued use and that they're running low, and each confirmation is saved as an audit-grade attestation on the patient's chart. Reminders fire on the payer's replacement cadence, so orders stay inside the allowed refill window.",
      },
      {
        q: "What about prior authorization?",
        a: "Electronic prior authorization is supported through DaVinci PAS (a FHIR-based standard), so auth requests can move electronically instead of by fax-and-wait. Fewer no-auth denials means fewer full appeal cycles to recover the money.",
      },
    ],
  },
  {
    id: "security",
    icon: <Lock size={13} />,
    eyebrow: "Security & privacy",
    title: "Security, privacy & HIPAA",
    lede: "How patient data is protected — the questions your compliance team will ask.",
    items: [
      {
        q: "Is Breathe HIPAA-compliant?",
        a: "Breathe runs on HIPAA-eligible infrastructure with a least-privilege posture — every AI and communications vendor in the stack is HIPAA-eligible — and will sign a Business Associate Agreement with your organization. HIPAA compliance is a shared responsibility: the platform provides the safeguards, and your organization operates them under your own policies. We're built to answer the questions your compliance team will ask.",
      },
      {
        q: "What happens to the mask-fitter photos?",
        a: "The virtual mask fitter does all of its facial measurement on-device, in the patient's own browser. Only the numeric measurements are used to recommend a mask — the camera image itself never leaves the device and is never transmitted, logged, or stored. It's privacy by design, not privacy by policy.",
      },
      {
        q: "Who can see patient data inside the platform?",
        a: "Access is role-based with granular permissions, so each teammate sees only what their job requires, and admin accounts can be protected with multi-factor authentication. You control the locations, roles, and permissions for your own team.",
      },
    ],
  },
  {
    id: "billing",
    icon: <Receipt size={13} />,
    eyebrow: "Revenue cycle",
    title: "Billing & revenue cycle",
    lede: "From eligibility to posted cash — the whole claim lifecycle on one record.",
    items: [
      {
        q: "Does it actually submit claims, or just prepare them?",
        a: "Both. Clean 837P claims auto-submit through Office Ally, and the 835/ERA posts back automatically. If you'd rather route claims through your existing clearinghouse, you can download the scrubbed 837P instead. Your billers work the exceptions, not every claim by hand.",
      },
      {
        q: "How are denials handled?",
        a: "Remittances auto-post, and denials arrive ranked by recoverable dollars × win probability instead of in a flat, first-in queue — so your team works the highest-value recoveries first and small denials don't quietly age out.",
      },
      {
        q: "Can it take patient payments too?",
        a: "Yes. The branded storefront uses Stripe for checkout, subscriptions, and autopay, and you can show patients a live benefit estimate of their out-of-pocket cost before they ever pay.",
      },
    ],
  },
  {
    id: "platform",
    icon: <RefreshCw size={13} />,
    eyebrow: "The platform",
    title: "Resupply, the storefront & your data",
    lede: "What the platform replaces, and how it fits the systems you already run.",
    items: [
      {
        q: "What does Breathe replace?",
        a: "For most operators it retires a stack of point tools — separate resupply software, an RCM/billing suite, a patient CRM, a telehealth app, a document/e-sign tool, therapy dashboards, and a call-center IVR — into one login on a single patient record.",
      },
      {
        q: "Do I have to give up PacWare or my billing system of record?",
        a: "No. PacWare stays your system of record. Breathe does a fill-only, lossless sync — it fills in blank fields and adds new patients, but never overwrites an existing value — and nothing is ever pushed automatically. You stay in control of the billing/warehouse system you already trust.",
      },
      {
        q: "Is my data locked in?",
        a: "No. Pricing is month-to-month with no multi-year lock-in, and your patients, orders, and history are exportable on demand — including back out to PacWare. Your data stays yours.",
      },
    ],
  },
  {
    id: "ai",
    icon: <Bot size={13} />,
    eyebrow: "AI workforce",
    title: "AI & automation",
    lede: "What the AI actually does — and what happens if a vendor key isn't set.",
    items: [
      {
        q: "What does the AI do?",
        a: "Breathe puts a shift of AI teammates on the floor: a 24/7 voice agent that answers resupply and status calls and books orders, a storefront chatbot and high-confidence email auto-reply, AI claim scrubbing, AI referral-fax intake that pre-fills a patient, a sleep coach for the make-or-break first weeks, and SMS intent triage. Best-in-class models from Anthropic, OpenAI, and ElevenLabs are wired in where each is strongest.",
      },
      {
        q: "Does the AI ever send something without a human?",
        a: "Only when it's safe to. The email auto-reply sends automatically only on high-confidence, general questions and hands off cleanly to a human for anything order-, account-, or clinically-specific. The admin assistant always confirms with you before it emails anything. Every channel honors consent, quiet hours, and frequency caps.",
      },
      {
        q: "What if an AI vendor is down or a key isn't configured?",
        a: "Every AI surface degrades gracefully — a missing key or a vendor outage never breaks the app. The platform falls back to a safe offline response or a human hand-off, so the rest of your business keeps running.",
      },
    ],
  },
  {
    id: "getting-started",
    icon: <Sparkles size={13} />,
    eyebrow: "Getting started",
    title: "Setup, pricing & getting started",
    lede: "How to try it, how it's priced, and how fast you can be live.",
    items: [
      {
        q: "How do I try it?",
        a: (
          <>
            You can{" "}
            <Link href="/breathe/signup">create your own workspace</Link> and
            walk your team through every feature on sample data — free, no
            credit card, and no sales call required.
          </>
        ),
      },
      {
        q: "How is it priced?",
        a: (
          <>
            One all-in price, month-to-month, with no per-module surprises. Size
            it for your own panel and staffing in the{" "}
            <Link href="/breathe/roi">ROI calculator</Link>.
          </>
        ),
      },
      {
        q: "How long until we're live?",
        a: "You can be live on day one. Integrations connect out of the box and you flip each surface on at your own pace — a missing credential never blocks the rest of the platform.",
      },
    ],
  },
];

/* ════════════════════════ Page ════════════════════════ */

export function BreatheFaq() {
  useDocumentTitle(
    "FAQ — Is Breathe Compliant with Medicare & Major Payers? | Breathe by CareMetric.ai",
    "Answers about the Breathe DME platform: how it keeps Medicare and major-payer billing compliant, security and HIPAA, revenue cycle, resupply, AI automation, data ownership, and getting started.",
    { schema: "Article" },
  );

  useRevealOnScroll();
  useNoIndexExceptApex();
  useSmoothScroll();
  useInitialHashScroll();

  return (
    <div className="breathe-page">
      <div className="bx-grain" aria-hidden="true" />
      <Nav />
      <main>
        <Intro />
        <ComplianceAnswer />
        <FaqSections />
        <ClosingCta />
      </main>
      <Footer />
    </div>
  );
}

/* ───────────────────────── Nav ───────────────────────── */
const NAV_ANCHORS: { href: string; label: string }[] = [
  { href: "#compliance-answer", label: "Compliance" },
  { href: "#security", label: "Security" },
  { href: "#billing", label: "Billing" },
  { href: "#platform", label: "Platform" },
  { href: "#ai", label: "AI" },
  { href: "#getting-started", label: "Get started" },
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
            <HelpCircle size={13} />
            Questions, answered
          </span>
          <h1 className="bx-h1 bx-reveal in">
            Is Breathe compliant with Medicare
            <br />
            <span className="grad-em">and the major payers?</span>
          </h1>
          <p className="bx-hero-sub bx-reveal in">
            Short answer: yes — Breathe is built to bill Medicare, Medicaid, and
            commercial payers correctly, and it automates the
            compliance-critical steps so the right thing happens by default.
            Here&apos;s exactly how, plus straight answers to everything else
            operators ask about the platform.
          </p>
          <div className="bx-hero-cta bx-reveal in">
            <a className="bx-btn bx-btn-primary" href="#compliance-answer">
              See how it stays compliant <ArrowRight size={17} />
            </a>
            <Link className="bx-btn bx-btn-ghost" href="/breathe/security">
              Read the security posture
            </Link>
          </div>
        </div>
      </div>
    </header>
  );
}

/* ───────────────────────── Marquee compliance answer ───────────────────────── */
function ComplianceAnswer() {
  return (
    <section className="bx-section" id="compliance-answer">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldCheck size={13} /> The compliance answer
          </span>
          <h2 className="bx-h2">
            Compliance, <em>built into the workflow</em>
          </h2>
          <p className="bx-lede">
            A clean Medicare or payer claim depends on a handful of things being
            true every single time: coverage was verified, the claim is in the
            right format, the resupply was inside the allowed window, and the
            documentation is on file. Breathe makes each of those automatic — so
            compliance is the default path, not a checklist someone has to
            remember.
          </p>
        </div>
        <div className="bx-caps">
          {COMPLIANCE_PILLARS.map((p) => (
            <article
              className={`bx-cap bx-reveal${p.gold ? " gold" : ""}`}
              key={p.title}
            >
              <div className="bx-cap-head">
                <span className="bx-cap-ic">{p.icon}</span>
                <div>
                  <h3>{p.title}</h3>
                  <p className="bx-cap-summary">{p.body}</p>
                </div>
              </div>
            </article>
          ))}
        </div>
        <p className="bxf-footnote bx-reveal">
          Breathe runs on HIPAA-eligible infrastructure (and will sign a
          Business Associate Agreement) and automates the billing,
          documentation, and adherence steps that payers require. It does not
          replace your accreditation, state licensure, payer contracts, or
          internal policies — it makes following them the path of least
          resistance.
        </p>
        <div className="bx-price-cta bx-reveal">
          <span>Want to see it run on sample data?</span>
          <a className="bx-btn bx-btn-gold" href="#demo">
            Start the free demo <ArrowRight size={16} />
          </a>
        </div>
      </div>
    </section>
  );
}

/* ───────────────────────── FAQ sections ───────────────────────── */
const GROUP_FALLBACK_ICON: Record<string, React.ReactNode> = {
  compliance: <ShieldCheck size={13} />,
  security: <Lock size={13} />,
  billing: <Receipt size={13} />,
  platform: <Database size={13} />,
  ai: <Bot size={13} />,
  "getting-started": <CreditCard size={13} />,
};

function FaqSections() {
  return (
    <>
      {FAQ_GROUPS.map((g) => (
        <section className="bx-section" id={g.id} key={g.id}>
          <div className="bx-shell bx-faq-shell">
            <div className="bx-section-head bx-reveal">
              <span className="bx-eyebrow">
                {g.icon ?? GROUP_FALLBACK_ICON[g.id]} {g.eyebrow}
              </span>
              <h2 className="bx-h2">{g.title}</h2>
              <p className="bx-lede">{g.lede}</p>
            </div>
            <div className="bx-faq bx-reveal">
              {g.items.map((f) => (
                <details className="bx-faq-item" key={g.id + f.q}>
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
      ))}
    </>
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
          <h2>Still have a question?</h2>
          <p>
            Spin up your own workspace and put it in front of your billers and
            clinicians — free, on sample data, no call required. Or reach our
            team and we&apos;ll answer anything that isn&apos;t covered here.
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
        <div className="bx-footer-contact">
          <span className="bx-footer-contact-label">
            <Headphones size={13} aria-hidden="true" />
            Customer &amp; tech support
          </span>
          <a className="bx-footer-contact-link" href="tel:+18775212890">
            <PhoneCall size={13} aria-hidden="true" />
            (877) 521-2890
            <span className="bx-footer-contact-toll">toll-free</span>
          </a>
          <a
            className="bx-footer-contact-link"
            href="mailto:info@cmbreathe.com"
          >
            <Mail size={13} aria-hidden="true" />
            info@cmbreathe.com
          </a>
        </div>
        <div className="bx-brand-sub">
          © {new Date().getFullYear()} CareMetric.ai
        </div>
      </div>
    </footer>
  );
}

/* ───────────────────────── Helpers ───────────────────────── */
/* Mirror the small effects used across the other /breathe pages so this
   companion page is fully self-contained (the homepage versions are
   module-private). */

function prefersReducedMotion() {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
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

// Lazy-loaded pages mount their sections a frame or two after the browser
// has already tried (and failed) to jump to a `#section` hash, so deep links
// like /breathe/faq#billing would otherwise land at the top. Retry the scroll
// until the target exists. Mirrors useInitialHashScroll in breathe.tsx.
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

export default BreatheFaq;
