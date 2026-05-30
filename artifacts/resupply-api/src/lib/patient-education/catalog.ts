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
// `slug` is the path under /learn the SPA renders; an article can
// be authored later without changing this catalog. Order within
// a stage is the order shown — pick wisely.

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
      slug: "/learn/first-week-comfort",
      title: "Your first week on CPAP",
      summary: "What to expect — and which discomforts settle on their own.",
      category: "comfort",
    },
    {
      slug: "/learn/ramp-and-pressure",
      title: "Ramp + pressure settings explained",
      summary: "Why your machine starts soft. When to ask us to adjust.",
      category: "comfort",
    },
    {
      slug: "/learn/mask-fit-basics",
      title: "Mask fit basics",
      summary: "Headgear tension, cushion position, the 30-second seal check.",
      category: "troubleshooting",
    },
  ],
  habituating: [
    {
      slug: "/learn/persistent-leaks",
      title: "If your mask still leaks",
      summary: "Common causes in weeks 3–8 — most fix with a small adjustment.",
      category: "troubleshooting",
    },
    {
      slug: "/learn/side-sleeping",
      title: "Sleeping on your side with CPAP",
      summary: "Pillow tricks + the masks that play nicest with side-sleepers.",
      category: "lifestyle",
    },
    {
      slug: "/learn/mouth-breathing",
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
      slug: "/learn/humidifier-tuning",
      title: "Tuning your humidifier for the season",
      summary: "Winter dry, summer warm — three settings worth knowing.",
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
      slug: "/learn/annual-review",
      title: "The annual sleep-medicine review",
      summary: "What to bring up at your next provider visit.",
      category: "lifestyle",
    },
    {
      slug: "/learn/rx-renewal-checklist",
      title: "Renewing your prescription",
      summary: "Timing, documents, and what we file on your behalf.",
      category: "maintenance",
    },
    {
      slug: "/learn/when-to-upgrade",
      title: "Knowing when to upgrade your machine",
      summary: "Five signs your unit's coasting toward retirement.",
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
