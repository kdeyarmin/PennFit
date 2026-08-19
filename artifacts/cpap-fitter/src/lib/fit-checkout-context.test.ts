// @vitest-environment jsdom
// The fitting → checkout handoff.
//
// The interesting cases are all failure modes, because the happy path is
// a round-trip through JSON: a record that outlives its usefulness would
// attribute an unrelated resupply order to an old fitting, and a
// malformed record must read as "no fitting" rather than throwing on a
// money path.
//
// This one needs jsdom (the module is localStorage-backed); the rest of
// src/lib runs in the default node environment.

import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";

import {
  clearFitCheckoutContext,
  clearSubmittedFitCheckoutContext,
  markFitCheckoutContextSubmitted,
  readFitCheckoutContext,
  rememberFitCheckoutContext,
} from "./fit-checkout-context";

const KEY = "pennfit_fit_checkout_v1";
const SESSION = "11111111-1111-4111-8111-111111111111";
const VARIANT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("fit checkout context", () => {
  it("round-trips the chosen mask and variant", () => {
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: VARIANT,
    });
    expect(readFitCheckoutContext()).toEqual({
      fitSessionId: SESSION,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: VARIANT,
    });
  });

  it("reads as absent when nothing was remembered", () => {
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("refuses to store a record with no session to attribute to", () => {
    rememberFitCheckoutContext({
      fitSessionId: "",
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: null,
    });
    expect(window.localStorage.getItem(KEY)).toBeNull();
  });

  it("keeps the LAST mask added, not the first", () => {
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "first-pick",
      orderedVariantId: null,
    });
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "changed-my-mind",
      orderedVariantId: null,
    });
    expect(readFitCheckoutContext()?.orderedMaskSlug).toBe("changed-my-mind");
  });

  it("expires rather than attributing a later, unrelated order", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: null,
    });
    // Just inside the window: still the same shopping trip.
    vi.setSystemTime(new Date("2026-08-01T23:59:00Z"));
    expect(readFitCheckoutContext()).not.toBeNull();
    // A week later this is somebody's routine resupply order.
    vi.setSystemTime(new Date("2026-08-08T00:00:00Z"));
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("reads a malformed or partial record as absent instead of throwing", () => {
    window.localStorage.setItem(KEY, "{not json");
    expect(readFitCheckoutContext()).toBeNull();

    window.localStorage.setItem(KEY, JSON.stringify({ savedAt: Date.now() }));
    expect(readFitCheckoutContext()).toBeNull();

    // A record with no timestamp can't be aged out, so it isn't trusted.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ fitSessionId: SESSION, orderedMaskSlug: "x" }),
    );
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("normalises a missing mask or variant to null, keeping the session", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ fitSessionId: SESSION, savedAt: Date.now() }),
    );
    expect(readFitCheckoutContext()).toEqual({
      fitSessionId: SESSION,
      orderedMaskSlug: null,
      orderedVariantId: null,
    });
  });

  it("drops a record whose fitSessionId is not a UUID instead of poisoning checkout", () => {
    // The checkout routes validate fitSessionId as z.string().uuid() in a
    // .strict() schema. Forwarding a corrupted stored value verbatim
    // would 400 the ENTIRE checkout — and keep 400ing it on retry, since
    // the record survives the failure. Not-a-UUID must read as absent.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({ fitSessionId: "hand-edited-junk", savedAt: Date.now() }),
    );
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("rejects a hyphen-shaped value Zod's RFC uuid() would refuse", () => {
    // Zod 4 enforces the version nibble (1-8) and variant bits — a merely
    // hyphen-shaped check would forward this and 400 every retry.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        fitSessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        savedAt: Date.now(),
      }),
    );
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("clearSubmitted leaves a record no checkout has carried yet", () => {
    // The record is a single localStorage slot shared across tabs: while
    // checkout A is pending on Stripe, another tab can store fitting B's
    // context. A's success page must clear only a record that actually
    // rode a checkout — never B's fresh, un-submitted one.
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: null,
    });
    clearSubmittedFitCheckoutContext();
    expect(readFitCheckoutContext()).not.toBeNull();

    markFitCheckoutContextSubmitted();
    clearSubmittedFitCheckoutContext();
    expect(readFitCheckoutContext()).toBeNull();
  });

  it("drops just the variant/slug when they are malformed, keeping the session", () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        fitSessionId: SESSION,
        orderedMaskSlug: "Not A Slug!",
        orderedVariantId: "also-junk",
        savedAt: Date.now(),
      }),
    );
    expect(readFitCheckoutContext()).toEqual({
      fitSessionId: SESSION,
      orderedMaskSlug: null,
      orderedVariantId: null,
    });
  });

  it("clears once the order it described has been placed", () => {
    rememberFitCheckoutContext({
      fitSessionId: SESSION,
      orderedMaskSlug: "resmed-airfit-f20",
      orderedVariantId: null,
    });
    clearFitCheckoutContext();
    expect(readFitCheckoutContext()).toBeNull();
  });
});
