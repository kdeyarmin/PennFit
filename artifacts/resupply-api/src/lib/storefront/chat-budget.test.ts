// Unit tests for the public-chat global spend ceiling (app-review
// 2026-06-10, P1-7). Pure module-state math — no DB, no vendors.

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetChatBudgetForTests, tryConsumeChatBudget } from "./chat-budget";

beforeEach(() => {
  resetChatBudgetForTests();
  delete process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE;
});

afterEach(() => {
  delete process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE;
});

describe("tryConsumeChatBudget", () => {
  it("allows up to the limit within a window, then refuses", () => {
    process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE = "3";
    const t0 = 1_000_000;
    expect(tryConsumeChatBudget(t0)).toBe(true);
    expect(tryConsumeChatBudget(t0 + 1)).toBe(true);
    expect(tryConsumeChatBudget(t0 + 2)).toBe(true);
    expect(tryConsumeChatBudget(t0 + 3)).toBe(false);
    expect(tryConsumeChatBudget(t0 + 59_999)).toBe(false);
  });

  it("replenishes when the window rolls over", () => {
    process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE = "1";
    const t0 = 1_000_000;
    expect(tryConsumeChatBudget(t0)).toBe(true);
    expect(tryConsumeChatBudget(t0 + 30_000)).toBe(false);
    expect(tryConsumeChatBudget(t0 + 60_000)).toBe(true);
  });

  it("falls back to the default limit on junk env values", () => {
    process.env.RESUPPLY_CHAT_GLOBAL_TURNS_PER_MINUTE = "not-a-number";
    const t0 = 1_000_000;
    // Default is 120 — far more than the couple of turns we try here.
    expect(tryConsumeChatBudget(t0)).toBe(true);
    expect(tryConsumeChatBudget(t0 + 1)).toBe(true);
  });
});
