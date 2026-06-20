import { describe, expect, it } from "vitest";

import {
  CUSTOMER_ACTIVE_LOOKBACK_DAYS,
  CUSTOMER_LAPSED_DAYS,
  WINBACK_COOLDOWN_DAYS,
  classifyCustomerRecency,
} from "./customer-recency";

describe("customer recency windows", () => {
  it("keeps the shared windows in one place", () => {
    expect(CUSTOMER_LAPSED_DAYS).toBe(180);
    expect(WINBACK_COOLDOWN_DAYS).toBe(365);
    expect(CUSTOMER_ACTIVE_LOOKBACK_DAYS).toBe(730);
  });
});

describe("classifyCustomerRecency", () => {
  it("classifies by days since last paid order", () => {
    expect(classifyCustomerRecency(30)).toBe("active");
    expect(classifyCustomerRecency(180)).toBe("active"); // boundary inclusive
    expect(classifyCustomerRecency(181)).toBe("lapsed");
    expect(classifyCustomerRecency(730)).toBe("lapsed"); // boundary inclusive
    expect(classifyCustomerRecency(731)).toBe("stale");
  });

  it("treats a never-ordered customer as stale", () => {
    expect(classifyCustomerRecency(null)).toBe("stale");
  });

  it("honors custom thresholds", () => {
    expect(
      classifyCustomerRecency(100, { lapsedDays: 90, staleDays: 365 }),
    ).toBe("lapsed");
  });
});
