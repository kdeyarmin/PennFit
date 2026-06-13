// Tests for resolving SMS recipients for shop-order lifecycle messages.
// The resolver may use a shop customer's email to find a DME patient row,
// but it must refuse duplicate email matches instead of choosing one.

import { beforeEach, describe, expect, it } from "vitest";

import {
  getSupabaseFilterCalls,
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { resolveSmsRecipientForShopOrder } from "./shop-orders-sms-resolver";

const optedInPrefs = { smsTransactional: true };

beforeEach(() => {
  supabaseMock.reset();
});

describe("resolveSmsRecipientForShopOrder", () => {
  it("returns the single matching opted-in patient recipient", async () => {
    stageSupabaseResponse("shop_customers", "select", {
      data: {
        email_lower: "pat@example.com",
        communication_preferences: optedInPrefs,
      },
    });
    stageSupabaseResponse("patients", "select", {
      data: [
        {
          phone_e164: "+15551234567",
          legal_first_name: "Pat",
          timezone: "America/New_York",
          address: { zip: "19104" },
        },
      ],
    });

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
});
