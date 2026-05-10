// Route tests for /admin/shop/customers/:userId/notes (Phase 10).
//
// Coverage:
//   * 401 / 400 / 404 paths for both GET and POST
//   * GET returns the notes array (newest-first ordering verified
//     by the SQL `desc(createdAt)`; we just confirm the route
//     forwards what the helper returns)
//   * POST validates body length (empty + over-limit)
//   * POST inserts + audits with non-PHI metadata; envelope never
//     contains the body content

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
  getSupabaseCallCount,
  getSupabaseWritePayloads,
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

import customerNotesRouter from "./customer-notes";

const USER_ID = "user_abc123";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(customerNotesRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
  logAuditMock.mockClear();
});

describe("GET /admin/shop/customers/:userId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(401);
  });

  it("400s with malformed userId (rejects spaces / special chars)", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get(
      `/admin/shop/customers/has spaces!/notes`,
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_user_id");
    expect(getSupabaseCallCount("shop_customers", "select")).toBe(0);
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    // exists check → maybeSingle returns null when no row
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
  });

  it("returns the notes list", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    stageSupabaseResponse("shop_customer_notes", "select", {
      data: [
        {
          id: "note_1",
          body: "Spoke with Anna 5/3 — switching to nasal pillows.",
          author_email: "ops@penn.example.com",
          author_user_id: "u_admin",
          created_at: new Date("2026-05-03T15:00:00Z").toISOString(),
        },
        {
          id: "note_0",
          body: "Old note.",
          author_email: "other@penn.example.com",
          author_user_id: "u_other",
          created_at: new Date("2026-05-01T10:00:00Z").toISOString(),
        },
      ],
    });

    const res = await request(makeApp()).get(
      `/admin/shop/customers/${USER_ID}/notes`,
    );
    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(2);
    expect(res.body.notes[0]).toMatchObject({
      id: "note_1",
      body: "Spoke with Anna 5/3 — switching to nasal pillows.",
      authorEmail: "ops@penn.example.com",
    });
    expect(res.body.notes[0].createdAt).toBe("2026-05-03T15:00:00.000Z");

    // Audit was written with structural metadata only.
    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.notes.list");
    expect(audit.targetTable).toBe("shop_customer_notes");
    expect(audit.targetId).toBe(USER_ID);
    expect(audit.metadata).toEqual({ customer_id: USER_ID, count: 2 });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("nasal pillows");
    expect(JSON.stringify(audit.metadata)).not.toContain("Old note");
  });
});

describe("POST /admin/shop/customers/:userId/notes", () => {
  it("401s without admin", async () => {
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "test" });
    expect(res.status).toBe(401);
  });

  it("400s with empty body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "   " });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("shop_customer_notes", "insert")).toBe(0);
  });

  it("400s with over-limit body", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "x".repeat(4001) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(getSupabaseCallCount("shop_customer_notes", "insert")).toBe(0);
  });

  it("404s when the customer doesn't exist", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", { data: null });
    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "Spoke 5/3" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("customer_not_found");
    expect(getSupabaseCallCount("shop_customer_notes", "insert")).toBe(0);
  });

  it("inserts + audits with non-PHI envelope", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    // INSERT … RETURNING with .single() returns the row directly.
    stageSupabaseResponse("shop_customer_notes", "insert", {
      data: {
        id: "note_new",
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
      },
    });

    const res = await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "Switched Anna to nasal pillows; 30-day follow-up set." });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      id: "note_new",
      createdAt: "2026-05-04T12:00:00.000Z",
    });

    expect(logAuditMock).toHaveBeenCalledTimes(1);
    const audit = logAuditMock.mock.calls[0]?.[0] as {
      action: string;
      targetTable: string;
      targetId: string;
      metadata: Record<string, unknown>;
    };
    expect(audit.action).toBe("shop_customer.note.create");
    expect(audit.targetTable).toBe("shop_customer_notes");
    expect(audit.targetId).toBe("note_new");
    expect(audit.metadata).toEqual({
      customer_id: USER_ID,
      body_length: "Switched Anna to nasal pillows; 30-day follow-up set."
        .length,
    });
    // Critical: no body content in the audit envelope.
    expect(JSON.stringify(audit.metadata)).not.toContain("nasal pillows");
    expect(JSON.stringify(audit.metadata)).not.toContain("Switched");
  });

  it("trims whitespace before persisting + measuring length", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("shop_customers", "select", {
      data: { customer_id: USER_ID },
    });
    stageSupabaseResponse("shop_customer_notes", "insert", {
      data: {
        id: "note_t",
        created_at: new Date("2026-05-04T12:00:00Z").toISOString(),
      },
    });

    await request(makeApp())
      .post(`/admin/shop/customers/${USER_ID}/notes`)
      .send({ body: "  hello there  " });

    const inserts = getSupabaseWritePayloads(
      "shop_customer_notes",
      "insert",
    ) as Record<string, unknown>[];
    // Persisted body is the TRIMMED string, not the raw 15-char input.
    expect(inserts[0]?.body).toBe("hello there");

    const audit = logAuditMock.mock.calls[0]?.[0] as {
      metadata: Record<string, unknown>;
    };
    // body_length matches the trimmed length.
    expect(audit.metadata.body_length).toBe("hello there".length);
  });
});
