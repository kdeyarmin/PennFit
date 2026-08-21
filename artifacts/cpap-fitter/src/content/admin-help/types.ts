// Shared content types for the staff Help Center (/admin/resources).
//
// The Help Center is content-as-data: every how-to, user-guide section,
// and FAQ entry is a plain object in this folder, and the pages under
// `pages/admin/admin-resources*.tsx` are thin renderers over it. Keeping
// the copy out of JSX buys three things:
//   * one search index across all three content types (the hub's search
//     box greps titles, summaries, body text, and keywords),
//   * a coverage test that can assert structural invariants (unique
//     slugs, resolvable cross-links, and — the important one — that
//     every /admin/... path the copy points at is a real console page),
//   * an editorial diff that reads like prose in review instead of
//     markup.
//
// Any string rendered through `<HelpText>` may contain bare /admin/...
// paths; the renderer turns them into one-click links, the same way the
// in-app assistant does. Write them verbatim (no backticks, no glued-on
// punctuation) so they link cleanly.

/** Top-level buckets shared by how-tos, guide sections, and FAQ entries. */
export type HelpCategoryId =
  | "getting-started"
  | "patients"
  | "orders"
  | "billing"
  | "outreach"
  | "analytics"
  | "system";

export interface HelpCategory {
  id: HelpCategoryId;
  label: string;
  /** One line describing what lives in this bucket. */
  blurb: string;
}

/** Ordered, and the order is the browse order on the hub. */
export const HELP_CATEGORIES: readonly HelpCategory[] = [
  {
    id: "getting-started",
    label: "Getting started",
    blurb:
      "Stand up your workspace, invite your team, and learn how the console is laid out.",
  },
  {
    id: "patients",
    label: "Patients & clinical",
    blurb:
      "Patient records, conversations, documents and e-sign, mask fitting, and therapy monitoring.",
  },
  {
    id: "orders",
    label: "Orders & shop",
    blurb:
      "Taking orders, fulfillment and shipping, subscriptions, returns, and inventory.",
  },
  {
    id: "billing",
    label: "Billing & claims",
    blurb:
      "Eligibility, prior auths, claim submission, ERAs, denials, and A/R follow-up.",
  },
  {
    id: "outreach",
    label: "Outreach & automation",
    blurb:
      "Campaigns, resupply reminders, templates, and the automation rule engine.",
  },
  {
    id: "analytics",
    label: "Analytics & reports",
    blurb: "Dashboards, the report catalog, goals, and team performance.",
  },
  {
    id: "system",
    label: "Settings & system",
    blurb:
      "Branding, sending identities, team and roles, feature modules, and integrations.",
  },
] as const;

/** A callout rendered beside a step or inside a guide section. */
export interface HelpCallout {
  tone: "tip" | "note" | "warning";
  text: string;
}

/** One numbered step in a how-to. */
export interface HelpStep {
  /** Imperative, specific: "Open Verify insurance and search the patient". */
  title: string;
  /** One short paragraph. May contain /admin/... paths. */
  body: string;
  /** Optional finer detail rendered as a sub-list under the step. */
  substeps?: readonly string[];
  callout?: HelpCallout;
}

/** A symptom → fix pair in a how-to's troubleshooting table. */
export interface HelpTroubleshooting {
  symptom: string;
  fix: string;
}

/** A task-oriented, step-by-step article. */
export interface HowToGuide {
  /** URL segment: /admin/resources/how-to/<slug>. */
  slug: string;
  title: string;
  category: HelpCategoryId;
  /** The one-sentence answer, shown before the steps and on the hub card. */
  summary: string;
  /** Who normally does this — helps a CSR skip an owner-only article. */
  audience: string;
  /** Rough time to complete, e.g. "About 5 minutes". */
  timeEstimate: string;
  /** The console page this article is mostly about. */
  primaryPath: string;
  /** What must already be true before step 1 works. */
  prerequisites: readonly string[];
  steps: readonly HelpStep[];
  troubleshooting?: readonly HelpTroubleshooting[];
  /** Slugs of other how-tos worth reading next. */
  related?: readonly string[];
  /** Extra search terms that don't appear in the prose. */
  keywords: readonly string[];
  /** Set on the handful of articles pinned to the top of the hub. */
  featured?: boolean;
}

/** One page described in a user-guide section's page table. */
export interface GuidePage {
  path: string;
  label: string;
  what: string;
}

/** A prose block inside a user-guide section. */
export type GuideBlock =
  | { kind: "para"; text: string }
  | { kind: "bullets"; items: readonly string[] }
  | { kind: "callout"; tone: HelpCallout["tone"]; text: string }
  | { kind: "pages"; title: string; rows: readonly GuidePage[] };

/** A chapter of the complete user guide. */
export interface GuideSection {
  /** Anchor id: /admin/resources/user-guide#<id>. */
  id: string;
  title: string;
  category: HelpCategoryId;
  /** One or two sentences shown under the heading and in the contents. */
  intro: string;
  blocks: readonly GuideBlock[];
}

/** One frequently asked question. */
export interface FaqEntry {
  /** Anchor id: /admin/resources/faq#<id>. */
  id: string;
  question: string;
  category: HelpCategoryId;
  /** One to three short paragraphs. May contain /admin/... paths. */
  answer: readonly string[];
  /** Slug of a how-to that covers this in full. */
  seeAlso?: string;
  keywords?: readonly string[];
}
