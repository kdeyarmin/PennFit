import { describe, expect, it } from "vitest";

import { DEFAULT_COMMUNICATION_PREFERENCES } from "@workspace/resupply-db";

import {
  decideSignatureChannels,
  dueSignatureReminder,
  reminderTargetChanged,
  signatureLinkExpired,
} from "./reminder-policy";

const DAY = "2026-06-02T15:00:00.000Z";
const NIGHT = "2026-06-02T07:00:00.000Z";

describe("signature reminder policy", () => {
  it("sends the 24h reminder first when both windows are already open", () => {
    const now = new Date("2026-06-04T15:00:00.000Z");
    expect(
      dueSignatureReminder({
        sentAt: "2026-06-02T00:00:00.000Z",
        now,
        reminder24At: null,
        reminder48At: null,
      }),
    ).toBe(24);
    expect(
      dueSignatureReminder({
        sentAt: "2026-06-02T00:00:00.000Z",
        now,
        reminder24At: "2026-06-03T00:00:00.000Z",
        reminder48At: null,
      }),
    ).toBe(48);
  });

  it("treats a new order or link version as unreminded", () => {
    expect(
      reminderTargetChanged({
        reminderOrderId: "order-1",
        reminderLinkVersion: 1,
        orderId: "order-1",
        linkVersion: 2,
      }),
    ).toBe(true);
    expect(
      reminderTargetChanged({
        reminderOrderId: "order-1",
        reminderLinkVersion: 1,
        orderId: "order-1",
        linkVersion: 1,
      }),
    ).toBe(false);
  });

  it("does not chase an expired link", () => {
    const now = new Date(DAY);
    expect(signatureLinkExpired("2026-06-01T00:00:00.000Z", now)).toBe(true);
    expect(signatureLinkExpired("2026-06-03T00:00:00.000Z", now)).toBe(false);
    expect(signatureLinkExpired(null, now)).toBe(false);
  });

  it("sends nothing when the preference lookup fails", () => {
    expect(
      decideSignatureChannels({
        email: "a@example.com",
        phone: "+15555550100",
        explicit: false,
        unknown: true,
        prefs: DEFAULT_COMMUNICATION_PREFERENCES,
        now: new Date(DAY),
        patientTimezone: "America/New_York",
      }),
    ).toEqual({ allowEmail: false, allowSms: false, defer: true });
  });

  it("texts a phone on the order only inside the send window when no preference is stored", () => {
    const base = {
      email: null as string | null,
      phone: "+15555550100",
      explicit: false,
      unknown: false,
      prefs: {
        ...DEFAULT_COMMUNICATION_PREFERENCES,
        timezone: "America/New_York",
      },
      patientTimezone: "America/New_York",
    };
    expect(
      decideSignatureChannels({ ...base, now: new Date(NIGHT) }).allowSms,
    ).toBe(false);
    expect(
      decideSignatureChannels({ ...base, now: new Date(DAY) }).allowSms,
    ).toBe(true);
  });

  it("honors an explicit transactional refusal", () => {
    const decision = decideSignatureChannels({
      email: "a@example.com",
      phone: "+15555550100",
      explicit: true,
      unknown: false,
      prefs: { ...DEFAULT_COMMUNICATION_PREFERENCES, smsTransactional: false },
      now: new Date(DAY),
      patientTimezone: "America/New_York",
    });
    expect(decision.allowEmail).toBe(true);
    expect(decision.allowSms).toBe(false);
  });
});
