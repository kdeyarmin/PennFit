// Patient education catalog — onboarding-stage-personalized content.
//
// Tier 1 K3 of the original plan: "Newly-onboarded patients see
// different content than 6-month patients." This file is the
// static catalog the /shop/me/education-feed endpoint uses to
// pick a small set of articles tailored to the patient's stage.
//
// Why static catalog (not DB)
// ---------------------------
// Same rationale as the hygiene catalog: the article set evolves
// with the codebase (SPA pages, copy, deeplinks) and shouldn't
// require a runtime mutation surface. Cadence — when each stage
// kicks in — is clinical convention, not per-tenant config.
//
// Stage boundaries
// ----------------
//   * `new`          — 0–14 days since first therapy night (or
//                      patient creation when no nights have
//                      streamed yet). Focus: mask comfort, ramp,
//                      first-week troubleshooting.
//   * `habituating`  — 15–60 days. Focus: mask seal, side-sleeping,
//                      congestion / mouth-breathing.
//   * `steady`       — 61–180 days. Focus: replacement cadence,
//                      humidifier tuning, traveling with CPAP.
//   * `experienced`  — 180+ days. Focus: annual review, Rx renewal
//                      lookahead, when to upgrade hardware.
//
// `slug` is the path under /learn the SPA renders. Only ship slugs
// that have a real `App.tsx` route — phantom paths 404 from the
// account education feed.

export type EducationStage = "new" | "habituating" | "steady" | "experienced";

export interface EducationArticle {
  slug: string;
  title: string;
  summary: string;
  category: "comfort" | "troubleshooting" | "maintenance" | "lifestyle";
}

const ARTICLES: Record<EducationStage, ReadonlyArray<EducationArticle>> = {
  new: [
    {
      slug: "/learn/first-two-weeks",
      title: "Your first two weeks on CPAP",
      summary: "What to expect — and which discomforts settle on their own.",
      category: "comfort",
    },
    {
      slug: "/learn/how-pap-works",
      title: "How PAP therapy works",
      summary: "Why your machine starts soft. When to ask us to adjust.",
      category: "comfort",
    },
    {
      slug: "/learn/mask-leaks",
      title: "Mask fit basics",
      summary: "Headgear tension, cushion position, the 30-second seal check.",
      category: "troubleshooting",
    },
  ],
  habituating: [
    {
      slug: "/learn/mask-leaks",
      title: "If your mask still leaks",
      summary: "Common causes in weeks 3–8 — most fix with a small adjustment.",
      category: "troubleshooting",
    },
    {
      slug: "/learn/sleep-hygiene",
      title: "Sleeping well with CPAP",
      summary: "Pillow tricks and habits that keep therapy on track.",
      category: "lifestyle",
    },
    {
      slug: "/learn/dry-mouth",
      title: "Mouth breathing, dry mouth, chin straps",
      summary: "Why your mouth feels like a desert and what actually helps.",
      category: "troubleshooting",
    },
  ],
  steady: [
    {
      slug: "/learn/replacement-schedule",
      title: "Replacement schedule, decoded",
      summary:
        "Cushion monthly, hose quarterly — but only if your therapy is steady.",
      category: "maintenance",
    },
    {
      slug: "/learn/cleaning-routine",
      title: "Cleaning + humidifier basics",
      summary: "Keep the hose and chamber fresh through the seasons.",
      category: "comfort",
    },
    {
      slug: "/learn/traveling-with-cpap",
      title: "Traveling with your CPAP",
      summary: "TSA, hotel outlets, battery packs, and altitude.",
      category: "lifestyle",
    },
  ],
  experienced: [
    {
      slug: "/learn/reading-your-sleep-report",
      title: "Reading your sleep report",
      summary: "What to bring up at your next provider visit.",
      category: "lifestyle",
    },
    {
      slug: "/learn/insurance-guide",
      title: "Insurance + prescription renewals",
      summary: "Timing, documents, and what we file on your behalf.",
      category: "maintenance",
    },
    {
      slug: "/learn/pap-therapy-benefits",
      title: "Getting more from your therapy",
      summary: "Signs it may be time to revisit mask or machine fit.",
      category: "lifestyle",
    },
  ],
};

/** Determine the patient's onboarding stage from the number of days
 *  since they started therapy. */
export function stageForDays(daysOnTherapy: number): EducationStage {
  if (daysOnTherapy < 15) return "new";
  if (daysOnTherapy < 61) return "habituating";
  if (daysOnTherapy < 181) return "steady";
  return "experienced";
}

/** Articles for a stage (immutable copy so callers can't mutate). */
export function articlesForStage(stage: EducationStage): EducationArticle[] {
  return [...ARTICLES[stage]];
}
