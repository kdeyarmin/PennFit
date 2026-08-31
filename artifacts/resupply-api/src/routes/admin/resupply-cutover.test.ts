// /admin/resupply-cutover — the per-tenant cutover workflow.
//
// What is worth testing here is not the assessment (covered exhaustively
// in @workspace/resupply-cutover) but the GATE: that a flag which changes
// when live patients are contacted cannot be turned on without a clean,
// current, recorded assessment; that it can always be turned back off;
// and that a rollback poisons the stored verdict so the next enable has
// to re-earn it.

import express, { type Express } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
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

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(() => Promise.resolve()),
}));

const invalidateCacheMock = vi.hoisted(() => vi.fn());
vi.mock("../../lib/feature-flags", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/feature-flags")
  >("../../lib/feature-flags");
  return { ...actual, invalidateFeatureFlagCache: invalidateCacheMock };
});

// The assessment itself is stubbed: this suite is about the gate.
const assessMock = vi.hoisted(() =>
  vi.fn<(orgId: string, key: string) => Promise<unknown>>(),
);
const flagStateMock = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
const latestRecordMock = vi.hoisted(() =>
  vi.fn<() => Promise<unknown | null>>(),
);
const writeRecordMock = vi.hoisted(() =>
  vi.fn<(input: Record<string, unknown>) => Promise<{ id: string }>>(),
);
const listRecordsMock = vi.hoisted(() => vi.fn<() => Promise<unknown[]>>());

vi.mock("@workspace/resupply-cutover", async () => {
  const actual = await vi.importActual<
    typeof import("@workspace/resupply-cutover")
  >("@workspace/resupply-cutover");
  return {
    ...actual,
    assessReadiness: assessMock,
    readCutoverFlagState: flagStateMock,
    readLatestCutoverRecord: latestRecordMock,
    writeCutoverRecord: writeRecordMock,
    listCutoverRecords: listRecordsMock,
  };
});

const { default: router } = await import("./resupply-cutover");

const DUE_AT = "resupply.due_at_authoritative";
/** The tenant the shared requireAdmin mock attaches to every request. */
const ORG = "00000000-0000-4000-8000-000000000001";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(router);
  return app;
}

function stubAdmin(role: "admin" | "agent" = "admin") {
  mockAdmin.current = { userId: "u1", email: "ops@example.com", role };
}

function readyReport() {
  return {
    flagKey: DUE_AT,
    status: "ready",
    evaluatedAt: "2026-06-01T00:00:00.000Z",
    blockers: [],
    warnings: [],
    metrics: { openEpisodes: 12, drifting: 0 },
    truncated: false,
    sampleDriftingEpisodeIds: [],
  };
}

function blockedReport() {
  return {
    ...readyReport(),
    status: "blocked",
    blockers: [{ code: "due_at_drift", detail: "31 episodes would move" }],
  };
}

/** The flag row the enable/rollback path reads before writing. */
function stageFlagRow(enabled: boolean) {
  stageSupabaseResponse("feature_flags", "select", {
    data: { key: DUE_AT, enabled },
  });
  stageSupabaseResponse("feature_flags", "update", { data: null });
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  invalidateCacheMock.mockClear();
  assessMock.mockReset();
  flagStateMock.mockReset().mockResolvedValue(false);
  latestRecordMock.mockReset().mockResolvedValue(null);
  writeRecordMock.mockReset().mockResolvedValue({ id: "rec_1" });
  listRecordsMock.mockReset().mockResolvedValue([]);
});

describe("GET /admin/resupply-cutover", () => {
  it("requires authentication", async () => {
    const res = await request(makeApp()).get("/admin/resupply-cutover");
    expect(res.status).toBe(401);
  });

  it("reports not_evaluated for a tenant nobody has assessed", async () => {
    stubAdmin();
    const res = await request(makeApp()).get("/admin/resupply-cutover");
    expect(res.status).toBe(200);
    expect(res.body.flags).toHaveLength(2);
    expect(res.body.flags[0]).toMatchObject({
      key: DUE_AT,
      enabled: false,
      readinessState: "not_evaluated",
      assessmentAgeDays: null,
    });
  });

  it("flags a switch that was flipped from the generic flags page", async () => {
    // A flag that is ON with no `enable` record bypassed the assessment.
    // Saying so is more useful than pretending the workflow was followed.
    stubAdmin();
    flagStateMock.mockResolvedValue(true);
    latestRecordMock.mockResolvedValue(null);
    const res = await request(makeApp()).get("/admin/resupply-cutover");
    expect(res.body.flags[0].enabledWithoutRecord).toBe(true);
  });

  it("does not flag a switch enabled through this workflow", async () => {
    stubAdmin();
    flagStateMock.mockResolvedValue(true);
    latestRecordMock.mockResolvedValue({
      id: "rec_1",
      action: "enable",
      readinessStatus: "ready",
      evidenceId: "OPS-1",
      actorEmail: "ops@example.com",
      evaluatedAt: new Date().toISOString(),
      rollbackReason: null,
    });
    const res = await request(makeApp()).get("/admin/resupply-cutover");
    expect(res.body.flags[0].enabledWithoutRecord).toBe(false);
    expect(res.body.flags[0].readinessState).toBe("ready");
  });
});

describe("POST /admin/resupply-cutover/:key/assess", () => {
  it("is read-only — it never writes the flag", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(blockedReport());
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/assess`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.report.status).toBe("blocked");
    expect(getSupabaseWritePayloads("feature_flags", "update")).toHaveLength(0);
  });

  it("records the verdict, including a blocked one", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(blockedReport());
    await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/assess`)
      .send({ evidenceId: "OPS-42" });
    expect(writeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "evaluate",
        readinessStatus: "blocked",
        evidenceId: "OPS-42",
      }),
    );
  });

  it("records a FAILED assessment rather than leaving the tenant looking unevaluated", async () => {
    stubAdmin();
    assessMock.mockRejectedValue(new Error("postgrest down"));
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/assess`)
      .send({});
    expect(res.status).toBe(503);
    expect(writeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ readinessStatus: "error" }),
    );
  });

  it("404s an unknown flag key", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post("/admin/resupply-cutover/sms.reminders/assess")
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("POST /admin/resupply-cutover/:key/enable", () => {
  it("refuses a CSR-bucket actor", async () => {
    stubAdmin("agent");
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(res.status).toBe(403);
    expect(getSupabaseWritePayloads("feature_flags", "update")).toHaveLength(0);
  });

  it("refuses without the literal confirmation", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: true, evidenceId: "OPS-1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("confirmation_required");
    expect(assessMock).not.toHaveBeenCalled();
  });

  it("refuses without an evidence identifier", async () => {
    stubAdmin();
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE" });
    expect(res.status).toBe(400);
  });

  it("REFUSES when the tenant is not ready, and writes nothing", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(blockedReport());
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_ready");
    expect(res.body.report.blockers[0].code).toBe("due_at_drift");
    expect(getSupabaseWritePayloads("feature_flags", "update")).toHaveLength(0);
  });

  it("re-assesses at enable time rather than trusting a stored pass", async () => {
    // A tenant that passed an hour ago can have imported a book of
    // patients since. The stored record authorises the click; the fresh
    // assessment decides the outcome.
    stubAdmin();
    latestRecordMock.mockResolvedValue({
      id: "rec_old",
      action: "evaluate",
      readinessStatus: "ready",
      evaluatedAt: new Date().toISOString(),
      evidenceId: "OPS-1",
      actorEmail: "ops@example.com",
      rollbackReason: null,
    });
    assessMock.mockResolvedValue(blockedReport());
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(assessMock).toHaveBeenCalled();
    expect(res.status).toBe(409);
  });

  it("enables on a clean assessment, and records the evidence", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(readyReport());
    stageFlagRow(false);
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1234" });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    const writes = getSupabaseWritePayloads("feature_flags", "update");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ enabled: true });
    expect(writeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "enable",
        previousValue: false,
        newValue: true,
        readinessStatus: "ready",
        evidenceId: "OPS-1234",
      }),
    );
    expect(invalidateCacheMock).toHaveBeenCalledWith(DUE_AT);
  });

  it("refuses a tenant whose flag row was never seeded", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(readyReport());
    stageSupabaseResponse("feature_flags", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("flag_not_seeded");
  });

  it("fails closed when the assessment itself errors", async () => {
    stubAdmin();
    assessMock.mockRejectedValue(new Error("postgrest down"));
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(res.status).toBe(503);
    expect(getSupabaseWritePayloads("feature_flags", "update")).toHaveLength(0);
  });
});

describe("POST /admin/resupply-cutover/:key/rollback", () => {
  it("requires the confirmation and a real reason", async () => {
    stubAdmin();
    const short = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/rollback`)
      .send({ confirm: "ROLLBACK", reason: "bad" });
    expect(short.status).toBe(400);

    const unconfirmed = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/rollback`)
      .send({ reason: "reminders firing early for override patients" });
    expect(unconfirmed.status).toBe(400);
  });

  it("turns the flag off WITHOUT requiring a readiness assessment", async () => {
    // A data-quality check must never stand between an operator and the
    // stop button: turning the flag off restores the behaviour every
    // other tenant already has.
    stubAdmin();
    stageFlagRow(true);
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/rollback`)
      .send({
        confirm: "ROLLBACK",
        reason: "reminders firing early for override patients",
      });
    expect(res.status).toBe(200);
    expect(assessMock).not.toHaveBeenCalled();
    expect(
      getSupabaseWritePayloads("feature_flags", "update")[0],
    ).toMatchObject({ enabled: false });
  });

  it("records the rollback as blocked, so the next enable must re-earn it", async () => {
    stubAdmin();
    stageFlagRow(true);
    await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/rollback`)
      .send({
        confirm: "ROLLBACK",
        reason: "reminders firing early for override patients",
      });
    expect(writeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "rollback",
        newValue: false,
        readinessStatus: "blocked",
        rollbackReason: "reminders firing early for override patients",
      }),
    );
  });

  it("refuses a CSR-bucket actor", async () => {
    stubAdmin("agent");
    const res = await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/rollback`)
      .send({ confirm: "ROLLBACK", reason: "something went wrong here" });
    expect(res.status).toBe(403);
  });
});

describe("tenant scope", () => {
  it("refuses to act without a tenant context", async () => {
    // `orgId: null` makes the auth mock attach no tenant, the shape a
    // request reaches the handler with when tenant resolution failed.
    // Fail closed: never fall back to a default org.
    mockAdmin.current = {
      userId: "u1",
      email: "ops@example.com",
      role: "admin",
      orgId: null,
    };
    const res = await request(makeApp()).get("/admin/resupply-cutover");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
  });

  it("passes the caller's org to every assessment and record write", async () => {
    stubAdmin();
    assessMock.mockResolvedValue(readyReport());
    stageFlagRow(false);
    await request(makeApp())
      .post(`/admin/resupply-cutover/${DUE_AT}/enable`)
      .send({ confirm: "ENABLE", evidenceId: "OPS-1" });
    expect(assessMock).toHaveBeenCalledWith(ORG, DUE_AT);
    expect(writeRecordMock).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: ORG }),
    );
  });
});
