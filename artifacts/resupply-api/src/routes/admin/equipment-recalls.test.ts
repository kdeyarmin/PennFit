// Tests for /admin/equipment-recalls — a patient-safety surface (an
// equipment recall that doesn't reach the right assets is a safety event).
// Two prongs:
//   1. Pure-helper / schema units: the ILIKE-escape (query-fan-out guard),
//      the http(s)-only URL schema (stored-XSS guard), and the create body.
//   2. HTTP route behaviour with mocked Supabase + auth: gating, the
//      snake_case→camelCase list mapping, create, and the unique-conflict.

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

// Rate limiting is out of scope here — pass through so repeated POSTs in a
// single test don't trip a "sensitive" preset.
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

import equipmentRecallsRouter, {
  createBody,
  escapeIlikePattern,
  httpUrl,
  serialMatchSchema,
} from "./equipment-recalls";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(equipmentRecallsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

// ---------------------------------------------------------------------------
// escapeIlikePattern — query-fan-out / wildcard-injection guard
// ---------------------------------------------------------------------------
describe("escapeIlikePattern", () => {
  it("escapes the ILIKE wildcards % and _", () => {
    expect(escapeIlikePattern("100%_off")).toBe("100\\%\\_off");
  });

  it("escapes backslashes first so the escape isn't itself re-escaped", () => {
    expect(escapeIlikePattern("a\\b")).toBe("a\\\\b");
    // A literal backslash followed by a wildcard becomes \\ then \%.
    expect(escapeIlikePattern("\\%")).toBe("\\\\\\%");
  });

  it("leaves ordinary text untouched", () => {
    expect(escapeIlikePattern("ResMed AirSense 11")).toBe("ResMed AirSense 11");
  });
});

// ---------------------------------------------------------------------------
// httpUrl — stored-XSS guard (no javascript:/data:/file: links)
// ---------------------------------------------------------------------------
describe("httpUrl schema", () => {
  it("accepts http and https URLs", () => {
    expect(httpUrl().safeParse("https://fda.gov/recall/123").success).toBe(
      true,
    );
    expect(httpUrl().safeParse("http://example.com").success).toBe(true);
  });

  it("rejects javascript:, data:, file:, and other dangerous protocols", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "vbscript:msgbox(1)",
    ]) {
      expect(httpUrl().safeParse(bad).success).toBe(false);
    }
  });

  it("rejects non-URLs", () => {
    expect(httpUrl().safeParse("not a url").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createBody / serialMatchSchema — input validation
// ---------------------------------------------------------------------------
describe("createBody schema", () => {
  const base = {
    recallReference: "FDA-2026-001",
    title: "AirSense foam degradation",
    manufacturer: "ResMed",
  };

  it("accepts a minimal valid body and defaults severity to priority", () => {
    const parsed = createBody.safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.severity).toBe("priority");
  });

  it("rejects an unknown severity", () => {
    expect(createBody.safeParse({ ...base, severity: "nuclear" }).success).toBe(
      false,
    );
  });

  it("rejects a non-ISO issuedAt date", () => {
    expect(
      createBody.safeParse({ ...base, issuedAt: "06/01/2026" }).success,
    ).toBe(false);
  });

  it("rejects a javascript: referenceUrl (XSS) via httpUrl", () => {
    expect(
      createBody.safeParse({ ...base, referenceUrl: "javascript:alert(1)" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown keys (strict)", () => {
    expect(createBody.safeParse({ ...base, sneaky: true }).success).toBe(false);
  });

  it("accepts a serial range and a serial list, but not an empty list", () => {
    expect(
      serialMatchSchema.safeParse({ kind: "range", from: "A1", to: "A9" })
        .success,
    ).toBe(true);
    expect(
      serialMatchSchema.safeParse({ kind: "list", serials: ["A1", "A2"] })
        .success,
    ).toBe(true);
    expect(
      serialMatchSchema.safeParse({ kind: "list", serials: [] }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HTTP — GET /admin/equipment-recalls
// ---------------------------------------------------------------------------
describe("GET /admin/equipment-recalls", () => {
  it("401s when no admin is signed in", async () => {
    const res = await request(makeApp()).get("/admin/equipment-recalls");
    expect(res.status).toBe(401);
  });

  it("returns recalls mapped to camelCase for a signed-in admin", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("equipment_recalls", "select", {
      data: [
        {
          id: "r1",
          recall_reference: "FDA-2026-001",
          title: "Foam degradation",
          manufacturer: "ResMed",
          model_match: "AirSense 11",
          serial_match: { kind: "range", from: "A1", to: "A9" },
          severity: "urgent",
          status: "active",
          issued_at: "2026-01-15",
          deadline_at: "2026-03-01",
          reference_url: "https://fda.gov/r/1",
          description: "desc",
          created_at: "2026-01-15T00:00:00Z",
          updated_at: "2026-01-15T00:00:00Z",
        },
      ],
    });

    const res = await request(makeApp()).get("/admin/equipment-recalls");
    expect(res.status).toBe(200);
    expect(res.body.recalls).toHaveLength(1);
    expect(res.body.recalls[0]).toMatchObject({
      id: "r1",
      recallReference: "FDA-2026-001",
      modelMatch: "AirSense 11",
      severity: "urgent",
      referenceUrl: "https://fda.gov/r/1",
    });
    // snake_case keys must not leak through.
    expect(res.body.recalls[0]).not.toHaveProperty("recall_reference");
  });
});

// ---------------------------------------------------------------------------
// HTTP — POST /admin/equipment-recalls
// ---------------------------------------------------------------------------
describe("POST /admin/equipment-recalls", () => {
  it("401s when no admin is signed in", async () => {
    const res = await request(makeApp())
      .post("/admin/equipment-recalls")
      .send({ recallReference: "X", title: "Y", manufacturer: "Z" });
    expect(res.status).toBe(401);
  });

  it("400s on an invalid body (and never touches the DB)", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/equipment-recalls")
      .send({ recallReference: "X", title: "Y" }); // missing manufacturer
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(supabaseMock.callCount("equipment_recalls", "insert")).toBe(0);
  });

  it("400s a javascript: referenceUrl through the real route (XSS guard)", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post("/admin/equipment-recalls").send({
      recallReference: "FDA-2026-002",
      title: "T",
      manufacturer: "ResMed",
      referenceUrl: "javascript:alert(document.cookie)",
    });
    expect(res.status).toBe(400);
    expect(supabaseMock.callCount("equipment_recalls", "insert")).toBe(0);
  });

  it("creates a recall and returns 201 with the new id", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("equipment_recalls", "insert", {
      data: { id: "new-recall-id" },
    });
    const res = await request(makeApp()).post("/admin/equipment-recalls").send({
      recallReference: "FDA-2026-003",
      title: "Foam recall",
      manufacturer: "ResMed",
      severity: "urgent",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "new-recall-id" });
  });

  it("maps a unique-violation (23505) to a 409 conflict", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("equipment_recalls", "insert", {
      error: { code: "23505", message: "duplicate key" },
    });
    const res = await request(makeApp()).post("/admin/equipment-recalls").send({
      recallReference: "FDA-2026-001",
      title: "Dup",
      manufacturer: "ResMed",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("recall_reference_taken");
  });
});
