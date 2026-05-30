import { describe, it, expect } from "vitest";

import {
  planReminderEscalations,
  ESCALATION_LADDER,
  type EscalationConvRow,
  type EscalationEpisodeRow,
} from "./reminder-escalation";

const NOW = new Date("2026-05-30T12:00:00Z").getTime();
const DAY = 24 * 60 * 60 * 1000;
const DELAY = 3 * DAY;
const MAX = 21 * DAY;

function plan(
  episodes: EscalationEpisodeRow[],
  conversations: EscalationConvRow[],
) {
  return planReminderEscalations({
    episodes,
    conversations,
    nowMs: NOW,
    delayMs: DELAY,
    maxMs: MAX,
    ladder: ESCALATION_LADDER,
  });
}

describe("planReminderEscalations", () => {
  it("escalates SMS-only to email after the delay", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY }],
    );
    expect(actions).toEqual([
      {
        episodeId: "e1",
        patientId: "p1",
        tier: { kind: "send", channel: "email" },
      },
    ]);
  });

  it("escalates email-only to SMS (symmetric ladder)", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY }],
    );
    expect(actions[0]!.tier).toEqual({ kind: "send", channel: "sms" });
  });

  it("hands off to a CSR once both channels are tried", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 8 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY },
      ],
    );
    expect(actions[0]!.tier).toEqual({ kind: "csr_exhausted" });
  });

  it("does not escalate before the delay window", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 1 * DAY }],
    );
    expect(actions).toEqual([]);
  });

  it("stops escalating past the max age", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 30 * DAY }],
    );
    expect(actions).toEqual([]);
  });

  it("ignores episodes that never got a first touch", () => {
    const actions = plan([{ id: "e1", patientId: "p1" }], []);
    expect(actions).toEqual([]);
  });

  it("uses the earliest touch to measure age", () => {
    // Earliest SMS is only 1 day old → too soon, even though a later
    // conversation exists.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 1 * DAY }],
    );
    expect(actions).toEqual([]);
  });

  it("handles multiple episodes independently", () => {
    const actions = plan(
      [
        { id: "e1", patientId: "p1" },
        { id: "e2", patientId: "p2" },
      ],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY },
        { episodeId: "e2", channel: "sms", createdAtMs: NOW - 8 * DAY },
        { episodeId: "e2", channel: "email", createdAtMs: NOW - 4 * DAY },
      ],
    );
    expect(actions).toHaveLength(2);
    const byEpisode = Object.fromEntries(
      actions.map((a) => [a.episodeId, a.tier]),
    );
    expect(byEpisode.e1).toEqual({ kind: "send", channel: "email" });
    expect(byEpisode.e2).toEqual({ kind: "csr_exhausted" });
  });
});
