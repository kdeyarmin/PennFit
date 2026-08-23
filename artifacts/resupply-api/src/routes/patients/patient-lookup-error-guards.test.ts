import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express, type IRouter } from "express";
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

const { mockAdmin, loggerMock, logAuditMock } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  loggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  logAuditMock: vi.fn<(input: unknown) => Promise<undefined>>(
    async () => undefined,
  ),
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);
vi.mock("../../lib/logger", () => ({ logger: loggerMock }));
vi.mock("@workspace/resupply-audit", () => ({
  logAudit: logAuditMock,
}));

import equipmentRouter from "./equipment";
import insuranceCoveragesRouter from "./insurance-coverages";
import priorAuthorizationsRouter from "./prior-authorizations";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const CREATED_ID = "22222222-2222-4222-8222-222222222222";

interface CreateRouteCase {
  name: string;
  router: IRouter;
  path: string;
  body: Record<string, unknown>;
  insertTable: string;
  lookupLogMessage: string;
  auditWarnMessage: string;
}

const CREATE_ROUTES: readonly CreateRouteCase[] = [
  {
    name: "equipment",
    router: equipmentRouter,
    path: `/resupply-api/patients/${PATIENT_ID}/equipment`,
    body: {
      deviceClass: "cpap",
      manufacturer: "ResMed",
      model: "AirSense 11",
      serialNumber: "SN-001",
    },
    insertTable: "equipment_assets",
    lookupLogMessage: "patient.equipment.create patient lookup failed",
    auditWarnMessage: "patient.equipment.create audit write failed",
  },
  {
    name: "insurance coverages",
    router: insuranceCoveragesRouter,
    path: `/resupply-api/patients/${PATIENT_ID}/insurance-coverages`,
    body: {
      payerName: "Medicare",
      memberId: "MEM-001",
    },
    insertTable: "insurance_coverages",
    lookupLogMessage: "patient.insurance_coverage.create patient lookup failed",
    auditWarnMessage: "patient.insurance.create audit write failed",
  },
  {
    name: "prior authorizations",
    router: priorAuthorizationsRouter,
    path: `/resupply-api/patients/${PATIENT_ID}/prior-authorizations`,
    body: {
      hcpcsCode: "E0601",
      payerName: "Medicare",
    },
    insertTable: "prior_authorizations",
    lookupLogMessage:
      "patient.prior_authorization.create patient lookup failed",
    auditWarnMessage: "patient.prior_authorization.create audit write failed",
  },
] as const;

function makeApp(router: IRouter): Express {
  const app = express();
  app.use(express.json());
  app.use("/resupply-api", router);
  return app;
}

beforeEach(() => {
  mockAdmin.current = {
    userId: "admin-1",
    email: "ops@penn.example.com",
    role: "admin",
  };
  supabaseMock.reset();
  loggerMock.error.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.info.mockReset();
  logAuditMock.mockReset().mockResolvedValue(undefined);
});

describe("patient create-route lookup failures", () => {
  for (const route of CREATE_ROUTES) {
    it(`${route.name} returns 500 query_failed when the patient lookup errors`, async () => {
      stageSupabaseResponse("patients", "select", {
        data: null,
        error: {
          code: "XX000",
          message: "database unavailable",
          details: "patient Alice Smith",
          hint: "contains PHI",
        },
      });

      const res = await request(makeApp(route.router))
        .post(route.path)
        .send(route.body);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: "query_failed" });
      expect(loggerMock.error).toHaveBeenCalledWith(
        {
          err: {
            name: "non_error",
            code: "XX000",
            message: "database unavailable",
          },
          patientId: PATIENT_ID,
        },
        route.lookupLogMessage,
      );
      expect(JSON.stringify(loggerMock.error.mock.calls[0]?.[0])).not.toContain(
        "Alice Smith",
      );
    });

    it(`${route.name} returns 404 when the patient does not exist`, async () => {
      stageSupabaseResponse("patients", "select", { data: null });

      const res = await request(makeApp(route.router))
        .post(route.path)
        .send(route.body);

      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: "not_found" });
      expect(loggerMock.error).not.toHaveBeenCalled();
    });
  }
});

describe("patient create-route audit logging", () => {
  for (const route of CREATE_ROUTES) {
    it(`${route.name} redacts audit-write errors before logging`, async () => {
      stageSupabaseResponse("patients", "select", { data: { id: PATIENT_ID } });
      stageSupabaseResponse(route.insertTable, "insert", {
        data: { id: CREATED_ID },
      });
      logAuditMock.mockRejectedValueOnce({
        code: "23514",
        message: "audit insert failed",
        details: "patient Alice Smith body leaked here",
        hint: "contains PHI",
      });

      const res = await request(makeApp(route.router))
        .post(route.path)
        .send(route.body);

      expect(res.status).toBe(201);
      expect(res.body).toEqual({ id: CREATED_ID });
      expect(loggerMock.warn).toHaveBeenCalledWith(
        {
          err: {
            name: "non_error",
            code: "23514",
            message: "audit insert failed",
          },
        },
        route.auditWarnMessage,
      );
      expect(JSON.stringify(loggerMock.warn.mock.calls[0]?.[0])).not.toContain(
        "Alice Smith",
      );
    });
  }
});
