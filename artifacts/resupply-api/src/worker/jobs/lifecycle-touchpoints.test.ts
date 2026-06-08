// Source-pinned guards for the lifecycle-touchpoints anniversary
// batching (2026-06-05 performance review §2 HIGH). PR #564 batched the
// opt-in gate (loadOptInStatuses); this change additionally replaces the
// per-candidate MIN(night_date) anniversary probe — an N+1 #564 left in
// place — with the patients_with_therapy_anniversary RPC (mig 0232),
// which returns only true matches, and routes the anniversary opt-in
// through the same batched helper.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(
  path.join(__dirname, "lifecycle-touchpoints.ts"),
  "utf8",
);

describe("lifecycle-touchpoints — anniversary match is computed server-side", () => {
  it("calls the patients_with_therapy_anniversary RPC instead of a per-candidate MIN(night) probe", () => {
    expect(SRC).toContain('.rpc("patients_with_therapy_anniversary"');
    // No per-candidate earliest-night probe left in the loop.
    expect(SRC).not.toMatch(
      /\.from\("patient_therapy_nights"\)\s*\.select\("night_date"\)\s*\.eq\("patient_id", row\.id\)/,
    );
  });
});

describe("lifecycle-touchpoints — opt-in gate is batched in both passes", () => {
  it("resolves opt-in via the batched loadOptInStatuses, not a per-row read", () => {
    expect(SRC).toContain("loadOptInStatuses(");
    // The anniversary pass now uses the batched map too…
    expect(SRC).toContain("const annOptIn = await loadOptInStatuses(");
    // …so the per-row isOptedIn helper is gone.
    expect(SRC).not.toContain("async function isOptedIn(");
    expect(SRC).not.toContain("await isOptedIn(");
  });
});
