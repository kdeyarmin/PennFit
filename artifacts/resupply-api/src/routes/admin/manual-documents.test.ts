// Tests for the manual-documents routes — the catalog contract the
// /admin/documents "New document" type dropdown depends on. Added while
// investigating an "empty type dropdown" report: the catalog is a pure
// in-code constant, so this endpoint must always return all six types
// for any staff role with patients.read.

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";
import { installSupabaseMock } from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

import manualDocumentsRouter from "./manual-documents";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "ops@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(manualDocumentsRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/manual-documents/catalog", () => {
  it("401s without admin; returns all six types with admin", async () => {
    expect(
      (await request(makeApp()).get("/admin/manual-documents/catalog")).status,
    ).toBe(401);
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).get("/admin/manual-documents/catalog");
    expect(res.status).toBe(200);
    expect(res.body.types.map((t: { type: string }) => t.type)).toEqual([
      "cmn",
      "prescription",
      "agreement",
      "delivery_ticket",
      "cover_letter",
      "other",
    ]);
  });

  it("returns the catalog for an agent (patients.read)", async () => {
    mockAdmin.current = { ...ADMIN, role: "agent" };
    const res = await request(makeApp()).get("/admin/manual-documents/catalog");
    expect(res.status).toBe(200);
    expect(res.body.types.length).toBe(6);
  });
});
