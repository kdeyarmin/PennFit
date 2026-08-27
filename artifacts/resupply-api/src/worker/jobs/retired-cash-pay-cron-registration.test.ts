import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logCalls = vi.hoisted(() => ({
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("../../lib/logger", () => ({
  logger: logCalls,
}));

import { registerShopOrderDeliveryFollowupJob } from "./shop-order-delivery-followup";
import { registerLapsedCustomerWinbackJob } from "./lapsed-customer-winback";
import { registerDeductibleResetPushJob } from "./deductible-reset-push";

interface BossSpy {
  createQueue: ReturnType<typeof vi.fn>;
  work: ReturnType<typeof vi.fn>;
  schedule: ReturnType<typeof vi.fn>;
  unschedule: ReturnType<typeof vi.fn>;
}

function makeBoss(): BossSpy {
  return {
    createQueue: vi.fn(async () => undefined),
    work: vi.fn(async () => undefined),
    schedule: vi.fn(async () => undefined),
    unschedule: vi.fn(async () => undefined),
  };
}

const ORIGINAL_DELIVERY =
  process.env.RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED;
const ORIGINAL_WINBACK =
  process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED;
const ORIGINAL_DEDUCTIBLE =
  process.env.RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED;

beforeEach(() => {
  logCalls.info.mockReset();
  logCalls.error.mockReset();
  logCalls.warn.mockReset();
  delete process.env.RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED;
  delete process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED;
  delete process.env.RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED;
});

afterEach(() => {
  if (ORIGINAL_DELIVERY === undefined) {
    delete process.env.RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED;
  } else {
    process.env.RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED =
      ORIGINAL_DELIVERY;
  }
  if (ORIGINAL_WINBACK === undefined) {
    delete process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED;
  } else {
    process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED =
      ORIGINAL_WINBACK;
  }
  if (ORIGINAL_DEDUCTIBLE === undefined) {
    delete process.env.RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED;
  } else {
    process.env.RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED =
      ORIGINAL_DEDUCTIBLE;
  }
});

describe("shop-order.delivery-followup cron registration", () => {
  it("is a no-op unless RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED=1", async () => {
    const boss = makeBoss();
    await registerShopOrderDeliveryFollowupJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.unschedule).toHaveBeenCalledWith(
      "shop-order.delivery-followup",
    );
  });

  it("registers when the env flag is enabled", async () => {
    process.env.RESUPPLY_SHOP_DELIVERY_FOLLOWUP_CRON_ENABLED = "1";
    const boss = makeBoss();
    await registerShopOrderDeliveryFollowupJob(boss as never);
    expect(boss.work).toHaveBeenCalledWith(
      "shop-order.delivery-followup",
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalled();
  });
});

describe("shop-customers.winback cron registration", () => {
  it("is a no-op unless RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED=1", async () => {
    const boss = makeBoss();
    await registerLapsedCustomerWinbackJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.unschedule).toHaveBeenCalledWith("shop-customers.winback");
  });

  it("registers when the env flag is enabled", async () => {
    process.env.RESUPPLY_LAPSED_CUSTOMER_WINBACK_CRON_ENABLED = "1";
    const boss = makeBoss();
    await registerLapsedCustomerWinbackJob(boss as never);
    expect(boss.work).toHaveBeenCalledWith(
      "shop-customers.winback",
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalled();
  });
});

describe("shop-customers.deductible-reset cron registration", () => {
  it("is a no-op unless RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED=1", async () => {
    const boss = makeBoss();
    await registerDeductibleResetPushJob(boss as never);
    expect(boss.createQueue).not.toHaveBeenCalled();
    expect(boss.work).not.toHaveBeenCalled();
    expect(boss.schedule).not.toHaveBeenCalled();
    expect(boss.unschedule).toHaveBeenCalledWith(
      "shop-customers.deductible-reset",
    );
  });

  it("registers when the env flag is enabled", async () => {
    process.env.RESUPPLY_DEDUCTIBLE_RESET_PUSH_CRON_ENABLED = "1";
    const boss = makeBoss();
    await registerDeductibleResetPushJob(boss as never);
    expect(boss.work).toHaveBeenCalledWith(
      "shop-customers.deductible-reset",
      expect.any(Function),
    );
    expect(boss.schedule).toHaveBeenCalled();
  });
});
