// Tests for the shared status-label helpers in Badge.tsx.
//
// These guard the "no raw snake_case in the UI" rule: every status enum
// rendered to a human must read as a friendly phrase rather than e.g.
// "awaiting_admin" or "submitted_to_pacware". humanizeStatus is the
// generic title-caser (acronym- and proper-noun-aware); the conversation
// inbox uses the friendlier conversationStatusLabel on top of it.

import { describe, expect, test } from "vitest";

import { conversationStatusLabel, humanizeStatus } from "./Badge";

describe("humanizeStatus", () => {
  test("renders an em dash for empty / nullish input", () => {
    expect(humanizeStatus(null)).toBe("—");
    expect(humanizeStatus(undefined)).toBe("—");
    expect(humanizeStatus("")).toBe("—");
    expect(humanizeStatus("___")).toBe("—");
  });

  test("title-cases a single word", () => {
    expect(humanizeStatus("draft")).toBe("Draft");
    expect(humanizeStatus("closed")).toBe("Closed");
  });

  test("splits snake_case into a readable phrase (no underscores)", () => {
    expect(humanizeStatus("awaiting_admin")).toBe("Awaiting Admin");
    expect(humanizeStatus("awaiting_patient")).toBe("Awaiting Patient");
    expect(humanizeStatus("outreach_pending")).toBe("Outreach Pending");
    expect(humanizeStatus("in_fulfillment")).toBe("In Fulfillment");
    expect(humanizeStatus("fax_dispatch_failed")).toBe("Fax Dispatch Failed");
    expect(humanizeStatus("awaiting_admin")).not.toContain("_");
  });

  test("preserves known acronyms", () => {
    expect(humanizeStatus("sms")).toBe("SMS");
    expect(humanizeStatus("mms")).toBe("MMS");
  });

  test("keeps small joining words lowercase mid-phrase and fixes brand case", () => {
    expect(humanizeStatus("submitted_to_pacware")).toBe("Submitted to PacWare");
    expect(humanizeStatus("returned_to_manufacturer")).toBe(
      "Returned to Manufacturer",
    );
  });

  test("treats the in_app channel as a readable label", () => {
    expect(humanizeStatus("in_app")).toBe("In App");
  });
});

describe("conversationStatusLabel", () => {
  test("maps each conversation state to a customer-service-friendly label", () => {
    expect(conversationStatusLabel("open")).toBe("Open");
    expect(conversationStatusLabel("awaiting_admin")).toBe("Awaiting reply");
    expect(conversationStatusLabel("awaiting_patient")).toBe(
      "Awaiting customer",
    );
    expect(conversationStatusLabel("closed")).toBe("Closed");
  });

  test("never leaks the raw awaiting_* enum", () => {
    expect(conversationStatusLabel("awaiting_admin")).not.toContain("_");
    expect(conversationStatusLabel("awaiting_patient")).not.toContain("_");
  });

  test("falls back to humanizeStatus for any unmapped future state", () => {
    expect(conversationStatusLabel("some_new_state")).toBe("Some New State");
  });
});
