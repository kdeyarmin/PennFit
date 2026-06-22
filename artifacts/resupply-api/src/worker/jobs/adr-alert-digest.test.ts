import { describe, expect, it } from "vitest";

import { formatAdrDigest, parseRecipientList } from "./adr-alert-digest";

describe("parseRecipientList", () => {
  it("splits on commas/space/newlines and trims", () => {
    expect(parseRecipientList("a@x.com, b@x.com\nc@x.com")).toEqual([
      "a@x.com",
      "b@x.com",
      "c@x.com",
    ]);
  });
  it("is empty for undefined / blank", () => {
    expect(parseRecipientList(undefined)).toEqual([]);
    expect(parseRecipientList("   ")).toEqual([]);
  });
});

describe("formatAdrDigest", () => {
  it("summarises overdue + at-risk counts and lists them", () => {
    const body = formatAdrDigest(
      [{ label: "TPE / Aetna — due 2026-06-01", daysOut: -5 }],
      [{ label: "RAC — due 2026-06-25", daysOut: 3 }],
    );
    expect(body).toContain("Overdue: 1");
    expect(body).toContain("At risk: 1");
    expect(body).toContain("OVERDUE");
    expect(body).toContain("TPE / Aetna — due 2026-06-01 (-5d)");
    expect(body).toContain("RAC — due 2026-06-25 (3d)");
  });

  it("omits empty sections", () => {
    const body = formatAdrDigest([], [{ label: "UPIC", daysOut: 7 }]);
    expect(body).not.toContain("OVERDUE");
    expect(body).toContain("AT RISK");
  });
});
