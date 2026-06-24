// placeOutboundReorderCall — shared code path for placing an outbound
// AI resupply check-in call to a patient.
//
// Called by:
//   - POST /voice/place-call             (admin-initiated, actor='admin')
//   - reminders.place-call pg-boss job   (system-initiated, actor='system')
//
// Both callers need the IDENTICAL sequence: validate the patient + episode,
// open a `conversations` row (channel='voice') so the dashboard timeline
// shows the attempt even if Twilio rejects the dial, register the in-memory
// pending session the WS bridge claims at upgrade time, place the call from
// the tenant's own caller-id (G7) or the platform default, stamp the
// returned CallSid, and audit. Pulling it into one helper keeps the admin
// route and the worker from drifting (the route was the only place this
// lived; the escalation ladder's automated voice tier needs the same).
//
// Mirrors the tagged-outcome contract of `@workspace/resupply-reminders`'
// sendReminderSms/sendReminderEmail: this function never throws on a
// recoverable error — it returns a tagged outcome the caller translates to
// HTTP status / log / pg-boss retry. A genuinely-unexpected exception (a
// Supabase read rejecting, a non-Twilio throw) bubbles up so the caller's
// error handling + Sentry see it.
//
// Audit invariants (ADR 008): metadata is structural only — never the phone
// number, never call audio/transcript. Both the success and the
// Twilio-error paths write exactly ONE `voice.call.placed` audit row from
// HERE; callers MUST NOT double-audit.

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createTwilioClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../logger";
import { resolveTenantVoiceFrom } from "../messaging/tenant-telecom";
import { getPendingSessions } from "./pending-sessions";
import type { VoiceConfig } from "./voice-config";

/**
 * Who initiated the call. Drives the audit operator fields ONLY — it never
 * influences which patient/episode is dialled. Mirrors the SendActor union
 * in @workspace/resupply-reminders so the two outbound paths read alike.
 */
export type CallActor =
  | {
      kind: "admin";
      adminEmail: string | null;
      adminUserId: string | null;
      ip: string | null;
      userAgent: string | null;
    }
  | { kind: "system"; jobId: string | null };

export type PlaceCallOutcome =
  | { status: "ok"; conversationId: string; callSid: string }
  | { status: "patient_not_found" }
  | { status: "patient_not_active"; patientStatus: string }
  | { status: "patient_missing_phone" }
  | { status: "episode_not_found" }
  | { status: "episode_patient_mismatch" }
  | { status: "conversation_create_failed" }
  | { status: "twilio_config_error" }
  | {
      status: "twilio_api_error";
      conversationId: string;
      twilioStatus: number | null;
      // Twilio's error code is numeric, but the client types it
      // `number | string` — keep the wider shape rather than coercing.
      twilioCode: number | string | null;
    };

export interface PlaceOutboundReorderCallInput {
  /** Tenant the call happens in. Every read/write is org-scoped to it. */
  orgId: string;
  patientId: string;
  episodeId: string;
  /**
   * Fully-resolved voice config (the caller already passed the readiness
   * gate). `twilioPhoneNumber` MUST be present — the caller checks it and
   * returns its own "outbound not configured" signal first.
   */
  config: VoiceConfig & { twilioPhoneNumber: string };
  actor: CallActor;
}

/**
 * Place a single outbound AI resupply check-in call. See file header for
 * the full contract. Returns a tagged outcome; throws only on an
 * unexpected (non-Twilio) error.
 */
export async function placeOutboundReorderCall(
  input: PlaceOutboundReorderCallInput,
): Promise<PlaceCallOutcome> {
  const { orgId, patientId, episodeId, config, actor } = input;
  const supabase = getOrgScopedClient(orgId);

  // Patient existence + phone + status. PostgREST has no JOIN, so the
  // patient and episode reads stay separate but run in parallel.
  const [patientRes, episodeRes] = await Promise.all([
    supabase
      .from("patients")
      .select("id, phone_e164, status")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle(),
    supabase
      .from("episodes")
      .select("id, patient_id")
      .eq("id", episodeId)
      .limit(1)
      .maybeSingle(),
  ]);
  if (patientRes.error) throw patientRes.error;
  if (episodeRes.error) throw episodeRes.error;

  const patient = patientRes.data;
  if (!patient) return { status: "patient_not_found" };
  if (patient.status !== "active") {
    return { status: "patient_not_active", patientStatus: patient.status };
  }
  if (!patient.phone_e164) return { status: "patient_missing_phone" };

  const episode = episodeRes.data;
  if (!episode) return { status: "episode_not_found" };
  if (episode.patient_id !== patientId) {
    return { status: "episode_patient_mismatch" };
  }

  // Create the conversation row up front so the dashboard timeline shows
  // the attempt even if Twilio rejects the dial.
  const { data: inserted, error: insertErr } = await supabase
    .from("conversations")
    .insert({
      patient_id: patientId,
      episode_id: episodeId,
      channel: "voice",
      status: "open",
      last_message_at: new Date().toISOString(),
    })
    .select("id")
    .limit(1)
    .maybeSingle();
  if (insertErr) throw insertErr;
  const conversationId = inserted?.id;
  if (!conversationId) return { status: "conversation_create_failed" };

  // Register pending session BEFORE Twilio dials so the WS upgrade — which
  // can race the API response — sees the entry the moment Twilio connects
  // its socket back.
  await getPendingSessions().register({
    conversationId,
    patientId,
    episodeId,
    orgId,
  });

  const baseUrl = config.publicBaseUrl;
  const twimlUrl = `${baseUrl}/resupply-api/voice/twiml-connect?conversationId=${encodeURIComponent(
    conversationId,
  )}`;
  const statusCallbackUrl = `${baseUrl}/resupply-api/voice/status-callback?conversationId=${encodeURIComponent(
    conversationId,
  )}`;

  // Place the call from the tenant's own voice caller-id when it has one
  // (G7), else the platform default. Fails soft to the default.
  const callerId =
    (await resolveTenantVoiceFrom(orgId)) ?? config.twilioPhoneNumber;

  let callSid: string;
  try {
    const twilio = createTwilioClient({
      accountSid: config.twilioAccountSid,
      authToken: config.twilioAuthToken,
    });
    const result = await twilio.placeCall({
      to: patient.phone_e164,
      from: callerId,
      url: twimlUrl,
      statusCallbackUrl,
      // Detect voicemail vs a live answer so the escalation can retry an
      // unanswered call (up to the cap) instead of counting a voicemail as a
      // completed conversation. The verdict (`AnsweredBy`) lands on the status
      // callback; if it never resolves, a completed call defaults to
      // "connected" so detection failing never blocks the ladder.
      machineDetection: "Enable",
    });
    callSid = result.sid;
  } catch (err) {
    if (err instanceof TwilioConfigError) {
      logger.error(
        { err: { name: err.name, message: err.message } },
        "voice.place-call: twilio config error",
      );
      return { status: "twilio_config_error" };
    }
    if (err instanceof TwilioApiError) {
      // Audit the failed attempt — the call WAS initiated, even if Twilio
      // refused. PHI-safe: phone number is NOT in metadata, only the
      // structural failure code. We deliberately do NOT roll back the
      // conversations row: the audit trail + dashboard timeline both need
      // to show "we tried to call at T".
      await safeAudit(actor, {
        targetId: conversationId,
        metadata: {
          patient_id: patientId,
          episode_id: episodeId,
          conversation_id: conversationId,
          status: "twilio_error",
          twilio_status: err.status ?? null,
          twilio_code: err.code ?? null,
        },
      });
      return {
        status: "twilio_api_error",
        conversationId,
        twilioStatus: err.status ?? null,
        twilioCode: err.code ?? null,
      };
    }
    throw err;
  }

  // attachCallSid is best-effort (read-modify-write on the pending row, which
  // can lose to a claim/expiry race). It returns false when the SID was NOT
  // stamped — the WS handler then runs with twilioCallSid=null until the
  // `start` frame lands. We can't fail the call over it (the dial already
  // succeeded), but a silent miss made the binding window invisible, so log it.
  const callSidAttached = await getPendingSessions().attachCallSid(
    conversationId,
    callSid,
  );
  if (!callSidAttached) {
    logger.warn(
      { event: "voice.place-call.attach_callsid_miss", conversationId },
      "voice.place-call: attachCallSid did not stamp the pending session (claimed/expired?); WS will bind from the start frame",
    );
  }
  const { error: updateErr } = await supabase
    .from("conversations")
    .update({
      external_ref: callSid,
      updated_at: new Date().toISOString(),
    })
    .eq("id", conversationId);
  if (updateErr) throw updateErr;

  await safeAudit(actor, {
    targetId: conversationId,
    metadata: {
      patient_id: patientId,
      episode_id: episodeId,
      conversation_id: conversationId,
      status: "ok",
      twilio_call_sid: callSid,
    },
  });

  return { status: "ok", conversationId, callSid };
}

/**
 * Write the single `voice.call.placed` audit row, translating the actor
 * union into the audit operator fields + structural metadata. Audit
 * failures must NOT fail an otherwise-successful (or already-failed)
 * call placement — we log and move on.
 */
async function safeAudit(
  actor: CallActor,
  event: { targetId: string; metadata: Record<string, unknown> },
): Promise<void> {
  const metadata =
    actor.kind === "admin"
      ? { ...event.metadata, actor_kind: "admin" }
      : { ...event.metadata, actor_kind: "system", job_id: actor.jobId };
  try {
    await logAudit({
      action: "voice.call.placed",
      adminEmail: actor.kind === "admin" ? actor.adminEmail : null,
      adminUserId: actor.kind === "admin" ? actor.adminUserId : null,
      targetTable: "conversations",
      targetId: event.targetId,
      metadata,
      ip: actor.kind === "admin" ? actor.ip : null,
      userAgent: actor.kind === "admin" ? actor.userAgent : null,
    });
  } catch (err) {
    logger.error(
      { err: { name: (err as Error).name, message: (err as Error).message } },
      "voice.place-call: logAudit failed",
    );
  }
}
