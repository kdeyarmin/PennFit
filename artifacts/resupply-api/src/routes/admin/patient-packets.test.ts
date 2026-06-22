// Route tests for the patient signature-packet admin endpoints
// (routes/admin/patient-packets.ts).
//
// Coverage focus (per docs/remaining-gaps-2026-06-22.md §5): the packet
// state machine (the edit / resend / void status guards), the
// token-substitution validation (unknown {{merge_token}} rejection on
// every send + template-save path), and the multi-channel delivery
// branches (the email/sms flags the send helpers surface). The heavy
// DB+delivery helpers (createAndSendPatientPacket*, deliverPacketLink,
// reconcile/applyOverrides), the signed-PDF builder, the company-profile
// resolver, the HMAC token mint, and getAuthDeps are mocked at the
// module boundary; the pure content/token-validation + template catalog
// helpers run for real so the validation paths are genuinely exercised.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("../../lib/auth-deps", () => ({
  getAuthDeps: () => ({ publicBaseUrl: "https://cmbreathe.com" }),
}));

// HMAC token mint reads RESUPPLY_LINK_HMAC_KEY from env — stub it so no
// secret is needed and the signing link is deterministic.
vi.mock("../../lib/patient-packet-token", () => ({
  signPatientPacketToken: vi.fn(() => "signed-token-abc"),
}));

// The company-profile resolver hits the billing identity resolver / DB;
// stub it to a fixed profile so the preview render is deterministic.
vi.mock("../../lib/patient-packet/company", () => ({
  resolveCompanyProfile: vi.fn(async () => ({
    name: "CareMetric Breathe",
    phone: "+12155550100",
    email: "info@example.com",
    addressLine1: "1 Main",
    addressLine2: null,
    city: "Phila",
    state: "PA",
    zip: "19101",
    website: "https://cmbreathe.com",
  })),
}));

// The signed-PDF builder is a heavy renderer — stub it.
const { buildSignedPacketPdfMock } = vi.hoisted(() => ({
  buildSignedPacketPdfMock: vi.fn(),
}));
vi.mock("../../lib/patient-packet/signed-pdf", () => ({
  buildSignedPacketPdf: buildSignedPacketPdfMock,
}));

// The create+send+deliver helpers own the DB writes + outbound channels;
// stub them so the route's validation, audit, and status-guard contract
// is what's under test. The pure key/override-validation helpers are
// real (`resolveDocumentKeys`, `findInvalidOverrideKeys`, the channel
// constant).
const {
  createPacketMock,
  createPacketToContactMock,
  deliverPacketLinkMock,
  reconcileMock,
  applyOverridesMock,
} = vi.hoisted(() => ({
  createPacketMock: vi.fn(),
  createPacketToContactMock: vi.fn(),
  deliverPacketLinkMock: vi.fn(),
  reconcileMock: vi.fn(async () => undefined),
  applyOverridesMock: vi.fn(async () => undefined),
}));
vi.mock("../../lib/patient-packet/send", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/patient-packet/send")
  >("../../lib/patient-packet/send");
  return {
    ...actual,
    createAndSendPatientPacket: createPacketMock,
    createAndSendPatientPacketToContact: createPacketToContactMock,
    deliverPacketLink: deliverPacketLinkMock,
    reconcilePacketDocuments: reconcileMock,
    applyPacketDocumentOverrides: applyOverridesMock,
  };
});

import packetsRouter from "./patient-packets";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

const PATIENT = "11111111-1111-4111-8111-111111111111";
const PACKET = "22222222-2222-4222-8222-222222222222";
const PRESET = "33333333-3333-4333-8333-333333333333";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(packetsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  createPacketMock.mockReset();
  createPacketToContactMock.mockReset();
  deliverPacketLinkMock.mockReset();
  reconcileMock.mockReset();
  reconcileMock.mockResolvedValue(undefined);
  applyOverridesMock.mockReset();
  applyOverridesMock.mockResolvedValue(undefined);
  buildSignedPacketPdfMock.mockReset();
});

// ── Template catalog ──────────────────────────────────────────────

describe("GET /admin/patient-packet-templates", () => {
  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/patient-packet-templates");
    expect(res.status).toBe(401);
  });

  it("returns the document catalog + merge tokens", async () => {
    mockAdmin.current = ADMIN;
    // loadTemplateOverrides read (no overrides → all default).
    stageSupabaseResponse("patient_packet_template_overrides", "select", {
      data: [],
    });
    const res = await request(makeApp()).get("/admin/patient-packet-templates");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.templates)).toBe(true);
    expect(res.body.templates.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.mergeTokens)).toBe(true);
    // An uncustomized template reports customized=false.
    expect(res.body.templates[0].customized).toBe(false);
  });
});

describe("PUT /admin/patient-packet-templates/:key (token validation)", () => {
  // Use a real catalog key so the isValidPacketDocumentKey gate passes.
  const KEY = "proof_of_delivery";

  it("404 on an unknown document key", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put("/admin/patient-packet-templates/not_a_real_key")
      .send({ sections: [{ paragraphs: ["hi"] }] });
    expect(res.status).toBe(404);
  });

  it("400 unknown_merge_tokens when a section uses an unknown token", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .put(`/admin/patient-packet-templates/${KEY}`)
      .send({
        sections: [{ paragraphs: ["Hello {{not_a_token}}"] }],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_merge_tokens");
    expect(res.body.unknownTokens).toContain("not_a_token");
  });

  it("saves a valid override + bumps the revision", async () => {
    mockAdmin.current = ADMIN;
    // saveTemplateOverride: prior-revision read, then upsert + history.
    stageSupabaseResponse("patient_packet_template_overrides", "select", {
      data: { revision: 2 },
    });
    stageSupabaseResponse("patient_packet_template_overrides", "upsert", {
      data: null,
    });
    stageSupabaseResponse("patient_packet_template_revisions", "insert", {
      data: null,
    });
    const res = await request(makeApp())
      .put(`/admin/patient-packet-templates/${KEY}`)
      .send({
        title: "POD",
        sections: [{ paragraphs: ["Delivered to {{patient_name}}."] }],
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: KEY, revision: 3, customized: true });
    const upserted = getSupabaseWritePayloads(
      "patient_packet_template_overrides",
      "upsert",
    )[0] as Record<string, unknown>;
    expect(upserted.revision).toBe(3);
  });
});

describe("DELETE /admin/patient-packet-templates/:key (revert)", () => {
  const KEY = "proof_of_delivery";
  it("reverts an existing override + writes a history row", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packet_template_overrides", "delete", {
      data: [{ document_key: KEY }],
    });
    stageSupabaseResponse("patient_packet_template_revisions", "insert", {
      data: null,
    });
    const res = await request(makeApp()).delete(
      `/admin/patient-packet-templates/${KEY}`,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ key: KEY, customized: false });
    const hist = getSupabaseWritePayloads(
      "patient_packet_template_revisions",
      "insert",
    )[0] as Record<string, unknown>;
    expect(hist.action).toBe("reverted");
  });
});

describe("POST /admin/patient-packet-templates/:key/preview", () => {
  const KEY = "proof_of_delivery";
  it("renders resolved sections for the operator", async () => {
    mockAdmin.current = ADMIN;
    // Promise.all: company (mocked) + overrides read.
    stageSupabaseResponse("patient_packet_template_overrides", "select", {
      data: [],
    });
    const res = await request(makeApp())
      .post(`/admin/patient-packet-templates/${KEY}/preview`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.key).toBe(KEY);
    expect(Array.isArray(res.body.sections)).toBe(true);
  });
});

// ── Recent packets list ───────────────────────────────────────────

describe("GET /admin/patient-packets", () => {
  it("returns recent packets", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: [{ id: PACKET, status: "sent", title: "New patient" }],
    });
    const res = await request(makeApp()).get("/admin/patient-packets");
    expect(res.status).toBe(200);
    expect(res.body.packets).toHaveLength(1);
  });

  it("applies the outstanding worklist filter (sent+viewed, oldest first)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", { data: [] });
    const res = await request(makeApp()).get(
      "/admin/patient-packets?status=outstanding",
    );
    expect(res.status).toBe(200);
    const filters = supabaseMock.filterCalls("patient_packets", "select");
    // The outstanding branch uses `.in("status", ["sent","viewed"])`.
    const inFilter = filters.find((f) => f.verb === "in");
    expect(inFilter?.args[1]).toEqual(["sent", "viewed"]);
  });
});

// ── Create + send (patient-scoped) ────────────────────────────────

describe("POST /admin/patients/:id/packets", () => {
  const url = `/admin/patients/${PATIENT}/packets`;

  it("400 unknown_merge_tokens on an override with a bad token", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(url)
      .send({
        documentOverrides: [
          {
            documentKey: "proof_of_delivery",
            sections: [{ paragraphs: ["{{bogus}}"] }],
          },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unknown_merge_tokens");
    expect(createPacketMock).not.toHaveBeenCalled();
  });

  it("happy path: returns the delivery flags the send helper reports", async () => {
    mockAdmin.current = ADMIN;
    createPacketMock.mockResolvedValue({
      ok: true,
      packetId: PACKET,
      documentCount: 3,
      emailSent: true,
      smsSent: false,
      signingLink: "https://cmbreathe.com/patient-packet-sign?token=x",
      matchedPatientId: PATIENT,
    });
    const res = await request(makeApp())
      .post(url)
      .send({ channels: ["email"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: PACKET,
      status: "sent",
      emailSent: true,
      smsSent: false,
    });
    // The route forwards the requested channels to the send helper.
    expect(createPacketMock.mock.calls[0][0].channels).toEqual(["email"]);
  });

  it("404 patient_not_found when the helper reports it", async () => {
    mockAdmin.current = ADMIN;
    createPacketMock.mockResolvedValue({
      ok: false,
      code: "patient_not_found",
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
  });

  it("400 invalid_document_keys when the helper reports it", async () => {
    mockAdmin.current = ADMIN;
    createPacketMock.mockResolvedValue({
      ok: false,
      code: "invalid_document_keys",
      invalidKeys: ["nope"],
    });
    const res = await request(makeApp())
      .post(url)
      .send({ documentKeys: ["nope"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_document_keys");
    expect(res.body.invalidKeys).toEqual(["nope"]);
  });
});

// ── Send to a contact (no patient selected) ───────────────────────

describe("POST /admin/patient-packets (send-to-contact)", () => {
  it("400 when neither email nor phone is supplied", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/patient-packets")
      .send({ recipientName: "Pat" });
    expect(res.status).toBe(400);
  });

  it("happy path: surfaces the chart-match metadata", async () => {
    mockAdmin.current = ADMIN;
    createPacketToContactMock.mockResolvedValue({
      ok: true,
      packetId: PACKET,
      documentCount: 2,
      emailSent: true,
      smsSent: true,
      signingLink: "https://cmbreathe.com/patient-packet-sign?token=y",
      matchedPatientId: PATIENT,
      matchedPatientName: "Jane Doe",
      matchAmbiguous: false,
    });
    const res = await request(makeApp())
      .post("/admin/patient-packets")
      .send({ email: "jane@example.com", channels: ["email", "sms"] });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      matchedPatientId: PATIENT,
      matchedPatientName: "Jane Doe",
      emailSent: true,
      smsSent: true,
    });
  });

  it("400 invalid_phone when the helper rejects the number", async () => {
    mockAdmin.current = ADMIN;
    createPacketToContactMock.mockResolvedValue({
      ok: false,
      code: "invalid_phone",
    });
    const res = await request(makeApp())
      .post("/admin/patient-packets")
      .send({ phone: "bad" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_phone");
  });
});

// ── Edit an open packet (state machine) ───────────────────────────

describe("PATCH /admin/packets/:packetId", () => {
  const url = `/admin/packets/${PACKET}`;

  it("404 when the packet is missing", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", { data: null });
    const res = await request(makeApp()).patch(url).send({ title: "x" });
    expect(res.status).toBe(404);
  });

  it("409 packet_closed when the packet is completed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: { id: PACKET, status: "completed" },
    });
    const res = await request(makeApp()).patch(url).send({ title: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("packet_closed");
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("reconciles documents + applies the scalar patch on an open packet", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: { id: PACKET, status: "sent" },
    });
    stageSupabaseResponse("patient_packets", "update", { data: null });
    const res = await request(makeApp())
      .patch(url)
      .send({ documentKeys: ["proof_of_delivery"], title: "Updated" });
    expect(res.status).toBe(200);
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    const patch = getSupabaseWritePayloads(
      "patient_packets",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.title).toBe("Updated");
  });
});

// ── Resend (link reissue) ─────────────────────────────────────────

describe("POST /admin/packets/:packetId/resend", () => {
  const url = `/admin/packets/${PACKET}/resend`;

  it("409 packet_closed when voided", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: { id: PACKET, status: "voided" },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("packet_closed");
  });

  it("reissues the link, bumps link_version, and redelivers", async () => {
    mockAdmin.current = ADMIN;
    deliverPacketLinkMock.mockResolvedValue({
      emailSent: true,
      smsSent: false,
    });
    stageSupabaseResponse("patient_packets", "select", {
      data: {
        id: PACKET,
        patient_id: PATIENT,
        status: "sent",
        link_version: 1,
        recipient_name: "Jane",
        recipient_email: "jane@example.com",
        recipient_phone: "+12155550123",
        expires_at: null,
      },
    });
    stageSupabaseResponse("patient_packets", "update", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "sent",
      emailSent: true,
      smsSent: false,
    });
    const patch = getSupabaseWritePayloads(
      "patient_packets",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.link_version).toBe(2);
    expect(deliverPacketLinkMock).toHaveBeenCalledTimes(1);
  });
});

// ── Void ──────────────────────────────────────────────────────────

describe("POST /admin/packets/:packetId/void", () => {
  const url = `/admin/packets/${PACKET}/void`;

  it("409 already_completed when the packet is signed", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: { id: PACKET, status: "completed" },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ reason: "duplicate" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_completed");
  });

  it("voids an open packet + invalidates the link", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packets", "select", {
      data: { id: PACKET, status: "sent" },
    });
    stageSupabaseResponse("patient_packets", "update", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ reason: "wrong patient" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("voided");
    const patch = getSupabaseWritePayloads(
      "patient_packets",
      "update",
    )[0] as Record<string, unknown>;
    expect(patch.status).toBe("voided");
    expect(patch.voided_reason).toBe("wrong patient");
    // The link is invalidated by jumping link_version far ahead.
    expect(patch.link_version).toBe(999_999);
  });
});

// ── Presets ───────────────────────────────────────────────────────

describe("packet presets", () => {
  it("POST 400 on an invalid document key", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/patient-packet-presets")
      .send({ name: "Medicare", documentKeys: ["not_a_key"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_document_keys");
  });

  it("POST 409 name_taken on a unique-index violation", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packet_presets", "insert", {
      error: { code: "23505" },
    });
    const res = await request(makeApp())
      .post("/admin/patient-packet-presets")
      .send({
        name: "Medicare new patient",
        documentKeys: ["proof_of_delivery"],
      });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("name_taken");
  });

  it("POST 201 creates a preset (keys folded to catalog order)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packet_presets", "insert", {
      data: { id: PRESET },
    });
    const res = await request(makeApp())
      .post("/admin/patient-packet-presets")
      .send({
        name: "Commercial new patient",
        documentKeys: ["proof_of_delivery"],
      });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PRESET);
  });

  it("DELETE removes a preset", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("patient_packet_presets", "delete", { data: null });
    const res = await request(makeApp()).delete(
      `/admin/patient-packet-presets/${PRESET}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── Signed PDF download ───────────────────────────────────────────

describe("GET /admin/packets/:packetId/pdf", () => {
  const url = `/admin/packets/${PACKET}/pdf`;

  it("404 when the packet/PDF can't be built", async () => {
    mockAdmin.current = ADMIN;
    buildSignedPacketPdfMock.mockResolvedValue(null);
    const res = await request(makeApp()).get(url);
    expect(res.status).toBe(404);
  });

  it("streams the signed PDF with attachment headers", async () => {
    mockAdmin.current = ADMIN;
    buildSignedPacketPdfMock.mockResolvedValue({
      packet: { id: PACKET },
      pdf: Buffer.from("%PDF-1.4 fake"),
    });
    const res = await request(makeApp()).get(url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/pdf");
    expect(res.headers["content-disposition"]).toContain("attachment");
  });
});
