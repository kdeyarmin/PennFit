import { describe, expect, it } from "vitest";

import {
  composeReminder,
  pickReminderTarget,
  type ReminderVisitRow,
} from "./video-visit-reminders";

function visit(overrides: Partial<ReminderVisitRow>): ReminderVisitRow {
  return {
    id: "v1",
    link_version: 1,
    scheduled_at: "2026-06-12T15:00:00.000Z",
    invite_channel: null,
    guest_name: null,
    guest_email: null,
    guest_phone_e164: null,
    patients: {
      status: "active",
      email: "Pat@Example.com",
      phone_e164: "+18145550100",
      legal_first_name: "Pat",
    },
    ...overrides,
  };
}

describe("pickReminderTarget", () => {
  it("prefers SMS for an active patient with a phone", () => {
    expect(pickReminderTarget(visit({}))).toEqual({
      channel: "sms",
      to: "+18145550100",
      firstName: "Pat",
    });
  });

  it("honors an email invite_channel preference", () => {
    expect(pickReminderTarget(visit({ invite_channel: "email" }))).toEqual({
      channel: "email",
      to: "pat@example.com",
      firstName: "Pat",
    });
  });

  it("never picks SMS for a non-active patient (STOP opt-out) — falls back to email", () => {
    const target = pickReminderTarget(
      visit({
        patients: {
          status: "paused",
          email: "pat@example.com",
          phone_e164: "+18145550100",
          legal_first_name: "Pat",
        },
      }),
    );
    expect(target).toEqual({
      channel: "email",
      to: "pat@example.com",
      firstName: "Pat",
    });
  });

  it("returns null when a non-active patient has no email", () => {
    expect(
      pickReminderTarget(
        visit({
          patients: {
            status: "paused",
            email: null,
            phone_e164: "+18145550100",
            legal_first_name: "Pat",
          },
        }),
      ),
    ).toBeNull();
  });

  it("uses guest contact info for no-chart visits", () => {
    const target = pickReminderTarget(
      visit({
        patients: null,
        guest_name: "Jordan Smith",
        guest_phone_e164: "+18145550199",
      }),
    );
    expect(target).toEqual({
      channel: "sms",
      to: "+18145550199",
      firstName: "Jordan",
    });
  });

  it("returns null for a link-only visit with no contact at all", () => {
    expect(
      pickReminderTarget(visit({ patients: null, guest_name: "Jordan Smith" })),
    ).toBeNull();
  });
});

describe("composeReminder", () => {
  it("includes the greeting, practice, start time, and link in every format", () => {
    const msg = composeReminder({
      firstName: "Pat",
      practiceName: "PennPaps",
      scheduledAt: "2026-06-12T15:00:00.000Z",
      link: "https://pennpaps.com/video-visit?token=abc",
    });
    for (const body of [msg.sms, msg.text, msg.html]) {
      expect(body).toContain("Pat");
      expect(body).toContain("PennPaps");
      expect(body).toContain("https://pennpaps.com/video-visit?token=abc");
    }
    // No PHI in the subject line.
    expect(msg.subject).not.toContain("Pat");
  });

  it("falls back to a generic greeting without a first name", () => {
    const msg = composeReminder({
      firstName: null,
      practiceName: "PennPaps",
      scheduledAt: "2026-06-12T15:00:00.000Z",
      link: "https://x.test/v",
    });
    expect(msg.sms).toContain("Hi there");
  });
});
