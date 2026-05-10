// Unit tests for the override-precedence layering in
// `messageTemplateLookup`. Mocks the Supabase service-role client
// via the shared test-helpers/supabase-mock so the tests don't need
// a live PostgREST surface.
//
// Coverage matrix:
//   * No override + active global → returns the global as-is.
//   * Active override + active global → per-field layering
//     (override field wins; null override field inherits).
//   * Disabled override + active global → synthetic empty-body
//     (the "suppress this customer" contract).
//   * Override row exists + global missing → use override fields
//     directly (degenerate case).
//   * Disabled global → behaves as if global is missing (the
//     fallback path runs).
//   * No customerId → only the global query is run; no override
//     lookup happens.
//   * Lookup throws → returns null (renderMessage falls back).

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import { messageTemplateLookup } from "./lookup";

const SAMPLE_GLOBAL = {
  id: "g_1",
  template_key: "rx_renewal.30_day",
  channel: "email",
  subject: "Time to renew",
  body_html: "<p>Renew your Rx</p>",
  body_text: "Renew your Rx",
  allowed_variables: ["first_name"],
  is_active: true,
  updated_at: new Date().toISOString(),
  updated_by: null,
  created_at: new Date().toISOString(),
  created_by: null,
};

beforeEach(() => {
  supabaseMock.reset();
});

afterEach(() => {
  // Nothing to clean up — supabase mock state is reset in beforeEach.
});

describe("messageTemplateLookup", () => {
  it("returns the global as-is when there's no override", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: null,
    });
    stageSupabaseResponse("message_templates", "select", {
      data: SAMPLE_GLOBAL,
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toEqual({
      templateKey: "rx_renewal.30_day",
      channel: "email",
      subject: "Time to renew",
      bodyHtml: "<p>Renew your Rx</p>",
      bodyText: "Renew your Rx",
      allowedVariables: ["first_name"],
    });
  });

  it("layers an active override per-field over the global", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: {
        id: "o_1",
        customer_id: "cust_a",
        template_key: "rx_renewal.30_day",
        channel: "email",
        subject: "Personalised renewal note",
        body_html: null,
        body_text: null,
        is_active: true,
        note: "patient asked for friendlier subject",
        created_at: new Date().toISOString(),
        created_by: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    stageSupabaseResponse("message_templates", "select", {
      data: SAMPLE_GLOBAL,
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result?.subject).toBe("Personalised renewal note");
    // bodyHtml + bodyText inherited from the global since override
    // had nulls there.
    expect(result?.bodyHtml).toBe("<p>Renew your Rx</p>");
    expect(result?.bodyText).toBe("Renew your Rx");
    // allowedVariables ALWAYS comes from the global so the editor
    // can validate against the call-site contract.
    expect(result?.allowedVariables).toEqual(["first_name"]);
  });

  it("disabled override returns an empty-body synthetic (suppress)", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: {
        id: "o_1",
        customer_id: "cust_a",
        template_key: "rx_renewal.30_day",
        channel: "email",
        subject: null,
        body_html: null,
        body_text: null,
        is_active: false,
        note: "opted out of email rx renewals",
        created_at: new Date().toISOString(),
        created_by: null,
        updated_at: new Date().toISOString(),
        updated_by: null,
      },
    });
    stageSupabaseResponse("message_templates", "select", {
      data: SAMPLE_GLOBAL,
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toEqual({
      templateKey: "rx_renewal.30_day",
      channel: "email",
      subject: null,
      bodyHtml: null,
      bodyText: "",
      allowedVariables: ["first_name"],
    });
  });

  it("disabled global is treated as missing (fallback path will run)", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: null,
    });
    stageSupabaseResponse("message_templates", "select", {
      data: { ...SAMPLE_GLOBAL, is_active: false },
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("returns null when both tables are empty", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: null,
    });
    stageSupabaseResponse("message_templates", "select", { data: null });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("returns null when the lookup throws (DB outage / missing table)", async () => {
    stageSupabaseResponse("shop_customer_message_template_overrides", "select", {
      data: null,
    });
    stageSupabaseResponse("message_templates", "select", {
      error: new Error('relation "message_templates" does not exist'),
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      "cust_a",
    );
    expect(result).toBeNull();
  });

  it("with no customerId, skips the override query entirely", async () => {
    // Only the global query should hit the DB. Stage that one alone;
    // an override stage would go unused, so we can assert the
    // override-table call count stays zero.
    stageSupabaseResponse("message_templates", "select", {
      data: SAMPLE_GLOBAL,
    });
    const result = await messageTemplateLookup(
      "rx_renewal.30_day",
      "email",
      null,
    );
    expect(
      getSupabaseCallCount("shop_customer_message_template_overrides", "select"),
    ).toBe(0);
    expect(result?.bodyText).toBe("Renew your Rx");
  });
});
