// Tests for the education-video admin routes (RT #25) — gates + validation.

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

import educationVideosAdminRouter from "./education-videos";

const ADMIN: MockAdminCtx = {
  userId: "u_admin",
  email: "admin@penn.example.com",
  role: "admin",
};
// csr holds reports.read but not admin.tools.manage.
const CSR: MockAdminCtx = {
  userId: "u_csr",
  email: "csr@penn.example.com",
  role: "agent",
  granularRole: "csr",
};
const VID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(educationVideosAdminRouter);
  return app;
}

beforeEach(() => {
  mockAdmin.current = null;
  supabaseMock.reset();
});

describe("GET /admin/education-videos", () => {
  it("401s without admin; lists with reports.read", async () => {
    expect(
      (await request(makeApp()).get("/admin/education-videos")).status,
    ).toBe(401);
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("education_videos", "select", {
      data: [{ id: VID, title: "Fitting your mask", active: true }],
      error: null,
    });
    const res = await request(makeApp()).get("/admin/education-videos");
    expect(res.status).toBe(200);
    expect(res.body.videos).toHaveLength(1);
  });
});

describe("POST /admin/education-videos", () => {
  it("403s a role without admin.tools.manage (csr)", async () => {
    mockAdmin.current = CSR;
    const res = await request(makeApp()).post("/admin/education-videos").send({
      title: "Cleaning",
      topic: "cleaning",
      videoUrl: "https://videos.example.com/clean.mp4",
    });
    expect(res.status).toBe(403);
  });

  it("400s an unknown topic", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp())
      .post("/admin/education-videos")
      .send({ title: "x", topic: "nope", videoUrl: "https://x/v.mp4" });
    expect(res.status).toBe(400);
  });

  it("400s a non-https video URL", async () => {
    mockAdmin.current = ADMIN;
    const res = await request(makeApp()).post("/admin/education-videos").send({
      title: "x",
      topic: "cleaning",
      videoUrl: "http://insecure.example.com/v.mp4",
    });
    expect(res.status).toBe(400);
  });

  it("creates a video with a valid body", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("education_videos", "insert", {
      data: { id: VID },
      error: null,
    });
    const res = await request(makeApp()).post("/admin/education-videos").send({
      title: "Fitting your mask",
      topic: "mask_fitting",
      videoUrl: "https://videos.example.com/fit.mp4",
      durationSeconds: 120,
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(VID);
  });
});

describe("PATCH /admin/education-videos/:id", () => {
  it("deactivates a video", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("education_videos", "update", {
      data: { id: VID },
      error: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/education-videos/${VID}`)
      .send({ active: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("404s an unknown id", async () => {
    mockAdmin.current = ADMIN;
    stageSupabaseResponse("education_videos", "update", {
      data: null,
      error: null,
    });
    const res = await request(makeApp())
      .patch(`/admin/education-videos/${VID}`)
      .send({ active: false });
    expect(res.status).toBe(404);
  });
});
