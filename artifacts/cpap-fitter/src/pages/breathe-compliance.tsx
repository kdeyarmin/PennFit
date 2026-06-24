import { Link } from "wouter";
import {
  Activity,
  ArrowRight,
  BadgeCheck,
  Bot,
  BrainCircuit,
  CalendarClock,
  ChevronDown,
  ClipboardCheck,
  Cpu,
  Database,
  EyeOff,
  FileCheck2,
  FileSignature,
  Fingerprint,
  Gauge,
  HeartPulse,
  KeyRound,
  Landmark,
  LineChart,
  Lock,
  MessageSquare,
  Network,
  PackageCheck,
  PhoneCall,
  Quote,
  Receipt,
  Scale,
  ScrollText,
  Send,
  Server,
  ShieldAlert,
  ShieldCheck,
  Stethoscope,
  UserCheck,
  Workflow,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Compliance.
 *
 * The compliance/legitimacy page a skeptical DME owner (and their compliance
 * reviewer or counsel) reads. Built ENTIRELY from claims that were mapped to
 * shipped code and then adversarially fact-checked against it (see the
 * breathe-compliance-research workflow). It deliberately holds the existing
 * site's anti-hype posture: "HIPAA-eligible", never "HIPAA-compliant"; named
 * rules/rails (LCD L33718, 270/271, 837P, 835/ERA, CMS-0057-F, TCPA,
 * RAC/CERT/TPE/UPIC) as the trust signal; "designed to", never a guarantee;
 * and an explicit responsibility boundary (Breathe does NOT replace your
 * accreditation, licensure, payer contracts, or policies).
 *
 * CRITICAL honesty guardrail — migration 0156 RETIRED the in-app compliance
 * machinery, so this page must NOT claim: a tamper-evident / complete audit
 * log, BAA inventory, DMEPOS/HIPAA staff attestation or training records, OIG
 * LEIE screening, patient-rights/grievance/disclosure logs, contingency-drill
 * tracking, ACHC QAPI, DME ownership disclosure, column-level PHI encryption,
 * a password pepper, or "HIPAA-compliant / handles your compliance for you".
 * The operational records below (POD, delivery tracking, patient-access trail,
 * patient timeline, voice-call ledger) are framed as operational records, not
 * an audit trail. The provider e-signature ledger IS legitimately hash-chained
 * and tamper-evident for SIGNATURES — that is the one place that wording is used.
 *
 * Reuses BreatheShell/PageHead/CapCard markup + the .bx-* system (incl. the
 * .bx-faq accordion + .bx-sec-grid); no new CSS. noindex + lazy-loaded.
 */

type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

function CapGrid({ items, three }: { items: Cap[]; three?: boolean }) {
  return (
    <div className={`bx-caps${three ? " bx-caps-3" : ""}`}>
      {items.map((c) => (
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
  );
}

/* ── Billed right the first time (preventive payer compliance) ── */
const PREVENT: Cap[] = [
  {
    icon: <BadgeCheck size={20} />,
    title: "Real-time eligibility (270/271)",
    summary: "Confirm active coverage before you dispense.",
    gold: true,
    points: [
      "One-click X12 270/271 to the payer through Office Ally, parsed and stored",
      "Reads active/inactive, deductible & out-of-pocket, and a prior-auth-required flag",
      "Designed to surface dead coverage before a claim ever goes out",
    ],
  },
  {
    icon: <ScrollText size={20} />,
    title: "Electronic prior authorization",
    summary:
      "Get the auth on file before billing — FHIR Da Vinci PAS (CMS-0057-F).",
    points: [
      "Builds & submits a PAS bundle, captures the decision and authorization number",
      "A queue tracks SLA, expiring-soon, and flags a missing or expired PA before product ships",
      "One-click renewal drafting; unattended submit is off by default and double-gated",
    ],
  },
  {
    icon: <FileCheck2 size={20} />,
    title: "Pre-submission scrubber",
    summary:
      "A deterministic checklist that blocks a bad claim before it sends.",
    points: [
      "Hard-blocks on payer not enrolled, DOS before enrollment, missing required NPI, no linked coverage, incomplete 5010 address",
      "Flags lines billed far above the contracted fee schedule as a likely coding error",
      "No claim transmits — manually or automatically — until every error clears",
    ],
  },
  {
    icon: <ClipboardCheck size={20} />,
    title: "Bill-hold paperwork gate",
    summary: "Hold the claim until the signed documents are on file.",
    points: [
      "Holds until the signed Rx / Standard Written Order, proof of delivery, and AOB are all in",
      "Lifts automatically on e-sign, chart upload, a CSR mark, or an auto-matched inbound fax",
      "Designed to head off the documentation-shortfall take-back on a later ADR/RAC review",
    ],
  },
  {
    icon: <ShieldAlert size={20} />,
    title: "Medical-necessity coverage rules",
    summary: "Bill a covered diagnosis — by each payer's own policy.",
    points: [
      "National Medicare-LCD baseline of covered ICD-10 per HCPCS, plus per-payer overrides",
      "Preflight flags a HCPCS the patient's diagnosis doesn't support under that payer",
      "Same-or-similar (RUL) warning when equipment is still inside its 5-year window",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Right modifiers, required forms",
    summary:
      "The CMS capped-rental rotation and the medical-necessity forms, every time.",
    points: [
      "Per-payer/HCPCS rules apply RR + KH/KI/KJ — and KX once adherence is documented",
      "A resolver pre-fills the same rotation on hand-keyed and corrected claims",
      "Structured CMN/DIF capture (CMS-484, DIF 10125/10126) that can't complete until required fields are filled",
    ],
  },
];

function Prevent() {
  return (
    <section className="bx-section" id="billed-right">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Lock size={13} /> Billed right the first time
          </span>
          <h2 className="bx-h2">
            Every guard between you and a <em>take-back</em>
          </h2>
          <p className="bx-lede">
            A recoupment usually traces back to one missing thing — lapsed
            coverage, no auth, an unsigned order, a wrong modifier. Breathe
            checks for each of them in the workflow, before the claim leaves the
            building, so the clean-claim work happens by default instead of by
            someone remembering.
          </p>
        </div>
        <CapGrid items={PREVENT} />
      </div>
    </section>
  );
}

/* ── When the money — or the auditor — comes back ── */
const RECOVER: Cap[] = [
  {
    icon: <CalendarClock size={20} />,
    title: "Timely-filing worklist + guard",
    summary: "Never lose a clean claim to the calendar.",
    gold: true,
    points: [
      "Every open claim ranked against the payer's filing window from date of service",
      "277CA clearinghouse rejections stay on the filing clock — not treated as done",
      "Becomes a blocking preflight error once the window is blown",
    ],
  },
  {
    icon: <Landmark size={20} />,
    title: "ERA underpayment detection (835)",
    summary: "Catch the payer that paid you less than it owed.",
    points: [
      "835 auto-posts allowed vs paid vs patient-responsibility, per claim and per payer",
      "Paid-vs-allowed gaps surface on the worklist instead of being buried",
      "Inbound 999 / 277CA / 277 / 271 / 835 auto-ingested every 15 minutes",
    ],
  },
  {
    icon: <Workflow size={20} />,
    title: "Secondary / COB rollover",
    summary: "Stop writing off coordination-of-benefits balances.",
    points: [
      "Auto-builds a worklist of paid primaries with a leftover balance and no secondary on file",
      "One click rolls it to the secondary as a draft 837 snapshotting the primary's adjudication",
      "Built to adjudicate cleanly in the 2320/2330 COB loop",
    ],
  },
  {
    icon: <Receipt size={20} />,
    title: "Denials worklist + appeals",
    summary: "Work the dollars worth chasing — then win them back.",
    points: [
      "Ranked by recoverable dollars × win-probability; CARC/RARC-tagged terminal vs workable",
      "A pre-filled appeal-letter PDF, faxed or logged, with outcome and win-rate tracking",
      "Resolved denials drop off the list automatically",
    ],
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "Medicare ADR / audit queue",
    summary:
      "When RAC / CERT / TPE / UPIC asks, the file is already assembled.",
    gold: true,
    points: [
      "Log the records request once; a scope-aware checklist seeds from a CPAP documentation catalog",
      "Per-patient readiness flags which required docs — signed order, sleep study, F2F, POD, adherence report — are on file",
      "Deadline tracked on-track / at-risk / overdue so a request never slips",
    ],
  },
];

function Recover() {
  return (
    <section className="bx-section bx-section-tight" id="take-backs">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldAlert size={13} /> Take-backs & under-billing
          </span>
          <h2 className="bx-h2">
            Keep the money you earned — and collect what you missed
          </h2>
          <p className="bx-lede">
            Compliance isn't only about the claim going out clean; it's about
            keeping the payment after it lands and not leaving dollars on the
            table. Breathe catches underpayments, COB balances, and aging
            claims, and assembles the documentation an auditor asks for — so a
            post-pay review doesn't turn a paid claim into a clawback.
          </p>
        </div>
        <CapGrid items={RECOVER} />
      </div>
    </section>
  );
}

/* ── The one-step ADR audit packet ── */
const PACKET_FLOW: {
  icon: React.ReactNode;
  label: string;
  sub: string;
  gold?: boolean;
}[] = [
  {
    icon: <ScrollText size={15} />,
    label: "Log the ADR",
    sub: "or read the fax",
  },
  {
    icon: <ClipboardCheck size={15} />,
    label: "Pick the scope",
    sub: "device / supplies",
  },
  { icon: <Cpu size={15} />, label: "Generate", sub: "one click", gold: true },
  {
    icon: <FileCheck2 size={15} />,
    label: "One PDF",
    sub: "cover sheet + index",
  },
  {
    icon: <Send size={15} />,
    label: "Fax the contractor",
    sub: "marked submitted",
  },
];

const PACKET_CARDS: Cap[] = [
  {
    icon: <FileSignature size={20} />,
    title: "Pulled from your chart",
    summary: "The documents already on file, gathered for you.",
    points: [
      "Signed order / SWO, the qualifying sleep study, and face-to-face notes",
      "Proof-of-delivery photo and the CMN, pulled straight from storage",
      "Merged as true PDFs — text stays selectable — each behind a divider page",
    ],
  },
  {
    icon: <Cpu size={20} />,
    title: "Generated on the spot",
    summary: "The summaries an auditor wants, built from your data.",
    gold: true,
    points: [
      "A cover sheet and table of contents with the patient, contractor, and deadline",
      "The LCD L33718 adherence report, computed from the device nights",
      "Equipment, claim detail, continued-use, and the supply replacement record",
    ],
  },
  {
    icon: <ClipboardCheck size={20} />,
    title: "Readiness check first",
    summary: "Know what's missing before you build — not at audit time.",
    points: [
      "Flags which required documents are present vs still needed for that scope",
      "So staff chase a missing SWO or sleep study early, not against the deadline",
      "The response deadline is tracked on-track / at-risk / overdue, with a nightly sweep and alert digest",
    ],
  },
];

function AuditPacket() {
  return (
    <section className="bx-section" id="audit-packet">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldCheck size={13} /> The easy audit response
          </span>
          <h2 className="bx-h2">
            When the auditor asks, answer in <em>one step</em>
          </h2>
          <p className="bx-lede">
            A Medicare records request — an ADR from RAC, CERT, TPE, or UPIC —
            used to mean digging through folders and hand-assembling a stack of
            PDFs against a clock. In Breathe you log the request once (or let it
            read the fax), pick the scope, and click Generate: the whole
            response builds itself into a single PDF you can download or fax to
            the contractor.
          </p>
        </div>
        <div className="bx-claims-engine bx-reveal">
          <div className="bx-claims-engine-head">
            <Workflow size={15} /> From records request to filed response
          </div>
          <ol className="bx-claims-flow">
            {PACKET_FLOW.map((s, i) => (
              <li
                className={`bx-claims-step${s.gold ? " gold" : ""}`}
                key={s.label}
              >
                <span className="bx-claims-ic">{s.icon}</span>
                <span className="bx-claims-meta">
                  <b>{s.label}</b>
                  <i>{s.sub}</i>
                </span>
                {i < PACKET_FLOW.length - 1 ? (
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
          {PACKET_CARDS.map((c) => (
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
          The one step assembles the packet — it gathers every document on file
          and generates the summaries; it can't produce a document that was
          never uploaded, which is exactly what the readiness check is for.
          Designed to turn a multi-hour scramble into a few clicks (available
          with the audit-response queue enabled).{" "}
          <Link href="/breathe/get-paid">See the full revenue cycle →</Link>
        </p>
      </div>
    </section>
  );
}

/* ── Therapy compliance Medicare keeps paying for ── */
const THERAPY: Cap[] = [
  {
    icon: <Gauge size={20} />,
    title: "One CMS adherence rule engine",
    summary: "LCD L33718, computed once and used everywhere.",
    gold: true,
    points: [
      "≥4 hrs/night on ≥21 of 30 days in the first 90 — one vetted, unit-tested module",
      "The same verdict feeds the attestation PDF, reports, analytics, and the KX-modifier check",
      "So the document you send a payer and the flag in billing can never disagree",
    ],
  },
  {
    icon: <FileSignature size={20} />,
    title: "90-day adherence attestation",
    summary: "The auditor-ready proof, generated for you.",
    points: [
      "Finds the best qualifying 30-day window inside the 90-day trial automatically",
      "Renders a signed/dated LCD L33718 attestation — compliant nights, %, date range, methodology",
      "Reads real device data (ResMed, Philips, 3B), de-duplicated across feeds",
    ],
  },
  {
    icon: <Activity size={20} />,
    title: "Daily compliance scanner",
    summary: "Catch a patient drifting before day 90.",
    points: [
      "Scores nightly usage against a target that ramps toward the 70%-of-nights bar",
      "Opens one at-risk alert per patient on the CSR worklist — early enough to act",
      "A transparent adherence-risk score from week one, with plain-language factors",
    ],
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Objective therapy data",
    summary: "Real manufacturer data, normalized into one shape.",
    points: [
      "Nightly sync from ResMed AirView, Philips Care Orchestrator, and 3B React Health",
      "Usage, AHI, leak, and P95 pressure with a per-vendor CMS-compliance read",
      "Replaces manual SD-card transcription — the recorded nights behind every claim",
    ],
  },
  {
    icon: <LineChart size={20} />,
    title: "Provider & referral reports",
    summary: "Show referrers their patients are doing well — safely.",
    points: [
      "Average usage, AHI, leak, % adherent, and CMS-threshold share by provider or manufacturer",
      "De-identified labels so the report is safe to share externally",
      "The same vetted adherence rule used across the whole platform",
    ],
  },
  {
    icon: <HeartPulse size={20} />,
    title: "Close the loop on at-risk patients",
    summary: "Flagging becomes intervention — automatically.",
    points: [
      "At-risk patients can auto-enroll into a tracked coaching plan (opt-in, idempotent)",
      "A patient-facing low-usage check-in nudge (off by default, fail-closed)",
      "Quarterly therapy summaries patients can forward to their physician",
    ],
  },
];

function Therapy() {
  return (
    <section className="bx-section" id="therapy">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Stethoscope size={13} /> Therapy & Medicare adherence
          </span>
          <h2 className="bx-h2">
            The documentation Medicare requires — captured automatically
          </h2>
          <p className="bx-lede">
            The 4-hour rule isn't just a clinical goal; it's the condition
            payers attach to continued reimbursement. Breathe scores every
            patient against Medicare's LCD L33718 standard from real device
            data, surfaces who's slipping in time to help, and generates the
            signed attestation — so patients stay on therapy and the coverage
            stays in place.
          </p>
        </div>
        <CapGrid items={THERAPY} />
      </div>
    </section>
  );
}

/* ── The safeguards, built in (data / privacy / access / telecom) ── */
const SAFEGUARDS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <EyeOff size={20} />,
    title: "On-device patient imaging",
    body: "The mask fitter runs its face-mesh vision in the browser; only millimeters are sent — the photo is discarded from memory and never uploaded or stored.",
  },
  {
    icon: <Database size={20} />,
    title: "PHI kept out of logs",
    body: "A documented hard rule forbids image bytes and order request bodies in any backend log; inbound MMS records counts and structure only — never media or message contents.",
  },
  {
    icon: <KeyRound size={20} />,
    title: "Least-privilege access",
    body: "Every admin route is permission-gated and fails closed; destructive actions are full-admin only, and a transiently unreadable role rejects the request rather than over-granting.",
  },
  {
    icon: <Fingerprint size={20} />,
    title: "Admin two-factor",
    body: "Authenticator-app MFA enforced server-side with hashed single-use recovery codes; mandatory-MFA blocks the whole admin surface until a second factor is verified.",
  },
  {
    icon: <Lock size={20} />,
    title: "Hardened sessions",
    body: "argon2id sign-in, DB-backed sessions stored only as a hash, HttpOnly/Secure/SameSite cookies, a constant-time CSRF check on every mutation, and no-store on admin responses.",
  },
  {
    icon: <Server size={20} />,
    title: "Tenant isolation",
    body: "Every query routes through one org-scoped client — with a CI guard that fails the build on any bypass, NOT-NULL org_id on every tenant table, and two-tenant leakage tests.",
  },
  {
    icon: <Database size={20} />,
    title: "File-level access control",
    body: "Each prescription, insurance card, and delivery photo carries its own access record on HIPAA-eligible storage, with an ownership-hijack guard so one patient can't claim another's file.",
  },
  {
    icon: <Network size={20} />,
    title: "Encrypted in transit",
    body: "TLS end to end with HSTS, nosniff, frame-deny, and a referrer policy chosen so patient identifiers in a URL don't leak to third parties via the Referer header.",
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "Verified webhooks",
    body: "Inbound Twilio webhooks are HMAC-verified in constant time before anything runs, so a forged callback can't spoof a patient's number to fake an opt-out or an order.",
  },
  {
    icon: <PhoneCall size={20} />,
    title: "TCPA send window",
    body: "Automated SMS is gated to 9am–8pm local to the recipient — stricter than the TCPA rule, timezone-resolved, and enforced independently of any user-set do-not-disturb.",
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Opt-outs always honored",
    body: "STOP / HELP (and Spanish and Portuguese equivalents) are matched before any patient lookup and exempt from rate-limiting, so an opt-out can never be dropped or throttled.",
  },
  {
    icon: <FileCheck2 size={20} />,
    title: "Agreements gate",
    body: "A tenant must e-sign the HIPAA Business Associate Agreement and Master Services Agreement before its console is usable — enforced in the API itself, not just the UI.",
  },
];

function Safeguards() {
  return (
    <section className="bx-section bx-section-tight" id="safeguards">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldCheck size={13} /> The safeguards, built in
          </span>
          <h2 className="bx-h2">
            Privacy and security by default, not by checklist
          </h2>
          <p className="bx-lede">
            The controls a compliance reviewer asks about — grouped the way a
            security review actually reads them. Each is enforced in the
            software, so it holds whether or not anyone remembers it.
          </p>
        </div>
        <div className="bx-sec-grid">
          {SAFEGUARDS.map((s) => (
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

/* ── Is the AI legitimate? (the skeptic's section) ── */
const AI_GUARDS: Cap[] = [
  {
    icon: <Cpu size={20} />,
    title: "Compliance-critical steps are code, not AI",
    summary: "The decisions that keep you compliant are deterministic rules.",
    gold: true,
    points: [
      "STOP/HELP is matched by scripted rules and honored before we even identify the sender",
      "Eligibility, the claim scrubber, timely filing, and modifiers are deterministic, re-derivable logic",
      "There's no model output to second-guess on the steps that decide compliance",
    ],
  },
  {
    icon: <UserCheck size={20} />,
    title: "The AI never decides coverage or care",
    summary: "It drafts and understands; a person decides.",
    points: [
      "AI classifies intent and drafts replies — a human approves anything that matters",
      "It makes no clinical and no coverage determination",
      "The voice agent leaves a summary; claims are scrubbed for a person to approve",
    ],
  },
  {
    icon: <Bot size={20} />,
    title: "Fenced with a confidence bar",
    summary: "Automation only runs when it's sure — otherwise a human.",
    points: [
      "Email auto-reply sends only above a configurable confidence bar (default 0.8)",
      "Anything order-, account-, billing-, insurance-, or clinically-specific routes to a person",
      "Empty or unparseable model output, or any error, fails to a human",
    ],
  },
  {
    icon: <EyeOff size={20} />,
    title: "PHI scrubbed before any model call",
    summary: "The model never sees the identifiers.",
    gold: true,
    points: [
      "Emails, SSNs, phone numbers, DOBs, and long IDs are masked before text reaches OpenAI or Anthropic",
      "The model knows “a phone number was mentioned” but never the digits",
      "We log only per-type redaction counts — never the values",
    ],
  },
  {
    icon: <BrainCircuit size={20} />,
    title: "The public chatbot holds no identity",
    summary: "Designed as a low-PHI, no-lookup surface.",
    points: [
      "Instructed never to repeat identifying details a visitor volunteers",
      "Account- and insurance-specific questions are directed to a person",
      "Even if the prompt rule were bypassed, redaction already removed the identifiers",
    ],
  },
  {
    icon: <ShieldCheck size={20} />,
    title: "HIPAA-eligible AI vendors, under BAA",
    summary: "No consumer-grade AI in any PHI path.",
    points: [
      "Anthropic, OpenAI, Deepgram, ElevenLabs, Twilio, SendGrid — each HIPAA-eligible and under a BAA",
      "A missing key or failed call returns an offline reply or hands to a human — it never breaks the day",
      "AI degrades gracefully; it is never load-bearing for safety",
    ],
  },
];

function AiGuards() {
  return (
    <section className="bx-section" id="ai-legitimacy">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <BrainCircuit size={13} /> For the AI skeptic
          </span>
          <h2 className="bx-h2">
            Is the AI legitimate? Here's exactly how it's fenced
          </h2>
          <p className="bx-lede">
            A fair question — and the honest answer is that the AI is kept well
            away from the decisions that carry compliance or clinical risk. The
            steps that keep you compliant are plain, auditable rules; the AI is
            confined to understanding messages and drafting words, always with a
            person in the loop and the patient's identifiers never in front of
            the model.
          </p>
        </div>
        <CapGrid items={AI_GUARDS} />
      </div>
    </section>
  );
}

/* ── Proof you can produce on demand (operational records) ── */
const RECORDS: Cap[] = [
  {
    icon: <FileSignature size={20} />,
    title: "Tamper-evident e-signature ledger",
    summary: "A hash-chained record of who signed what, and when.",
    gold: true,
    points: [
      "Providers e-sign orders, Rx, claims, and CMNs/DWOs/SWOs over MFA with explicit ESIGN consent",
      "Every step recorded as an append-only, SHA-256 hash-chained event (name, NPI, IP, timestamp)",
      "A printable, tamper-evident signature chain — exactly who signed what, when",
    ],
  },
  {
    icon: <ClipboardCheck size={20} />,
    title: "Signature-tracking ledger",
    summary: "The paperwork you need to bill never falls through the cracks.",
    points: [
      "One view of every order still out for a prescriber's signature, oldest first",
      "A scannable barcode on the PDF; scanning the return instantly marks it received",
      "Grouped by provider and practice so the queue works at a glance",
    ],
  },
  {
    icon: <PackageCheck size={20} />,
    title: "Proof of delivery",
    summary: "Evidence an item arrived — for the patient or the payer.",
    points: [
      "A doorstep or parcel photo (and optional signed-for name) captured per order",
      "Stored as private object storage and validated on upload",
      "Produced when a patient says “I never got it” or a payer requests it",
    ],
  },
  {
    icon: <Send size={20} />,
    title: "Delivery tracking on every notice",
    summary: "A dated record that you actually reached the patient.",
    points: [
      "Each SMS and email records sent / delivered / failed with timestamp and error code",
      "Carrier and SendGrid callbacks update the final state",
      "Failures surface in a delivery view and trigger an alert — not lost silently",
    ],
  },
  {
    icon: <Fingerprint size={20} />,
    title: "Patient-access trail",
    summary: "Which staff member opened which patient record.",
    points: [
      "A queryable, CSV-exportable record of view / create / update / delete by staff",
      "Recorded after the response so it adds no latency; URL search terms are never stored",
      "PHI-safe by design — stable identifiers only, never names, DOB, or clinical text",
    ],
  },
  {
    icon: <Activity size={20} />,
    title: "One patient timeline",
    summary: "Reconstruct the whole fulfillment sequence at a glance.",
    points: [
      "Episodes, shipments, outreach, address changes, recalls, coaching, and visits in order",
      "Assembled from live operational records across the platform",
      "An operational activity feed — not a tamper-evident audit log",
    ],
  },
];

function Records() {
  return (
    <section className="bx-section bx-section-tight" id="records">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ScrollText size={13} /> Proof on demand
          </span>
          <h2 className="bx-h2">
            When someone asks “prove it,” the record is already there
          </h2>
          <p className="bx-lede">
            Compliance lives or dies on documentation. As your team works,
            Breathe keeps the operational records that defend a claim or answer
            a dispute — signatures, delivery, the documents still outstanding,
            and who touched which record — without anyone stopping to file them.
          </p>
        </div>
        <CapGrid items={RECORDS} />
      </div>
    </section>
  );
}

/* ── The honest boundary — what stays yours ── */
function Boundary() {
  return (
    <section className="bx-section bx-manifesto-section">
      <div className="bx-shell">
        <figure className="bx-manifesto bx-reveal">
          <Quote className="bx-quote-mark" size={40} aria-hidden="true" />
          <blockquote>
            We won't tell you software makes you HIPAA-compliant — no software
            can, and any vendor that says so is selling you something. Breathe
            runs on HIPAA-eligible infrastructure with the compliance-critical
            steps built into the daily workflow. Your accreditation, state
            licensure, payer contracts, and internal policies stay yours —
            Breathe just makes following them the path of least resistance.
          </blockquote>
          <figcaption>
            <span>
              <b>Where the software ends, and your program begins</b>
              <i>
                Compliance is a shared responsibility — we're clear about which
                half is ours
              </i>
            </span>
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ── FAQ ── */
const FAQ: { q: string; a: string }[] = [
  {
    q: "Is CareMetric Breathe HIPAA-compliant?",
    a: "We say HIPAA-eligible, not HIPAA-compliant — on purpose. HIPAA is a shared responsibility: the platform provides the safeguards (least-privilege access, PHI minimization, encryption in transit, HIPAA-eligible vendors under a BAA), and you operate them under your own policies. The compliance-critical steps are enforced in the software rather than left to memory — but no vendor can hand you compliance, and any that claims to is overselling.",
  },
  {
    q: "Does the AI make clinical or coverage decisions?",
    a: "No. The steps that decide compliance — opt-out handling, eligibility, claim scrubbing, timely filing, modifiers — are deterministic code, not AI. The AI is confined to understanding messages and drafting replies, always with a human approving anything order-, billing-, or clinically-specific. It makes no clinical and no coverage determination.",
  },
  {
    q: "Is our patient data used to train AI models?",
    a: "Every AI vendor we use is HIPAA-eligible and under a Business Associate Agreement, and no consumer-grade AI endpoint is wired into any PHI path. Patient-typed text is PII-scrubbed — emails, phone numbers, SSNs, and dates of birth masked — before it ever reaches a model, and we log only per-type redaction counts, never the values.",
  },
  {
    q: "What happens in a Medicare audit (RAC, CERT, TPE)?",
    a: "Log the records request once and a scope-aware checklist assembles from a CPAP documentation catalog, with a per-patient readiness check showing which required documents — signed order, qualifying sleep study, face-to-face notes, proof of delivery, and the LCD L33718 adherence attestation — are already on file. The response deadline is tracked on-track / at-risk / overdue so the request never slips past its window.",
  },
  {
    q: "Does this replace my accreditation or licensure?",
    a: "No. Your ACHC or Joint Commission accreditation, state DME licensure, payer contracts, and internal policies stay yours. Breathe makes following them the path of least resistance — it doesn't stand in for them, and we're deliberate about not pretending otherwise.",
  },
];

function Faq() {
  return (
    <section className="bx-section" id="compliance-faq">
      <div className="bx-shell bx-faq-shell">
        <div className="bx-section-head bx-reveal">
          <span className="bx-eyebrow">
            <MessageSquare size={13} /> Questions your compliance team will ask
          </span>
          <h2 className="bx-h2">Straight answers, including where we stop</h2>
          <p className="bx-lede">
            The questions a careful buyer — or their counsel — asks before they
            trust software with PHI and payer money.
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
        <p className="bx-stats-note bx-reveal">
          Looking for the control list a security review reads, or the full
          revenue-cycle detail?{" "}
          <Link href="/breathe/security">See security</Link> ·{" "}
          <Link href="/breathe/get-paid">see the revenue cycle →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreatheCompliance() {
  useDocumentTitle(
    "Compliance — Breathe by CareMetric.ai",
    "How CareMetric Breathe builds payer, Medicare/CMS, therapy-adherence, privacy, and telecom compliance into the daily workflow — preventing take-backs and under-billing, documenting the 4-hour rule, fencing the AI away from clinical and coverage decisions, and keeping the records an auditor asks for. HIPAA-eligible, honest about where the software ends.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Scale}
        eyebrow="Compliance"
        title={
          <>
            Compliant by design —{" "}
            <span className="grad-em">not by reminder.</span>
          </>
        }
        sub="Payer rules, Medicare adherence, patient privacy, and telecom law — the compliance-critical steps are enforced in the software itself, not left to anyone's memory. Fewer take-backs, less under-billing, and the documentation already assembled when an auditor asks. Here's exactly how — and exactly where our job ends and yours begins."
      />
      <Prevent />
      <Recover />
      <AuditPacket />
      <Therapy />
      <Safeguards />
      <AiGuards />
      <Records />
      <Boundary />
      <Faq />
      <ClosingCta />
    </BreatheShell>
  );
}
