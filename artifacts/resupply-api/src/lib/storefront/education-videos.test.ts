// Tests for the education-video pure helpers (RT #25).

import { describe, it, expect } from "vitest";

import {
  activeVideosInOrder,
  groupActiveVideosByTopic,
  isEducationTopic,
  type EducationVideo,
} from "./education-videos";

function v(over: Partial<EducationVideo>): EducationVideo {
  return {
    id: "v",
    title: "T",
    topic: "other",
    description: null,
    videoUrl: "https://x/v.mp4",
    thumbnailUrl: null,
    durationSeconds: null,
    sortOrder: 0,
    active: true,
    ...over,
  };
}

describe("activeVideosInOrder", () => {
  it("drops inactive and sorts by sortOrder then title", () => {
    const out = activeVideosInOrder([
      v({ id: "c", title: "Charlie", sortOrder: 1 }),
      v({ id: "x", title: "Hidden", active: false, sortOrder: 0 }),
      v({ id: "a", title: "Alpha", sortOrder: 0 }),
      v({ id: "b", title: "Bravo", sortOrder: 0 }),
    ]);
    expect(out.map((o) => o.id)).toEqual(["a", "b", "c"]);
  });
});

describe("groupActiveVideosByTopic", () => {
  it("groups in canonical topic order, dropping empty topics", () => {
    const groups = groupActiveVideosByTopic([
      v({ id: "clean1", topic: "cleaning" }),
      v({ id: "fit1", topic: "mask_fitting" }),
      v({ id: "fit2", topic: "mask_fitting", sortOrder: 1 }),
    ]);
    expect(groups.map((g) => g.topic)).toEqual(["mask_fitting", "cleaning"]);
    expect(groups[0]!.videos.map((x) => x.id)).toEqual(["fit1", "fit2"]);
    expect(groups[0]!.label).toBe("Mask fitting");
  });

  it("surfaces unknown topics under 'More'", () => {
    const groups = groupActiveVideosByTopic([
      v({ id: "weird", topic: "made_up" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.topic).toBe("other");
    expect(groups[0]!.videos[0]!.id).toBe("weird");
  });

  it("returns [] for an empty / all-inactive catalog (fail-soft)", () => {
    expect(groupActiveVideosByTopic([])).toEqual([]);
    expect(groupActiveVideosByTopic([v({ active: false })])).toEqual([]);
  });
});

describe("isEducationTopic", () => {
  it("validates the catalog topics", () => {
    expect(isEducationTopic("mask_fitting")).toBe(true);
    expect(isEducationTopic("nope")).toBe(false);
    expect(isEducationTopic(3)).toBe(false);
  });
});
