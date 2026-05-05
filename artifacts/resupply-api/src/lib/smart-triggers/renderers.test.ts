// Unit tests for the smart-trigger copy renderers.
//
// Pure-function tests; pin the conversion-critical UX details so
// an A/B copy edit can't accidentally break the channel-specific
// length budgets.

import { describe, it, expect } from "vitest";

import {
  htmlBody,
  pushBody,
  smsBody,
  subjectForKind,
  textBody,
} from "./renderers";
import { type TriggerKind } from "./index";

const KINDS: TriggerKind[] = [
  "leak_rising",
  "usage_dropping",
  "cushion_wear",
  "humidifier_drop",
];

describe("subjectForKind", () => {
  it("returns a non-empty string for every TriggerKind", () => {
    for (const kind of KINDS) {
      const subject = subjectForKind(kind);
      expect(subject.length).toBeGreaterThan(0);
      // Subject lines should fit in a typical inbox preview (~60).
      expect(subject.length).toBeLessThanOrEqual(80);
    }
  });
});

describe("smsBody", () => {
  it("fits a single ASCII Twilio segment for every kind", () => {
    for (const kind of KINDS) {
      const body = smsBody("Anna", kind);
      expect(body.length).toBeLessThanOrEqual(160);
    }
  });

  it("includes STOP keyword for opt-out compliance", () => {
    for (const kind of KINDS) {
      expect(smsBody("Anna", kind)).toContain("STOP");
    }
  });

  it("greets without name when firstName is empty", () => {
    expect(smsBody("", "leak_rising")).toMatch(/^Hi, /);
  });

  it("greets with first name when supplied", () => {
    expect(smsBody("Anna", "leak_rising")).toMatch(/^Hi Anna, /);
  });
});

describe("pushBody", () => {
  it("clears the iOS lock-screen budget (~110 chars) for every kind", () => {
    for (const kind of KINDS) {
      // Lock screen truncates aggressively. We give ourselves
      // headroom below 110.
      expect(pushBody(kind).length).toBeLessThanOrEqual(110);
    }
  });

  it("returns a non-empty string for every kind", () => {
    for (const kind of KINDS) {
      expect(pushBody(kind).length).toBeGreaterThan(0);
    }
  });
});

describe("textBody", () => {
  it("includes the greeting in every kind", () => {
    for (const kind of KINDS) {
      expect(textBody("Hi Anna", kind)).toContain("Hi Anna");
    }
  });
});

describe("htmlBody", () => {
  it("escapes <, >, & in the greeting (XSS hardening)", () => {
    const html = htmlBody("Hi <script>alert(1)</script>", "leak_rising");
    expect(html).not.toContain("<script>");
  });

  it("renders the kind heading at the top", () => {
    const html = htmlBody("Hi Anna", "cushion_wear");
    expect(html).toContain(subjectForKind("cushion_wear"));
  });
});
