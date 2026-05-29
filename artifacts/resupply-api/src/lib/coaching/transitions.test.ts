import { describe, it, expect } from "vitest";

import { canTransition, isTerminal } from "./transitions";

describe("canTransition", () => {
  it("allows the documented happy-path moves", () => {
    expect(canTransition({ from: "open", to: "outreach_made" }).ok).toBe(true);
    expect(canTransition({ from: "outreach_made", to: "improving" }).ok).toBe(
      true,
    );
    expect(canTransition({ from: "improving", to: "resolved" }).ok).toBe(true);
  });

  it("treats no-op (from === to) as allowed", () => {
    expect(canTransition({ from: "open", to: "open" }).ok).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition({ from: "open", to: "resolved" })).toEqual({
      ok: false,
      reason: "illegal_transition",
    });
  });

  it("escalation is reachable from every non-terminal", () => {
    for (const s of ["open", "outreach_made", "improving"] as const) {
      expect(canTransition({ from: s, to: "escalated" }).ok).toBe(true);
    }
  });

  it("terminal states reject any further move", () => {
    expect(canTransition({ from: "resolved", to: "improving" })).toEqual({
      ok: false,
      reason: "terminal",
    });
    expect(canTransition({ from: "abandoned", to: "open" })).toEqual({
      ok: false,
      reason: "terminal",
    });
  });
});

describe("isTerminal", () => {
  it("identifies resolved + abandoned", () => {
    expect(isTerminal("resolved")).toBe(true);
    expect(isTerminal("abandoned")).toBe(true);
  });
  it("identifies non-terminal states", () => {
    for (const s of [
      "open",
      "outreach_made",
      "improving",
      "escalated",
    ] as const) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});
