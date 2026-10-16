import { describe, expect, it } from "vitest";

import { escapeIlikeExact, uniquePatientIdsByEmail } from "./email-match";
import {
  chooseSetupOrder,
  isMachineFulfillment,
  orderHasE0601,
} from "./machine-order";
import { e0601PriorAuthRequired } from "./prior-auth";

describe("setup email matching", () => {
  it("escapes ilike wildcards", () => {
    expect(escapeIlikeExact("alex_jones@example.com")).toBe(
      "alex\\_jones@example.com",
    );
    expect(escapeIlikeExact("a%b")).toBe("a\\%b");
  });

  it("drops an email shared by two charts", () => {
    const index = uniquePatientIdsByEmail([
      { id: "a", email: "Alex@example.com" },
      { id: "b", email: "alex@example.com" },
      { id: "c", email: "only@example.com" },
    ]);
    expect(index.get("alex@example.com")).toBeUndefined();
    expect(index.get("only@example.com")).toBe("c");
  });
});

describe("setup order association", () => {
  const machine = {
    id: "order-1",
    status: "sent",
    created_at: "2026-06-02T00:00:00.000Z",
    items: [{ description: "CPAP device (E0601)", sku: "AIR11" }],
  };

  it("keeps the linked E0601 order", () => {
    expect(
      chooseSetupOrder({
        linkedOrderId: "order-1",
        openedAt: "2026-06-01T00:00:00.000Z",
        orders: [
          machine,
          {
            id: "older",
            status: "signed",
            created_at: "2026-01-01T00:00:00.000Z",
            items: [{ description: "CPAP device (E0601)", sku: "OLD" }],
          },
        ],
      }),
    ).toBe("order-1");
  });

  it("does not guess when two unbound machine orders exist", () => {
    expect(
      chooseSetupOrder({
        linkedOrderId: null,
        openedAt: "2026-06-01T00:00:00.000Z",
        orders: [
          machine,
          { ...machine, id: "order-2", created_at: "2026-06-03T00:00:00.000Z" },
        ],
      }),
    ).toBeNull();
  });

  it("ignores a filter fulfillment on the machine order", () => {
    expect(orderHasE0601(machine.items)).toBe(true);
    expect(isMachineFulfillment("FILTER", machine.items)).toBe(false);
    expect(isMachineFulfillment("AIR11", machine.items)).toBe(true);
    expect(isMachineFulfillment("E0601", [])).toBe(true);
  });
});

describe("E0601 prior auth", () => {
  it("follows the payer flag and the eligibility result", () => {
    expect(
      e0601PriorAuthRequired({
        payerRequiresPriorAuthDme: false,
        eligibilityRequiresPriorAuth: null,
      }),
    ).toBe(false);
    expect(
      e0601PriorAuthRequired({
        payerRequiresPriorAuthDme: true,
        eligibilityRequiresPriorAuth: false,
      }),
    ).toBe(true);
    expect(
      e0601PriorAuthRequired({
        payerRequiresPriorAuthDme: false,
        eligibilityRequiresPriorAuth: true,
      }),
    ).toBe(true);
  });
});
