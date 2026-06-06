// Tests for the voice-call timing ledger writer.

import { describe, it, expect, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
} from "../../test-helpers/supabase-mock";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  buildVoiceCallPatch,
  parseCallDuration,
  recordVoiceCallEvent,
} from "./voice-call-record";

const NOW = "2026-06-06T12:00:00.000Z";
const SID = "CA_test_sid";

describe("buildVoiceCallPatch", () => {
  const base = {
    callSid: SID,
    conversationId: null,
    direction: "outbound-api",
    durationSeconds: null,
    nowIso: NOW,
  };

  it("stamps initiated_at on initiated/queued", () => {
    for (const s of ["initiated", "queued"]) {
      const p = buildVoiceCallPatch({ ...base, callStatus: s });
      expect(p.initiated_at).toBe(NOW);
      expect(p.answered_at).toBeUndefined();
      expect(p.ended_at).toBeUndefined();
      expect(p.status).toBe(s);
    }
  });

  it("stamps answered_at on in-progress (Twilio's answered event)", () => {
    const p = buildVoiceCallPatch({ ...base, callStatus: "in-progress" });
    expect(p.answered_at).toBe(NOW);
    expect(p.initiated_at).toBeUndefined();
    expect(p.ended_at).toBeUndefined();
  });

  it("does not touch timestamps on ringing (status only)", () => {
    const p = buildVoiceCallPatch({ ...base, callStatus: "ringing" });
    expect(p.initiated_at).toBeUndefined();
    expect(p.answered_at).toBeUndefined();
    expect(p.ended_at).toBeUndefined();
    expect(p.status).toBe("ringing");
  });

  it("stamps ended_at + duration on terminal events", () => {
    for (const s of ["completed", "failed", "busy", "no-answer", "canceled"]) {
      const p = buildVoiceCallPatch({
        ...base,
        callStatus: s,
        durationSeconds: 42,
      });
      expect(p.ended_at).toBe(NOW);
      expect(p.duration_seconds).toBe(42);
      expect(p.answered_at).toBeUndefined();
    }
  });
});

describe("parseCallDuration", () => {
  it("parses whole-second strings", () => {
    expect(parseCallDuration("125")).toBe(125);
    expect(parseCallDuration("0")).toBe(0);
  });
  it("rejects junk and negatives", () => {
    expect(parseCallDuration("")).toBeNull();
    expect(parseCallDuration(undefined)).toBeNull();
    expect(parseCallDuration("-3")).toBeNull();
    expect(parseCallDuration("abc")).toBeNull();
  });
});

describe("recordVoiceCallEvent", () => {
  const supabaseMock = installSupabaseMock();
  beforeEach(() => supabaseMock.reset());

  it("inserts a new row when the call_sid is unseen", async () => {
    stageSupabaseResponse("voice_calls", "select", { data: null });
    stageSupabaseResponse("voice_calls", "insert", { data: null });
    await recordVoiceCallEvent(getSupabaseServiceRoleClient(), {
      callSid: SID,
      conversationId: "11111111-1111-4111-8111-111111111111",
      callStatus: "initiated",
      direction: "outbound-api",
      durationSeconds: null,
      nowIso: NOW,
    });
    const inserts = getSupabaseWritePayloads("voice_calls", "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      call_sid: SID,
      direction: "outbound-api",
      initiated_at: NOW,
      status: "initiated",
    });
  });

  it("updates (not inserts) when the row already exists", async () => {
    stageSupabaseResponse("voice_calls", "select", { data: { id: "row1" } });
    stageSupabaseResponse("voice_calls", "update", { data: null });
    await recordVoiceCallEvent(getSupabaseServiceRoleClient(), {
      callSid: SID,
      conversationId: null,
      callStatus: "completed",
      direction: "outbound-api",
      durationSeconds: 90,
      nowIso: NOW,
    });
    const updates = getSupabaseWritePayloads("voice_calls", "update");
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      status: "completed",
      ended_at: NOW,
      duration_seconds: 90,
    });
    expect(getSupabaseWritePayloads("voice_calls", "insert")).toHaveLength(0);
  });

  it("swallows a unique-violation insert race", async () => {
    stageSupabaseResponse("voice_calls", "select", { data: null });
    stageSupabaseResponse("voice_calls", "insert", {
      error: { code: "23505", message: "dup" },
    });
    await expect(
      recordVoiceCallEvent(getSupabaseServiceRoleClient(), {
        callSid: SID,
        conversationId: null,
        callStatus: "initiated",
        direction: null,
        durationSeconds: null,
        nowIso: NOW,
      }),
    ).resolves.toBeUndefined();
  });
});
