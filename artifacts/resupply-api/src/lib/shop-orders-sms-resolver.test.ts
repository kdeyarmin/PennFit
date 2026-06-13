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
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolveSmsRecipientForShopOrder } from "./shop-orders-sms-resolver";

const OPTED_IN_CUSTOMER = {
  email_lower: "pat@example.com",
  communication_preferences: { smsTransactional: true },
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
  it("returns the phone when exactly one patient matches the email", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", { data: [PATIENT_ROW] });

    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(recipient).toEqual({
      phoneE164: "+15551234567",
      patientFirstName: "Pat",
      timezone: "America/New_York",
      zip: "19104",
    });
  });

  it("returns null when MULTIPLE patients share the email (ambiguity guard)", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", {
      data: [PATIENT_ROW, { ...PATIENT_ROW, phone_e164: "+15559999999" }],
    });

    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(recipient).toBeNull();
  });

  it("returns null when no patient matches the email", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", { data: [] });

    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(recipient).toBeNull();
  });

  it("returns null when the matched patient has no phone", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: OPTED_IN_CUSTOMER,
    });
    stageSupabaseResponse("patients", "select", {
      data: [{ ...PATIENT_ROW, phone_e164: null }],
    });

    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(recipient).toBeNull();
  });

  it("returns null when smsTransactional is opted out", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "pat@example.com",
        communication_preferences: { smsTransactional: false },
      },
    });

    const recipient = await resolveSmsRecipientForShopOrder({
      customerId: "cust_1",
      customerEmailFromOrder: null,
    });
    expect(recipient).toBeNull();
  });
});
