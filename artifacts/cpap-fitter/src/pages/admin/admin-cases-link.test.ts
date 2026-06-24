// Behavioural tests for caseLinkHref — the per-kind deep-link builder that
// turns a case's linked items into launchpad links (open the entity) for
// the kinds with a dedicated route, and returns null otherwise.

import { describe, it, expect } from "vitest";

import { caseLinkHref } from "./admin-cases";

describe("caseLinkHref", () => {
  it("links a conversation to its detail route", () => {
    expect(caseLinkHref("conversation", "conv_123")).toBe(
      "/admin/conversations/conv_123",
    );
  });

  it("links a referral to the review queue deep link", () => {
    expect(caseLinkHref("referral", "rev_9")).toBe(
      "/admin/referral-reviews?review=rev_9",
    );
  });

  it("URL-encodes the ref id", () => {
    expect(caseLinkHref("conversation", "a b/c")).toBe(
      "/admin/conversations/a%20b%2Fc",
    );
    expect(caseLinkHref("referral", "a&b")).toBe(
      "/admin/referral-reviews?review=a%26b",
    );
  });

  it("returns null for kinds with no dedicated per-entity route", () => {
    for (const kind of [
      "order",
      "fax",
      "followup",
      "review",
      "product_question",
      "work_item",
      "other",
    ] as const) {
      expect(caseLinkHref(kind, "x123")).toBeNull();
    }
  });

  it("returns null for a blank ref id even on a linkable kind", () => {
    expect(caseLinkHref("conversation", "")).toBeNull();
    expect(caseLinkHref("conversation", "   ")).toBeNull();
  });
});
