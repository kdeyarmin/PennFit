// allow-source-read: second describe block asserts structural security
// invariants (error objects must be redacted before reaching the logger,
// never passed as raw `{ err }`) that have no clean behavioral equivalent
// — you cannot observe from an HTTP response whether the logger received
// a sanitised or a raw Postgres error object.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const logAuditMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: (...a: unknown[]) => logAuditMock(...a),
}));

import equipmentRouter from "./equipment";
import insuranceCoveragesRouter from "./insurance-coverages";
import priorAuthorizationsRouter from "./prior-authorizations";

const PATIENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function stubAdmin(): void {
  mockAdmin.current = {
    userId: "user_op",
    email: "ops@penn.example.com",
    role: "admin",
  };
}

function makeApp(router: ReturnType<typeof express.Router>): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", router);
  return app;
}

const EQUIPMENT_BODY = {
  deviceClass: "cpap",
  manufacturer: "ResMed",
  model: "AirSense 11",
  serialNumber: "SN-001",
};

const COVERAGE_BODY = {
  rank: "primary",
  payerName: "Aetna",
  memberId: "MBR-001",
};

const PRIOR_AUTH_BODY = {
  hcpcsCode: "E0601",
  payerName: "Aetna",
};

describe("patient create-route lookup failures", () => {
  beforeEach(() => {
    mockAdmin.current = null;
    supabaseMock.reset();
    logAuditMock.mockReset().mockResolvedValue(undefined);
  });

  describe("equipment.ts", () => {
    it("returns 500 query_failed when DB errors on patient lookup", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", {
        data: null,
        error: { message: "connection failure", code: "08006" },
      });

      const res = await request(makeApp(equipmentRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/equipment`)
        .send(EQUIPMENT_BODY);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "query_failed" });
    });

    it("returns 404 not_found when patient does not exist", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", { data: null, error: null });

      const res = await request(makeApp(equipmentRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/equipment`)
        .send(EQUIPMENT_BODY);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    });
  });

  describe("insurance-coverages.ts", () => {
    it("returns 500 query_failed when DB errors on patient lookup", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", {
        data: null,
        error: { message: "connection failure", code: "08006" },
      });

      const res = await request(makeApp(insuranceCoveragesRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/insurance-coverages`)
        .send(COVERAGE_BODY);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "query_failed" });
    });

    it("returns 404 not_found when patient does not exist", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", { data: null, error: null });

      const res = await request(makeApp(insuranceCoveragesRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/insurance-coverages`)
        .send(COVERAGE_BODY);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    });
  });

  describe("prior-authorizations.ts", () => {
    it("returns 500 query_failed when DB errors on patient lookup", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", {
        data: null,
        error: { message: "connection failure", code: "08006" },
      });

      const res = await request(makeApp(priorAuthorizationsRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/prior-authorizations`)
        .send(PRIOR_AUTH_BODY);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "query_failed" });
    });

    it("returns 404 not_found when patient does not exist", async () => {
      stubAdmin();
      stageSupabaseResponse("patients", "select", { data: null, error: null });

      const res = await request(makeApp(priorAuthorizationsRouter))
        .post(`/resupply-api/patients/${PATIENT_ID}/prior-authorizations`)
        .send(PRIOR_AUTH_BODY);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
    });
  });
});

// ---- Structural invariants (source-read justified by allow-source-read) ----
// These checks assert that every route on the patient surface wraps DB errors
// in redactDbErr() before passing them to the logger — a security invariant
// that cannot be observed from HTTP responses alone.

const AUDITED_ROUTES = [
  "equipment.ts",
  "insurance-coverages.ts",
  "prior-authorizations.ts",
  "followups.ts",
  "notes-create.ts",
  "notes-list.ts",
  "sleep-studies.ts",
] as const;

describe("patient-route audit logging", () => {
  for (const route of AUDITED_ROUTES) {
    it(`${route} redacts audit-write errors before logging`, () => {
      const source = readFileSync(
        path.join(import.meta.dirname, route),
        "utf8",
      );

      expect(source).not.toContain("logger.warn({ err },");
      expect(source).not.toContain("logger.warn(\n        { err },");
      expect(source).toContain("redactDbErr");
    });
  }

  it("never logs raw caught errors on the patient route surface", () => {
    const routeFiles = readdirSync(import.meta.dirname).filter(
      (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
    );

    for (const route of routeFiles) {
      const source = readFileSync(path.join(import.meta.dirname, route), "utf8");
      expect(source, route).not.toContain("logger.warn({ err },");
      expect(source, route).not.toContain("logger.error({ err },");
    }
  });
});
