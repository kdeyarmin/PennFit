import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  getSupabaseRpcArgs,
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
  stageSupabaseRpcResponse,
} from "../../test-helpers/supabase-mock";

const db = installSupabaseMock();
const { verify, autofile } = vi.hoisted(() => ({
  verify: vi.fn(),
  autofile: vi.fn(),
}));
vi.mock("../../lib/patient-packet-token", () => ({
  verifyPatientPacketToken: verify,
}));
vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: async () =>
    "11111111-1111-4111-8111-111111111111",
}));
vi.mock("../../lib/patient-packet/autofile", () => ({
  autofileSignedPacketPdf: autofile,
}));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));
import router from "./patient-packets";

const ORG = "11111111-1111-4111-8111-111111111111";
const PACKET = "22222222-2222-4222-8222-222222222222";
const completedAt = "2026-09-11T12:00:00.000Z";
const packet = {
  id: PACKET,
  status: "sent",
  link_version: 1,
  expires_at: "2099-01-01T00:00:00Z",
  title: "Fixture packet",
  recipient_name: "Fixture Patient",
  completed_at: null,
};
const body = {
  token: "fixture-token",
  signerName: "Fixture Patient",
  signerRelationship: "self",
  consentEsign: true,
  acknowledgedDocumentKeys: ["welcome"],
};
function app() {
  const app = express();
  app.use(express.json());
  app.use(router);
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "internal_error" });
    },
  );
  return app;
}
function openPacket() {
  stageSupabaseResponse("patient_packets", "select", { data: packet });
  stageSupabaseResponse("patient_packet_documents", "select", {
    data: [{ document_key: "welcome" }],
  });
}
function stageCompleted(status = "completed") {
  stageSupabaseRpcResponse("finalize_patient_packet", {
    data: { status, completed_at: completedAt },
  });
}
beforeEach(() => {
  db.reset();
  vi.clearAllMocks();
  verify.mockReturnValue({ valid: true, packetId: PACKET, linkVersion: 1 });
  autofile.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("patient packet signing recovery", () => {
  it("lets the original successful link show generic completion", async () => {
    openPacket();
    stageCompleted();
    stageSupabaseResponse("patient_packets", "update", {
      data: [{ id: PACKET }],
    });
    const signed = await request(app())
      .post("/patient-packets/sign")
      .send(body);
    expect(signed.status).toBe(200);
    const patch =
      getSupabaseWritePayloads("patient_packets", "update")[0] ?? {};
    stageSupabaseResponse("patient_packets", "select", {
      data: {
        ...packet,
        status: "completed",
        completed_at: completedAt,
        ...(patch as object),
      },
    });
    const reopened = await request(app()).get(
      "/patient-packets/view?token=fixture-token",
    );
    expect(reopened.status).toBe(200);
    expect(reopened.body).toEqual({ status: "completed", documents: [] });
  });

  it("acknowledges a completed retry without capturing another signature", async () => {
    stageSupabaseResponse("patient_packets", "select", {
      data: { ...packet, status: "completed", completed_at: completedAt },
    });
    const res = await request(app()).post("/patient-packets/sign").send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "completed", completedAt });
    expect(
      getSupabaseWritePayloads("patient_packet_signatures", "insert"),
    ).toHaveLength(0);
    expect(autofile).not.toHaveBeenCalled();
  });

  it("does not make a standalone signature write before a failed finalization", async () => {
    openPacket();
    stageSupabaseResponse("patient_packets", "update", {
      error: { message: "Fixture write failure" },
    });
    stageSupabaseRpcResponse("finalize_patient_packet", {
      error: { message: "Fixture write failure" },
    });
    const res = await request(app()).post("/patient-packets/sign").send(body);
    expect(res.status).toBe(500);
    expect(
      getSupabaseWritePayloads("patient_packet_signatures", "insert"),
    ).toHaveLength(0);
    expect(autofile).not.toHaveBeenCalled();
  });

  it("lets racing valid requests finish with one completion result", async () => {
    openPacket();
    openPacket();
    stageCompleted();
    stageCompleted("already_completed");
    stageSupabaseResponse("patient_packets", "update", {
      data: [{ id: PACKET }],
    });
    stageSupabaseResponse("patient_packets", "update", { data: [] });
    const results = await Promise.all([
      request(app()).post("/patient-packets/sign").send(body),
      request(app()).post("/patient-packets/sign").send(body),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      getSupabaseWritePayloads("patient_packet_signatures", "insert"),
    ).toHaveLength(0);
    expect(autofile).toHaveBeenCalledTimes(1);
    expect(getSupabaseRpcArgs("finalize_patient_packet")).toEqual([
      expect.objectContaining({
        p_org_id: ORG,
        p_packet_id: PACKET,
        p_link_version: 1,
      }),
      expect.objectContaining({
        p_org_id: ORG,
        p_packet_id: PACKET,
        p_link_version: 1,
      }),
    ]);
  });

  it.each(["completed", "voided"])(
    "still rejects a revoked link to a %s packet",
    async (status) => {
      stageSupabaseResponse("patient_packets", "select", {
        data: { ...packet, status, completed_at: completedAt, link_version: 2 },
      });
      const res = await request(app()).get(
        "/patient-packets/view?token=fixture-token",
      );
      expect(res.status).toBe(410);
      expect(res.body).toEqual({ error: "invalid" });
    },
  );

  it("rejects an expired token before reading any patient record", async () => {
    verify.mockReturnValue({ valid: false });
    const res = await request(app()).post("/patient-packets/sign").send(body);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "invalid" });
    expect(getSupabaseRpcArgs("finalize_patient_packet")).toHaveLength(0);
  });

  it("rejects a packet exactly at its expiration time", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date(packet.expires_at).getTime(),
    );
    openPacket();
    stageCompleted();
    const res = await request(app()).post("/patient-packets/sign").send(body);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "expired" });
    expect(getSupabaseRpcArgs("finalize_patient_packet")).toHaveLength(0);
  });

  it.each(["2026-02-31", "2025-02-29", "2026-13-01"])(
    "rejects impossible received date %s before any signing write",
    async (dateReceived) => {
      const res = await request(app())
        .post("/patient-packets/sign")
        .send({ ...body, dateReceived });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_body");
      expect(getSupabaseRpcArgs("finalize_patient_packet")).toHaveLength(0);
    },
  );
});
