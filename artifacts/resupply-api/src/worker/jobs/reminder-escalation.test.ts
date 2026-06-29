import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

import {
  planReminderEscalations,
  resolveEscalationTiming,
  isVoiceCallConnected,
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

  it("same-channel re-pings do NOT reset the step-spacing anchor", () => {
    // Regression: the hourly first-touch scan re-pings the SAME channel
    // (sms here) every ~48h while an episode stays open. Those re-pings must
    // not keep deferring the next ladder step — otherwise the anchor sticks
    // below the 3-day window forever and the ladder never advances past the
    // first channel to email → voice → CSR. With the first sms touch 10d ago
    // and re-pings at 4d and 1d ago (all sms), the spacing anchor stays at
    // the first sms touch, so the window is satisfied and we escalate to
    // email. (Pre-fix this returned [] — a permanent stall.)
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 10 * DAY },
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 4 * DAY },
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 1 * DAY },
      ],
    );
    expect(actions[0]!.tier).toEqual({
      kind: "send",
      channel: "email",
      variant: "final",
    });
  });

  it("still defers when a genuinely new channel was tried recently", () => {
    // Counterpart to the re-ping case: once a DISTINCT new channel (email)
    // is introduced 1 day ago, the spacing anchor legitimately moves to it,
    // so the next step (voice, in the voice-enabled ladder) waits the full
    // window even though sms is old. This preserves the original
    // "wait delayMs between distinct steps" behavior.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 10 * DAY },
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 6 * DAY },
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

  it("RETRIES voice after one unanswered call (below the attempt cap)", () => {
    // sms + email done, one voice attempt that didn't connect → dial again
    // rather than hand off (cap is 2).
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
      kind: "send",
      channel: "voice",
      variant: "final",
    });
  });

  it("hands off to a CSR after the voice attempt cap (2 unanswered calls)", () => {
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 12 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 9 * DAY },
        { episodeId: "e1", channel: "voice", createdAtMs: NOW - 6 * DAY },
        { episodeId: "e1", channel: "voice", createdAtMs: NOW - 3 * DAY },
      ],
      ESCALATION_LADDER_WITH_VOICE,
    );
    expect(actions[0]!.tier).toEqual({
      kind: "csr_exhausted",
      triedChannels: ["sms", "email", "voice"],
    });
  });

  it("hands off to a CSR immediately once a call reaches a live person", () => {
    // A single CONNECTED call ends the voice tier — no second dial.
    const actions = plan(
      [{ id: "e1", patientId: "p1" }],
      [
        { episodeId: "e1", channel: "sms", createdAtMs: NOW - 9 * DAY },
        { episodeId: "e1", channel: "email", createdAtMs: NOW - 6 * DAY },
        {
          episodeId: "e1",
          channel: "voice",
          createdAtMs: NOW - 3 * DAY,
          voiceConnected: true,
        },
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

describe("isVoiceCallConnected — live-answer detection", () => {
  it("treats a completed call with no/​human verdict as connected", () => {
    expect(isVoiceCallConnected("completed", null)).toBe(true);
    expect(isVoiceCallConnected("completed", "human")).toBe(true);
    expect(isVoiceCallConnected("completed", "unknown")).toBe(true);
  });

  it("treats voicemail / fax as NOT connected", () => {
    expect(isVoiceCallConnected("completed", "machine_start")).toBe(false);
    expect(isVoiceCallConnected("completed", "machine_end_beep")).toBe(false);
    expect(isVoiceCallConnected("completed", "fax")).toBe(false);
  });

  it("treats non-completed terminals as NOT connected", () => {
    expect(isVoiceCallConnected("no-answer", null)).toBe(false);
    expect(isVoiceCallConnected("busy", null)).toBe(false);
    expect(isVoiceCallConnected("failed", null)).toBe(false);
    expect(isVoiceCallConnected(null, null)).toBe(false);
  });
});

describe("resolveEscalationTiming — admin-tunable cadence", () => {
  it("falls back to the defaults when unset", () => {
    expect(resolveEscalationTiming(null, null)).toEqual({
      delayDays: 3,
      maxDays: 21,
    });
  });

  it("parses valid admin values", () => {
    expect(resolveEscalationTiming("5", "30")).toEqual({
      delayDays: 5,
      maxDays: 30,
    });
  });

  it("clamps the step delay into 1..30", () => {
    expect(resolveEscalationTiming("0", "21").delayDays).toBe(1);
    expect(resolveEscalationTiming("999", "21").delayDays).toBe(30);
  });

  it("floors max-age at the step delay (a smaller max would stall everything)", () => {
    // max (2) below delay (7) → floored to delay.
    expect(resolveEscalationTiming("7", "2")).toEqual({
      delayDays: 7,
      maxDays: 7,
    });
  });

  it("caps max-age at 120 and falls back on non-numeric input", () => {
    expect(resolveEscalationTiming("3", "9999").maxDays).toBe(120);
    expect(resolveEscalationTiming("abc", "xyz")).toEqual({
      delayDays: 3,
      maxDays: 21,
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

  it("reads the tenant's tunable cadence instead of the bare constants", () => {
    expect(SRC).toContain("resolveEscalationTimingForOrg(orgId)");
    // The planner must be fed the resolved values, not the constants.
    expect(SRC).toContain("delayMs: delayDays * DAY_MS");
    expect(SRC).toContain("maxMs: maxDays * DAY_MS");
  });

  it("reads voice-call disposition to drive the retry/exhaust decision", () => {
    // Joins voice_calls by conversation_id via .raw() (rows are written
    // webhook-side without org_id, so the org filter would miss them). We still
    // SELECT org_id and skip any row carrying a CONFLICTING tenant — defense in
    // depth against a future webhook that does stamp it.
    expect(SRC).toContain('.from("voice_calls")');
    expect(SRC).toContain(
      '.select("conversation_id, status, answered_by, org_id")',
    );
    expect(SRC).toContain("rowOrg != null && rowOrg !== orgId");
    expect(SRC).toContain("isVoiceCallConnected(");
  });

  it("treats the open-alert unique violation (23505) as an idempotent no-op", () => {
    // A concurrent escalation tick can lose the read-then-insert race; the
    // partial unique index csr_compliance_alerts_open_unique rejects the
    // duplicate. That 23505 must be a silent no-op, NOT a spurious
    // alert_failed warning.
    expect(SRC).toContain('alertInsertErr.code === "23505"');
  });
});
