// Tests for stripeErrLogFields — the categorized log-field extractor
// used by the Stripe catalog routes instead of free-text err.message
// (which the log layer redacts on objects, and which a string under
// the `err` key would smuggle past redaction).

import { describe, expect, it } from "vitest";

import { stripeErrLogFields } from "./err-log-fields";

describe("stripeErrLogFields", () => {
  it("extracts the enumerated Stripe identifiers from an SDK error", () => {
    const err = Object.assign(new Error("No such price: 'price_x'"), {
      statusCode: 404,
      code: "resource_missing",
      type: "StripeInvalidRequestError",
      requestId: "req_abc123",
    });
    expect(stripeErrLogFields(err)).toEqual({
      stripeStatus: 404,
      stripeCode: "resource_missing",
      stripeType: "StripeInvalidRequestError",
      stripeRequestId: "req_abc123",
    });
  });

  it("omits fields that are absent or wrongly typed (never invents values)", () => {
    const err = Object.assign(new Error("boom"), {
      statusCode: "502", // string, not number → dropped
      code: 42, // number, not string → dropped
    });
    expect(stripeErrLogFields(err)).toEqual({});
  });

  it("returns no fields for non-object throws", () => {
    expect(stripeErrLogFields("stripe is down")).toEqual({});
    expect(stripeErrLogFields(null)).toEqual({});
    expect(stripeErrLogFields(undefined)).toEqual({});
  });

  it("never copies the free-text message into the result", () => {
    const err = Object.assign(new Error("postgres://user:pw@host/db"), {
      statusCode: 500,
    });
    const fields = stripeErrLogFields(err);
    expect(JSON.stringify(fields)).not.toContain("postgres://");
    expect(fields).toEqual({ stripeStatus: 500 });
  });
});
