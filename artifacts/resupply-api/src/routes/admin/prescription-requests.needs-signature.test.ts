// Route tests for the hand-delivery signature batch:
//   GET /admin/prescription-requests/needs-signature       (JSON)
//   GET /admin/prescription-requests/needs-signature/pdf   (combined PDF)
//
// Coverage:
//   * 401 without admin
//   * 400 when neither / both of providerId, practiceName are given
//   * JSON manifest happy path (count + projected packets)
//   * PDF 404 when nothing is outstanding
//   * PDF happy path renders a %PDF stream for one resolvable packet

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

const logAuditMock = vi.hoisted(() =>
  vi.fn<(input: unknown) => Promise<undefined>>(async () => undefined),
);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import prescriptionRequestsRouter from "./prescription-requests";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(prescriptionRequestsRouter);
  return app;
}

const JOIN_ROW = {
  id: "pkt_a",
  patient_id: "pat_a",
  provider_id: "prv_1",
  status: "draft",
  return_fax_e164: "+12155551212",
  sent_at: null,
  created_at: "2026-05-01T00:00:00.000Z",
  patients: { legal_first_name: "Anna", legal_last_name: "Smith" },
  providers: {
    id: "prv_1",
    legal_name: "Jane Doe",
    npi: "1234567890",
    practice_name: "Sleep Wellness Clinic",
  },
};

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/prescription-requests/needs-signature", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      "/admin/prescription-requests/needs-signature?providerId=" +
        "11111111-1111-4111-8111-111111111111",
    );
    expect(res.status).toBe(401);
  });

  it("400s when neither providerId nor practiceName is given", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/prescription-requests/needs-signature",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_query");
  });

  it("400s when both providerId and practiceName are given", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      "/admin/prescription-requests/needs-signature" +
        "?providerId=11111111-1111-4111-8111-111111111111" +
        "&practiceName=Sleep%20Wellness%20Clinic",
    );
    expect(res.status).toBe(400);
  });

  it("returns the manifest for a provider", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: [JOIN_ROW],
    });
    const res = await request(makeApp()).get(
      "/admin/prescription-requests/needs-signature?practiceName=" +
        "Sleep%20Wellness%20Clinic",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.label).toBe("Sleep Wellness Clinic");
    expect(res.body.packets[0]).toMatchObject({
      id: "pkt_a",
      patientName: "Smith, Anna",
      status: "draft",
    });
  });
});

describe("GET /admin/prescription-requests/needs-signature/pdf", () => {
  it("404s when nothing is outstanding", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: [],
    });
    const res = await request(makeApp()).get(
      "/admin/prescription-requests/needs-signature/pdf" +
        "?providerId=11111111-1111-4111-8111-111111111111",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no_outstanding_packets");
  });

  it("renders a combined PDF for a resolvable packet", async () => {
    mockAdmin.current = ADMIN;
    // A supplier return fax must be configured for the packet to pass
    // render validation.
    process.env.RESUPPLY_SUPPLIER_FAX_E164 = "+18005551212";

    // 1) the aggregation join query
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: [JOIN_ROW],
    });
    // 2) the resolver's packet-detail query
    stageSupabaseResponse("prescription_request_packets", "select", {
      data: {
        id: "pkt_a",
        patient_id: "pat_a",
        provider_id: "prv_1",
        hcpcs_items_json: [
          { hcpcs: "E0601", description: "CPAP device", quantity: 1 },
        ],
        icd10_codes_json: ["G47.33"],
        device_settings_json: null,
        length_of_need_months: 99,
        return_fax_e164: "+12155551212",
        return_email: null,
        clinical_notes: null,
        created_at: "2026-05-01T00:00:00.000Z",
      },
    });
    // 3) resolver fan-out: patient, provider, coverage
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Anna",
        legal_last_name: "Smith",
        date_of_birth: "1960-01-15",
        address: null,
        phone_e164: "+12155551212",
      },
    });
    stageSupabaseResponse("providers", "select", {
      data: {
        legal_name: "Jane Doe",
        npi: "1234567890",
        practice_name: "Sleep Wellness Clinic",
        fax_e164: "+12155551212",
      },
    });
    stageSupabaseResponse("insurance_coverages", "select", { data: null });

    const res = await request(makeApp())
      .get(
        "/admin/prescription-requests/needs-signature/pdf?providerId=" +
          "11111111-1111-4111-8111-111111111111",
      )
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    const body = res.body as Buffer;
    expect(body.subarray(0, 4).toString("latin1")).toBe("%PDF");
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    expect(logAuditMock.mock.calls[0]?.[0]).toMatchObject({
      action: "prescription_request.batch_previewed",
      metadata: { target_kind: "provider", included: 1, excluded: 0 },
    });
  });
});
