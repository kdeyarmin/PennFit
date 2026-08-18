import { Fragment } from "react";
import { Link } from "wouter";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Check,
  ChevronDown,
  ClipboardCheck,
  Eye,
  FileCheck2,
  Filter,
  Gauge,
  HeartPulse,
  Layers,
  LockKeyhole,
  Magnet,
  MessagesSquare,
  Minus,
  QrCode,
  Repeat,
  Ruler,
  ScanFace,
  ShieldAlert,
  Signature,
  Smartphone,
  Sparkles,
  Stethoscope,
  Store,
  TrendingUp,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Clinical mask fitting deep-dive.
 *
 * Why this page exists: the fitter is the platform's sharpest competitive
 * surface — it is the one thing a point-solution vendor (SleepGlad, now the
 * AI-fitting layer inside VGM Total Sleep Services) sells as a whole product
 * — and until this page the marketing site described it as a *convenience*
 * ("no staff time, no wasted sample masks"). Everything that makes it a
 * clinical instrument shipped in migrations 0481–0496 and was invisible to a
 * buyer. See `docs/competitor-analysis-sleepglad-2026-08-18.md`.
 *
 * Accuracy — every claim here maps to shipped code, not roadmap:
 *  - On-device capture: `pages/capture.tsx` + `pages/measure.tsx` run MediaPipe
 *    FaceLandmarker in the browser; only scalar measurements are transmitted
 *    (CLAUDE.md hard rule: no image logging anywhere in the backend).
 *  - Six-tier engine: `lib/fitting/tiers.ts`. Tiers 1–2 (safety, therapy
 *    compatibility) are HARD FILTERS — a candidate that fails is removed, not
 *    penalised. Tiers 5–6 (formulary, inventory) are bounded multipliers that
 *    feed `rankScore` only; the patient-facing `confidence` is computed from
 *    clinical terms alone, so a commercial preference can never inflate it.
 *  - Safety screening: migration 0484 (versioned rules, household scope),
 *    0492 (magnet flag corrections), 0493 (`magnet_free_variant_slug` — the
 *    same-model magnet-free twin is offered first when it survives).
 *  - Sizing: `mask_size_variants` (0481) millimetre bands, cushion and frame
 *    resolved independently; `components/fit-range-diagram.tsx` renders the
 *    to-scale band on `/results`.
 *  - Formulary: 0482 `formularies` / `formulary_rules` scope by contract,
 *    payer, location, therapy mode and service line.
 *  - Confidence: `lib/fitting/confidence.ts` — an explicit "I don't know"
 *    that routes to human review; an unreviewed size band is capped below
 *    high confidence regardless of geometric match.
 *  - Fit report + provenance: 0483 `fit_sessions` / append-only
 *    `fit_session_events`, 0491 sign-off `source_kind` / `source_ref`, 0495
 *    band provenance with a citation-or-estimated CHECK.
 *  - Referral portal: 0487, `routes/provider/*`, `pages/provider/*`.
 *  - Entry points: 0489 `in_office` invite channel (QR, 12h TTL), 0490 the
 *    established-patient re-fit scan.
 *  - Outcomes: `routes/admin/analytics-fitter-outcomes.ts`.
 *  - Feedback loop: `lib/storefront/mask-fit-tuning.ts` — neutral until ≥10
 *    samples, clamped to ±0.15.
 *
 * Deliberately absent: an accuracy percentage. We do not publish one, and
 * §"Measure it" turns that into the argument — see the competitor doc, which
 * records vendor accuracy claims as unvalidated and internally inconsistent.
 *
 * Reuses the shared chrome and the namespaced `.bx-*` design system — no new
 * CSS, inherits the apex-gated `noindex`, lazy-loaded off the patient bundle.
 */

/* ── Three ways a fitting starts ── */
const ENTRY_POINTS: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
}[] = [
  {
    icon: <QrCode size={20} />,
    title: "At your counter",
    summary: "The patient is standing right there. Don't send them home first.",
    points: [
      "Staff open a fitting and hand over a QR code on screen — nothing is sent",
      "No email address, no mobile number, no waiting for a text to land",
      "The link is short-lived by design because it lives on a screen in a semi-public room",
      "Finishes on the patient's own phone, in your lobby, before they leave",
    ],
    gold: true,
  },
  {
    icon: <Smartphone size={20} />,
    title: "At home, from a text",
    summary:
      "Text or email a link and the fitting comes back to your worklist.",
    points: [
      "Works on any phone browser — no app to download, no account to create",
      "The patient scans, answers a short comfort questionnaire, and is done",
      "Results land in your fitter worklist with the mask, the size and the reasoning",
      "New leads and referrals can be fitted before they are ever a patient",
    ],
  },
  {
    icon: <Repeat size={20} />,
    title: "Re-fit a patient you already have",
    summary:
      "The mask that fit at setup is not always the mask that fits at month nine.",
    points: [
      "A daily scan finds patients who reported a leaking or uncomfortable fit",
      "It also finds patients still on a mask the manufacturer discontinued",
      "Each one is offered a fresh fitting — capped at one message per quarter",
      "Turns your existing roster into resupply revenue instead of churn",
    ],
  },
];

function EntryPoints() {
  return (
    <section className="bx-section" id="start">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ScanFace size={13} /> Three ways in
          </span>
          <h2 className="bx-h2">
            A fitting starts wherever the patient <em>actually is</em>
          </h2>
          <p className="bx-lede">
            Most fitting tools do exactly one thing: text a link and wait. That
            misses the patient at your counter and every patient already on
            service. Breathe opens a fitting from all three — and they all land
            in the same worklist, on the same record.
          </p>
        </div>
        <div className="bx-caps">
          {ENTRY_POINTS.map((c) => (
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

/* ── The six-tier engine ── */
const TIERS: {
  n: string;
  icon: React.ReactNode;
  name: string;
  how: string;
  hard?: boolean;
  gold?: boolean;
}[] = [
  {
    n: "1",
    icon: <ShieldAlert size={15} />,
    name: "Safety",
    how: "Implants, contraindications, household risk — a fail removes the mask",
    hard: true,
  },
  {
    n: "2",
    icon: <HeartPulse size={15} />,
    name: "Therapy compatibility",
    how: "Pressure range, therapy mode, service line — a fail removes the mask",
    hard: true,
  },
  {
    n: "3",
    icon: <Ruler size={15} />,
    name: "Facial fit",
    how: "The patient's millimetres against each size's published band",
  },
  {
    n: "4",
    icon: <Stethoscope size={15} />,
    name: "Patient characteristics",
    how: "Sleep position, mouth breathing, claustrophobia, facial hair, glasses",
  },
  {
    n: "5",
    icon: <Filter size={15} />,
    name: "Your formulary",
    how: "Contract, payer, location and therapy mode — bounded, ranking only",
  },
  {
    n: "6",
    icon: <Store size={15} />,
    name: "Inventory & supply",
    how: "What you can actually ship this week — bounded, ranking only",
  },
];

function Engine() {
  return (
    <section className="bx-section" id="engine">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Layers size={13} /> How the recommendation is made
          </span>
          <h2 className="bx-h2">
            Six tiers — and the first two <em>cannot be outvoted</em>
          </h2>
          <p className="bx-lede">
            Most recommendation engines are one big score: every factor becomes
            points, and enough points anywhere can outweigh a warning. Ours
            doesn&apos;t work that way. Safety and therapy compatibility are
            filters, not points — a mask that fails either is removed from the
            list entirely. No margin, no stock level, and no formulary
            preference can score its way past a contraindication, because by the
            time those tiers run the unsafe masks are already gone.
          </p>
        </div>

        <div className="bx-ladder bx-reveal">
          <span className="bx-ladder-cap start">
            <ScanFace size={13} /> Every mask in your catalog enters here
          </span>
          {TIERS.map((t, i) => (
            <Fragment key={t.name}>
              <div className="bx-ladder-step">
                <div className={`bx-ladder-node${t.hard ? " gold" : ""}`}>
                  <span className="bx-ladder-ic">{t.icon}</span>
                  <span className="bx-ladder-meta">
                    <b>
                      Tier {t.n} · {t.name}
                    </b>
                    <i>{t.how}</i>
                  </span>
                </div>
                {t.hard ? (
                  <span className="bx-ladder-exit">
                    <Minus size={13} /> Fails → removed from consideration
                  </span>
                ) : null}
              </div>
              {i < TIERS.length - 1 ? (
                <span className="bx-ladder-gap">
                  <ChevronDown size={14} aria-hidden="true" /> Survivors
                  continue
                </span>
              ) : null}
            </Fragment>
          ))}
          <span className="bx-ladder-gap">
            <ChevronDown size={14} aria-hidden="true" /> Ranked, with the
            reasoning kept
          </span>
          <span className="bx-ladder-cap end">
            <BadgeCheck size={13} /> A recommendation, its alternatives, and
            what was ruled out
          </span>
        </div>

        <p className="bx-stats-note bx-reveal">
          <Sparkles
            size={14}
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          The confidence number your patient sees is computed from{" "}
          <b>clinical terms only</b>. Formulary preference, stock levels,
          margin, and outcome tuning are excluded from it by construction — they
          can re-order two near-equal masks, and that is all. A patient can
          never be shown a confidence score inflated by what you would rather
          dispense.
        </p>
      </div>
    </section>
  );
}

/* ── Privacy: on-device vs. upload-and-discard ── */
const THEIRS = [
  "The patient's photo is uploaded to a vendor's cloud",
  "It is processed there, then deleted — you are trusting the deletion",
  "The image crosses a network you do not control on the way",
  "Your privacy story depends on a third party's retention policy",
];

const OURS: { icon: React.ReactNode; label: string; note: string }[] = [
  {
    icon: <Smartphone size={15} />,
    label: "The camera never leaves the phone",
    note: "Facial landmark detection runs in the patient's own browser",
  },
  {
    icon: <Ruler size={15} />,
    label: "Numbers are all that travel",
    note: "A handful of millimetre measurements — no image, no frames, no video",
  },
  {
    icon: <LockKeyhole size={15} />,
    label: "Nothing image-derived is ever logged",
    note: "A platform-level rule, enforced in the codebase, not a setting",
  },
  {
    icon: <Check size={15} />,
    label: "No app, no account, no upload",
    note: "The patient opens a link and it works on the phone they own",
  },
];

function Privacy() {
  return (
    <section className="bx-section" id="privacy">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <LockKeyhole size={13} /> Privacy by architecture
          </span>
          <h2 className="bx-h2">
            &ldquo;We delete the photo&rdquo; and{" "}
            <em>&ldquo;we never received the photo&rdquo;</em> are not the same
            promise
          </h2>
          <p className="bx-lede">
            Every remote fitting tool has to answer one question from a patient
            and a very different one from your compliance officer: where does
            the face picture go? Most answer &ldquo;to our cloud, and then we
            delete it.&rdquo; We answer &ldquo;nowhere.&rdquo; The measurement
            happens on the patient&apos;s device and only the numbers come back
            — which is a claim about how the software is built, not a policy you
            have to take on faith.
          </p>
        </div>
        <div className="bx-vs bx-reveal">
          <article className="bx-vs-col bx-vs-legacy">
            <header>
              <span className="bx-vs-kicker">Upload-and-discard fitting</span>
              <h3>The image leaves the patient&apos;s phone</h3>
            </header>
            <ul className="bx-vs-list">
              {THEIRS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </article>
          <div className="bx-vs-divider" aria-hidden="true">
            <span>vs</span>
          </div>
          <article className="bx-vs-col bx-vs-native">
            <header>
              <span className="bx-vs-kicker">Breathe</span>
              <h3>The image never leaves the patient&apos;s phone</h3>
            </header>
            <ul className="bx-vs-native-list">
              {OURS.map((o) => (
                <li key={o.label}>
                  <span className="bx-vs-ic">{o.icon}</span>
                  <span className="bx-vs-text">
                    <b>{o.label}</b>
                    <i>{o.note}</i>
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>
        <p className="bx-stats-note bx-reveal">
          It is also the easiest privacy conversation your staff will ever have
          with a nervous patient:{" "}
          <i>&ldquo;the picture stays on your phone.&rdquo;</i>{" "}
          <Link href="/breathe/security">See the full security posture →</Link>
        </p>
      </div>
    </section>
  );
}

/* ── The clinical safeguards ── */
const SAFEGUARDS: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
}[] = [
  {
    icon: <Magnet size={20} />,
    title: "Magnetic-component screening",
    summary:
      "The recall that made this a headline is a checkbox in most systems. Here it is a filter.",
    points: [
      "Covers pacemakers, defibrillators, neurostimulators, aneurysm clips, cochlear implants and metallic ocular implants",
      "Covers the household too — the risk is proximity, and it is not only the patient who sleeps in that bed",
      "A declared implant removes every magnetic-clip mask from the list — it is never merely down-ranked",
      "When the same model has a magnet-free version, that version is offered first — the patient keeps the mask they wanted",
      "The questions are put to the patient inside the fitting, and the engine refuses to recommend anything until they are answered",
    ],
    gold: true,
  },
  {
    icon: <FileCheck2 size={20} />,
    title: "Rules that carry a version",
    summary: "A manufacturer revises a warning. You don't wait for a release.",
    points: [
      "Exclusion rules are versioned data, not logic buried in a release",
      "A fit report cites the exact rule version that ran, by name",
      "Reprint it a year later and it shows the rules that applied that day — not today's",
      "Which is the difference between a record and a re-computation",
      "You publish a revised version yourself — clone the active set, change the question, publish. No release, no ticket",
    ],
  },
  {
    icon: <Gauge size={20} />,
    title: "It is allowed to say “I don’t know”",
    summary:
      "A fitter that always answers confidently is not confident — it is just always answering.",
    points: [
      "Lighting, focus, head pose and framing are scored on the actual frame — a blurry or badly-lit scan cannot produce a confident answer however well the mask matches",
      "A single unverified frame is treated as moderate, never as perfect — without cross-frame agreement there is no evidence the measurement is stable",
      "An incomplete questionnaire caps confidence too, rather than guessing the missing answers",
      "A size band no clinician has signed off can never produce a high-confidence result",
      "Low confidence routes to a human on your team instead of shipping a guess",
      "A frame the capture checks judge unusable — too dark, too soft, head turned too far — is reported as such, and caps the result no matter how well the geometry scored",
    ],
  },
];

function Safeguards() {
  return (
    <section className="bx-section" id="safety">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ShieldAlert size={13} /> The safeguards
          </span>
          <h2 className="bx-h2">
            Built like a clinical instrument, <em>not a product quiz</em>
          </h2>
          <p className="bx-lede">
            The gap between a fitting tool and a clinical tool is what happens
            in the awkward cases: the patient with a pacemaker, the scan taken
            in a dark kitchen, the manufacturer that revised a warning last
            month. This is what the engine does with all three.
          </p>
        </div>
        <div className="bx-caps">
          {SAFEGUARDS.map((c) => (
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

/* ── Sizing, formulary, the report ── */
const DEPTH: {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
}[] = [
  {
    icon: <Ruler size={20} />,
    title: "A size, and the reason for it",
    summary: "Shown to the patient as a diagram, not asserted as a verdict.",
    points: [
      "Every size carries its own millimetre band — not one range for the whole model",
      "Cushion and frame are resolved independently, because they are sized independently",
      "The patient sees their own measurement drawn to scale inside the size band it landed in",
      "“Your nose is 34 mm; the Medium cushion covers 31–37 mm” beats “trust us, Medium”",
    ],
    gold: true,
  },
  {
    icon: <Filter size={20} />,
    title: "Your formulary, scoped the way contracts actually work",
    summary: "Not one global allow-list — the rules a real DME lives under.",
    points: [
      "Scope by contract, payer, location, therapy mode and service line",
      "Rules resolve by specificity, so the most specific rule wins, unambiguously",
      "A payer-specific exclusion deliberately does not fire when the payer is unknown — we never deny on an assumption",
      "Formulary preference is bounded: it re-orders near-ties, it never promotes a poor clinical match",
    ],
  },
  {
    icon: <ClipboardCheck size={20} />,
    title: "A fit report you could hand to an auditor",
    summary:
      "Including the part nobody else prints: what was ruled out, and why.",
    points: [
      "Scan quality, measurements, questionnaire, safety screening, the recommendation and its alternatives",
      "The masks that were excluded and the named rule that excluded each one",
      "Clinical review, dispensing, and the evidence each size band was signed off against — and where a signer named none, the report says so rather than inventing one",
      "Every step written to an append-only session history — nothing rewrites the past",
    ],
  },
];

function Depth() {
  return (
    <section className="bx-section" id="depth">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Eye size={13} /> Show your work
          </span>
          <h2 className="bx-h2">
            A black box is a liability. <em>Ours opens.</em>
          </h2>
          <p className="bx-lede">
            When a patient asks &ldquo;why this mask?&rdquo;, when an RT
            second-guesses a size, or when a payer asks how a decision was made,
            &ldquo;the algorithm chose it&rdquo; is not an answer. Every fitting
            here produces its own reasoning — in a diagram for the patient, and
            in a stamped report for the chart.
          </p>
        </div>
        <div className="bx-caps">
          {DEPTH.map((c) => (
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

/* ── Referral network ── */
const REFERRAL: { icon: React.ReactNode; label: string; note: string }[] = [
  {
    icon: <Signature size={15} />,
    label: "Sign a whole queue at once",
    note: "Physicians review and batch-sign multiple patients in one pass",
  },
  {
    icon: <FileCheck2 size={15} />,
    label: "The fitting rides along",
    note: "Scan results attach to the order the prescriber is signing",
  },
  {
    icon: <MessagesSquare size={15} />,
    label: "Message the referring office",
    note: "Threaded messages and shared documents on the referral itself",
  },
  {
    icon: <LockKeyhole size={15} />,
    label: "Verified prescriber identity",
    note: "Two-factor sign-in on the provider portal, not a shared link",
  },
];

function ReferralNetwork() {
  return (
    <section className="bx-section" id="referrals">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Building2 size={13} /> Referral network
          </span>
          <h2 className="bx-h2">
            Your referring physicians get <em>their own portal</em>
          </h2>
          <p className="bx-lede">
            A fitting is only half the workflow — the other half is getting it
            prescribed. Referring offices sign in to a portal of their own, work
            a queue of your patients, and sign in batches. The paperwork stops
            being a fax you chase and becomes a queue somebody clears.
          </p>
        </div>
        <div className="bx-vs bx-reveal">
          <article className="bx-vs-col bx-vs-legacy">
            <header>
              <span className="bx-vs-kicker">Without it</span>
              <h3>Chase the signature</h3>
            </header>
            <ul className="bx-vs-list">
              <li>Fax out, wait, fax again, call the office</li>
              <li>Scan results live in a different system than the order</li>
              <li>Questions come back as voicemail, days later</li>
              <li>Nobody can tell you where a given referral actually is</li>
            </ul>
          </article>
          <div className="bx-vs-divider" aria-hidden="true">
            <span>vs</span>
          </div>
          <article className="bx-vs-col bx-vs-native">
            <header>
              <span className="bx-vs-kicker">Breathe</span>
              <h3>A queue the prescriber clears</h3>
            </header>
            <ul className="bx-vs-native-list">
              {REFERRAL.map((r) => (
                <li key={r.label}>
                  <span className="bx-vs-ic">{r.icon}</span>
                  <span className="bx-vs-text">
                    <b>{r.label}</b>
                    <i>{r.note}</i>
                  </span>
                </li>
              ))}
            </ul>
          </article>
        </div>
      </div>
    </section>
  );
}

/* ── Measure it ── */
const MEASURED = [
  "Refit rate — the number every fitting vendor quotes at you, on your own patients",
  "How often your team accepted the recommendation, and the reasons they overrode it",
  "Scan quality, so you can see whether the problem is the engine or the lighting",
  "The confidence mix, and how long a flagged fitting waited for a human",
  "All of it split by where the fitting started — your counter, a link you sent, or re-fit outreach to a patient already on service",
];

function Measured() {
  return (
    <section className="bx-section" id="measure">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <TrendingUp size={13} /> Measure it
          </span>
          <h2 className="bx-h2">
            We don&apos;t quote you an accuracy number.{" "}
            <em>We ship you the dashboard that measures ours.</em>
          </h2>
          <p className="bx-lede">
            Fitting vendors market accuracy percentages. Ask where the number
            comes from and the answer is the vendor. We would rather hand you
            the instrument: a fitter-outcomes dashboard, running on your
            patients, that tells you exactly how the engine is performing in
            your business — including when it isn&apos;t.
          </p>
        </div>
        <div className="bx-switch-wants bx-reveal">
          <h2 className="bx-switch-wants-title">
            What it reports, on your data
          </h2>
          <ul className="bx-switch-wants-list">
            {MEASURED.map((m) => (
              <li key={m}>
                <Check size={16} aria-hidden="true" />
                {m}
              </li>
            ))}
          </ul>
        </div>
        <p className="bx-stats-note bx-reveal">
          <Repeat
            size={14}
            aria-hidden="true"
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          Those outcomes feed back into the ranking — but carefully. The engine
          stays neutral until it has a real sample, and the adjustment is
          clamped tight enough to re-order two near-equal masks and nothing
          more. Feedback can never rescue a clinically poor mask, which is
          exactly the failure mode &ldquo;every scan makes it smarter&rdquo;
          invites.{" "}
          <Link href="/breathe/analytics">See the analytics suite →</Link>
        </p>
      </div>
    </section>
  );
}

/* ── Head-to-head with a point-solution fitter ── */
type Cell = "yes" | "no" | "partial";

const FIT_ROWS: {
  label: string;
  sub?: string;
  breathe: Cell;
  other: Cell;
  text?: { breathe: string; other: string };
}[] = [
  {
    label: "Remote selfie fitting, no app",
    breathe: "yes",
    other: "yes",
  },
  {
    label: "Manufacturer-agnostic model + size",
    breathe: "yes",
    other: "yes",
  },
  {
    label: "Provider sets their own formulary",
    breathe: "yes",
    other: "yes",
  },
  {
    label: "In-office scan at the counter",
    breathe: "yes",
    other: "yes",
  },
  {
    label: "Physician referral portal & batch signing",
    breathe: "yes",
    other: "yes",
  },
  {
    label: "Image never leaves the patient's device",
    sub: "vs. uploaded, then deleted",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Safety is a hard filter, not a score penalty",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Household screened for magnetic implants",
    sub: "not just the patient",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Same-model magnet-free swap offered first",
    breathe: "yes",
    other: "partial",
  },
  {
    label: "Per-size millimetre bands",
    sub: "cushion and frame resolved separately",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Patient sees their measurement against the band",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Formulary scoped by payer, contract & location",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Confidence excludes commercial factors by construction",
    breathe: "yes",
    other: "no",
  },
  {
    label: "The engine can decline and route to a human",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Fit report naming what was ruled out & why",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Rule versions stamped at the time of the fitting",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Size bands signed off by your own clinician",
    sub: "against evidence the report then prints",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Your own fitter-outcomes dashboard",
    sub: "refit rate, overrides, scan quality",
    breathe: "yes",
    other: "no",
  },
  {
    label: "Re-fit outreach to patients already on service",
    breathe: "yes",
    other: "partial",
  },
  {
    label: "Runs the rest of the business too",
    sub: "resupply · billing · clinical · storefront",
    breathe: "yes",
    other: "no",
    text: {
      breathe: "One platform",
      other: "A separate suite",
    },
  },
];

// The mark is an icon, and lucide-react hides an unlabelled icon from
// assistive tech — so without the visually-hidden text a screen reader reads
// an empty cell on every row and the table conveys nothing.
function FitMark({ v }: { v: Cell }) {
  if (v === "yes")
    return (
      <span className="bx-yes">
        <Check size={18} strokeWidth={2.6} aria-hidden="true" />
        <span className="bx-sr-only">Yes</span>
      </span>
    );
  if (v === "partial") return <span className="bx-partial">partial</span>;
  return (
    <span className="bx-no">
      <Minus size={17} aria-hidden="true" />
      <span className="bx-sr-only">No</span>
    </span>
  );
}

export function FitterCompare() {
  return (
    <section className="bx-section" id="vs">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <ScanFace size={13} /> Head to head
          </span>
          <h2 className="bx-h2">Against a stand-alone AI mask fitter</h2>
          <p className="bx-lede">
            The best-known one is SleepGlad, now the AI-fitting layer inside VGM
            Total Sleep Services. It is a good product and it does the fitting
            moment well — the top of this table is genuinely a tie. The
            difference is everything underneath: what happens on the awkward
            cases, what you can prove afterwards, and whether the fitting is a
            tool you bought or a step in the business you already run.
          </p>
        </div>

        <p className="bx-compare-swipe">
          Swipe the table to compare
          <span aria-hidden="true"> →</span>
        </p>

        <div className="bx-compare-wrap bx-reveal">
          <div className="bx-compare-scroll">
            <table className="bx-compare">
              <thead>
                <tr>
                  <th />
                  <th className="bx-col-breathe">
                    <span className="bx-compare-brand">
                      <b>Breathe</b>
                    </span>
                  </th>
                  <th className="bx-other" style={{ textAlign: "center" }}>
                    Stand-alone AI fitter
                  </th>
                </tr>
              </thead>
              <tbody>
                {FIT_ROWS.map((row) => (
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
                        <FitMark v={row.breathe} />
                      )}
                    </td>
                    <td className="bx-other">
                      {row.text ? row.text.other : <FitMark v={row.other} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="bx-compare-legend bx-reveal">
          <span>
            <span className="bx-yes">
              <Check size={15} strokeWidth={2.6} />
            </span>
            Built in &amp; included
          </span>
          <span>
            <span className="bx-partial">partial</span>
            Available in a limited form, or through a separate product
          </span>
          <span>
            <span className="bx-no">
              <Minus size={15} />
            </span>
            Not described in the product&apos;s published material
          </span>
        </div>

        <p className="bx-compare-foot">
          Comparison reflects publicly described capabilities as of 2026 and is
          provided for illustration. A blank is not an accusation — it means the
          capability is not described in that product&apos;s published material.
          SleepGlad and VGM are trademarks of their respective owners and are
          named here only to identify the products compared.
        </p>
      </div>
    </section>
  );
}

/* ── Turning it on ── */
function Activation() {
  return (
    <section className="bx-section bx-section-tight" id="activation">
      <div className="bx-shell">
        <div className="bx-switch-wants bx-reveal">
          <h2 className="bx-switch-wants-title">
            One honest note about turning it on
          </h2>
          <p
            className="bx-lede"
            style={{ marginTop: 10, marginBottom: 14, textAlign: "left" }}
          >
            The clinical engine ships switched off, and that is deliberate. A
            size band is a clinical number, so before the engine goes live your
            respiratory therapist signs off the bands for the models{" "}
            <em>you actually dispense</em> — against the manufacturer&apos;s own
            fitting documentation, which the console links for you — and every
            sign-off records what it was checked against. It is a short session
            per model, not a project, and until it is done the engine is capped
            below high confidence on purpose.
          </p>
          <ul className="bx-switch-wants-list">
            <li>
              <Check size={16} aria-hidden="true" />
              You are never fielding somebody else&apos;s estimate as your
              clinical output
            </li>
            <li>
              <Check size={16} aria-hidden="true" />
              Sign off only the models you stock — you do not clear a catalog
              you don&apos;t dispense
            </li>
            <li>
              <Check size={16} aria-hidden="true" />
              Batch sign-off for a whole model&apos;s size run, and the evidence
              you name prints on every fit report afterwards
            </li>
            <li>
              <Check size={16} aria-hidden="true" />
              Flip the switches yourself in the console — no deploy, no ticket,
              no waiting on us
            </li>
          </ul>
        </div>
        <div className="bx-price-cta bx-reveal">
          <span>Want to see the fitting flow end to end, on sample data?</span>
          <Link className="bx-btn bx-btn-primary" href="/breathe/signup">
            Create your account <ArrowRight size={16} />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function BreatheMaskFitting() {
  useDocumentTitle(
    "Clinical mask fitting — Breathe by CareMetric.ai",
    "AI mask fitting built like a clinical instrument: the image never leaves the patient's phone, safety is a hard filter rather than a score penalty, magnetic-implant screening covers the household, sizes carry millimetre bands, and every fitting produces a report naming what was ruled out and why.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={ScanFace}
        eyebrow="Clinical mask fitting"
        title={
          <>
            The mask fitter a clinician would{" "}
            <span className="grad-em">put their name on.</span>
          </>
        }
        sub="Anyone can text a patient a link and return a mask name. The hard part is the awkward cases — the pacemaker, the dark kitchen, the size nobody signed off, the payer that excludes the model you were about to send. This is a fitting engine built for those, and it happens to be the fastest one your staff will ever run."
      />
      <EntryPoints />
      <Engine />
      <Privacy />
      <Safeguards />
      <Depth />
      <ReferralNetwork />
      <Measured />
      <FitterCompare />
      <Activation />
      <ClosingCta />
    </BreatheShell>
  );
}

export default BreatheMaskFitting;
