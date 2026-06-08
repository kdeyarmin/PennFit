// Source-pinned guards for the maintenance-nudge batching (2026-06-05
// performance review §2 HIGH). Two N+1s were removed: the per-patient
// quiet-period re-read (now an in-memory check against the already-built
// recentlyNudgedIds set) and the per-patient full maintenance_log read
// (now the patient_maintenance_latest_by_task RPC, mig 0232, which
// returns one row per (patient, task)).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "maintenance-nudges.ts"), "utf8");

describe("maintenance-nudges — quiet-period guard is in-memory", () => {
  it("uses the pre-built recentlyNudgedIds set, not a per-patient nudge read", () => {
    expect(SRC).toContain("recentlyNudgedIds.has(patient.id)");
    // No per-patient quiet-period round-trip left in the loop.
    expect(SRC).not.toMatch(
      /\.from\("patient_maintenance_nudges"\)\s*\.select\("id"\)\s*\.eq\("patient_id", patient\.id\)/,
    );
  });
});

describe("maintenance-nudges — last-completion read is batched", () => {
  it("uses the patient_maintenance_latest_by_task RPC, not a per-patient log read", () => {
    expect(SRC).toContain('.rpc("patient_maintenance_latest_by_task"');
    expect(SRC).not.toMatch(
      /\.from\("patient_maintenance_log"\)\s*\.select\("task_key, completed_at"\)\s*\.eq\("patient_id", patient\.id\)/,
    );
  });
});
