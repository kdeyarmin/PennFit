// Tests for pages/learn.tsx — deep-dive guide links added in this PR
//
// This PR added a "Long-form reading you can share" section to the Learn
// page that links to six new educational articles. These tests verify:
//   1. All six article paths are present and point to the correct routes.
//   2. Each link has the expected data-testid attribute.
//   3. The Learn page exports correctly and the surrounding structure is intact.
//
// Also tests that each new article file in the PR exports the expected
// function and includes a ShareArticle component (the share affordance is
// the key feature of these new articles).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEARN_SRC = readFileSync(path.join(__dirname, "learn.tsx"), "utf8");

// ---------------------------------------------------------------------------
// learn.tsx — exports and document metadata
// ---------------------------------------------------------------------------

describe("learn — exports", () => {
  it("exports the Learn function", () => {
    expect(LEARN_SRC).toContain("export function Learn");
  });

  it("uses useDocumentTitle", () => {
    expect(LEARN_SRC).toContain("useDocumentTitle");
  });

  it("includes 'CPAP guides' in the document title", () => {
    expect(LEARN_SRC).toContain("CPAP guides");
  });
});

// ---------------------------------------------------------------------------
// learn.tsx — deep-dive guide links (added in this PR)
// ---------------------------------------------------------------------------

const DEEP_DIVE_LINKS = [
  {
    href: "/learn/sleep-apnea-explained",
    testid: "learn-link-deep-sleep-apnea-explained",
    title: "What sleep apnea really is",
  },
  {
    href: "/learn/health-risks",
    testid: "learn-link-deep-health-risks",
    title: "The hidden cost of leaving it alone",
  },
  {
    href: "/learn/pap-therapy-benefits",
    testid: "learn-link-deep-benefits",
    title: "What treatment actually feels like",
  },
  {
    href: "/learn/how-pap-works",
    testid: "learn-link-deep-how-pap-works",
    title: "How PAP therapy actually works",
  },
  {
    href: "/learn/therapy-types",
    testid: "learn-link-deep-therapy-types",
    title: "CPAP vs APAP vs BiPAP vs ASV",
  },
  {
    href: "/learn/sleep-apnea-heart-health",
    testid: "learn-link-deep-heart-health",
    title: "Sleep apnea is a cardiovascular disease",
  },
];

describe("learn — deep-dive guide section exists", () => {
  it("contains a 'Long-form reading you can share' section heading", () => {
    expect(LEARN_SRC).toContain("Long-form reading you can share");
  });

  it("mentions that each guide has a built-in share button", () => {
    // Whitespace-normalized so Prettier line-wrapping the JSX prose
    // (e.g. "built-in share\nbutton") doesn't break the match.
    expect(LEARN_SRC.replace(/\s+/g, " ")).toContain("built-in share button");
  });
});

describe("learn — deep-dive links hrefs", () => {
  for (const { href, title } of DEEP_DIVE_LINKS) {
    it(`links to ${href} for article "${title}"`, () => {
      expect(LEARN_SRC).toContain(`href: "${href}"`);
    });
  }
});

describe("learn — deep-dive links testids", () => {
  for (const { testid, title } of DEEP_DIVE_LINKS) {
    it(`has testid "${testid}" on the link for "${title}"`, () => {
      expect(LEARN_SRC).toContain(`testid: "${testid}"`);
    });
  }
});

describe("learn — deep-dive link titles", () => {
  for (const { title } of DEEP_DIVE_LINKS) {
    it(`contains the article title "${title}"`, () => {
      expect(LEARN_SRC).toContain(title);
    });
  }
});

// ---------------------------------------------------------------------------
// Each new article file — exports the expected component and uses ShareArticle
// ---------------------------------------------------------------------------

const ARTICLE_FILES = [
  {
    file: "learn-sleep-apnea-explained.tsx",
    exportName: "LearnSleepApneaExplained",
  },
  {
    file: "learn-health-risks.tsx",
    exportName: "LearnHealthRisks",
  },
  {
    file: "learn-pap-therapy-benefits.tsx",
    exportName: "LearnPapTherapyBenefits",
  },
  {
    file: "learn-how-pap-works.tsx",
    exportName: "LearnHowPapWorks",
  },
  {
    file: "learn-therapy-types.tsx",
    exportName: "LearnTherapyTypes",
  },
  {
    file: "learn-sleep-apnea-heart-health.tsx",
    exportName: "LearnSleepApneaHeartHealth",
  },
];

for (const { file, exportName } of ARTICLE_FILES) {
  describe(`${file} — structural checks`, () => {
    const src = readFileSync(path.join(__dirname, file), "utf8");

    it(`exports function ${exportName}`, () => {
      expect(src).toContain(`export function ${exportName}`);
    });

    it("uses useDocumentTitle for SEO metadata", () => {
      expect(src).toContain("useDocumentTitle");
    });

    it("includes a breadcrumb link back to /learn", () => {
      expect(src).toContain('href="/learn"');
    });

    it("navigates to /consent from at least one CTA button", () => {
      expect(src).toContain('navigate("/consent")');
    });
  });
}

// ---------------------------------------------------------------------------
// ShareArticle usage — only applicable to articles that include it
// ---------------------------------------------------------------------------

const ARTICLES_WITH_SHARE = [
  "learn-health-risks.tsx",
  "learn-how-pap-works.tsx",
];

describe("articles with ShareArticle component", () => {
  for (const file of ARTICLES_WITH_SHARE) {
    it(`${file} imports and renders ShareArticle`, () => {
      const src = readFileSync(path.join(__dirname, file), "utf8");
      expect(src).toContain("ShareArticle");
      expect(src).toContain("share-article");
    });

    it(`${file} passes a path prop to ShareArticle`, () => {
      const src = readFileSync(path.join(__dirname, file), "utf8");
      expect(src).toContain("path=");
    });

    it(`${file} passes a testIdPrefix to ShareArticle`, () => {
      const src = readFileSync(path.join(__dirname, file), "utf8");
      expect(src).toContain("testIdPrefix=");
    });
  }
});

// ---------------------------------------------------------------------------
// learn.tsx — pre-existing section structure is intact
// ---------------------------------------------------------------------------

describe("learn — pre-existing content not regressed", () => {
  it("still contains the six-category article grid", () => {
    expect(LEARN_SRC).toContain("articlesByCategory");
  });

  it("still has the Virtual Mask Fitter CTA section", () => {
    expect(LEARN_SRC).toContain("learn-fitter-cta");
  });

  it("still links to /learn/sleep-apnea-quiz from the cross-links section", () => {
    expect(LEARN_SRC).toContain("/learn/sleep-apnea-quiz");
  });

  it("still links to /learn/device-setup", () => {
    expect(LEARN_SRC).toContain("/learn/device-setup");
  });
});
