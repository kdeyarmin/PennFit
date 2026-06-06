// Voice-call timing ledger writer (feeds /admin/voice/metrics).
//
// Called best-effort from POST /voice/status-callback as Twilio reports
// each lifecycle transition. One row per CallSid; each event sets only
// the column(s) it owns so a later event never clobbers an earlier
// timestamp (the terminal `completed` event must not wipe answered_at).
//
// PHI: stores NO phone numbers — only timing, the CallSid, direction,
// and the conversation FK. The caller already refuses to read From/To.

import type { ResupplySupabaseClient } from "@workspace/resupply-db";

import { logger } from "../logger";

/** Twilio CallStatus values we treat as terminal (the call is over). */
const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "busy",
  "no-answer",
  "canceled",
]);

/** Statuses that mark the start of the call attempt. */
const INITIATED_STATUSES = new Set(["queued", "initiated"]);

export interface VoiceCallEvent {
  callSid: string;
  conversationId: string | null;
  callStatus: string;
  direction: string | null;
  /** Parsed Twilio `CallDuration` (whole seconds) on terminal events. */
  durationSeconds: number | null;
  nowIso: string;
}

export interface VoiceCallPatch {
  status: string;
  updated_at: string;
  initiated_at?: string;
  answered_at?: string;
  ended_at?: string;
  duration_seconds?: number | null;
}

/**
 * Build the column patch for one lifecycle event. Pure — each branch
 * touches a distinct timestamp column so events compose without
 * overwriting each other.
 */
export function buildVoiceCallPatch(event: VoiceCallEvent): VoiceCallPatch {
  const patch: VoiceCallPatch = {
    status: event.callStatus,
    updated_at: event.nowIso,
  };
  if (INITIATED_STATUSES.has(event.callStatus)) {
    patch.initiated_at = event.nowIso;
  } else if (event.callStatus === "in-progress") {
    // Twilio posts CallStatus "in-progress" for the `answered` event.
    patch.answered_at = event.nowIso;
  } else if (TERMINAL_STATUSES.has(event.callStatus)) {
    patch.ended_at = event.nowIso;
    patch.duration_seconds = event.durationSeconds;
  }
  return patch;
}

/** Parse Twilio's `CallDuration` field (a string of whole seconds). */
export function parseCallDuration(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Upsert the timing row for one call event. Throws on DB error — the
 * caller wraps this so a telemetry failure never breaks the 200 ack to
 * Twilio. Uses a read-then-write (not a blind upsert) so we update only
 * the columns this event owns and leave earlier timestamps intact.
 */
export async function recordVoiceCallEvent(
  supabase: ResupplySupabaseClient,
  event: VoiceCallEvent,
): Promise<void> {
  const patch = buildVoiceCallPatch(event);

  const { data: existing, error: selErr } = await supabase
    .schema("resupply")
    .from("voice_calls")
    .select("id")
    .eq("call_sid", event.callSid)
    .limit(1)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    const { error } = await supabase
      .schema("resupply")
      .from("voice_calls")
      .update(patch)
      .eq("call_sid", event.callSid);
    if (error) throw error;
    return;
  }

  const { error } = await supabase
    .schema("resupply")
    .from("voice_calls")
    .insert({
      call_sid: event.callSid,
      conversation_id: event.conversationId,
      direction: event.direction,
      ...patch,
    });
  // A concurrent first-event insert can race us to the unique call_sid;
  // treat the unique-violation as benign (the row now exists) rather
  // than surfacing it as a telemetry error.
  if (error && (error as { code?: string }).code !== "23505") {
    throw error;
  }
  if (error) {
    logger.debug(
      { event: "voice_call_record_insert_race", callSid: event.callSid },
      "voice-call record: insert lost the unique-sid race (benign)",
    );
  }
}
