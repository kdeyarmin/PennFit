// Source-pinned guards for the maintenance-nudge batching (2026-06-05
// performance review §2 HIGH). Two N+1s were removed: the per-patient
// quiet-period re-read (now an in-memory check against the already-built
// recentlyNudgedIds set) and the per-patient full maintenance_log read
// (now the patient_maintenance_latest_by_task RPC, mig 0232, which
// returns one row per (patient, task)).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

// The per-org body now builds its email client via createTenantSendgridClient
// and brands copy via resolveBrandingByOrgId. Mock both so the fan-out
// proceeds to the roster scan (the client no longer comes from cfg) and the
// brand is deterministic (seed → "Penn Home Medical Supply").
vi.mock("../../lib/email/tenant-sender.js", () => ({
  createTenantSendgridClient: vi.fn(async () => ({
    sendEmail: vi.fn().mockResolvedValue({ messageId: "m_test" }),
  })),
}));
vi.mock("../../lib/tenant-branding.js", () => ({
  resolveBrandingByOrgId: vi.fn(async () => ({
    storefrontName: "Penn Home Medical Supply",
    legalName: "Penn Home Medical Supply",
    tagline: "tagline",
    logoUrl: null,
  })),
  resolveTenantBaseUrl: vi.fn(async () => null),
}));

const supabaseMock = installSupabaseMock();

import { runMaintenanceNudgeSweep } from "./maintenance-nudges";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(path.join(__dirname, "maintenance-nudges.ts"), "utf8");

// Messaging config the sweep needs to get past its incomplete-config guard.
// SendGrid is never actually invoked here — every staged roster is empty,
// so no send is attempted.
const FULL_CFG = {
  sendgridApiKey: "SG.unit-test",
  sendgridFromEmail: "info@pennpaps.example",
  sendgridFromName: "Penn Home Medical Supply",
  practiceName: "Penn Home Medical Supply",
  publicBaseUrl: "https://pennfit.example",
};

describe("maintenance-nudges — quiet-period guard is in-memory", () => {
  it("uses the pre-built recentlyNudgedIds set, not a per-patient nudge read", () => {
    expect(SRC).toContain("recentlyNudgedIds.has(patient.id)");
    // No per-patient quiet-period round-trip left in the loop.
    expect(SRC).not.toMatch(
      /\.from\("patient_maintenance_nudges"\)\s*\.select\("id"\)\s*\.eq\("patient_id", patient\.id\)/,
    );
  });
});

describe("maintenance-nudges — only active patients are nudged", () => {
  it("filters the candidate roster query on status = 'active'", () => {
    // Every other patient-send path gates on status === 'active'; this job
    // must not email paused / discharged patients. Pinned to the candidate
    // query so the gate can't be dropped in a future refactor.
    expect(SRC).toMatch(/\.eq\("status",\s*"active"\)/);
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

// Multi-tenant fan-out smoke coverage (G2). The full per-tenant nudge body
// runs against a real PostgREST surface in the integration suite
// (maintenance-nudges.integration.test.ts); here we verify the sweep fans
// out across every active tenant and no-ops cleanly when there are none.
describe("runMaintenanceNudgeSweep — multi-tenant fan-out", () => {
  beforeEach(() => supabaseMock.reset());

  it("runs once per active tenant (empty rosters → zero emails)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }, { id: "org-b" }],
    });
    const stats = await runMaintenanceNudgeSweep(FULL_CFG);
    expect(stats.emailed).toBe(0);
    expect(stats.scanned).toBe(0);
    // Each active tenant walks its own roster: the first candidate page
    // (patients) is read once per org before the empty result breaks.
    expect(getSupabaseCallCount("patients", "select")).toBe(2);
  });

  it("no-ops when there are no active tenants (no roster read at all)", async () => {
    stageSupabaseResponse("organizations", "select", { data: [] });
    const stats = await runMaintenanceNudgeSweep(FULL_CFG);
    expect(stats.emailed).toBe(0);
    expect(stats.scanned).toBe(0);
    expect(getSupabaseCallCount("patients", "select")).toBe(0);
  });

  it("skips entirely when the messaging config is incomplete (no fan-out)", async () => {
    stageSupabaseResponse("organizations", "select", {
      data: [{ id: "org-a" }],
    });
    const stats = await runMaintenanceNudgeSweep({
      ...FULL_CFG,
      sendgridApiKey: null,
    });
    expect(stats.emailed).toBe(0);
    // Bailed before resolving active tenants → no organizations read.
    expect(getSupabaseCallCount("organizations", "select")).toBe(0);
  });
});
