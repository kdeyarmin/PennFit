// Tests for payer-profiles route — migration 0149 additions.
//
// Scope: code added/changed in this PR:
//   - New submission-readiness fields on GET list/detail responses
//   - GET  /admin/payer-profiles/export.csv (new route)
//   - POST /admin/payer-profiles            (new 0149 fields + validation)
//   - PATCH /admin/payer-profiles/:id       (new 0149 fields + verification stamp)
//   - csvCell / renderOfficeAllyCsv helpers (tested via the export endpoint)
//
// Tests verify:
//   1. Auth gates: 401 (unauthenticated), 403 (insufficient role/permission).
//   2. POST / PATCH validation for new fields (claimsState regex, modifier
//      regex, timelyFilingDays bounds, EDI enrollment enum, PA method enum).
//   3. POST paperOnly + electronic-ID guard still works.
//   4. export.csv Content-Type, Content-Disposition, Cache-Control headers.
//   5. export.csv default filter (electronic-only) vs ?includeNonElectronic=true.
//   6. CSV body: header row order, REVIEW sentinels, RFC 4180 escaping.
//   7. PATCH stamps requirements_last_verified_at / _by on every save.
//   8. POST stamps requirements_last_verified_at / _by on create.
//   9. rowToApi maps new 0149 columns into camelCase API shape.

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

// ── Supabase mock (module-scoped) ────────────────────────────────────────────
const supabaseMock = installSupabaseMock();

// ── Auth mock ────────────────────────────────────────────────────────────────
const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// ── adminRateLimit mock ──────────────────────────────────────────────────────
const rateLimitBlocked = vi.hoisted(() => ({ current: false }));
const adminRateLimitSpy = vi.hoisted(() =>
  vi.fn<
    (opts: { name: string; preset?: string }) => (
      req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => void
  >((opts) => (_req, res, next) => {
    if (rateLimitBlocked.current) {
      res.status(429).json({
        error: "too_many_requests",
        limiter: opts.name,
        retryAfterSeconds: 3600,
      });
      return;
    }
    next();
  }),
);
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: adminRateLimitSpy,
}));

// ── Audit mock ───────────────────────────────────────────────────────────────
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => undefined),
}));

import payerProfilesRouter from "./payer-profiles";

// ── UUIDs ────────────────────────────────────────────────────────────────────
const PAYER_UUID = "aaaaaaaa-1111-4000-8000-000000000001";

// ── App factory ──────────────────────────────────────────────────────────────
function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(payerProfilesRouter);
  return app;
}

// ── Auth helpers ─────────────────────────────────────────────────────────────
function stubAdmin() {
  mockAdmin.current = {
    userId: "u_admin_1",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

function stubAgent() {
  mockAdmin.current = {
    userId: "u_agent_1",
    email: "agent@penn.example.com",
    role: "agent",
  };
}

// ── Minimal row fixture (all 0149 columns) ────────────────────────────────────
function makePayerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PAYER_UUID,
    slug: "aetna_pa",
    display_name: "Aetna (PA Commercial)",
    payer_legal_name: "Aetna Life Insurance Company",
    parent_org: "CVS Health",
    line_of_business: "commercial",
    region: "pa",
    office_ally_payer_id: "60054",
    edi_5010_payer_id: "60054",
    claim_format: "837p",
    paper_only: false,
    requires_prior_auth_dme: true,
    prior_auth_phone_e164: "+18005551234",
    claim_status_phone_e164: "+18005559876",
    provider_portal_url: "https://example.com",
    fee_schedule_source: "cms_published",
    notes: null,
    is_active: true,
    // 0149 columns
    timely_filing_days: 180,
    claims_address_line1: "PO Box 981106",
    claims_address_line2: null,
    claims_city: "El Paso",
    claims_state: "TX",
    claims_zip: "79998",
    claims_phone_e164: "+18005559876",
    claims_fax_e164: null,
    prior_auth_submission_method: "portal",
    prior_auth_fax_e164: null,
    prior_auth_turnaround_business_days: 14,
    required_claim_modifiers: ["KX"],
    accepts_electronic_secondary: true,
    edi_enrollment_status: "enrolled",
    member_id_format_hint: "9-digit",
    requirements_last_verified_at: "2026-05-22T00:00:00Z",
    requirements_last_verified_by: "ops@penn.example.com",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

// ── Minimal valid POST body ───────────────────────────────────────────────────
const VALID_CREATE_BODY = {
  slug: "test_payer_2026",
  displayName: "Test Payer 2026",
  payerLegalName: "Test Payer Inc.",
  lineOfBusiness: "commercial",
  region: "pa",
  claimFormat: "837p",
  isActive: true,
};

beforeEach(() => {
  mockAdmin.current = null;
  rateLimitBlocked.current = false;
  supabaseMock.reset();
});

// ── GET /admin/payer-profiles — list with 0149 fields ────────────────────────

describe("GET /admin/payer-profiles — 0149 response shape", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get("/admin/payer-profiles");
    expect(res.status).toBe(401);
  });

  it("returns payerProfiles array including all 0149 fields", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow()],
    });

    const res = await request(makeApp()).get("/admin/payer-profiles");

    expect(res.status).toBe(200);
    const p = res.body.payerProfiles[0];
    expect(p.timelyFilingDays).toBe(180);
    expect(p.claimsAddressLine1).toBe("PO Box 981106");
    expect(p.claimsCity).toBe("El Paso");
    expect(p.claimsState).toBe("TX");
    expect(p.claimsZip).toBe("79998");
    expect(p.priorAuthSubmissionMethod).toBe("portal");
    expect(p.requiredClaimModifiers).toEqual(["KX"]);
    expect(p.acceptsElectronicSecondary).toBe(true);
    expect(p.ediEnrollmentStatus).toBe("enrolled");
    expect(p.memberIdFormatHint).toBe("9-digit");
    expect(p.requirementsLastVerifiedAt).toBe("2026-05-22T00:00:00Z");
    expect(p.requirementsLastVerifiedBy).toBe("ops@penn.example.com");
  });

  it("coerces null required_claim_modifiers to empty array", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ required_claim_modifiers: null })],
    });

    const res = await request(makeApp()).get("/admin/payer-profiles");
    expect(res.body.payerProfiles[0].requiredClaimModifiers).toEqual([]);
  });
});

// ── GET /admin/payer-profiles/export.csv ─────────────────────────────────────

describe("GET /admin/payer-profiles/export.csv", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (no reports.read permission)", async () => {
    stubAgent();
    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with Content-Type text/csv for admin", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
  });

  it("sets Content-Disposition attachment header", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.headers["content-disposition"]).toMatch(/attachment/);
    expect(res.headers["content-disposition"]).toMatch(
      /pa-payer-profiles-\d{4}-\d{2}-\d{2}\.csv/,
    );
  });

  it("sets Cache-Control: no-store", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("returns CSV with correct header row as first line", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    const lines = res.text.split("\r\n");
    const headers = lines[0]!.split(",");
    expect(headers[0]).toBe("OA Payer ID");
    expect(headers[1]).toBe("EDI 5010 ID");
    expect(headers[2]).toBe("Display Name");
    expect(headers[3]).toBe("Payer Legal Name");
    // CSV has exactly 32 columns per the diff
    expect(headers.length).toBe(32);
  });

  it("renders a data row with all 0149 fields", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow()],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    const lines = res.text.split("\r\n").filter(Boolean);
    // lines[0] = header, lines[1] = first data row
    expect(lines.length).toBe(2);
    const row = lines[1]!;
    // OA Payer ID
    expect(row).toContain("60054");
    // Display Name
    expect(row).toContain("Aetna (PA Commercial)");
    // EDI Enrollment Status
    expect(row).toContain("enrolled");
    // Timely Filing Days
    expect(row).toContain("180");
    // Required modifiers — arrays are pipe-joined
    expect(row).toContain("KX");
  });

  it("uses REVIEW sentinel for null timelyFilingDays", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ timely_filing_days: null })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.text).toContain("REVIEW");
  });

  it("uses REVIEW sentinel for null priorAuthSubmissionMethod", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ prior_auth_submission_method: null })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.text).toContain("REVIEW");
  });

  it("renders empty cell for null fields (not the word null)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ claims_fax_e164: null, member_id_format_hint: null })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    // null fields must become empty string cells, never the literal "null"
    expect(res.text).not.toContain(",null,");
    expect(res.text).not.toContain(",null\r\n");
  });

  it("wraps field in quotes when it contains a comma", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ payer_legal_name: "Smith, Jones & Co." })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.text).toContain('"Smith, Jones & Co."');
  });

  it("doubles embedded quotes per RFC 4180", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ notes: 'Payer says "pre-auth required"' })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    // The quote should be doubled: "" inside surrounding quotes
    expect(res.text).toContain('""pre-auth required""');
  });

  it("ends with CRLF per RFC 4180", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.text.endsWith("\r\n")).toBe(true);
  });

  it("renders yes/no for boolean fields (acceptsElectronicSecondary)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: [makePayerRow({ accepts_electronic_secondary: false })],
    });

    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    // The header is "Accepts Electronic Secondary" (col index 9, 0-based)
    // and the value should be "no"
    const dataLine = res.text.split("\r\n")[1]!;
    const cells = dataLine.split(",");
    // col 9 = accepts_electronic_secondary
    expect(cells[9]).toBe("no");
  });

  it("default query excludes paper_only rows (electronic-only filter)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    await request(makeApp()).get("/admin/payer-profiles/export.csv");

    const filters = supabaseMock.filterCalls("payer_profiles", "select");
    const eqFilters = filters.filter((f) => f.verb === "eq");
    const notFilters = filters.filter((f) => f.verb === "not");

    // Should have eq("paper_only", false) and not("office_ally_payer_id", "is", null)
    const paperOnlyFilter = eqFilters.find((f) => f.args[0] === "paper_only");
    expect(paperOnlyFilter).toBeDefined();
    expect(paperOnlyFilter!.args[1]).toBe(false);

    const oaIdFilter = notFilters.find((f) => f.args[0] === "office_ally_payer_id");
    expect(oaIdFilter).toBeDefined();
  });

  it("?includeNonElectronic=true bypasses electronic-only filter", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    await request(makeApp()).get(
      "/admin/payer-profiles/export.csv?includeNonElectronic=true",
    );

    const filters = supabaseMock.filterCalls("payer_profiles", "select");
    const paperOnlyFilter = filters.find((f) => f.verb === "eq" && f.args[0] === "paper_only");
    // Should NOT have a paper_only filter when includeNonElectronic=true
    expect(paperOnlyFilter).toBeUndefined();
  });

  it("always filters is_active=true", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: [] });

    await request(makeApp()).get("/admin/payer-profiles/export.csv");

    const filters = supabaseMock.filterCalls("payer_profiles", "select");
    const activeFilter = filters.find(
      (f) => f.verb === "eq" && f.args[0] === "is_active",
    );
    expect(activeFilter).toBeDefined();
    expect(activeFilter!.args[1]).toBe(true);
  });

  it("returns 500 on database error", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: null,
      error: { message: "db failure" },
    });

    // The route throws on error; Express default error handler sends 500
    const res = await request(makeApp()).get(
      "/admin/payer-profiles/export.csv",
    );
    expect(res.status).toBe(500);
  });
});

// ── GET /admin/payer-profiles/:id — detail ───────────────────────────────────

describe("GET /admin/payer-profiles/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp()).get(
      `/admin/payer-profiles/${PAYER_UUID}`,
    );
    expect(res.status).toBe(401);
  });

  it("returns 404 for non-UUID id", async () => {
    stubAdmin();
    const res = await request(makeApp()).get(
      "/admin/payer-profiles/not-a-uuid",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 404 when payer not found", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", { data: null });

    const res = await request(makeApp()).get(
      `/admin/payer-profiles/${PAYER_UUID}`,
    );
    expect(res.status).toBe(404);
  });

  it("returns 200 with all 0149 fields in the payerProfile object", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "select", {
      data: makePayerRow(),
    });

    const res = await request(makeApp()).get(
      `/admin/payer-profiles/${PAYER_UUID}`,
    );
    expect(res.status).toBe(200);
    const p = res.body.payerProfile;
    expect(p.id).toBe(PAYER_UUID);
    expect(p.slug).toBe("aetna_pa");
    expect(p.timelyFilingDays).toBe(180);
    expect(p.claimsAddressLine1).toBe("PO Box 981106");
    expect(p.claimsCity).toBe("El Paso");
    expect(p.claimsState).toBe("TX");
    expect(p.claimsZip).toBe("79998");
    expect(p.claimsPhoneE164).toBe("+18005559876");
    expect(p.priorAuthSubmissionMethod).toBe("portal");
    expect(p.priorAuthTurnaroundBusinessDays).toBe(14);
    expect(p.requiredClaimModifiers).toEqual(["KX"]);
    expect(p.acceptsElectronicSecondary).toBe(true);
    expect(p.ediEnrollmentStatus).toBe("enrolled");
    expect(p.memberIdFormatHint).toBe("9-digit");
    expect(p.requirementsLastVerifiedAt).toBe("2026-05-22T00:00:00Z");
    expect(p.requirementsLastVerifiedBy).toBe("ops@penn.example.com");
  });
});

// ── POST /admin/payer-profiles ───────────────────────────────────────────────

describe("POST /admin/payer-profiles", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe("payer_profiles.create");
  });

  it("calls adminRateLimit with name='payer_profiles.create' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_profiles.create",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("sensitive");
  });

  it("returns 201 with id on valid create", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(PAYER_UUID);
  });

  it("creates with all new 0149 fields in the insert payload", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    await request(makeApp())
      .post("/admin/payer-profiles")
      .send({
        ...VALID_CREATE_BODY,
        timelyFilingDays: 365,
        claimsAddressLine1: "PO Box 999",
        claimsAddressLine2: "Suite 100",
        claimsCity: "Harrisburg",
        claimsState: "PA",
        claimsZip: "17111",
        claimsPhoneE164: "+15551234567",
        claimsFaxE164: "+15559876543",
        priorAuthSubmissionMethod: "portal",
        priorAuthFaxE164: "+15550001111",
        priorAuthTurnaroundBusinessDays: 7,
        requiredClaimModifiers: ["KX"],
        acceptsElectronicSecondary: true,
        ediEnrollmentStatus: "enrolled",
        memberIdFormatHint: "9-digit member ID",
      });

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    expect(payloads).toHaveLength(1);
    const inserted = payloads[0] as Record<string, unknown>;
    expect(inserted["timely_filing_days"]).toBe(365);
    expect(inserted["claims_address_line1"]).toBe("PO Box 999");
    expect(inserted["claims_city"]).toBe("Harrisburg");
    expect(inserted["claims_state"]).toBe("PA");
    expect(inserted["prior_auth_submission_method"]).toBe("portal");
    expect(inserted["required_claim_modifiers"]).toEqual(["KX"]);
    expect(inserted["accepts_electronic_secondary"]).toBe(true);
    expect(inserted["edi_enrollment_status"]).toBe("enrolled");
    expect(inserted["member_id_format_hint"]).toBe("9-digit member ID");
  });

  it("stamps requirements_last_verified_at on create", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    const before = new Date().toISOString();
    await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);
    const after = new Date().toISOString();

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    const inserted = payloads[0] as Record<string, unknown>;
    const stamp = inserted["requirements_last_verified_at"] as string;
    expect(stamp >= before).toBe(true);
    expect(stamp <= after).toBe(true);
  });

  it("stamps requirements_last_verified_by with adminEmail on create", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    const inserted = payloads[0] as Record<string, unknown>;
    expect(inserted["requirements_last_verified_by"]).toBe(
      "ops@penn.example.com",
    );
  });

  it("returns 409 on slug conflict (Postgres error 23505)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    });

    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("slug_conflict");
  });

  it("returns 400 for missing required fields", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ slug: "x" }); // missing displayName, payerLegalName, lineOfBusiness
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid slug (uppercase letters)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, slug: "INVALID_SLUG" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid slug (spaces)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, slug: "has space" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when paperOnly=true with officeAllyPayerId set", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({
        ...VALID_CREATE_BODY,
        paperOnly: true,
        officeAllyPayerId: "12345",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(res.body.issues[0].path).toBe("paperOnly");
  });

  it("returns 400 when paperOnly=true with edi5010PayerId set", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({
        ...VALID_CREATE_BODY,
        paperOnly: true,
        edi5010PayerId: "ABC12",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  // ── New 0149 field validation ──────────────────────────────────────────────

  it("returns 400 when timelyFilingDays is below minimum (29)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, timelyFilingDays: 29 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when timelyFilingDays is above maximum (1826)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, timelyFilingDays: 1826 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts timelyFilingDays at boundary minimum (30)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, timelyFilingDays: 30 });
    expect(res.status).toBe(201);
  });

  it("accepts timelyFilingDays at boundary maximum (1825)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, timelyFilingDays: 1825 });
    expect(res.status).toBe(201);
  });

  it("returns 400 when claimsState is not a 2-letter uppercase code", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, claimsState: "Pennsylvania" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when claimsState is lowercase", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, claimsState: "pa" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts a valid 2-letter uppercase claimsState", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, claimsState: "PA" });
    expect(res.status).toBe(201);
  });

  it("returns 400 when requiredClaimModifiers contains a 3-char modifier", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, requiredClaimModifiers: ["KXX"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 when requiredClaimModifiers contains a 1-char modifier", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, requiredClaimModifiers: ["K"] });
    expect(res.status).toBe(400);
  });

  it("accepts valid 2-char alphanumeric modifiers", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, requiredClaimModifiers: ["KX", "GA"] });
    expect(res.status).toBe(201);
  });

  it("returns 400 for invalid priorAuthSubmissionMethod value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, priorAuthSubmissionMethod: "telegram" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts all valid priorAuthSubmissionMethod values", async () => {
    const validMethods = ["portal", "fax", "phone", "electronic_278", "paper", "none"];
    for (const method of validMethods) {
      stubAdmin();
      stageSupabaseResponse("payer_profiles", "insert", {
        data: { id: PAYER_UUID },
      });
      const res = await request(makeApp())
        .post("/admin/payer-profiles")
        .send({ ...VALID_CREATE_BODY, priorAuthSubmissionMethod: method });
      expect(res.status).toBe(201);
    }
  });

  it("returns 400 for invalid ediEnrollmentStatus value", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, ediEnrollmentStatus: "yes" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts all valid ediEnrollmentStatus values", async () => {
    const validStatuses = ["enrolled", "pending", "not_enrolled", "not_applicable"];
    for (const status of validStatuses) {
      stubAdmin();
      stageSupabaseResponse("payer_profiles", "insert", {
        data: { id: PAYER_UUID },
      });
      const res = await request(makeApp())
        .post("/admin/payer-profiles")
        .send({ ...VALID_CREATE_BODY, ediEnrollmentStatus: status });
      expect(res.status).toBe(201);
    }
  });

  it("returns 400 when priorAuthTurnaroundBusinessDays exceeds 180", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, priorAuthTurnaroundBusinessDays: 181 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("accepts priorAuthTurnaroundBusinessDays at boundary (180)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, priorAuthTurnaroundBusinessDays: 180 });
    expect(res.status).toBe(201);
  });

  it("returns 400 for extra unknown fields (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/payer-profiles")
      .send({ ...VALID_CREATE_BODY, unknownField: "value" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("sets edi_enrollment_status default to not_applicable when omitted", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY); // no ediEnrollmentStatus

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    const inserted = payloads[0] as Record<string, unknown>;
    expect(inserted["edi_enrollment_status"]).toBe("not_applicable");
  });

  it("sets required_claim_modifiers default to [] when omitted", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    const inserted = payloads[0] as Record<string, unknown>;
    expect(inserted["required_claim_modifiers"]).toEqual([]);
  });

  it("sets accepts_electronic_secondary default to true when omitted", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "insert", {
      data: { id: PAYER_UUID },
    });

    await request(makeApp())
      .post("/admin/payer-profiles")
      .send(VALID_CREATE_BODY);

    const payloads = supabaseMock.writePayloads("payer_profiles", "insert");
    const inserted = payloads[0] as Record<string, unknown>;
    expect(inserted["accepts_electronic_secondary"]).toBe(true);
  });
});

// ── PATCH /admin/payer-profiles/:id ─────────────────────────────────────────

describe("PATCH /admin/payer-profiles/:id", () => {
  it("returns 401 when unauthenticated", async () => {
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(401);
  });

  it("returns 403 when agent (requireAdminOnly blocks)", async () => {
    stubAgent();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ isActive: false });
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limited", async () => {
    stubAdmin();
    rateLimitBlocked.current = true;
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ displayName: "New Name" });
    expect(res.status).toBe(429);
    expect(res.body.limiter).toBe("payer_profiles.update");
  });

  it("calls adminRateLimit with name='payer_profiles.update' and preset='sensitive'", () => {
    const call = adminRateLimitSpy.mock.calls.find(
      ([opts]) => opts.name === "payer_profiles.update",
    );
    expect(call).toBeDefined();
    expect(call![0].preset).toBe("sensitive");
  });

  it("returns 404 for non-UUID id", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch("/admin/payer-profiles/not-a-uuid")
      .send({ displayName: "X" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("returns 200 { ok: true } on successful patch", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ displayName: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("writes new 0149 fields into the update payload", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({
        timelyFilingDays: 90,
        claimsAddressLine1: "New Address",
        claimsState: "PA",
        requiredClaimModifiers: ["KX", "GA"],
        ediEnrollmentStatus: "enrolled",
        priorAuthSubmissionMethod: "fax",
      });

    const payloads = supabaseMock.writePayloads("payer_profiles", "update");
    const updated = payloads[0] as Record<string, unknown>;
    expect(updated["timely_filing_days"]).toBe(90);
    expect(updated["claims_address_line1"]).toBe("New Address");
    expect(updated["claims_state"]).toBe("PA");
    expect(updated["required_claim_modifiers"]).toEqual(["KX", "GA"]);
    expect(updated["edi_enrollment_status"]).toBe("enrolled");
    expect(updated["prior_auth_submission_method"]).toBe("fax");
  });

  it("always stamps requirements_last_verified_at on patch", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    const before = new Date().toISOString();
    await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ isActive: false });
    const after = new Date().toISOString();

    const payloads = supabaseMock.writePayloads("payer_profiles", "update");
    const updated = payloads[0] as Record<string, unknown>;
    const stamp = updated["requirements_last_verified_at"] as string;
    expect(stamp >= before).toBe(true);
    expect(stamp <= after).toBe(true);
  });

  it("always stamps requirements_last_verified_by with adminEmail on patch", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ notes: "Updated note" });

    const payloads = supabaseMock.writePayloads("payer_profiles", "update");
    const updated = payloads[0] as Record<string, unknown>;
    expect(updated["requirements_last_verified_by"]).toBe(
      "ops@penn.example.com",
    );
  });

  it("does not include fields that are absent from the patch body", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    // Only patch displayName — claimsState should NOT appear in update payload
    await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ displayName: "Renamed Payer" });

    const payloads = supabaseMock.writePayloads("payer_profiles", "update");
    const updated = payloads[0] as Record<string, unknown>;
    expect("claims_state" in updated).toBe(false);
    expect("timely_filing_days" in updated).toBe(false);
    expect("required_claim_modifiers" in updated).toBe(false);
  });

  it("returns 400 for invalid timelyFilingDays on patch", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ timelyFilingDays: 15 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid claimsState on patch (1 letter)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ claimsState: "P" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid modifier on patch", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ requiredClaimModifiers: ["KXZ"] }); // 3 chars
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for invalid ediEnrollmentStatus on patch", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ ediEnrollmentStatus: "unknown" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("returns 400 for extra unknown fields on patch (strict schema)", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({ unknownExtraField: "value" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("allows an empty patch body (only stamps updated_at and verification)", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    const res = await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("can null out optional 0149 fields via patch", async () => {
    stubAdmin();
    stageSupabaseResponse("payer_profiles", "update", { data: null });

    await request(makeApp())
      .patch(`/admin/payer-profiles/${PAYER_UUID}`)
      .send({
        claimsAddressLine1: null,
        priorAuthSubmissionMethod: null,
        timelyFilingDays: null,
      });

    const payloads = supabaseMock.writePayloads("payer_profiles", "update");
    const updated = payloads[0] as Record<string, unknown>;
    expect(updated["claims_address_line1"]).toBeNull();
    expect(updated["prior_auth_submission_method"]).toBeNull();
    expect(updated["timely_filing_days"]).toBeNull();
  });
});
