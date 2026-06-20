// resolveSmsRecipientForShopOrder — recipient resolution + the
// exactly-one patient ambiguity guard.
//
// The email → patients walk must return the phone ONLY when a single
// patient matches the shop_customer email. Two patients sharing an
// email is unresolvable ambiguity: picking one arbitrarily could text
// the wrong patient's phone (cross-patient PHI exposure). The resolver
// must return null (email-only fallback) in that case.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolveSmsRecipientForShopOrder } from "./shop-orders-sms-resolver";

const optedInPrefs = { smsTransactional: true };

const OPTED_IN_CUSTOMER = {
  email_lower: "pat@example.com",
  communication_preferences: optedInPrefs,
};

const PATIENT_ROW = {
  phone_e164: "+15551234567",
  legal_first_name: "Pat",
  timezone: "America/New_York",
  address: { zip: "19104" },
};

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveSmsRecipientForShopOrder", () => {
  it("returns the single matching opted-in patient recipient", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", { data: [PATIENT_ROW] });

    const result = await resolveSmsRecipientForShopOrder({
      customerId: "cust-1",
      customerEmailFromOrder: null,
    });

    expect(result).toEqual({
      phoneE164: "+15551234567",
      patientFirstName: "Pat",
      timezone: "America/New_York",
      zip: "19104",
    });
  });

  it("returns null when the email matches more than one patient", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "shared@example.com",
        communication_preferences: optedInPrefs,
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          phone_e164: "+15550000001",
          legal_first_name: "Pat",
          timezone: null,
          address: null,
        },
        {
          phone_e164: "+15550000002",
          legal_first_name: "Sam",
          timezone: null,
          address: null,
        },
      ],
    });

    const result = await resolveSmsRecipientForShopOrder({
      customerId: "cust-1",
      customerEmailFromOrder: null,
    });

    expect(result).toBeNull();
    expect(getSupabaseFilterCalls("patients", "select")).toContainEqual({
      verb: "limit",
      args: [2],
    });
  });

  it("returns null when no patient matches the email", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", { data: [] });

    const result = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when the matched patient has no phone", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ ...PATIENT_ROW, phone_e164: null }],
    });

    const result = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(result).toBeNull();
  });

  it("returns null when smsTransactional is opted out", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "pat@example.com",
        communication_preferences: { smsTransactional: false },
      },
    });

    const result = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(result).toBeNull();
  });
});
