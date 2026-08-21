// Registry + search for the staff Help Center (/admin/resources).
//
// One flattened index across all three content types so the hub's
// search box returns how-tos, user-guide sections, and FAQ answers in a
// single ranked list — an operator searching "denial" should not have to
// guess which of the three tabs the answer lives in.

import { FAQ_ENTRIES } from "./faq";
import { HOW_TO_GUIDES } from "./how-tos";
import {
  HELP_CATEGORIES,
  type FaqEntry,
  type GuideSection,
  type HelpCategoryId,
  type HowToGuide,
} from "./types";
import { GUIDE_SECTIONS } from "./user-guide";

export { FAQ_ENTRIES, GUIDE_SECTIONS, HELP_CATEGORIES, HOW_TO_GUIDES };
export * from "./types";

/** Where an individual how-to lives. */
export function howToHref(slug: string): string {
  return `/admin/resources/how-to/${slug}`;
}

/** Deep link to one chapter of the user guide. */
export function guideHref(sectionId: string): string {
  return `/admin/resources/user-guide#${sectionId}`;
}

/** Deep link to one FAQ answer. */
export function faqHref(entryId: string): string {
  return `/admin/resources/faq#${entryId}`;
}

export function getHowTo(slug: string): HowToGuide | undefined {
  return HOW_TO_GUIDES.find((g) => g.slug === slug);
}

/** The handful pinned to the top of the hub. */
export function featuredHowTos(): readonly HowToGuide[] {
  return HOW_TO_GUIDES.filter((g) => g.featured);
}

export function howTosInCategory(
  category: HelpCategoryId,
): readonly HowToGuide[] {
  return HOW_TO_GUIDES.filter((g) => g.category === category);
}

export function guideSectionsInCategory(
  category: HelpCategoryId,
): readonly GuideSection[] {
  return GUIDE_SECTIONS.filter((s) => s.category === category);
}

export function faqInCategory(category: HelpCategoryId): readonly FaqEntry[] {
  return FAQ_ENTRIES.filter((f) => f.category === category);
}

export function categoryLabel(id: HelpCategoryId): string {
  return HELP_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

// ---------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------

export type SearchKind = "how-to" | "guide" | "faq";

export interface SearchResult {
  kind: SearchKind;
  /** Stable key: the slug, section id, or FAQ id. */
  id: string;
  title: string;
  /** One line of context under the title in the results list. */
  excerpt: string;
  href: string;
  category: HelpCategoryId;
}

interface IndexedDoc extends SearchResult {
  /** Lowercased haystack: title, excerpt, body text, and keywords. */
  haystack: string;
}

function guideSectionText(section: GuideSection): string {
  const parts: string[] = [section.intro];
  for (const block of section.blocks) {
    if (block.kind === "para" || block.kind === "callout") {
      parts.push(block.text);
    } else if (block.kind === "bullets") {
      parts.push(block.items.join(" "));
    } else {
      parts.push(block.title);
      for (const row of block.rows) {
        parts.push(`${row.label} ${row.path} ${row.what}`);
      }
    }
  }
  return parts.join(" ");
}

function howToText(guide: HowToGuide): string {
  const parts: string[] = [
    guide.summary,
    guide.audience,
    guide.primaryPath,
    guide.prerequisites.join(" "),
    guide.keywords.join(" "),
  ];
  for (const step of guide.steps) {
    parts.push(step.title, step.body);
    if (step.substeps) parts.push(step.substeps.join(" "));
    if (step.callout) parts.push(step.callout.text);
  }
  for (const t of guide.troubleshooting ?? []) {
    parts.push(t.symptom, t.fix);
  }
  return parts.join(" ");
}

const INDEX: readonly IndexedDoc[] = [
  ...HOW_TO_GUIDES.map((g): IndexedDoc => {
    const doc = {
      kind: "how-to" as const,
      id: g.slug,
      title: g.title,
      excerpt: g.summary,
      href: howToHref(g.slug),
      category: g.category,
    };
    return { ...doc, haystack: `${g.title} ${howToText(g)}`.toLowerCase() };
  }),
  ...GUIDE_SECTIONS.map((s): IndexedDoc => {
    const doc = {
      kind: "guide" as const,
      id: s.id,
      title: s.title,
      excerpt: s.intro,
      href: guideHref(s.id),
      category: s.category,
    };
    return {
      ...doc,
      haystack: `${s.title} ${guideSectionText(s)}`.toLowerCase(),
    };
  }),
  ...FAQ_ENTRIES.map((f): IndexedDoc => {
    const doc = {
      kind: "faq" as const,
      id: f.id,
      title: f.question,
      excerpt: f.answer[0] ?? "",
      href: faqHref(f.id),
      category: f.category,
    };
    return {
      ...doc,
      haystack:
        `${f.question} ${f.answer.join(" ")} ${(f.keywords ?? []).join(" ")}`.toLowerCase(),
    };
  }),
];

/** Every indexed document — exported for the coverage test. */
export function searchIndexSize(): number {
  return INDEX.length;
}

/**
 * Rank documents against a free-text query. Every whitespace-separated
 * term must appear somewhere in the document (AND, not OR) so a two-word
 * query narrows rather than widens; a term matching the title outranks
 * one that only matches the body, and a how-to outranks a guide section
 * on an equal match because it is the more actionable answer.
 */
export function searchHelp(query: string, limit = 12): readonly SearchResult[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  const scored: Array<{ doc: IndexedDoc; score: number }> = [];
  for (const doc of INDEX) {
    const title = doc.title.toLowerCase();
    let score = 0;
    let matchedAll = true;
    for (const term of terms) {
      if (title.includes(term)) {
        score += title.startsWith(term) ? 12 : 8;
      } else if (doc.haystack.includes(term)) {
        score += 2;
      } else {
        matchedAll = false;
        break;
      }
    }
    if (!matchedAll) continue;
    if (doc.kind === "how-to") score += 1;
    scored.push({ doc, score });
  }

  scored.sort((a, b) =>
    b.score === a.score
      ? a.doc.title.localeCompare(b.doc.title)
      : b.score - a.score,
  );
  return scored.slice(0, limit).map(({ doc }) => {
    // Drop the private haystack from the public result shape.
    const { haystack: _haystack, ...result } = doc;
    return result;
  });
}

/**
 * Every /admin/... path referenced anywhere in the Help Center content.
 * `admin-help.coverage.test.ts` cross-checks these against the console's
 * NAV_GROUPS so the help center can never point at a page that does not
 * exist.
 */
export function referencedConsolePaths(): readonly string[] {
  const found = new Set<string>();
  const re = /\/admin(?:\/[a-z0-9-]+)*/g;
  const collect = (text: string): void => {
    for (const match of text.matchAll(re)) found.add(match[0]);
  };

  for (const g of HOW_TO_GUIDES) {
    collect(g.primaryPath);
    collect(howToText(g));
  }
  for (const s of GUIDE_SECTIONS) collect(guideSectionText(s));
  for (const f of FAQ_ENTRIES) collect(f.answer.join(" "));

  return [...found].sort();
}
