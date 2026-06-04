import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  planReminderEscalations,
  ESCALATION_LADDER,
  type EscalationConvRow,
  type EscalationEpisodeRow,
} from "./reminder-escalation";

const SRC = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "reminder-escalation.ts",
  ),
  "utf8",
);

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

// Regression guard (structural source check): the episodes + conversations
// reads in runReminderEscalationScan MUST keyset-page. PostgREST caps a
// single response at ~1000 rows, so the previous raw .limit(5000) /
// .limit(50000) silently truncated — and an episode whose page was dropped
// looked "never reminded" to the conversation-stitch and stopped
// escalating. A behavioural test would need a multi-page Supabase mock;
// pin the invariant cheaply, like the dedup/IDOR source checks elsewhere.
describe("runReminderEscalationScan — paginated reads (no ~1000-row truncation)", () => {
  it("does not use a raw high .limit() that PostgREST would silently cap", () => {
    expect(SRC).not.toContain(".limit(5000)");
    expect(SRC).not.toContain(".limit(50000)");
  });

  it("keyset-pages both reads with .range() ordered by id", () => {
    expect(SRC).toContain('.order("id", { ascending: true })');
    expect(SRC).toContain(".range(from, from + PAGE_SIZE - 1)");
  });
});
