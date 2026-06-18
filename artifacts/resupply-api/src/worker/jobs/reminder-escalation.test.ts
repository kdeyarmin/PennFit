import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  planReminderEscalations,
  ESCALATION_LADDER,
  ESCALATION_LADDER_WITH_VOICE,
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
  ladder: readonly string[] = ESCALATION_LADDER,
) {
  return planReminderEscalations({
    episodes,
    conversations,
    nowMs: NOW,
    delayMs: DELAY,
    maxMs: MAX,
    ladder,
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
        // email is the last untried channel in the base [sms, email] ladder,
        // so it carries the "final" copy variant.
        tier: { kind: "send", channel: "email", variant: "final" },
      },
    ]);
  });

  it("escalates email-only to SMS (symmetric ladder)", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY }],
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "sms",
      variant: "final",
    });
  });

  it("hands off to a CSR once both channels are tried", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 8 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY },
      ],
    );
    expect(actions[0]!.tier).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["sms", "email"],
    });
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

  it("uses the max-age cap against the earliest touch", () => {
    // Earliest touch is 30 days old (past the 21-day max) even though a
    // later touch exists 2 days ago — we stop nagging on the FIRST-touch age.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 30 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 2 * DAY },
      ],
    );
    expect(actions).toEqual([]);
  });

  it("spaces steps out against the MOST RECENT touch", () => {
    // First touch is old (10d) but the most recent reminder was just 1 day
    // ago → too soon for the next step, even though the ladder isn't
    // exhausted. This is what keeps the ladder from firing on back-to-back
    // days.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 10 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 1 * DAY },
      ],
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
    expect(byEpisode.e1).toEqual({
      kind: "send",
      channel: "email",
      variant: "final",
    });
    expect(byEpisode.e2).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["sms", "email"],
    });
  });
});

describe("planReminderEscalations — voice tier", () => {
  it("escalates to voice after SMS + email when the voice ladder is active", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 8 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 4 * DAY },
      ],
      ESCALATION_LADDER_WITH_VOICE,
    );
    // voice is the last untried channel → "final" (ignored downstream by the
    // voice job, but the tier carries it uniformly).
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "voice",
      variant: "final",
    });
  });

  it("uses the 'followup' variant when more channels still follow", () => {
    // SMS done, email is next, but voice is still untried after it → the
    // email reads as a circle-back, not a last call.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY }],
      ESCALATION_LADDER_WITH_VOICE,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "email",
      variant: "followup",
    });
  });

  it("hands off to a CSR only after voice is also tried", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 9 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 6 * DAY },
        { episodeId: "e1", channel: "voice", createdAtMs: NOW - 3 * DAY },
      ],
      ESCALATION_LADDER_WITH_VOICE,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["sms", "email", "voice"],
    });
  });

  it("ignores a voice conversation when voice is NOT in the ladder", () => {
    // A manual admin call (voice) shouldn't count toward the text-only
    // ladder: the episode still has SMS untried-as-second-step, so it
    // escalates SMS→email as usual and a stray voice row is ignored.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY },
        { episodeId: "e1", channel: "voice", createdAtMs: NOW - 4 * DAY },
      ],
      ESCALATION_LADDER,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "sms",
      variant: "final",
    });
  });
});

describe("planReminderEscalations — channel capability", () => {
  it("hands an email-only patient to a CSR instead of stalling on SMS", () => {
    // No phone → SMS is unreachable. With the email touch done, the only
    // reachable channel is exhausted, so we hand off to a human rather than
    // re-enqueue an un-deliverable SMS forever.
    const actions = plan(
      [{ id: "e1", patientId: "p1", hasPhone: false, hasEmail: true }],
      [{ episodeId: "e1", channel: "email", createdAtMs: NOW - 5 * DAY }],
      ESCALATION_LADDER,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["email"],
    });
  });

  it("hands a phone-only patient to a CSR after SMS (email skipped)", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1", hasPhone: true, hasEmail: false }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY }],
      ESCALATION_LADDER,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["sms"],
    });
  });

  it("skips the unreachable email and escalates a phone-only patient to voice", () => {
    // Phone but no email, voice ladder active: after SMS the next REACHABLE
    // channel is voice (email is skipped), and it's the last one → "final".
    const actions = plan(
      [{ id: "e1", patientId: "p1", hasPhone: true, hasEmail: false }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY }],
      ESCALATION_LADDER_WITH_VOICE,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "voice",
      variant: "final",
    });
  });

  it("treats capability as reachable when unspecified (back-compat)", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [{ episodeId: "e1", channel: "sms", createdAtMs: NOW - 5 * DAY }],
      ESCALATION_LADDER,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "email",
      variant: "final",
    });
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

// Multi-tenant: the escalation sweep must fan out across every active
// tenant and gate on the PER-TENANT dispatcher flag, never the single seed
// org. A behavioural test would need to mock listActiveOrgIds + a paged
// Supabase client + pg-boss; pin the cutover invariants cheaply via source,
// like the pagination guard above.
describe("runReminderEscalationScan — per-tenant fan-out", () => {
  it("fans out across active tenants instead of resolving the seed org", () => {
    expect(SRC).toContain("forEachActiveOrg(");
    expect(SRC).not.toContain("resolveSeedOrgId");
  });

  it("checks the dispatcher flag against the per-tenant orgId", () => {
    expect(SRC).toContain(
      'isFeatureEnabled("reminder_escalation.dispatcher", orgId)',
    );
  });
});

// Opt-out + capability: the runner must read patient status (to escalate only
// ACTIVE patients — respecting the STOP opt-out the send helpers no-op on) and
// contactability (to feed the planner's channel-skip). A behavioural test
// needs a paged Supabase mock; pin the invariants via source like above.
describe("runReminderEscalationScan — patient status + capability read", () => {
  it("reads patient status + contact fields for the candidate patients", () => {
    expect(SRC).toContain('.select("id, status, phone_e164, email")');
  });

  it("escalates only ACTIVE patients (respects the STOP opt-out)", () => {
    expect(SRC).toContain('?.status ?? "active") === "active"');
  });
});
