// Route tests for the AI claim-intelligence endpoints
// (routes/patients/insurance-claims-ai.ts).
//
// Coverage focus (per docs/remaining-gaps-2026-06-22.md §5): the
// happy path for each LLM-backed action and the provider-offline /
// error fallbacks. The LLM brains (scrubClaim / analyzeDenial), the
// patch applier, the heuristic scorer, and the Office Ally adapter are
// all mocked at the module boundary so the route's own contract —
// claim scoping, state guards, persistence, denormalisation, the
// double-apply guards, and the audit metadata — is what's exercised.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  MOCK_ORG_ID,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
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

// LLM brains + helpers — mock the module boundary so no network/key is
// needed and each test drives the output shape it wants.
const { scrubClaimMock, analyzeDenialMock, applyAiPatchesMock, scoreMock } =
  vi.hoisted(() => ({
    scrubClaimMock: vi.fn(),
    analyzeDenialMock: vi.fn(),
    applyAiPatchesMock: vi.fn(),
    scoreMock: vi.fn(async () => undefined),
  }));

vi.mock("../../lib/billing/ai-claim-scrubber", () => ({
  SCRUB_PROMPT_VERSION: "scrub-1.0",
  scrubClaim: scrubClaimMock,
}));
vi.mock("../../lib/billing/ai-denial-analyzer", () => ({
  DENIAL_PROMPT_VERSION: "denial-1.0",
  analyzeDenial: analyzeDenialMock,
}));
vi.mock("../../lib/billing/ai-patch", () => ({
  applyAiPatches: applyAiPatchesMock,
}));
vi.mock("../../lib/billing/heuristic-denial-scorer", () => ({
  scoreAndPersist: scoreMock,
}));

const { submitClaimsMock } = vi.hoisted(() => ({
  submitClaimsMock: vi.fn(),
}));
vi.mock("@workspace/resupply-integrations-office-ally", () => ({
  allocateControlNumbers: vi.fn(() => ({
    interchangeControlNumber: "000000123",
    groupControlNumber: "123",
  })),
  createOfficeAllyAdapter: vi.fn(() => ({
    submitClaims: submitClaimsMock,
  })),
}));

import aiRouter from "./insurance-claims-ai";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};
const AGENT: MockAdminCtx = {
  userId: "u_agent",
  email: "csr@penn.example.com",
  role: "agent",
};

const PATIENT = "11111111-1111-4111-8111-111111111111";
const CLAIM = "22222222-2222-4222-8222-222222222222";
const SCRUB = "33333333-3333-4333-8333-333333333333";
const ANALYSIS = "44444444-4444-4444-8444-444444444444";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(aiRouter);
  return app;
}

function scrubOutput(over: Record<string, unknown> = {}) {
  return {
    verdict: "fixable",
    summary: "Two fixable findings.",
    confidence: 0.7,
    findings: [{ field: "modifier", issue: "missing" }],
    suggestedPatches: [{ op: "set_modifier", value: "KX" }],
    droppedPatches: [],
    latencyMs: 1200,
    promptTokens: 100,
    completionTokens: 40,
    errorMessage: null,
    ...over,
  };
}

function denialOutput(over: Record<string, unknown> = {}) {
  return {
    recommendation: "auto_resubmit",
    confidence: 0.85,
    rootCauseSummary: "Missing KX modifier.",
    mappedCodes: [{ code: "CO-16", meaning: "missing info" }],
    fixSteps: [{ step: "add KX" }],
    appealLetterSketch: null,
    suggestedPatches: [{ op: "set_modifier", value: "KX" }],
    droppedPatches: [],
    canAutoResubmit: true,
    latencyMs: 1500,
    promptTokens: 120,
    completionTokens: 60,
    errorMessage: null,
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  scrubClaimMock.mockReset();
  analyzeDenialMock.mockReset();
  applyAiPatchesMock.mockReset();
  scoreMock.mockReset();
  scoreMock.mockResolvedValue(undefined);
  submitClaimsMock.mockReset();
});

describe("POST /patients/:id/insurance-claims/:claimId/ai-scrub", () => {
  const url = `/patients/${PATIENT}/insurance-claims/${CLAIM}/ai-scrub`;

  it("401 unauthenticated", async () => {
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(401);
  });

  it("404 when the claim is not found / not scoped to the patient", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
    expect(scrubClaimMock).not.toHaveBeenCalled();
  });

  it("happy path: persists a scrub row + denormalises onto the claim", async () => {
    mockAdmin.current = ADMIN;
    scrubClaimMock.mockResolvedValue(scrubOutput());
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "draft" },
    });
    stageSupabaseResponse("claim_scrub_results", "insert", {
      data: { id: SCRUB },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      scrubResultId: SCRUB,
      verdict: "fixable",
      confidence: 0.7,
    });
    // The persisted row carries the model + prompt version.
    const inserted = getSupabaseWritePayloads(
      "claim_scrub_results",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.claim_id).toBe(CLAIM);
    expect(inserted.prompt_version).toBe("scrub-1.0");
    expect(inserted.verdict).toBe("fixable");
    // The denormalisation update fires.
    const denorm = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    )[0] as Record<string, unknown>;
    expect(denorm.latest_scrub_verdict).toBe("fixable");
    expect(denorm.latest_scrub_result_id).toBe(SCRUB);
    // The cheap heuristic scorer is kicked off (fire-and-forget).
    expect(scoreMock).toHaveBeenCalledWith(CLAIM);
  });

  it("provider-offline: persists the errored verdict the brain returns", async () => {
    mockAdmin.current = ADMIN;
    scrubClaimMock.mockResolvedValue(
      scrubOutput({
        verdict: "errored",
        summary: "AI scrub unavailable (OPENAI_API_KEY not set).",
        confidence: null,
        findings: [],
        suggestedPatches: [],
        errorMessage: "OPENAI_API_KEY not configured",
      }),
    );
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "draft" },
    });
    stageSupabaseResponse("claim_scrub_results", "insert", {
      data: { id: SCRUB },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp()).post(url).send({});
    // Offline still 201s (graceful degrade) with the errored verdict.
    expect(res.status).toBe(201);
    expect(res.body.verdict).toBe("errored");
    const inserted = getSupabaseWritePayloads(
      "claim_scrub_results",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.error_message).toBe("OPENAI_API_KEY not configured");
  });

  it("still 201s when the non-blocking heuristic scorer rejects", async () => {
    mockAdmin.current = ADMIN;
    scoreMock.mockRejectedValue(new Error("scorer down"));
    scrubClaimMock.mockResolvedValue(scrubOutput());
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "draft" },
    });
    stageSupabaseResponse("claim_scrub_results", "insert", {
      data: { id: SCRUB },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(201);
  });
});

describe("POST /patients/:id/insurance-claims/:claimId/ai-scrub/apply", () => {
  const url = `/patients/${PATIENT}/insurance-claims/${CLAIM}/ai-scrub/apply`;

  it("403 for an agent (admin-only mutation)", async () => {
    mockAdmin.current = AGENT;
    const res = await request(makeApp())
      .post(url)
      .send({ scrubResultId: SCRUB });
    expect(res.status).toBe(403);
  });

  it("400 on an invalid body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post(url).send({ scrubResultId: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("404 when the scrub row is not found / not scoped to the claim", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_scrub_results", "select", { data: null });
    const res = await request(makeApp())
      .post(url)
      .send({ scrubResultId: SCRUB });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("scrub_not_found");
  });

  it("409 when the scrub was already applied (double-apply guard)", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("claim_scrub_results", "select", {
      data: {
        id: SCRUB,
        claim_id: CLAIM,
        suggested_patches_json: [],
        review_status: "auto_applied",
        applied_at: "2026-06-01T00:00:00Z",
      },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ scrubResultId: SCRUB });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_applied");
    expect(applyAiPatchesMock).not.toHaveBeenCalled();
  });

  it("happy path: applies all patches + stamps the scrub row", async () => {
    mockAdmin.current = ADMIN;
    applyAiPatchesMock.mockResolvedValue([
      { status: "applied" },
      { status: "skipped" },
    ]);
    stageSupabaseResponse("claim_scrub_results", "select", {
      data: {
        id: SCRUB,
        claim_id: CLAIM,
        suggested_patches_json: [
          { op: "set_modifier", value: "KX" },
          { op: "noop" },
        ],
        review_status: "pending",
        applied_at: null,
      },
    });
    stageSupabaseResponse("claim_scrub_results", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ scrubResultId: SCRUB });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.outcomes).toHaveLength(2);
    // Default = all indexes applied.
    expect(applyAiPatchesMock).toHaveBeenCalledWith(MOCK_ORG_ID, CLAIM, [
      { op: "set_modifier", value: "KX" },
      { op: "noop" },
    ]);
    const stamp = getSupabaseWritePayloads(
      "claim_scrub_results",
      "update",
    )[0] as Record<string, unknown>;
    expect(stamp.review_status).toBe("auto_applied");
    expect(stamp.applied_at).toBeTruthy();
  });

  it("applies only the requested patch indexes", async () => {
    mockAdmin.current = ADMIN;
    applyAiPatchesMock.mockResolvedValue([{ status: "applied" }]);
    stageSupabaseResponse("claim_scrub_results", "select", {
      data: {
        id: SCRUB,
        claim_id: CLAIM,
        suggested_patches_json: [{ op: "a" }, { op: "b" }, { op: "c" }],
        review_status: "pending",
        applied_at: null,
      },
    });
    stageSupabaseResponse("claim_scrub_results", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });

    await request(makeApp())
      .post(url)
      .send({ scrubResultId: SCRUB, patchIndexes: [2] });
    expect(applyAiPatchesMock).toHaveBeenCalledWith(MOCK_ORG_ID, CLAIM, [
      { op: "c" },
    ]);
  });
});

describe("POST /patients/:id/insurance-claims/:claimId/ai-denial-analysis", () => {
  const url = `/patients/${PATIENT}/insurance-claims/${CLAIM}/ai-denial-analysis`;

  it("409 when the claim is not denied", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "draft" },
    });
    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_state");
    expect(analyzeDenialMock).not.toHaveBeenCalled();
  });

  it("happy path: persists the analysis + points the claim at it", async () => {
    mockAdmin.current = ADMIN;
    analyzeDenialMock.mockResolvedValue(denialOutput());
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "denied" },
    });
    stageSupabaseResponse("claim_denial_analyses", "insert", {
      data: { id: ANALYSIS },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      analysisId: ANALYSIS,
      recommendation: "auto_resubmit",
      canAutoResubmit: true,
    });
    const inserted = getSupabaseWritePayloads(
      "claim_denial_analyses",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.review_status).toBe("pending");
    expect(inserted.can_auto_resubmit).toBe(true);
    const pointer = getSupabaseWritePayloads(
      "insurance_claims",
      "update",
    )[0] as Record<string, unknown>;
    expect(pointer.latest_denial_analysis_id).toBe(ANALYSIS);
  });

  it("provider-offline: persists review_status='errored'", async () => {
    mockAdmin.current = ADMIN;
    analyzeDenialMock.mockResolvedValue(
      denialOutput({
        recommendation: "manual_review",
        canAutoResubmit: false,
        suggestedPatches: [],
        mappedCodes: [],
        errorMessage: "AI denial analysis failed: network",
      }),
    );
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, status: "denied" },
    });
    stageSupabaseResponse("claim_denial_analyses", "insert", {
      data: { id: ANALYSIS },
    });
    stageSupabaseResponse("insurance_claims", "update", { data: null });

    const res = await request(makeApp()).post(url).send({});
    expect(res.status).toBe(201);
    const inserted = getSupabaseWritePayloads(
      "claim_denial_analyses",
      "insert",
    )[0] as Record<string, unknown>;
    expect(inserted.review_status).toBe("errored");
    expect(inserted.can_auto_resubmit).toBe(false);
  });
});

describe("auto-fix-and-resubmit", () => {
  const url = `/patients/${PATIENT}/insurance-claims/${CLAIM}/ai-denial-analysis/auto-fix-and-resubmit`;

  it("403 for an agent (admin-only)", async () => {
    mockAdmin.current = AGENT;
    const res = await request(makeApp())
      .post(url)
      .send({ analysisId: ANALYSIS });
    expect(res.status).toBe(403);
  });

  it("409 auto_resubmit_not_safe when the analysis is not auto-safe", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, patient_id: PATIENT, status: "denied" },
    });
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: {
        id: ANALYSIS,
        recommendation: "manual_review",
        can_auto_resubmit: false,
        suggested_patches_json: [],
        applied_at: null,
      },
    });
    const res = await request(makeApp())
      .post(url)
      .send({ analysisId: ANALYSIS });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("auto_resubmit_not_safe");
    expect(applyAiPatchesMock).not.toHaveBeenCalled();
  });

  it("409 no_patches_applied + stamps rejected when nothing lands", async () => {
    mockAdmin.current = ADMIN;
    applyAiPatchesMock.mockResolvedValue([{ status: "skipped" }]);
    stageSupabaseResponse("insurance_claims", "select", {
      data: { id: CLAIM, patient_id: PATIENT, status: "denied" },
    });
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: {
        id: ANALYSIS,
        recommendation: "auto_resubmit",
        can_auto_resubmit: true,
        suggested_patches_json: [{ op: "x" }],
        applied_at: null,
      },
    });
    stageSupabaseResponse("claim_denial_analyses", "update", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ analysisId: ANALYSIS });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_patches_applied");
    const stamp = getSupabaseWritePayloads(
      "claim_denial_analyses",
      "update",
    )[0] as Record<string, unknown>;
    expect(stamp.review_status).toBe("rejected");
    // No Office Ally submission attempted.
    expect(submitClaimsMock).not.toHaveBeenCalled();
  });

  it("happy path: clones a draft, submits to OA, closes the prior claim", async () => {
    mockAdmin.current = ADMIN;
    applyAiPatchesMock.mockResolvedValue([{ status: "applied" }]);
    submitClaimsMock.mockResolvedValue({
      interchangeControlNumber: "000000123",
      groupControlNumber: "123",
      fileSizeBytes: 2048,
      claimCount: 1,
      transport: "file",
      upload: { ok: true, message: "ok" },
    });

    // 1) load the denied claim
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: CLAIM,
        patient_id: PATIENT,
        status: "denied",
        payer_name: "Acme",
        payer_profile_id: "pp-1",
        date_of_service: "2026-05-01",
        total_billed_cents: 10000,
        insurance_coverage_id: "cov-1",
      },
    });
    // 2) load the analysis
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: {
        id: ANALYSIS,
        recommendation: "auto_resubmit",
        can_auto_resubmit: true,
        suggested_patches_json: [{ op: "x" }],
        applied_at: null,
      },
    });
    // 3) cloneAsDraft: read source claim
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        patient_id: PATIENT,
        insurance_coverage_id: "cov-1",
        secondary_coverage_id: null,
        payer_name: "Acme",
        date_of_service: "2026-05-01",
        fulfillment_id: "ful-1",
        payer_profile_id: "pp-1",
        referring_provider_id: null,
        rendering_provider_id: null,
        notes: "n",
      },
    });
    // 4) cloneAsDraft: insert the new claim
    stageSupabaseResponse("insurance_claims", "insert", {
      data: { id: "new-claim-1" },
    });
    // 5) cloneAsDraft: read source line items
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "KX",
          description: "CPAP",
          quantity: 1,
          billed_cents: 10000,
        },
      ],
    });
    // 6) cloneAsDraft: insert cloned line items
    stageSupabaseResponse("insurance_claim_line_items", "insert", {
      data: null,
    });
    // 7) cloneAsDraft: update total on the new claim
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    // 8) submitDraftToOfficeAlly: load the cloned claim
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: "new-claim-1",
        patient_id: PATIENT,
        payer_profile_id: "pp-1",
        date_of_service: "2026-05-01",
        total_billed_cents: 10000,
        insurance_coverage_id: "cov-1",
      },
    });
    // 9) submitDraftToOfficeAlly: Promise.all reads
    stageSupabaseResponse("insurance_claim_line_items", "select", {
      data: [
        {
          hcpcs_code: "E0601",
          modifier: "KX",
          billed_cents: 10000,
          quantity: 1,
        },
      ],
    });
    stageSupabaseResponse("payer_profiles", "select", {
      data: { payer_legal_name: "Acme Health", office_ally_payer_id: "OA123" },
    });
    stageSupabaseResponse("insurance_coverages", "select", {
      data: { member_id: "M1", policyholder_relationship: "self" },
    });
    stageSupabaseResponse("patients", "select", {
      data: {
        legal_first_name: "Jane",
        legal_last_name: "Doe",
        date_of_birth: "1970-01-01",
        address: { line1: "1 Main", city: "Phila", state: "PA", zip: "19101" },
      },
    });
    // The recorded diagnosis. This path used to hardcode G47.33; it now
    // resolves the real code and refuses the resubmit without one, so a
    // billable claim has to have a sleep study on file.
    stageSupabaseResponse("sleep_studies", "select", {
      data: { diagnosis_icd10: "G47.33" },
    });
    // 10) prior-highest control number lookup
    stageSupabaseResponse("office_ally_submissions", "select", {
      data: { isa_control_number: "000000100" },
    });
    // 11) insert the OA submission row
    stageSupabaseResponse("office_ally_submissions", "insert", {
      data: { id: "sub-1" },
    });
    // 12) claim submitted-stamp + submitted event
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });
    // 13) back in the route: accept-stamp the analysis
    stageSupabaseResponse("claim_denial_analyses", "update", { data: null });
    // 14) close the prior claim + closed event
    stageSupabaseResponse("insurance_claims", "update", { data: null });
    stageSupabaseResponse("insurance_claim_events", "insert", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ analysisId: ANALYSIS });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.newClaimId).toBe("new-claim-1");
    expect(res.body.submission.uploadOk).toBe(true);
    expect(res.body.submission.officeAllySubmissionId).toBe("sub-1");
    expect(submitClaimsMock).toHaveBeenCalledTimes(1);
    // The denial analysis is stamped accepted_resubmitted.
    const analysisStamps = getSupabaseWritePayloads(
      "claim_denial_analyses",
      "update",
    );
    const accept = analysisStamps[analysisStamps.length - 1] as Record<
      string,
      unknown
    >;
    expect(accept.review_status).toBe("accepted_resubmitted");
    expect(accept.resubmit_office_ally_submission_id).toBe("sub-1");
  });

  it("500 clone_failed when the source claim can't be read", async () => {
    mockAdmin.current = ADMIN;
    applyAiPatchesMock.mockResolvedValue([{ status: "applied" }]);
    stageSupabaseResponse("insurance_claims", "select", {
      data: {
        id: CLAIM,
        patient_id: PATIENT,
        status: "denied",
        payer_profile_id: "pp-1",
        insurance_coverage_id: "cov-1",
      },
    });
    stageSupabaseResponse("claim_denial_analyses", "select", {
      data: {
        id: ANALYSIS,
        recommendation: "auto_resubmit",
        can_auto_resubmit: true,
        suggested_patches_json: [{ op: "x" }],
        applied_at: null,
      },
    });
    // cloneAsDraft source-claim read returns null → clone fails.
    stageSupabaseResponse("insurance_claims", "select", { data: null });

    const res = await request(makeApp())
      .post(url)
      .send({ analysisId: ANALYSIS });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("clone_failed");
    expect(submitClaimsMock).not.toHaveBeenCalled();
    // The clone aborts before any insert, so no new insurance_claims row is created.
    expect(getSupabaseCallCount("insurance_claims", "insert")).toBe(0);
  });
});
