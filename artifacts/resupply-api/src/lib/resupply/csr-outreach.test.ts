import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSupabaseMock,
  stageSupabaseResponse as stage,
} from "../../test-helpers/supabase-mock";
import { checkCsrOutreach } from "./csr-outreach";
const db = installSupabaseMock();
const { authoritative } = vi.hoisted(() => ({ authoritative: vi.fn() }));
vi.mock("../feature-flags", () => ({ isFeatureEnabled: authoritative }));
const now = new Date("2026-09-10T16:00:00Z");
beforeEach(() => {
  db.reset();
  authoritative.mockReset().mockResolvedValue(true);
});
function seed(overrides = {}, patientOverrides = {}, rxOverrides = {}) {
  stage("episodes", "select", {
    data: {
      id: "e",
      patient_id: "p",
      prescription_id: "r",
      status: "outreach_pending",
      due_at: "2026-09-09T16:00:00Z",
      ...overrides,
    },
  });
  stage("patients", "select", {
    data: {
      id: "p",
      status: "active",
      phone_e164: "+15555550100",
      email: "test@example.test",
      timezone: "America/New_York",
      created_at: "2025-01-01T00:00:00Z",
      ...patientOverrides,
    },
  });
  stage("prescriptions", "select", {
    data: {
      id: "r",
      patient_id: "p",
      status: "active",
      valid_until: "2027-09-01",
      item_sku: "MASK",
      cadence_days: 30,
      created_at: "2026-08-01T16:00:00Z",
      ...rxOverrides,
    },
  });
}
describe("CSR outreach preflight", () => {
  it("uses effective cadence before the tenant's due-date cutover", async () => {
    authoritative.mockResolvedValue(false);
    seed({ due_at: "2026-12-01T00:00:00Z" });
    expect(
      (await checkCsrOutreach("org", "e", "email", now)).reason,
    ).toBeNull();
    db.reset();
    seed({ due_at: "2026-08-01T00:00:00Z" }, { cadence_override_days: 90 });
    expect((await checkCsrOutreach("org", "e", "email", now)).reason).toMatch(
      /not scheduled as due/,
    );
  });
  it.each(["sms", "email", "voice"] as const)(
    "allows due active patients for %s",
    async (channel) => {
      seed();
      expect(await checkCsrOutreach("org", "e", channel, now)).toMatchObject({
        reason: null,
        patientId: "p",
      });
    },
  );
  it.each(["confirmed", "declined", "fulfilled", "address_hold"])(
    "blocks a stale %s cycle before delivery",
    async (status) => {
      seed({ status });
      expect((await checkCsrOutreach("org", "e", "sms", now)).reason).toMatch(
        /no longer/,
      );
    },
  );
  it("blocks future and expired cycles", async () => {
    seed({ due_at: "2026-10-01T00:00:00Z" });
    expect((await checkCsrOutreach("org", "e", "email", now)).reason).toMatch(
      /not scheduled as due/,
    );
    db.reset();
    seed({ expires_at: "2026-09-09T00:00:00Z" });
    expect((await checkCsrOutreach("org", "e", "voice", now)).reason).toMatch(
      /expired/,
    );
  });
  it("skips recent conversations instead of contacting the same patient again", async () => {
    seed();
    stage("conversations", "select", { data: [{ id: "conversation" }] });
    expect((await checkCsrOutreach("org", "e", "sms", now)).reason).toMatch(
      /48 hours/,
    );
  });
  it("fails closed on lookup errors", async () => {
    stage("episodes", "select", { error: new Error("offline") });
    await expect(checkCsrOutreach("org", "e", "sms", now)).rejects.toThrow(
      "offline",
    );
  });
});
