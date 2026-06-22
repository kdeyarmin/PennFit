import { describe, expect, it } from "vitest";

import { deliveryFailureThreshold } from "./delivery-failure-monitor";

describe("deliveryFailureThreshold", () => {
  it("defaults to 5 when unset", () => {
    expect(deliveryFailureThreshold({})).toBe(5);
  });

  it("reads a valid override", () => {
    expect(
      deliveryFailureThreshold({
        RESUPPLY_DELIVERY_FAILURE_ALERT_THRESHOLD: "12",
      }),
    ).toBe(12);
  });

  it("falls back to the default on a non-numeric or <1 value", () => {
    expect(
      deliveryFailureThreshold({
        RESUPPLY_DELIVERY_FAILURE_ALERT_THRESHOLD: "nope",
      }),
    ).toBe(5);
    expect(
      deliveryFailureThreshold({
        RESUPPLY_DELIVERY_FAILURE_ALERT_THRESHOLD: "0",
      }),
    ).toBe(5);
  });
});
