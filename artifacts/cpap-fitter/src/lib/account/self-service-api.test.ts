import { describe, expect, test } from "vitest";

import {
  getMembershipOptions,
  startMembershipCheckout,
} from "./self-service-api";

describe("retired cash-pay membership client", () => {
  test("getMembershipOptions throws without calling the network", async () => {
    await expect(getMembershipOptions()).rejects.toThrow(
      /membership_checkout_retired/,
    );
  });

  test("startMembershipCheckout throws without calling the network", async () => {
    await expect(startMembershipCheckout("standard")).rejects.toThrow(
      /membership_checkout_retired/,
    );
  });
});
