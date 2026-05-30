// Unit tests for the return auto-approval rule layer (A4).
//
// Pure-function helper, so the tests don't touch the DB or HTTP —
// just assert the policy boundary one case at a time.

import { describe, it, expect } from "vitest";

import type { ShopReturnReason } from "@workspace/resupply-db";

import {
  AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS,
  AUTO_APPROVE_ORDER_VALUE_CAP_CENTS,
  AUTO_APPROVE_PRIOR_RETURN_CAP,
  AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS,
  evaluateAutoApprovalRules,
  formatAutoApprovalNote,
} from "./auto-approval-rules";

function input(
  over: Partial<Parameters<typeof evaluateAutoApprovalRules>[0]>,
): Parameters<typeof evaluateAutoApprovalRules>[0] {
  return {
    reason: "defective" as ShopReturnReason,
    ageDays: 1,
    priorApprovedReturnsLast90d: 0,
    orderValueCents: 0,
    ...over,
  };
}

describe("evaluateAutoApprovalRules — defective_within_7d", () => {
  it("auto-approves a fresh defective claim", () => {
    expect(
      evaluateAutoApprovalRules(input({ reason: "defective", ageDays: 0 })),
    ).toEqual({
      autoApprove: true,
      rule: "defective_within_7d",
    });
  });

  it("auto-approves a defective claim exactly at the boundary", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS,
        }),
      ),
    ).toEqual({ autoApprove: true, rule: "defective_within_7d" });
  });

  it("does NOT auto-approve a defective claim past the boundary", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: AUTO_APPROVE_DEFECTIVE_MAX_AGE_DAYS + 0.5,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });
});

describe("evaluateAutoApprovalRules — wrong_item_within_30d", () => {
  it("auto-approves a fresh wrong-item claim", () => {
    expect(
      evaluateAutoApprovalRules(input({ reason: "wrong_item", ageDays: 3 })),
    ).toEqual({ autoApprove: true, rule: "wrong_item_within_30d" });
  });

  it("auto-approves wrong-item at the boundary", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "wrong_item",
          ageDays: AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS,
        }),
      ),
    ).toEqual({ autoApprove: true, rule: "wrong_item_within_30d" });
  });

  it("does NOT auto-approve wrong-item past the boundary", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "wrong_item",
          ageDays: AUTO_APPROVE_WRONG_ITEM_MAX_AGE_DAYS + 1,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });
});

describe("evaluateAutoApprovalRules — manual-queue reasons", () => {
  const manualReasons: ShopReturnReason[] = [
    "fit",
    "no_longer_needed",
    "other",
  ];
  for (const reason of manualReasons) {
    it(`does NOT auto-approve reason="${reason}" regardless of age`, () => {
      expect(evaluateAutoApprovalRules(input({ reason, ageDays: 0 }))).toEqual({
        autoApprove: false,
        rule: null,
      });
      expect(evaluateAutoApprovalRules(input({ reason, ageDays: 30 }))).toEqual(
        { autoApprove: false, rule: null },
      );
    });
  }
});

describe("evaluateAutoApprovalRules — fraud cap", () => {
  it("falls through to manual when prior returns >= cap", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: 1,
          priorApprovedReturnsLast90d: AUTO_APPROVE_PRIOR_RETURN_CAP,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });

  it("still auto-approves when prior returns == cap - 1", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: 1,
          priorApprovedReturnsLast90d: AUTO_APPROVE_PRIOR_RETURN_CAP - 1,
        }),
      ),
    ).toEqual({ autoApprove: true, rule: "defective_within_7d" });
  });

  it("falls through to manual when prior returns > cap", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "wrong_item",
          ageDays: 5,
          priorApprovedReturnsLast90d: AUTO_APPROVE_PRIOR_RETURN_CAP + 10,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });
});

describe("evaluateAutoApprovalRules — high-value order guard", () => {
  it("falls through to manual when orderValueCents exceeds the cap", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: 1,
          orderValueCents: AUTO_APPROVE_ORDER_VALUE_CAP_CENTS + 1,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });

  it("falls through to manual when orderValueCents is exactly at the cap", () => {
    // Inclusive: the policy text says "$500+ orders are queued", so a
    // $500.00 exact order must route to manual review, not auto-approve.
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: 1,
          orderValueCents: AUTO_APPROVE_ORDER_VALUE_CAP_CENTS,
        }),
      ),
    ).toEqual({ autoApprove: false, rule: null });
  });

  it("auto-approves just below the cap", () => {
    expect(
      evaluateAutoApprovalRules(
        input({
          reason: "defective",
          ageDays: 1,
          orderValueCents: AUTO_APPROVE_ORDER_VALUE_CAP_CENTS - 1,
        }),
      ),
    ).toEqual({ autoApprove: true, rule: "defective_within_7d" });
  });

  it("orderValueCents=0 (unknown) does not trip the cap", () => {
    expect(
      evaluateAutoApprovalRules(
        input({ reason: "wrong_item", ageDays: 5, orderValueCents: 0 }),
      ),
    ).toEqual({ autoApprove: true, rule: "wrong_item_within_30d" });
  });
});

describe("formatAutoApprovalNote", () => {
  it("includes the timestamp, the system marker, and the rule name", () => {
    const note = formatAutoApprovalNote({
      rule: "defective_within_7d",
      nowIso: "2026-05-21T12:00:00.000Z",
    });
    expect(note).toBe(
      "[2026-05-21T12:00:00.000Z] system — Auto-approved by rule: defective_within_7d",
    );
  });

  it("matches the shape of appendNote() so the admin_note column reads consistently", () => {
    // The human admin-approve path writes
    //   `[<iso>] <adminUserId|system> — <action>[: <note>]`
    // via lib/.../appendNote(). We don't import that helper to avoid
    // a cycle, but we mirror the format. This test pins the format
    // contract so a future change to appendNote() requires updating
    // both sides.
    const note = formatAutoApprovalNote({
      rule: "wrong_item_within_30d",
      nowIso: "2026-05-21T12:00:00.000Z",
    });
    expect(note).toMatch(/^\[[^\]]+\] system — /);
  });
});
