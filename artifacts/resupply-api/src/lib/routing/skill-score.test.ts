import { describe, it, expect } from "vitest";

import { scoreCandidates } from "./skill-score";

describe("scoreCandidates", () => {
  it("ranks covers-all candidates first regardless of queue", () => {
    const r = scoreCandidates({
      requiredSkills: ["spanish", "clinical"],
      candidates: [
        {
          adminUserId: "a_busy_specialist",
          skills: ["spanish", "clinical"],
          openQueueSize: 99,
        },
        {
          adminUserId: "a_empty_partial",
          skills: ["spanish"],
          openQueueSize: 0,
        },
      ],
    });
    expect(r[0]!.adminUserId).toBe("a_busy_specialist");
    expect(r[0]!.coversAll).toBe(true);
    expect(r[1]!.coversAll).toBe(false);
  });

  it("breaks score ties by load (smaller queue wins)", () => {
    const r = scoreCandidates({
      requiredSkills: ["spanish"],
      candidates: [
        { adminUserId: "a_loaded", skills: ["spanish"], openQueueSize: 5 },
        { adminUserId: "a_open", skills: ["spanish"], openQueueSize: 2 },
      ],
    });
    expect(r[0]!.adminUserId).toBe("a_open");
  });

  it("treats empty requiredSkills as every candidate covers all", () => {
    const r = scoreCandidates({
      requiredSkills: [],
      candidates: [
        { adminUserId: "z", skills: [], openQueueSize: 3 },
        { adminUserId: "a", skills: ["clinical"], openQueueSize: 1 },
      ],
    });
    expect(r.every((c) => c.coversAll)).toBe(true);
    // Load breaks the tie.
    expect(r[0]!.adminUserId).toBe("a");
  });

  it("case-insensitive + trims whitespace", () => {
    const r = scoreCandidates({
      requiredSkills: ["  Spanish "],
      candidates: [
        { adminUserId: "a", skills: ["spanish"], openQueueSize: 0 },
      ],
    });
    expect(r[0]!.matchedSkillCount).toBe(1);
    expect(r[0]!.coversAll).toBe(true);
  });

  it("partial-overlap candidates still listed, score < coversAll", () => {
    const r = scoreCandidates({
      requiredSkills: ["spanish", "clinical", "billing_basics"],
      candidates: [
        { adminUserId: "a_two", skills: ["spanish", "clinical"], openQueueSize: 1 },
        { adminUserId: "a_one", skills: ["spanish"], openQueueSize: 0 },
      ],
    });
    expect(r[0]!.adminUserId).toBe("a_two");
    expect(r[0]!.matchedSkillCount).toBe(2);
    expect(r[0]!.coversAll).toBe(false);
    expect(r[1]!.matchedSkillCount).toBe(1);
  });
});
