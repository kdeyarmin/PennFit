// Route tests for staff branch (location) assignment via
// PATCH /admin/team/:id (multi-location phase 2). Focus: the location
// is validated against active locations before it's written, mirroring
// the patient-side guard.

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
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockAdmin } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
}));
vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

// The team route imports the in-house auth helpers + auth-deps; they're
// never reached on a location-only PATCH (no role change), but the
// module must resolve.
vi.mock("@workspace/resupply-auth", () => ({
  inviteTeamMember: vi.fn(),
  revokeTeamMember: vi.fn(),
  updateTeamMemberRole: vi.fn(async () => undefined),
}));
vi.mock("../../lib/auth-deps", () => ({ getAuthDeps: () => ({}) }));

import teamRouter from "./team";

const MEMBER_ID = "33333333-3333-4333-8333-333333333333";
const LOCATION = "99999999-9999-4999-8999-999999999999";
const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@penn.example.com",
  role: "admin",
};

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(teamRouter);
  return app;
}

// A full admin_users row shape the update RETURNING + serializer expect.
function memberRow(over: Record<string, unknown> = {}) {
  return {
    id: MEMBER_ID,
    email_lower: "csr@penn.example.com",
    auth_user_id: null,
    role: "csr",
    status: "active",
    display_name: "Casey CSR",
    notes: null,
    invited_by: null,
    invited_at: "2026-01-01T00:00:00.000Z",
    accepted_at: "2026-01-02T00:00:00.000Z",
    revoked_at: null,
    revoked_by: null,
    last_login_at: null,
    location_id: LOCATION,
    ...over,
  };
}

beforeEach(() => {
  mockAdmin.current = ADMIN;
  supabaseMock.reset();
});

describe("PATCH /admin/team/:id — branch assignment", () => {
  it("assigns an active location and writes location_id", async () => {
    stageSupabaseResponse("locations", "select", {
      data: { id: LOCATION, name: "Pittsburgh", is_active: true },
    });
    stageSupabaseResponse("admin_users", "update", { data: memberRow() });

    const res = await request(makeApp())
      .patch(`/admin/team/${MEMBER_ID}`)
      .send({ locationId: LOCATION });

    expect(res.status).toBe(200);
    expect(res.body.member.locationId).toBe(LOCATION);
    const writes = getSupabaseWritePayloads("admin_users", "update");
    expect(writes[0]).toMatchObject({ location_id: LOCATION });
  });

  it("422s when the location is deactivated and does not write", async () => {
    stageSupabaseResponse("locations", "select", {
      data: { id: LOCATION, name: "Old Branch", is_active: false },
    });

    const res = await request(makeApp())
      .patch(`/admin/team/${MEMBER_ID}`)
      .send({ locationId: LOCATION });

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      error: "invalid_location",
      reason: "inactive",
    });
    expect(getSupabaseWritePayloads("admin_users", "update")).toEqual([]);
  });

  it("clears the assignment with null", async () => {
    stageSupabaseResponse("admin_users", "update", {
      data: memberRow({ location_id: null }),
    });

    const res = await request(makeApp())
      .patch(`/admin/team/${MEMBER_ID}`)
      .send({ locationId: null });

    expect(res.status).toBe(200);
    const writes = getSupabaseWritePayloads("admin_users", "update");
    expect(writes[0]).toMatchObject({ location_id: null });
  });
});
