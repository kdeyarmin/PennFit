// Source-pinned guards for the therapy-milestones N+1 batching
// (2026-06-05 performance review §2 CRITICAL). The evaluate loop must
// (a) batch the existing-milestone lookup across the whole candidate set
// instead of one `.eq("patient_id", …)` read per patient, and (b) skip
// the per-patient night read entirely for patients who already hold all
// milestone kinds. The pure `detectMilestones` is unit-tested separately;
// these pins protect the query shape against regression.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "therapy-milestones.ts"), "utf8");

describe("therapy-milestones — existing-milestone lookup is batched", () => {
  it("reads existing milestone kinds with a chunked .in('patient_id', …)", () => {
    expect(SRC).toMatch(
      /\.from\("patient_therapy_milestones"\)\s*\.select\("patient_id, milestone_kind"\)\s*\.in\("patient_id", idChunk\)/,
    );
  });

  it("does NOT re-introduce a per-patient .eq('patient_id', patientId) milestone read", () => {
    // The prior N+1 read existing kinds once per patient inside the loop.
    expect(SRC).not.toMatch(
      /\.from\("patient_therapy_milestones"\)\s*\.select\("milestone_kind"\)\s*\.eq\("patient_id", patientId\)/,
    );
  });

  it("skips the night read for patients already holding every milestone kind", () => {
    expect(SRC).toContain(
      "ALL_MILESTONE_KINDS.every((k) => existingKinds.has(k))",
    );
  });
});
