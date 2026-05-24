// Tests for voice → CSR handoff routing.
//
// Coverage:
//   * Escalates a fresh conversation (escalated_at NULL) to high
//     priority + adds the voice-handoff tag.
//   * Escalates a distressed-sentiment call to "urgent", not "high".
//   * Never DOWNGRADES priority — an already-urgent row stays urgent
//     even when sentiment is neutral.
//   * Skips conversations that are already escalated (human-set
//     escalation_reason carries more context than the model's).
//   * Skips when the conversation row is missing.
//   * Dedupes the voice-handoff tag — a re-route on a conversation
//     that already carries the tag doesn't double-insert.
//   * Truncates a long outcome string into the escalation_reason cap.

import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
  getSupabaseWritePayloads,
  getSupabaseCallCount,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

import {
  routeVoiceHandoffToCsrQueue,
  VOICE_HANDOFF_TAG,
} from "./post-call-handoff";

beforeEach(() => {
  supabaseMock.reset();
  vi.useRealTimers();
});

describe("routeVoiceHandoffToCsrQueue — fresh escalation", () => {
  it("stamps escalated_at + bumps priority to high + adds the voice-handoff tag", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_1",
        priority: "normal",
        tags: [],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_1",
      outcome: "Patient asked about a billing question we couldn't resolve.",
      sentiment: "concerned",
    });

    const writes = getSupabaseWritePayloads("conversations", "update");
    expect(writes).toHaveLength(1);
    const write = writes[0] as {
      escalated_at: string;
      escalation_reason: string;
      priority: string;
      tags: string[];
    };
    expect(write.priority).toBe("high");
    expect(write.tags).toContain(VOICE_HANDOFF_TAG);
    expect(write.escalation_reason).toMatch(
      /^voice_post_call_handoff \(concerned\): /,
    );
    expect(write.escalated_at).toBeTypeOf("string");
  });

  it("routes a distressed sentiment to urgent (not high)", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_distress",
        priority: "normal",
        tags: [],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_distress",
      outcome: "Caller expressed distress about adherence.",
      sentiment: "distressed",
    });

    const writes = getSupabaseWritePayloads("conversations", "update");
    expect((writes[0] as { priority: string }).priority).toBe("urgent");
  });
});

describe("routeVoiceHandoffToCsrQueue — never downgrades priority", () => {
  it("keeps an already-urgent conversation at urgent when sentiment is neutral", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_urgent",
        priority: "urgent",
        tags: [],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_urgent",
      outcome: "Routine refill confirmation.",
      sentiment: "neutral",
    });

    const writes = getSupabaseWritePayloads("conversations", "update");
    expect((writes[0] as { priority: string }).priority).toBe("urgent");
  });
});

describe("routeVoiceHandoffToCsrQueue — already escalated", () => {
  it("skips the update when escalated_at is already set", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_already",
        priority: "high",
        tags: ["human-flagged"],
        escalated_at: "2026-05-23T01:23:45Z",
        escalation_reason: "billing dispute — human-set",
      },
    });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_already",
      outcome: "Caller mentioned a different concern.",
      sentiment: "concerned",
    });

    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
  });
});

describe("routeVoiceHandoffToCsrQueue — missing row", () => {
  it("logs a warn and resolves cleanly when the conversation isn't found", async () => {
    stageSupabaseResponse("conversations", "select", { data: null });

    await expect(
      routeVoiceHandoffToCsrQueue({
        conversationId: "conv_missing",
        outcome: "Anything",
        sentiment: "neutral",
      }),
    ).resolves.toBeUndefined();

    expect(getSupabaseCallCount("conversations", "update")).toBe(0);
  });
});

describe("routeVoiceHandoffToCsrQueue — tag dedup", () => {
  it("does not duplicate the voice-handoff tag if it's already present", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_tagged",
        priority: "normal",
        tags: [VOICE_HANDOFF_TAG, "billing"],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_tagged",
      outcome: "Re-flagged on a second voice attempt.",
      sentiment: "concerned",
    });

    const writes = getSupabaseWritePayloads("conversations", "update");
    const tags = (writes[0] as { tags: string[] }).tags;
    const handoffCount = tags.filter((t) => t === VOICE_HANDOFF_TAG).length;
    expect(handoffCount).toBe(1);
  });
});

describe("routeVoiceHandoffToCsrQueue — escalation_reason truncation", () => {
  it("caps the escalation_reason at the persisted column limit", async () => {
    const longOutcome = "x".repeat(500);
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_long",
        priority: "normal",
        tags: [],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", { data: null });

    await routeVoiceHandoffToCsrQueue({
      conversationId: "conv_long",
      outcome: longOutcome,
      sentiment: "concerned",
    });

    const writes = getSupabaseWritePayloads("conversations", "update");
    const reason = (writes[0] as { escalation_reason: string })
      .escalation_reason;
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason.endsWith("…")).toBe(true);
  });
});

describe("routeVoiceHandoffToCsrQueue — fault tolerance", () => {
  it("does not throw when the read errors out", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: null,
      error: { code: "08006", message: "connection refused" },
    });

    await expect(
      routeVoiceHandoffToCsrQueue({
        conversationId: "conv_err",
        outcome: "anything",
        sentiment: "neutral",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw when the update errors out", async () => {
    stageSupabaseResponse("conversations", "select", {
      data: {
        id: "conv_update_err",
        priority: "normal",
        tags: [],
        escalated_at: null,
        escalation_reason: null,
      },
    });
    stageSupabaseResponse("conversations", "update", {
      data: null,
      error: { code: "08006", message: "connection refused" },
    });

    await expect(
      routeVoiceHandoffToCsrQueue({
        conversationId: "conv_update_err",
        outcome: "anything",
        sentiment: "neutral",
      }),
    ).resolves.toBeUndefined();
  });
});
