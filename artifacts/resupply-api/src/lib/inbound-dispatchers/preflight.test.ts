// Structural source check for runReferralPreflight idempotency.
//
// The preflight path is DB-heavy (multiple Supabase round-trips across
// the PA / eligibility / docs-gap checks), so — like era-reconciler —
// the comprehensive behavioural coverage lives in the integration suite.
// Here we pin the one invariant that's easy to regress: a re-run must
// clear the prior preflight checks before recording new ones, because
// recordCheck() only inserts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "preflight.ts"), "utf8");

describe("runReferralPreflight — idempotency (source check)", () => {
  it("deletes prior inbound_referral_preflight_checks before recording a new run", () => {
    // recordCheck() only INSERTs, so without an up-front delete a re-run
    // (manual /run-preflight route, a pg-boss retry, or a future
    // overlapping tick) would append a second full set of check rows.
    expect(SRC).toMatch(
      /from\("inbound_referral_preflight_checks"\)\s*\.delete\(\)/,
    );
  });

  it("scopes the clear to the referral being processed", () => {
    const delIdx = SRC.search(
      /from\("inbound_referral_preflight_checks"\)\s*\.delete\(\)/,
    );
    expect(delIdx).toBeGreaterThan(-1);
    // The .eq("referral_id", ...) guard must follow the delete so we only
    // clear this referral's checks, never the whole table.
    const window = SRC.slice(delIdx, delIdx + 160);
    expect(window).toContain('.eq("referral_id"');
  });
});
