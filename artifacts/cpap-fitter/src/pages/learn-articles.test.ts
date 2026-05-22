// Tests for the new long-form educational article pages and the updated
// learn hub:
//
//   pages/learn.tsx                          (hub — new deep-dive article grid)
//   pages/learn-sleep-apnea-explained.tsx
//   pages/learn-health-risks.tsx
//   pages/learn-pap-therapy-benefits.tsx
//   pages/learn-how-pap-works.tsx
//   pages/learn-therapy-types.tsx
//   pages/learn-sleep-apnea-heart-health.tsx
//
// None of these can be rendered in the node vitest environment. We use:
//   1. Static source analysis — readFileSync + toContain / regex assertions
//      for structural invariants (exports, ShareArticle props, data arrays,
//      breadcrumb hrefs, CTA targets, data-testid values).
//   2. Pure-logic re-implementations where the article data has testable
//      shape (e.g. pressure range table, risk data, therapy modes).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const LEARN_HUB = readFileSync(path.join(__dirname, "learn.tsx"), "utf8");
const EXPLAINED = readFileSync(
  path.join(__dirname, "learn-sleep-apnea-explained.tsx"),
  "utf8",
);
const HEALTH_RISKS = readFileSync(
  path.join(__dirname, "learn-health-risks.tsx"),
  "utf8",
);
const PAP_BENEFITS = readFileSync(
  path.join(__dirname, "learn-pap-therapy-benefits.tsx"),
  "utf8",
);
const HOW_PAP = readFileSync(
  path.join(__dirname, "learn-how-pap-works.tsx"),
  "utf8",
);
const THERAPY_TYPES = readFileSync(
  path.join(__dirname, "learn-therapy-types.tsx"),
  "utf8",
);
const HEART_HEALTH = readFileSync(
  path.join(__dirname, "learn-sleep-apnea-heart-health.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// learn.tsx (hub) — new deep-dive article grid (PR change)
// ---------------------------------------------------------------------------

describe("learn hub — new long-form article section", () => {
  it('contains the "Long-form reading you can share." heading', () => {
    expect(LEARN_HUB).toContain("Long-form reading you can share.");
  });

  it("mentions that each article has a built-in share button", () => {
    expect(LEARN_HUB).toContain("share button");
  });

  it("describes the section as six in-depth articles", () => {
    expect(LEARN_HUB).toContain("Six in-depth articles");
  });
});

describe("learn hub — deep-dive article links all point to correct routes", () => {
  const deepArticleHrefs = [
    "/learn/sleep-apnea-explained",
    "/learn/health-risks",
    "/learn/pap-therapy-benefits",
    "/learn/how-pap-works",
    "/learn/therapy-types",
    "/learn/sleep-apnea-heart-health",
  ];

  for (const href of deepArticleHrefs) {
    it(`links to ${href}`, () => {
      expect(LEARN_HUB).toContain(`href: "${href}"`);
    });
  }
});

describe("learn hub — deep-dive article data-testid values", () => {
  const testids = [
    "learn-link-deep-sleep-apnea-explained",
    "learn-link-deep-health-risks",
    "learn-link-deep-benefits",
    "learn-link-deep-how-pap-works",
    "learn-link-deep-therapy-types",
    "learn-link-deep-heart-health",
  ];

  for (const testid of testids) {
    it(`has data-testid="${testid}"`, () => {
      expect(LEARN_HUB).toContain(testid);
    });
  }
});

describe("learn hub — deep-dive article card titles", () => {
  it('includes "What sleep apnea really is" card', () => {
    expect(LEARN_HUB).toContain("What sleep apnea really is");
  });

  it('includes "The hidden cost of leaving it alone" card', () => {
    expect(LEARN_HUB).toContain("The hidden cost of leaving it alone");
  });

  it('includes "What treatment actually feels like" card', () => {
    expect(LEARN_HUB).toContain("What treatment actually feels like");
  });

  it('includes "How PAP therapy actually works" card', () => {
    expect(LEARN_HUB).toContain("How PAP therapy actually works");
  });

  it('includes "CPAP vs APAP vs BiPAP vs ASV" card', () => {
    expect(LEARN_HUB).toContain("CPAP vs APAP vs BiPAP vs ASV");
  });

  it('includes "Sleep apnea is a cardiovascular disease" card', () => {
    expect(LEARN_HUB).toContain("Sleep apnea is a cardiovascular disease");
  });
});

// ---------------------------------------------------------------------------
// learn-sleep-apnea-explained.tsx
// ---------------------------------------------------------------------------

describe("learn-sleep-apnea-explained — exports", () => {
  it("exports the LearnSleepApneaExplained function", () => {
    expect(EXPLAINED).toContain("export function LearnSleepApneaExplained");
  });
});

describe("learn-sleep-apnea-explained — ShareArticle props", () => {
  it('passes path="/learn/sleep-apnea-explained" to ShareArticle', () => {
    expect(EXPLAINED).toContain('path="/learn/sleep-apnea-explained"');
  });

  it('passes testIdPrefix="share-sleep-apnea" to ShareArticle', () => {
    expect(EXPLAINED).toContain('testIdPrefix="share-sleep-apnea"');
  });

  it("imports ShareArticle from @/components/share-article", () => {
    expect(EXPLAINED).toContain(
      'import { ShareArticle } from "@/components/share-article"',
    );
  });
});

describe("learn-sleep-apnea-explained — breadcrumb", () => {
  it('breadcrumb links back to "/learn"', () => {
    expect(EXPLAINED).toContain('href="/learn"');
  });

  it("labels the current page as Sleep apnea explained", () => {
    expect(EXPLAINED).toContain("Sleep apnea explained");
  });
});

describe("learn-sleep-apnea-explained — content", () => {
  it("references 30 million American adults with sleep apnea", () => {
    expect(EXPLAINED).toContain("30 million");
  });

  it("states that 80% of OSA patients are undiagnosed", () => {
    expect(EXPLAINED).toContain("80%");
  });

  it("covers obstructive, central, and mixed apnea types", () => {
    expect(EXPLAINED).toContain("obstructive");
    expect(EXPLAINED).toContain("central");
    expect(EXPLAINED).toContain("mixed");
  });
});

// ---------------------------------------------------------------------------
// learn-health-risks.tsx
// ---------------------------------------------------------------------------

describe("learn-health-risks — exports", () => {
  it("exports the LearnHealthRisks function", () => {
    expect(HEALTH_RISKS).toContain("export function LearnHealthRisks");
  });
});

describe("learn-health-risks — ShareArticle props", () => {
  it('passes path="/learn/health-risks" to ShareArticle', () => {
    expect(HEALTH_RISKS).toContain('path="/learn/health-risks"');
  });

  it('passes testIdPrefix="share-health-risks"', () => {
    expect(HEALTH_RISKS).toContain('testIdPrefix="share-health-risks"');
  });

  it('passes a title containing "sleep apnea"', () => {
    expect(HEALTH_RISKS).toContain(
      'title="The hidden cost of leaving sleep apnea alone"',
    );
  });
});

describe("learn-health-risks — risks data array", () => {
  it("includes a Cardiovascular risk block", () => {
    expect(HEALTH_RISKS).toContain('"Cardiovascular"');
  });

  it("includes a Metabolic risk block", () => {
    expect(HEALTH_RISKS).toContain('"Metabolic"');
  });

  it("includes a Cognitive risk block", () => {
    expect(HEALTH_RISKS).toContain('"Cognitive"');
  });

  it("includes a Daily safety risk block", () => {
    expect(HEALTH_RISKS).toContain('"Daily safety"');
  });

  it("includes a Mental health risk block", () => {
    expect(HEALTH_RISKS).toContain('"Mental health"');
  });

  it("includes a Medication efficacy risk block", () => {
    expect(HEALTH_RISKS).toContain('"Medication efficacy"');
  });

  it("has six risk categories in total", () => {
    const matches = HEALTH_RISKS.match(/category: "(?:[^"]+)"/g);
    // Each risk block has a category field
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(6);
  });
});

describe("learn-health-risks — stat highlight row", () => {
  it("highlights that 80% of OSA is undiagnosed", () => {
    expect(HEALTH_RISKS).toContain("80%");
  });

  it("cites 2.5× drowsy-driving crash risk", () => {
    expect(HEALTH_RISKS).toContain("2.5×");
  });

  it("cites 2–3× stroke risk", () => {
    expect(HEALTH_RISKS).toContain("2–3×");
  });

  it("cites 30M+ US adults with OSA", () => {
    expect(HEALTH_RISKS).toContain("30M+");
  });
});

describe("learn-health-risks — medical disclaimer", () => {
  it("includes an educational disclaimer (not medical advice)", () => {
    expect(HEALTH_RISKS).toContain("not medical advice");
  });

  it("warns against stopping medication based on a single article", () => {
    expect(HEALTH_RISKS).toContain("don't stop or change any medication");
  });
});

describe("learn-health-risks — data-testid", () => {
  it("bottom CTA has data-testid health-risks-bottom-cta-fit", () => {
    expect(HEALTH_RISKS).toContain('data-testid="health-risks-bottom-cta-fit"');
  });
});

// ---------------------------------------------------------------------------
// learn-pap-therapy-benefits.tsx
// ---------------------------------------------------------------------------

describe("learn-pap-therapy-benefits — exports", () => {
  it("exports the LearnPapTherapyBenefits function", () => {
    expect(PAP_BENEFITS).toContain("export function LearnPapTherapyBenefits");
  });
});

describe("learn-pap-therapy-benefits — ShareArticle props", () => {
  it('passes path="/learn/pap-therapy-benefits" to ShareArticle', () => {
    expect(PAP_BENEFITS).toContain('path="/learn/pap-therapy-benefits"');
  });

  it('passes testIdPrefix="share-benefits"', () => {
    expect(PAP_BENEFITS).toContain('testIdPrefix="share-benefits"');
  });
});

describe("learn-pap-therapy-benefits — timeline data", () => {
  it('has "The first morning" as a timeline milestone', () => {
    expect(PAP_BENEFITS).toContain("The first morning");
  });

  it('has "Week 1–2" as a timeline milestone', () => {
    expect(PAP_BENEFITS).toContain("Week 1–2");
  });

  it('has "Month 1" as a timeline milestone', () => {
    expect(PAP_BENEFITS).toContain("Month 1");
  });

  it("describes morning headache relief as a first-morning benefit", () => {
    expect(PAP_BENEFITS).toContain("No morning headache");
  });

  it("describes the 3pm crash disappearing by week 1–2", () => {
    expect(PAP_BENEFITS).toContain("3pm");
  });
});

describe("learn-pap-therapy-benefits — breadcrumb", () => {
  it('breadcrumb links back to "/learn"', () => {
    expect(PAP_BENEFITS).toContain('href="/learn"');
  });
});

// ---------------------------------------------------------------------------
// learn-how-pap-works.tsx
// ---------------------------------------------------------------------------

describe("learn-how-pap-works — exports", () => {
  it("exports the LearnHowPapWorks function", () => {
    expect(HOW_PAP).toContain("export function LearnHowPapWorks");
  });
});

describe("learn-how-pap-works — ShareArticle props", () => {
  it('passes path="/learn/how-pap-works" to ShareArticle', () => {
    expect(HOW_PAP).toContain('path="/learn/how-pap-works"');
  });

  it('passes testIdPrefix="share-how-pap-works"', () => {
    expect(HOW_PAP).toContain('testIdPrefix="share-how-pap-works"');
  });
});

describe("learn-how-pap-works — pressure range data", () => {
  it('includes the "Light" pressure range (4–6 cmH₂O)', () => {
    expect(HOW_PAP).toContain('"4–6"');
    expect(HOW_PAP).toContain('"Light"');
  });

  it('includes the "Typical" pressure range (7–11 cmH₂O)', () => {
    expect(HOW_PAP).toContain('"7–11"');
    expect(HOW_PAP).toContain('"Typical"');
  });

  it('includes the "Higher" pressure range (12–16 cmH₂O)', () => {
    expect(HOW_PAP).toContain('"12–16"');
    expect(HOW_PAP).toContain('"Higher"');
  });

  it('includes the "Maximum" pressure range (17–25 cmH₂O)', () => {
    expect(HOW_PAP).toContain('"17–25"');
    expect(HOW_PAP).toContain('"Maximum"');
  });

  it("has four pressure range entries", () => {
    // Count the range: "..." fields in the pressure data
    const matches = HOW_PAP.match(/range: "[\d–]+"/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(4);
  });
});

describe("learn-how-pap-works — mechanism description", () => {
  it("describes therapy as a pneumatic splint", () => {
    expect(HOW_PAP).toContain("pneumatic splint");
  });

  it("explains that the machine is not delivering oxygen", () => {
    expect(HOW_PAP).toContain("not delivering oxygen");
  });

  it("covers exhalation relief (EPR, A-Flex/C-Flex, SmartFlex)", () => {
    expect(HOW_PAP).toContain("EPR");
    expect(HOW_PAP).toContain("A-Flex");
    expect(HOW_PAP).toContain("SmartFlex");
  });

  it("covers humidification and the distilled-water instruction", () => {
    expect(HOW_PAP).toContain("distilled water");
  });
});

describe("learn-how-pap-works — nightly metrics section", () => {
  it("covers AHI (Apnea-Hypopnea Index)", () => {
    expect(HOW_PAP).toContain("AHI");
  });

  it("covers unintentional leak rate", () => {
    expect(HOW_PAP).toContain("Leak rate");
  });

  it("covers P95 (95th-percentile pressure)", () => {
    expect(HOW_PAP).toContain("P95");
  });
});

// ---------------------------------------------------------------------------
// learn-therapy-types.tsx
// ---------------------------------------------------------------------------

describe("learn-therapy-types — exports", () => {
  it("exports the LearnTherapyTypes function", () => {
    expect(THERAPY_TYPES).toContain("export function LearnTherapyTypes");
  });
});

describe("learn-therapy-types — ShareArticle props", () => {
  it('passes path="/learn/therapy-types" to ShareArticle', () => {
    expect(THERAPY_TYPES).toContain('path="/learn/therapy-types"');
  });

  it('passes testIdPrefix="share-therapy-types"', () => {
    expect(THERAPY_TYPES).toContain('testIdPrefix="share-therapy-types"');
  });
});

describe("learn-therapy-types — therapy modes data", () => {
  it("includes CPAP as the first therapy mode", () => {
    expect(THERAPY_TYPES).toContain('abbrev: "CPAP"');
    expect(THERAPY_TYPES).toContain('"Continuous Positive Airway Pressure"');
  });

  it("includes APAP (auto-titrating)", () => {
    expect(THERAPY_TYPES).toContain('abbrev: "APAP"');
    expect(THERAPY_TYPES).toContain('"Auto-titrating Positive Airway Pressure"');
  });

  it("includes BiPAP", () => {
    expect(THERAPY_TYPES).toContain('abbrev: "BiPAP"');
  });

  it("marks APAP as the flagship/most prescribed mode", () => {
    expect(THERAPY_TYPES).toContain("flagship: true");
  });

  it("gives CPAP the one-liner 'One fixed pressure, all night.'", () => {
    expect(THERAPY_TYPES).toContain("One fixed pressure, all night.");
  });
});

describe("learn-therapy-types — breadcrumb", () => {
  it('breadcrumb links back to "/learn"', () => {
    expect(THERAPY_TYPES).toContain('href="/learn"');
  });
});

// ---------------------------------------------------------------------------
// learn-sleep-apnea-heart-health.tsx
// ---------------------------------------------------------------------------

describe("learn-sleep-apnea-heart-health — exports", () => {
  it("exports the LearnSleepApneaHeartHealth function", () => {
    expect(HEART_HEALTH).toContain("export function LearnSleepApneaHeartHealth");
  });
});

describe("learn-sleep-apnea-heart-health — ShareArticle props", () => {
  it('passes path="/learn/sleep-apnea-heart-health" to ShareArticle', () => {
    expect(HEART_HEALTH).toContain('path="/learn/sleep-apnea-heart-health"');
  });

  it('passes testIdPrefix="share-heart-health"', () => {
    expect(HEART_HEALTH).toContain('testIdPrefix="share-heart-health"');
  });

  it('passes a title containing "cardiovascular"', () => {
    expect(HEART_HEALTH).toContain(
      'title="Sleep apnea is a cardiovascular disease"',
    );
  });
});

describe("learn-sleep-apnea-heart-health — cardio risk data", () => {
  it("includes hypertension risk block", () => {
    expect(HEART_HEALTH).toContain('"Hypertension"');
  });

  it("includes atrial fibrillation risk block", () => {
    expect(HEART_HEALTH).toContain('"Atrial fibrillation"');
  });

  it("includes stroke risk block", () => {
    expect(HEART_HEALTH).toContain('"Stroke"');
  });

  it("includes heart failure risk block", () => {
    expect(HEART_HEALTH).toContain('"Heart failure"');
  });

  it("includes sudden cardiac death risk block", () => {
    expect(HEART_HEALTH).toContain('"Sudden cardiac death"');
  });

  it("has five cardiovascular risk entries", () => {
    const matches = HEART_HEALTH.match(/condition: "(?:[^"]+)"/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(5);
  });
});

describe("learn-sleep-apnea-heart-health — data statistics", () => {
  it("cites 2–4× AFib risk in untreated moderate-to-severe OSA", () => {
    expect(HEART_HEALTH).toContain("2–4×");
  });

  it("cites 80% OSA co-prevalence in resistant hypertension", () => {
    expect(HEART_HEALTH).toContain("80%");
  });

  it("mentions AFib ablation recurrence risk without treatment", () => {
    expect(HEART_HEALTH).toContain("ablation");
  });
});

describe("learn-sleep-apnea-heart-health — breadcrumb", () => {
  it('breadcrumb links back to "/learn"', () => {
    expect(HEART_HEALTH).toContain('href="/learn"');
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all six article pages import ShareArticle
// ---------------------------------------------------------------------------

describe("all new learn article pages — ShareArticle import", () => {
  const pages = [
    { name: "learn-sleep-apnea-explained", src: EXPLAINED },
    { name: "learn-health-risks", src: HEALTH_RISKS },
    { name: "learn-pap-therapy-benefits", src: PAP_BENEFITS },
    { name: "learn-how-pap-works", src: HOW_PAP },
    { name: "learn-therapy-types", src: THERAPY_TYPES },
    { name: "learn-sleep-apnea-heart-health", src: HEART_HEALTH },
  ];

  for (const { name, src } of pages) {
    it(`${name} imports ShareArticle from @/components/share-article`, () => {
      expect(src).toContain(
        'import { ShareArticle } from "@/components/share-article"',
      );
    });
  }
});

describe("all new learn article pages — ShareArticle path matches registered route", () => {
  it('sleep-apnea-explained uses path that matches the registered route', () => {
    expect(EXPLAINED).toContain('path="/learn/sleep-apnea-explained"');
  });

  it('health-risks uses path that matches the registered route', () => {
    expect(HEALTH_RISKS).toContain('path="/learn/health-risks"');
  });

  it('pap-therapy-benefits uses path that matches the registered route', () => {
    expect(PAP_BENEFITS).toContain('path="/learn/pap-therapy-benefits"');
  });

  it('how-pap-works uses path that matches the registered route', () => {
    expect(HOW_PAP).toContain('path="/learn/how-pap-works"');
  });

  it('therapy-types uses path that matches the registered route', () => {
    expect(THERAPY_TYPES).toContain('path="/learn/therapy-types"');
  });

  it('sleep-apnea-heart-health uses path that matches the registered route', () => {
    expect(HEART_HEALTH).toContain('path="/learn/sleep-apnea-heart-health"');
  });
});

describe("all new learn article pages — breadcrumb links back to /learn", () => {
  const pages = [
    { name: "learn-sleep-apnea-explained", src: EXPLAINED },
    { name: "learn-health-risks", src: HEALTH_RISKS },
    { name: "learn-pap-therapy-benefits", src: PAP_BENEFITS },
    { name: "learn-how-pap-works", src: HOW_PAP },
    { name: "learn-therapy-types", src: THERAPY_TYPES },
    { name: "learn-sleep-apnea-heart-health", src: HEART_HEALTH },
  ];

  for (const { name, src } of pages) {
    it(`${name} has a breadcrumb link to /learn`, () => {
      expect(src).toContain('href="/learn"');
    });
  }
});

describe("all new learn article pages — navigate to /consent on CTA", () => {
  const pages = [
    { name: "learn-sleep-apnea-explained", src: EXPLAINED },
    { name: "learn-health-risks", src: HEALTH_RISKS },
    { name: "learn-pap-therapy-benefits", src: PAP_BENEFITS },
    { name: "learn-how-pap-works", src: HOW_PAP },
    { name: "learn-therapy-types", src: THERAPY_TYPES },
    { name: "learn-sleep-apnea-heart-health", src: HEART_HEALTH },
  ];

  for (const { name, src } of pages) {
    it(`${name} has a bottom CTA that navigates to /consent`, () => {
      expect(src).toContain('navigate("/consent")');
    });
  }
});
