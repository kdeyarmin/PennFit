// Route tests for POST /shop/me/sleep-study.
//
// Coverage:
//   * 401 without sign-in
//   * 401 when email missing
//   * 400 on invalid body (out-of-range ahi)
//   * 404 when patient lookup misses
//   * 400 when documentId points at another patient's document (IDOR guard)
//   * 400 when documentId does not exist
//   * 201 happy path inserts with source=csr_entry + self-reported note
//   * 409 on 23505 duplicate-study

import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireSignedInMock,
  type MockSignedInProfile,
} from "../../test-helpers/auth-mocks";
import {
  getSupabaseWritePayloads,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const { mockSignedIn } = vi.hoisted(() => ({
  mockSignedIn: {
    current: null as null | string | MockSignedInProfile,
  },
}));
vi.mock("../../middlewares/requireSignedIn", () =>
  makeRequireSignedInMock(mockSignedIn),
);

import sleepStudyRouter from "./me-sleep-study";

const DOC_ID = "11111111-1111-4111-8111-111111111111";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(sleepStudyRouter);
  return app;
}

beforeEach(() => {
  mockSignedIn.current = null;
  supabaseMock.reset();
});

describe("POST /shop/me/sleep-study", () => {
  it("401s without sign-in", async () => {
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({});
    expect(res.status).toBe(401);
  });

  it("401s when email is missing", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: null };
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({});
    expect(res.status).toBe(401);
  });

  it("400s on out-of-range ahi", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 999,
    });
    expect(res.status).toBe(400);
  });

  it("404s when patient lookup misses", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [] });
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 12,
    });
    expect(res.status).toBe(404);
  });

  it("400s (IDOR) when documentId belongs to a different patient", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_documents", "select", {
      data: { id: DOC_ID, patient_id: "p_OTHER" },
    });
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 12,
      documentId: DOC_ID,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_document_id");
  });

  it("400s when documentId doesn't exist", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("patient_documents", "select", { data: null });
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 12,
      documentId: DOC_ID,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_document_id");
  });

  it("201s and persists with csr_entry source on happy path", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("sleep_studies", "insert", {
      data: { id: "study_1" },
    });
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 12.5,
      rdi: 14,
      lowestSpo2Pct: 88,
      facilityName: "Penn Sleep Center",
    });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: "study_1" });
    const writes = getSupabaseWritePayloads("sleep_studies", "insert");
    expect(writes[0]).toMatchObject({
      patient_id: "p_1",
      study_date: "2026-04-01",
      study_type: "hsat",
      ahi: "12.5",
      rdi: "14",
      source: "csr_entry",
    });
    expect((writes[0] as { notes: string }).notes).toMatch(/self-reported/);
  });

  it("409s on 23505 duplicate study", async () => {
    mockSignedIn.current = { customerId: "cust_1", email: "a@a.test" };
    stageSupabaseResponse("patients", "select", { data: [{ id: "p_1" }] });
    stageSupabaseResponse("sleep_studies", "insert", {
      error: { code: "23505", message: "dup" },
    });
    const res = await request(makeApp()).post("/shop/me/sleep-study").send({
      studyDate: "2026-04-01",
      studyType: "hsat",
      ahi: 12,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("duplicate_study");
  });
});
