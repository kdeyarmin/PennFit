// Unit tests for splitAdminPaths — the helper that turns the bot's
// `/admin/...` path mentions into clickable-link segments.

import { describe, it, expect } from "vitest";

import { splitAdminPaths } from "./AdminAssistantWidget";

describe("splitAdminPaths", () => {
  it("returns a single text segment when there is no path", () => {
    expect(splitAdminPaths("Use the billing hub to start.")).toEqual([
      { type: "text", value: "Use the billing hub to start." },
    ]);
  });

  it("splits a path embedded in prose into a link segment", () => {
    const segs = splitAdminPaths("Open /admin/billing/eligibility to check.");
    expect(segs).toEqual([
      { type: "text", value: "Open " },
      { type: "link", value: "/admin/billing/eligibility" },
      { type: "text", value: " to check." },
    ]);
  });

  it("does not swallow trailing punctuation into the link", () => {
    const segs = splitAdminPaths("See (/admin/patients).");
    expect(segs).toEqual([
      { type: "text", value: "See (" },
      { type: "link", value: "/admin/patients" },
      { type: "text", value: ")." },
    ]);
  });

  it("links multiple paths in one reply", () => {
    const segs = splitAdminPaths(
      "Start at /admin/billing then /admin/billing/era.",
    );
    expect(segs.filter((s) => s.type === "link").map((s) => s.value)).toEqual([
      "/admin/billing",
      "/admin/billing/era",
    ]);
  });

  it("treats a :param placeholder path as plain text, not a link", () => {
    const segs = splitAdminPaths(
      "A patient lives at /admin/patients/:id here.",
    );
    expect(segs.some((s) => s.type === "link")).toBe(false);
  });

  it("links a bare /admin", () => {
    const segs = splitAdminPaths("Home is /admin");
    expect(segs).toEqual([
      { type: "text", value: "Home is " },
      { type: "link", value: "/admin" },
    ]);
  });
});
