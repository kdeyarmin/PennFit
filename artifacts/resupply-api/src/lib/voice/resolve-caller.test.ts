// Unit tests for resolveCallerByPhone — the unified inbound-caller
// resolver (clinical patients first, then cash-pay storefront, with a
// shared-number ambiguity guard on each).

import { beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { resolveCallerByPhone } from "./resolve-caller";

const PATIENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PATIENT_ID = "99999999-9999-4999-8999-999999999999";
const SHOP_CUSTOMER_ID = "cust_abc123";

function sb(): ReturnType<typeof getSupabaseServiceRoleClient> {
  return getSupabaseServiceRoleClient();
}

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveCallerByPhone", () => {
  it("resolves a single patient match and never consults storefront (patients win)", async () => {
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });

    const res = await resolveCallerByPhone(sb(), "+12155550001");

    expect(res).toEqual({ kind: "patient", patientId: PATIENT_ID });
    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
  });

  it("reports ambiguous when a number is on multiple patient accounts", async () => {
    stageSupabaseResponse("patients", "select", {
      data: [{ id: PATIENT_ID }, { id: OTHER_PATIENT_ID }],
    });

    const res = await resolveCallerByPhone(sb(), "+12155550001");

    expect(res).toEqual({ kind: "ambiguous" });
    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
  });

  it("falls through to a storefront match when no patient matches", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", {
      data: [{ customer_id: SHOP_CUSTOMER_ID }],
    });

    const res = await resolveCallerByPhone(sb(), "+12155550002");

    expect(res).toEqual({
      kind: "shop_customer",
      customerId: SHOP_CUSTOMER_ID,
    });
  });

  it("reports ambiguous when a number is on multiple storefront customers", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", {
      data: [{ customer_id: "cust_a" }, { customer_id: "cust_b" }],
    });

    const res = await resolveCallerByPhone(sb(), "+12155550002");

    expect(res).toEqual({ kind: "ambiguous" });
  });

  it("returns none when neither table matches", async () => {
    stageSupabaseResponse("patients", "select", { data: [] });
    stageSupabaseResponse("shop_customers", "select", { data: [] });

    const res = await resolveCallerByPhone(sb(), "+12155550003");

    expect(res).toEqual({ kind: "none" });
  });

  it("normalizes a bare 10-digit NANP number to +1XXXXXXXXXX before querying", async () => {
    stageSupabaseResponse("patients", "select", { data: [{ id: PATIENT_ID }] });

    await resolveCallerByPhone(sb(), "2155550001");

    const phoneFilter = supabaseMock
      .filterCalls("patients", "select")
      .find((c) => c.verb === "eq" && c.args[0] === "phone_e164");
    expect(phoneFilter?.args[1]).toBe("+12155550001");
  });

  it("returns none for an unparseable number without touching the DB", async () => {
    const res = await resolveCallerByPhone(sb(), "1234");

    expect(res).toEqual({ kind: "none" });
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
    expect(supabaseMock.callCount("shop_customers", "select")).toBe(0);
  });

  it("returns none for an empty string without touching the DB", async () => {
    const res = await resolveCallerByPhone(sb(), "");

    expect(res).toEqual({ kind: "none" });
    expect(supabaseMock.callCount("patients", "select")).toBe(0);
  });
});
