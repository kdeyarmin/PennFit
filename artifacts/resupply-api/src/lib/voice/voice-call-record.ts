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
  /**
   * Twilio Answering Machine Detection verdict (`AnsweredBy`): human |
   * machine_start | machine_end_* | fax | unknown. Present only when the call
   * was placed with machine detection AND Twilio has resolved it. Null/absent
   * otherwise — never clobbers a prior non-null verdict.
   */
  answeredBy?: string | null;
  nowIso: string;
}

export interface VoiceCallPatch {
  status: string;
  updated_at: string;
  initiated_at?: string;
  answered_at?: string;
  ended_at?: string;
  duration_seconds?: number | null;
  answered_by?: string;
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
  // AMD verdict can arrive on any event (Twilio resolves it shortly after
  // answer). Only set it when present + non-empty so a later event carrying no
  // verdict can't wipe an earlier one.
  if (typeof event.answeredBy === "string" && event.answeredBy.trim() !== "") {
    patch.answered_by = event.answeredBy.trim();
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
 *
 * ORG ATTRIBUTION. This helper used to insert with no `org_id` at all,
 * because a Twilio webhook has no request tenant and the row is reached
 * by the globally-unique CallSid. But `voice_calls.org_id` EXISTS and two
 * admin surfaces read through the org-scoped client, which appends
 * `.eq("org_id", …)`:
 *
 *   * routes/admin/voice-metrics.ts  (GET /admin/voice/metrics)
 *   * routes/admin/analytics-channel-engagement.ts (the `voice` channel)
 *
 * With every row's `org_id` NULL, both returned zero for EVERY tenant,
 * including the seed one — a dashboard that had never shown a number and
 * looked like "no calls yet". A third reader,
 * worker/jobs/reminder-escalation.ts, already carried a `.raw()`
 * workaround with a comment naming this exact bug.
 *
 * The lookup below deliberately stays keyed on `call_sid` alone. A Twilio
 * CallSid comes from one shared vendor account and can only ever belong
 * to one call, so the unique index on it is correct as a GLOBAL key; the
 * `org_id` we write is attribution, not a scoping filter.
 */
export async function recordVoiceCallEvent(
  supabase: ResupplySupabaseClient,
  event: VoiceCallEvent,
  /**
   * The call's OWNING TENANT, resolved by the caller off the conversation
   * row. Optional only because it may genuinely be unknown (a status
   * callback for a conversation that has been deleted); a row written
   * without it stays unattributed rather than being misfiled under the
   * seed tenant.
   *
   * Passing this is what makes /admin/voice/metrics and the
   * channel-engagement analytics work at all — see the header.
   */
  orgId?: string | null,
): Promise<void> {
  const patch = buildVoiceCallPatch(event);
  const tenantOrgId =
    typeof orgId === "string" && orgId.trim() !== "" ? orgId.trim() : null;

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
      .update(tenantOrgId ? { ...patch, org_id: tenantOrgId } : patch)
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
      ...(tenantOrgId ? { org_id: tenantOrgId } : {}),
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
