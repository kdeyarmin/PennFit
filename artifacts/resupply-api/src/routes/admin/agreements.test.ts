// Tests for /admin/agreements — G16 tenant onboarding agreements gate.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { REQUIRED_AGREEMENTS } from "../../lib/agreements";

const ORG = "11111111-1111-4111-8111-111111111111";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    // Accepted (agreement_type, version) rows this fake tenant carries.
    accepted: [] as Array<{ agreement_type: string; version: string }>,
    selectError: null as unknown,
    insertError: null as { code?: string } | null,
    inserted: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next();
  return {
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: () => ({
      // status.ts awaits .select(...) directly → resolve {data,error}.
      select: async () => ({
        data: state.selectError ? null : state.accepted,
        error: state.selectError,
      }),
      // The accept route awaits .insert(...) → resolve {error}. On success
      // we also reflect the row into `accepted` so the route's post-insert
      // re-read (getPendingAgreementTypes) sees it, mirroring the DB.
      insert: async (row: Record<string, unknown>) => {
        if (!state.insertError) {
          state.inserted.push(row);
          state.accepted.push({
            agreement_type: row.agreement_type as string,
            version: row.version as string,
          });
        }
        return { error: state.insertError };
      },
    }),
  }),
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn(async () => {}),
}));

import agreementsRouter from "./agreements";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(agreementsRouter);
  return app;
}

const BAA = REQUIRED_AGREEMENTS.find((a) => a.type === "baa")!;
const TERMS = REQUIRED_AGREEMENTS.find((a) => a.type === "platform_terms")!;

beforeEach(() => {
  mockAdmin.current = {
    email: "owner@acme",
    userId: "u_owner",
    role: "admin",
    granularRole: "admin",
    orgId: ORG,
    permissions: ["system.config.manage"],
  } as MockAdminCtx;
  state.accepted = [];
  state.selectError = null;
  state.insertError = null;
  state.inserted = [];
});

describe("GET /admin/agreements", () => {
  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get("/admin/agreements");
    expect(res.status).toBe(401);
  });

  it("returns every required agreement as unsigned for a fresh tenant", async () => {
    const res = await request(makeApp()).get("/admin/agreements");
    expect(res.status).toBe(200);
    expect(res.body.agreements).toHaveLength(REQUIRED_AGREEMENTS.length);
    expect(
      res.body.agreements.every((a: { accepted: boolean }) => !a.accepted),
    ).toBe(true);
  });

  it("marks an agreement signed once its current version is accepted", async () => {
    state.accepted = [{ agreement_type: "baa", version: BAA.version }];
    const res = await request(makeApp()).get("/admin/agreements");
    const baa = res.body.agreements.find(
      (a: { type: string }) => a.type === "baa",
    );
    const terms = res.body.agreements.find(
      (a: { type: string }) => a.type === "platform_terms",
    );
    expect(baa.accepted).toBe(true);
    expect(terms.accepted).toBe(false);
  });

  it("treats a stale-version acceptance as still pending", async () => {
    state.accepted = [{ agreement_type: "baa", version: "1999-01-01" }];
    const res = await request(makeApp()).get("/admin/agreements");
    const baa = res.body.agreements.find(
      (a: { type: string }) => a.type === "baa",
    );
    expect(baa.accepted).toBe(false);
  });
});

describe("POST /admin/agreements/accept", () => {
  it("records an acceptance and reports remaining pending types", async () => {
    const res = await request(makeApp()).post("/admin/agreements/accept").send({
      type: "baa",
      version: BAA.version,
      signatoryName: "Jane Doe",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.allSigned).toBe(false);
    expect(res.body.pending).toContain("platform_terms");
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      agreement_type: "baa",
      version: BAA.version,
      signatory_name: "Jane Doe",
    });
  });

  it("reports allSigned once the last agreement is accepted", async () => {
    // Terms already signed; accepting the BAA completes the set.
    state.accepted = [
      { agreement_type: "platform_terms", version: TERMS.version },
    ];
    const res = await request(makeApp()).post("/admin/agreements/accept").send({
      type: "baa",
      version: BAA.version,
      signatoryName: "Jane Doe",
    });
    expect(res.status).toBe(200);
    expect(res.body.allSigned).toBe(true);
    expect(res.body.pending).toHaveLength(0);
  });

  it("rejects a stale/forged version (409)", async () => {
    const res = await request(makeApp())
      .post("/admin/agreements/accept")
      .send({ type: "baa", version: "1999-01-01", signatoryName: "Jane Doe" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("stale_agreement_version");
    expect(state.inserted).toHaveLength(0);
  });

  it("rejects a missing signatory name (400)", async () => {
    const res = await request(makeApp())
      .post("/admin/agreements/accept")
      .send({ type: "baa", version: BAA.version });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  it("treats a duplicate acceptance (23505) as idempotent success", async () => {
    state.insertError = { code: "23505" };
    const res = await request(makeApp()).post("/admin/agreements/accept").send({
      type: "baa",
      version: BAA.version,
      signatoryName: "Jane Doe",
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("500s on a non-conflict insert error", async () => {
    state.insertError = { code: "42501" };
    const res = await request(makeApp()).post("/admin/agreements/accept").send({
      type: "baa",
      version: BAA.version,
      signatoryName: "Jane Doe",
    });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("accept_failed");
  });
});
