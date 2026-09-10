import { beforeEach, describe, expect, it } from "vitest";
import {
  installSupabaseMock,
  stageSupabaseResponse as stage,
} from "../../test-helpers/supabase-mock";
import { checkCsrOutreach } from "./csr-outreach";
const db = installSupabaseMock();
const now = new Date("2026-09-10T16:00:00Z");
beforeEach(() => db.reset());
function seed(overrides = {}) {
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
    },
  });
  stage("prescriptions", "select", {
    data: {
      id: "r",
      patient_id: "p",
      status: "active",
      valid_until: "2027-09-01",
    },
  });
}
describe("CSR outreach preflight", () => {
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
