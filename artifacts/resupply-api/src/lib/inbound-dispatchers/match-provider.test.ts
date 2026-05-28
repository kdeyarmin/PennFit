// Tests for the inbound-referral provider matcher.
//
// Coverage:
//   * Empty NPI → none
//   * exact_npi local hit returns the local provider id
//   * NPPES lookup throws NppesLookupError → kind=none
//   * NPPES lookup unexpected error → kind=none
//   * NPPES lookup returns null → kind=none
//   * NPPES lookup succeeds → INSERT + return kind='nppes_lookup'
//   * 23505 race re-selects existing provider row

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

const NppesLookupErrorClass = vi.hoisted(() => {
  class NppesLookupError extends Error {
    constructor(m = "nppes down") {
      super(m);
      this.name = "NppesLookupError";
    }
  }
  return NppesLookupError;
});

vi.mock("../nppes", () => ({
  NppesLookupError: NppesLookupErrorClass,
  lookupNpi: vi.fn(),
}));

import { matchProvider } from "./match-provider";

beforeEach(() => supabaseMock.reset());

describe("matchProvider", () => {
  it("returns kind='none' for null NPI", async () => {
    const r = await matchProvider({ npi: null });
    expect(r).toEqual({ providerId: null, kind: "none" });
  });

  it("returns kind='exact_npi' on local DB hit", async () => {
    stageSupabaseResponse("providers", "select", { data: { id: "prov_1" } });
    const r = await matchProvider({ npi: "1234567890" });
    expect(r).toEqual({ providerId: "prov_1", kind: "exact_npi" });
  });

  it("returns kind='none' on NppesLookupError", async () => {
    stageSupabaseResponse("providers", "select", { data: null });
    const nppesLookup = vi.fn(async () => {
      throw new NppesLookupErrorClass("503");
    });
    const r = await matchProvider({
      npi: "1234567890",
      nppesLookup: nppesLookup as never,
    });
    expect(r.kind).toBe("none");
  });

  it("returns kind='none' on unexpected NPPES error", async () => {
    stageSupabaseResponse("providers", "select", { data: null });
    const nppesLookup = vi.fn(async () => {
      throw new Error("network down");
    });
    const r = await matchProvider({
      npi: "1234567890",
      nppesLookup: nppesLookup as never,
    });
    expect(r.kind).toBe("none");
  });

  it("returns kind='none' when NPPES returns null", async () => {
    stageSupabaseResponse("providers", "select", { data: null });
    const nppesLookup = vi.fn(async () => null);
    const r = await matchProvider({
      npi: "1234567890",
      nppesLookup: nppesLookup as never,
    });
    expect(r.kind).toBe("none");
  });

  it("inserts a providers row and returns kind='nppes_lookup' on NPPES hit", async () => {
    stageSupabaseResponse("providers", "select", { data: null });
    stageSupabaseResponse("providers", "insert", {
      data: { id: "prov_new" },
    });
    const nppesLookup = vi.fn(async () => ({
      npi: "1234567890",
      legalName: "Dr Test",
      taxonomyCode: "207Q00000X",
      phoneE164: "+18005550100",
      faxE164: null,
      practiceName: "Test Practice",
      practiceAddress: { line1: "1 Main St", city: "X", state: "PA", zip: "1" },
    }));
    const r = await matchProvider({
      npi: "1234567890",
      nppesLookup: nppesLookup as never,
    });
    expect(r).toEqual({ providerId: "prov_new", kind: "nppes_lookup" });
  });

  it("re-selects existing row on 23505 race", async () => {
    stageSupabaseResponse("providers", "select", { data: null });
    stageSupabaseResponse("providers", "insert", {
      error: { code: "23505", message: "dup" },
    });
    stageSupabaseResponse("providers", "select", {
      data: { id: "prov_raced" },
    });
    const nppesLookup = vi.fn(async () => ({
      npi: "1234567890",
      legalName: "Dr Test",
      taxonomyCode: "207Q",
      phoneE164: null,
      faxE164: null,
      practiceName: null,
      practiceAddress: null,
    }));
    const r = await matchProvider({
      npi: "1234567890",
      nppesLookup: nppesLookup as never,
    });
    expect(r).toEqual({ providerId: "prov_raced", kind: "nppes_lookup" });
  });
});
