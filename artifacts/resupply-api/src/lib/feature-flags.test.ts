// Tests for the feature-flag runtime helper.
//
// Coverage:
//   1. isFeatureEnabled() returns the value persisted in the row.
//   2. Unknown / unseeded keys default to true.
//   3. Read errors fail closed (return false) so a downed DB
//      doesn't accidentally re-enable a disabled feature.
//   4. Repeated calls within the 5s TTL hit the cache, not Supabase.
//   5. invalidateFeatureFlagCache(key) forces the next call to
//      re-read.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { isFeatureEnabled, invalidateFeatureFlagCache } from "./feature-flags";

beforeEach(() => {
  supabaseMock.reset();
  invalidateFeatureFlagCache();
});

describe("isFeatureEnabled", () => {
  it("returns true when the row says enabled=true", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    expect(await isFeatureEnabled("sms.reminders")).toBe(true);
  });

  it("returns false when the row says enabled=false", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    expect(await isFeatureEnabled("voice.agent")).toBe(false);
  });

  it("defaults to enabled when the flag is missing", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: null,
    });
    expect(await isFeatureEnabled("storefront.chatbot")).toBe(true);
  });

  it("fails closed on a DB error (returns false)", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "supabase down" },
    });
    expect(await isFeatureEnabled("bulk_campaigns.send")).toBe(false);
  });

  it("defaults to enabled when SUPABASE_URL is not configured", async () => {
    // Simulate a dev / test environment where the supabase client
    // can't even be constructed. The mock raises by setting a
    // staged error whose message starts with the canonical phrase.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "SUPABASE_URL must be set for ..." },
    });
    expect(await isFeatureEnabled("storefront.chatbot")).toBe(true);
  });

  it("defaults to enabled when Supabase is unreachable (ECONNREFUSED)", async () => {
    // Smoke tests point SUPABASE_URL at 127.0.0.1:1 so node-fetch
    // raises ECONNREFUSED. Treat that as "no DB" rather than
    // failing closed and breaking every checkout / chat / voice
    // call in test runs.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "fetch failed: ECONNREFUSED 127.0.0.1:1" },
    });
    expect(await isFeatureEnabled("storefront.checkout")).toBe(true);
  });

  it("defaults to enabled when Supabase is unreachable (ENOTFOUND)", async () => {
    // CI / dev environments with no DNS entry for the Supabase host
    // raise ENOTFOUND. The PR (0151 branch) merged ENOTFOUND into the
    // same fail-open branch as ECONNREFUSED + missing DB config.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "ENOTFOUND db.xyz.supabase.co" },
    });
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled("fitter_supply_campaign.dispatcher")).toBe(
      true,
    );
  });

  it("defaults to enabled when Supabase is unreachable (EAI_AGAIN)", async () => {
    // Some DNS resolvers emit EAI_AGAIN (temporary DNS failure) rather
    // than ENOTFOUND. This should be treated identically — fail open.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "EAI_AGAIN db.xyz.supabase.co" },
    });
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled("smart_triggers.dispatcher")).toBe(true);
  });

  it("defaults to enabled when the error message is 'fetch failed' (no port detail)", async () => {
    // A bare "fetch failed" message (without ECONNREFUSED or similar)
    // should also be treated as an unreachable-DB scenario.
    stageSupabaseResponse("feature_flags", "select", {
      error: { message: "fetch failed" },
    });
    invalidateFeatureFlagCache();
    expect(await isFeatureEnabled("patient_onboarding.dispatcher")).toBe(true);
  });

  it("caches within the TTL — a second call doesn't re-query", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    // First call resolves the staged response.
    expect(await isFeatureEnabled("sms.reminders")).toBe(false);
    // Stage a CONTRADICTORY response and verify the cache short-
    // circuits — the second call still sees the cached `false`.
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    expect(await isFeatureEnabled("sms.reminders")).toBe(false);
  });

  it("re-reads after invalidateFeatureFlagCache(key)", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    expect(await isFeatureEnabled("sms.reminders")).toBe(false);
    invalidateFeatureFlagCache("sms.reminders");
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    expect(await isFeatureEnabled("sms.reminders")).toBe(true);
  });
});

describe("isFeatureEnabled — org scoping (Phase 1)", () => {
  it("reads the supplied tenant's row", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    expect(await isFeatureEnabled("sms.reminders", "org-abc")).toBe(false);
  });

  it("falls back to the seed org's value when the tenant has no row of its own", async () => {
    // org-abc has no row (first lookup → null), so the reader falls
    // back to the seed org's row (second lookup → disabled).
    stageSupabaseResponse("feature_flags", "select", { data: null });
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    expect(await isFeatureEnabled("voice.agent", "org-abc")).toBe(false);
  });

  it("caches per (org, key) so different tenants don't collide", async () => {
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: true },
    });
    expect(await isFeatureEnabled("sms.reminders", "org-1")).toBe(true);
    // A different org with a contradictory response must NOT read org-1's
    // cached entry.
    stageSupabaseResponse("feature_flags", "select", {
      data: { enabled: false },
    });
    expect(await isFeatureEnabled("sms.reminders", "org-2")).toBe(false);
  });
});
