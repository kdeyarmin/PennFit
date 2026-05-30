// Tests for recordFitterLead — the best-effort DB persistence helper
// for the POST /shop/fitter-leads route.
//
// Covers:
//   * happy path — insert returns a row id
//   * null data returned from the DB (no-RETURNING or conflict)
//   * supabase error propagated through the try/catch
//   * non-Error thrown value (plain object from PostgREST)
//   * correct column mapping: all four input fields reach the DB

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { recordFitterLead } from "./fitter-lead-record";

beforeEach(() => {
  supabaseMock.reset();
});

const BASE_INPUT = {
  email: "alice@example.com",
  marketingOptIn: true,
  submitterIp: "1.2.3.4",
  userAgent: "Mozilla/5.0",
};

describe("recordFitterLead", () => {
  it("returns the row id on a successful insert", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: { id: "fl_abc123" },
    });
    const result = await recordFitterLead(BASE_INPUT);
    expect(result).toEqual({ id: "fl_abc123" });
  });

  it("returns { id: null } when the DB returns no row (null data)", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: null,
      error: null,
    });
    const result = await recordFitterLead(BASE_INPUT);
    expect(result).toEqual({ id: null });
    // No error property when the insert itself didn't fail
    expect(result.error).toBeUndefined();
  });

  it("catches a Supabase error and returns { id: null, error: message }", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: null,
      error: new Error("unique constraint violation"),
    });
    const result = await recordFitterLead(BASE_INPUT);
    expect(result.id).toBeNull();
    expect(result.error).toBe("unique constraint violation");
  });

  it("handles a non-Error thrown value (PostgREST-style error object)", async () => {
    // PostgREST sometimes returns { message, code, details } without
    // extending Error. recordFitterLead uses String(err) as the fallback.
    stageSupabaseResponse("fitter_leads", "insert", {
      data: null,
      error: { message: "not an Error", code: "23505" },
    });
    const result = await recordFitterLead(BASE_INPUT);
    expect(result.id).toBeNull();
    // The error is not an Error instance, so String(err) is used.
    // Exact format depends on JS engine, but it must be non-empty.
    expect(typeof result.error).toBe("string");
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it("maps input fields to the correct DB column names", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: { id: "fl_col_check" },
    });
    await recordFitterLead({
      email: "test@example.org",
      marketingOptIn: true,
      submitterIp: "10.0.0.1",
      userAgent: "test-agent",
    });
    const payloads = getSupabaseWritePayloads("fitter_leads", "insert");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      email: "test@example.org",
      marketing_opt_in: true,
      submitter_ip: "10.0.0.1",
      user_agent: "test-agent",
    });
  });

  it("passes null submitter_ip and userAgent through to the DB", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: { id: "fl_nulls" },
    });
    await recordFitterLead({
      email: "anon@example.com",
      marketingOptIn: true,
      submitterIp: null,
      userAgent: null,
    });
    const payloads = getSupabaseWritePayloads("fitter_leads", "insert");
    expect(payloads[0]).toMatchObject({
      email: "anon@example.com",
      marketing_opt_in: true,
      submitter_ip: null,
      user_agent: null,
    });
  });

  it("never throws — a DB failure returns a result, not an exception", async () => {
    stageSupabaseResponse("fitter_leads", "insert", {
      data: null,
      error: new Error("connection refused"),
    });
    // Must resolve, not reject
    await expect(recordFitterLead(BASE_INPUT)).resolves.toMatchObject({
      id: null,
    });
  });
});
