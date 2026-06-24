import { Link } from "wouter";
import {
  CreditCard,
  Heart,
  MessageSquare,
  RefreshCw,
  ScanFace,
  Smile,
  Star,
  Stethoscope,
  Store,
  TrendingUp,
  UserRound,
} from "lucide-react";

import { useDocumentTitle } from "@/hooks/use-document-title";

import { BreatheShell, ClosingCta, PageHead } from "./breathe";
import "./breathe.css";

/**
 * Breathe — Patient experience.
 *
 * The site sells almost entirely to the owner/operator; this page adds the
 * missing dimension — what the operator's PATIENTS get — framed for the
 * operator as the retention story that drives reorder revenue: happier
 * patients stay on therapy and reorder. Every surface maps to shipped
 * functionality (branded storefront + virtual mask fitter, patient portal /
 * account + statements + order tracking, storefront chatbot + email
 * auto-reply, sleep coach + coaching plans, payment plans/autopay, reviews +
 * NPS).
 *
 * Reuses the shared chrome and `.bx-*` design system — no new CSS, inherits
 * the apex-gated `noindex`, lazy-loaded. Branded to the platform (CareMetric
 * Breathe), never a tenant.
 */

/* ── What patients actually get ── */
type Cap = {
  icon: React.ReactNode;
  title: string;
  summary: string;
  points: string[];
  gold?: boolean;
};

const EXPERIENCE: Cap[] = [
  {
    icon: <Store size={20} />,
    title: "A storefront that feels like yours",
    summary: "Your brand, your domain — not a generic portal.",
    points: [
      "A modern shop with your logo, colors, and your own web address",
      "Catalog, cart, and checkout patients can use without calling in",
      "Live insurance benefit estimates before they ever pay",
    ],
  },
  {
    icon: <ScanFace size={20} />,
    title: "Fit a mask from the couch",
    summary: "No in-person fitting, no guesswork.",
    points: [
      "The virtual fitter measures from a phone photo and recommends the size",
      "The image never leaves the browser — only measurements are used",
      "Fewer returns and exchanges from masks that fit the first time",
    ],
    gold: true,
  },
  {
    icon: <UserRound size={20} />,
    title: "Everything in one account",
    summary: "Self-service that cuts your inbound calls.",
    points: [
      "Order history, upcoming refills, and reorder in a couple of taps",
      "Clear billing statements and a one-tap link to pay or plan",
      "Live order tracking, so “where's my order?” answers itself",
    ],
  },
  {
    icon: <MessageSquare size={20} />,
    title: "Answers, any hour",
    summary: "An on-brand assistant that never sleeps.",
    points: [
      "A storefront chatbot that answers product and coverage questions",
      "High-confidence email replies sent automatically, day or night",
      "Anything order-, account-, or clinical-specific routes to your team",
    ],
  },
  {
    icon: <Stethoscope size={20} />,
    title: "Coaching through the hard part",
    summary: "Support exactly when patients tend to quit.",
    points: [
      "An AI sleep coach answers comfort and adherence questions 24/7",
      "Scheduled coaching plans guide the make-or-break first weeks",
      "Education that keeps patients on therapy — and on resupply",
    ],
    gold: true,
  },
  {
    icon: <CreditCard size={20} />,
    title: "Easy ways to pay",
    summary: "Convenience that lifts conversion.",
    points: [
      "Card checkout, subscriptions, and autopay for refills",
      "Payment plans that split a high balance into installments",
      "Saved details mean reordering is friction-free next time",
    ],
  },
];

function Experience() {
  return (
    <section className="bx-section" id="experience">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <Smile size={13} /> The patient side
          </span>
          <h2 className="bx-h2">An experience patients actually like</h2>
          <p className="bx-lede">
            Every patient-facing surface carries your brand and removes a reason
            to call: a real online shop, a self-serve mask fitter, one account
            for orders and bills, always-on answers, and coaching through the
            weeks patients are most likely to quit.
          </p>
        </div>
        <div className="bx-caps">
          {EXPERIENCE.map((c) => (
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

/* ── Why it pays off (the retention → revenue tie) ── */
const RETENTION: {
  icon: React.ReactNode;
  metric: string;
  metricSub: string;
  title: string;
  body: string;
  gold?: boolean;
}[] = [
  {
    icon: <Heart size={22} />,
    metric: "Stay",
    metricSub: "on therapy",
    title: "Patients who feel supported don't quit",
    gold: true,
    body: "Roughly one in three CPAP patients drifts out of adherence. The fitter, the coach, and the coaching plans keep more of them comfortable and compliant — which keeps them eligible and ordering.",
  },
  {
    icon: <RefreshCw size={22} />,
    metric: "Reorder",
    metricSub: "without friction",
    title: "Easy is what gets reordered",
    body: "A one-tap signed reorder link, a saved card, and a shop they already trust turn the most predictable revenue in DME — resupply — into something patients complete themselves.",
  },
  {
    icon: <Star size={22} />,
    metric: "Refer",
    metricSub: "& review",
    title: "Happy patients become your marketing",
    body: "Post-order review and NPS surveys turn good experiences into star ratings on your storefront and a steady read on satisfaction — social proof that brings the next patient in.",
  },
];

function Retention() {
  return (
    <section className="bx-section" id="retention">
      <div className="bx-shell">
        <div className="bx-section-head center bx-reveal">
          <span className="bx-eyebrow">
            <TrendingUp size={13} /> Why it pays off
          </span>
          <h2 className="bx-h2">A better experience is a bigger bottom line</h2>
          <p className="bx-lede">
            This isn&apos;t about being nice for its own sake. In DME, the
            patient experience <em>is</em> the retention engine — and retention
            is where resupply revenue comes from. Keep patients comfortable,
            compliant, and able to reorder in two taps, and the numbers follow.
          </p>
        </div>
        <div className="bx-pillars">
          {RETENTION.map((p) => (
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
          Proactive, well-supported resupply lifts reorder capture from roughly
          one in five to nearly half — and the experience is what makes patients
          say yes.{" "}
          <Link href="/breathe/patient-experience#experience">
            See everything they get above
          </Link>{" "}
          ·{" "}
          <Link href="/breathe/roi">size the revenue →</Link>
        </p>
      </div>
    </section>
  );
}

export function BreathePatientExperience() {
  useDocumentTitle(
    "Patient experience — Breathe by CareMetric.ai",
    "What your patients get with Breathe: a branded storefront and virtual mask fitter, a self-serve portal for orders, statements, and tracking, an always-on assistant, an AI sleep coach, and easy ways to pay — the experience that keeps patients on therapy and reordering.",
    { schema: "Article" },
  );
  return (
    <BreatheShell>
      <PageHead
        icon={Smile}
        eyebrow="Patient experience"
        title={
          <>
            Patients who love it{" "}
            <span className="grad-em">stay — and reorder.</span>
          </>
        }
        sub="Breathe gives your patients a branded shop, a self-serve mask fitter, one account for orders and bills, always-on answers, and a coach for the hard weeks — the experience that keeps them on therapy and turns resupply into recurring revenue."
      />
      <Experience />
      <Retention />
      <ClosingCta />
    </BreatheShell>
  );
}
