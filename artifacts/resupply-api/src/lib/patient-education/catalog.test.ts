import { describe, it, expect } from "vitest";

import { articlesForStage, stageForDays } from "./catalog";

describe("stageForDays", () => {
  it("boundary days bucket correctly", () => {
    expect(stageForDays(0)).toBe("new");
    expect(stageForDays(14)).toBe("new");
    expect(stageForDays(15)).toBe("habituating");
    expect(stageForDays(60)).toBe("habituating");
    expect(stageForDays(61)).toBe("steady");
    expect(stageForDays(180)).toBe("steady");
    expect(stageForDays(181)).toBe("experienced");
    expect(stageForDays(10_000)).toBe("experienced");
  });
});

describe("articlesForStage", () => {
  it("returns a non-empty list for every stage", () => {
    for (const stage of [
      "new",
      "habituating",
      "steady",
      "experienced",
    ] as const) {
      expect(articlesForStage(stage).length).toBeGreaterThan(0);
    }
  });

  it("returns a fresh array per call (caller mutation safety)", () => {
    const a = articlesForStage("new");
    a.push({
      slug: "/x",
      title: "x",
      summary: "x",
      category: "comfort",
    });
    const b = articlesForStage("new");
    expect(b.length).toBeLessThan(a.length);
  });

  it("every slug starts with /learn/", () => {
    for (const stage of [
      "new",
      "habituating",
      "steady",
      "experienced",
    ] as const) {
      for (const a of articlesForStage(stage)) {
        expect(a.slug.startsWith("/learn/")).toBe(true);
      }
    }
  });

  it("only links to learn pages that ship in the SPA", () => {
    // Keep in sync with App.tsx /learn/* routes — phantom slugs 404 from
    // the account education feed.
    const live = new Set([
      "/learn/first-two-weeks",
      "/learn/how-pap-works",
      "/learn/mask-leaks",
      "/learn/sleep-hygiene",
      "/learn/dry-mouth",
      "/learn/replacement-schedule",
      "/learn/cleaning-routine",
      "/learn/traveling-with-cpap",
      "/learn/reading-your-sleep-report",
      "/learn/insurance-guide",
      "/learn/pap-therapy-benefits",
    ]);
    for (const stage of [
      "new",
      "habituating",
      "steady",
      "experienced",
    ] as const) {
      for (const a of articlesForStage(stage)) {
        expect(live.has(a.slug)).toBe(true);
      }
    }
  });
});
