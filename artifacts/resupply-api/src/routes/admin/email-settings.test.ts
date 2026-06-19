// Tests for /admin/organization/email-settings — tenant From identity.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    orgRow: {
      from_email: null as string | null,
      from_name: null as string | null,
    },
    updateError: null as { code?: string } | null,
    lastUpdate: null as Record<string, unknown> | null,
    domainAuth: {
      status: "unauthenticated" as const,
      detail: "not authenticated",
    },
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next();
  return {
    adminRateLimit: () => passthrough,
    adminReadRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-db", () => ({
  resolveSeedOrgId: async () => "org",
  getOrgScopedClient: () => ({
    raw: () => ({
      schema: () => ({
        from: () => ({
          select: () => ({
            eq: () => ({
              limit: () => ({
                maybeSingle: async () => ({ data: state.orgRow, error: null }),
              }),
            }),
          }),
          update: (obj: Record<string, unknown>) => {
            state.lastUpdate = obj;
            return {
              eq: async () => {
                if (!state.updateError) Object.assign(state.orgRow, obj);
                return { error: state.updateError };
              },
            };
          },
        }),
      }),
    }),
  }),
}));

vi.mock("@workspace/resupply-email", () => ({
  DEFAULT_SENDGRID_FROM_EMAIL: "noreply@cmbreathe.com",
  DEFAULT_SENDGRID_FROM_NAME: "CareMetric Breathe",
}));

vi.mock("@workspace/resupply-audit", () => ({ logAudit: async () => {} }));
vi.mock("../../lib/email/tenant-sender", () => ({
  invalidateTenantSenderCache: () => {},
}));
vi.mock("../../lib/email/sendgrid-domain-auth", () => ({
  checkSendgridDomainAuth: async () => state.domainAuth,
}));

import emailSettingsRouter from "./email-settings";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(emailSettingsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = {
    email: "owner@acme",
    userId: "u_owner",
    role: "admin",
    granularRole: "admin",
  };
  state.orgRow = { from_email: null, from_name: null };
  state.updateError = null;
  state.lastUpdate = null;
  state.domainAuth = { status: "unauthenticated", detail: "not authenticated" };
});

describe("GET /admin/organization/email-settings", () => {
  it("401s when unauthenticated", async () => {
    mockAdmin.current = null;
    const res = await request(makeApp()).get(
      "/admin/organization/email-settings",
    );
    expect(res.status).toBe(401);
  });

  it("returns the platform default + unknown domain auth when unset", async () => {
    const res = await request(makeApp()).get(
      "/admin/organization/email-settings",
    );
    expect(res.status).toBe(200);
    expect(res.body.fromEmail).toBeNull();
    expect(res.body.platformDefaultEmail).toBe("noreply@cmbreathe.com");
    expect(res.body.domainAuth.status).toBe("unknown");
  });

  it("runs the domain-auth check when a sender is set", async () => {
    state.orgRow = { from_email: "info@acme.com", from_name: "Acme" };
    state.domainAuth = {
      status: "authenticated",
      detail: "ok",
    } as unknown as typeof state.domainAuth;
    const res = await request(makeApp()).get(
      "/admin/organization/email-settings",
    );
    expect(res.body.fromEmail).toBe("info@acme.com");
    expect(res.body.domainAuth.status).toBe("authenticated");
  });
});

describe("PATCH /admin/organization/email-settings", () => {
  it("sets the From identity", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/email-settings")
      .send({ fromEmail: "info@acme.com", fromName: "Acme" });
    expect(res.status).toBe(200);
    expect(state.lastUpdate).toEqual({
      from_email: "info@acme.com",
      from_name: "Acme",
    });
  });

  it("clears the sender with null", async () => {
    state.orgRow = { from_email: "info@acme.com", from_name: "Acme" };
    await request(makeApp())
      .patch("/admin/organization/email-settings")
      .send({ fromEmail: null, fromName: null });
    expect(state.lastUpdate).toEqual({ from_email: null, from_name: null });
  });

  it("rejects an invalid email", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/email-settings")
      .send({ fromEmail: "not-an-email" });
    expect(res.status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const res = await request(makeApp())
      .patch("/admin/organization/email-settings")
      .send({});
    expect(res.status).toBe(400);
  });
});
