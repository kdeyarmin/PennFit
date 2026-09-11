import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";
const db = installSupabaseMock();
import { getOrgScopedClient } from "@workspace/resupply-db";
vi.mock("../tenant-branding", () => ({
  resolveTenantLinkBaseUrl: async () => "https://fixture.example.test",
}));
vi.mock("../auth-deps", () => ({
  getAuthDeps: () => ({ publicBaseUrl: "https://fixture.example.test" }),
}));
import { createAndSendPatientPacket } from "./send";

beforeEach(() => db.reset());
describe("packet creation", () => {
  it("does not publish an open envelope when its document snapshot write fails", async () => {
    stageSupabaseResponse("patients", "select", {
      data: {
        id: "fixture-patient",
        legal_first_name: "Fixture",
        legal_last_name: "Patient",
      },
    });
    stageSupabaseResponse("patient_packets", "insert", {
      data: { id: "fixture-packet", link_version: 1 },
    });
    const error = new Error("Fixture document write failure");
    stageSupabaseResponse("patient_packet_documents", "insert", { error });
    stageSupabaseRpcResponse("create_patient_packet", { error });
    await expect(
      createAndSendPatientPacket({
        supabase: getOrgScopedClient("11111111-1111-4111-8111-111111111111"),
        patientId: "fixture-patient",
        channels: [],
      }),
    ).rejects.toThrow("Fixture document write failure");
    expect(getSupabaseWritePayloads("patient_packets", "insert")).toHaveLength(
      0,
    );
  });
});
