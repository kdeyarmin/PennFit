// Smart-trigger send-due dispatcher (Phase G.14 — Phase E.2 / G.7
// follow-up). Same pattern as ./evaluator.ts: lifts the body of
// POST /admin/smart-triggers/send-due out of its route handler so
// both the admin "Run now" surface AND the daily pg-boss cron can
// call the same code path.
//
// Per-channel construction: an SMS-channel run never touches
// SendGrid and vice-versa, so a missing-on-one-side env doesn't
// gate the other. Returns a tagged-union outcome so the route can
// 503 on "not_configured" while the cron logs+skips.
//
// Concurrency / double-send prevention
// -------------------------------------
// The original Drizzle path used a single `WITH … FOR UPDATE SKIP
// LOCKED` CTE so two concurrent dispatchers picked up disjoint
// slices of the queue. PostgREST has no SKIP LOCKED, so we
// approximate with the SELECT-then-UPDATE-with-null-guard pattern
// the abandoned-cart and review-request dispatchers use:
//
//   1. SELECT eligible event ids (sent_at IS NULL, dismissed_at
//      IS NULL, capped at PER_RUN_SEND_CAP*4 and JS-filtered by
//      patient status + contact channel).
//   2. UPDATE WHERE id IN (...) AND sent_at IS NULL — Postgres
//      serialises the row writes, so a parallel dispatcher's
//      UPDATE matches zero rows and does no work.
//   3. On send failure unclaim (sent_at → NULL) so the next cron
//      tick can retry the row.

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../logger";
import { sendPushToCustomerByEmail } from "../web-push";
import { withRetry } from "../with-retry";
import { PATIENT_DISPATCH_KINDS, type TriggerKind } from "./index";

/** Per-dispatcher-run cap. Same value the route uses. */
const PER_RUN_SEND_CAP = 50;

export interface DispatcherActor {
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type DispatcherOutcome =
  | { status: "not_configured"; channel: "email" | "sms" }
  | {
      status: "ok";
      channel: "email" | "sms";
      attempted: number;
      sent: number;
      failed: number;
      skippedNoContact: number;
      remaining: number;
    };

/**
 * Shared smart-trigger renderers, passed in by the caller so this
 * dispatcher stays decoupled from the renderer module and any route
 * wiring. Copy lives in `lib/smart-triggers/renderers.ts`; this
 * dispatcher uses `subjectForKind` for the push title and the
 * channel-specific body helpers when sending.
 */
export interface SmartTriggerRenderers {
  subjectForKind: (kind: TriggerKind) => string;
  textBody: (greeting: string, kind: TriggerKind) => string;
  htmlBody: (greeting: string, kind: TriggerKind) => string;
  smsBody: (firstName: string, kind: TriggerKind) => string;
  pushBody: (kind: TriggerKind) => string;
}

export async function runSmartTriggerSendDue(
  channel: "email" | "sms",
  actor: DispatcherActor,
  renderers: SmartTriggerRenderers,
): Promise<DispatcherOutcome> {
  const supabase = getSupabaseServiceRoleClient();

  let sg: ReturnType<typeof createSendgridClient> | null = null;
  let sms: ReturnType<typeof createTwilioSmsClient> | null = null;
  if (channel === "email") {
    try {
      sg = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        return { status: "not_configured", channel };
      }
      throw err;
    }
  } else {
    try {
      sms = createTwilioSmsClient();
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        return { status: "not_configured", channel };
      }
      throw err;
    }
  }

  // Step 1 — pick eligible events. We over-fetch by 4x the send cap
  // because the channel-specific contact filter (email / phone_e164
  // present) and the patient-active filter run JS-side in step 2; a
  // batch with many ineligible rows would otherwise short-deliver.
  //
  // Kind filter: only auto-message PATIENT_DISPATCH_KINDS — the
  // self-serve nudges. RT clinical kinds (ahi_elevated,
  // non_adherent_30d) sit in the table for the RT board but the
  // dispatcher leaves them alone so a clinician decides the next step.
  const { data: eventCandidates, error: candidatesErr } = await supabase
    .schema("resupply")
    .from("patient_smart_trigger_events")
    .select("id, patient_id, kind")
    .in("kind", PATIENT_DISPATCH_KINDS as readonly string[])
    .is("sent_at", null)
    .is("dismissed_at", null)
    .order("detected_at", { ascending: true })
    .limit(PER_RUN_SEND_CAP * 4);
  if (candidatesErr) throw candidatesErr;
  const events = eventCandidates ?? [];

  if (events.length === 0) {
    return {
      status: "ok",
      channel,
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedNoContact: 0,
      remaining: 0,
    };
  }

  // Step 2 — bulk-fetch the patient contact records and filter
  // JS-side. Patient list is bounded by event count so the
  // round-trip is cheap.
  const patientIds = Array.from(new Set(events.map((e) => e.patient_id)));
  const { data: patientRows, error: patientsErr } = await supabase
    .schema("resupply")
    .from("patients")
    .select("id, legal_first_name, email, phone_e164, status")
    .in("id", patientIds);
  if (patientsErr) throw patientsErr;
  const patientMap = new Map(
    (patientRows ?? []).map((p) => [
      p.id,
      {
        firstName: p.legal_first_name,
        email: p.email,
        phoneE164: p.phone_e164,
        status: p.status,
      },
    ]),
  );

  // Filter to only events whose patient is active AND has the right
  // contact channel populated. Then truncate to the per-run cap.
  const eligible = events
    .filter((e) => {
      const p = patientMap.get(e.patient_id);
      if (!p || p.status !== "active") return false;
      const contact = channel === "email" ? p.email : p.phoneE164;
      return contact !== null && contact !== "";
    })
    .slice(0, PER_RUN_SEND_CAP);
  if (eligible.length === 0) {
    return {
      status: "ok",
      channel,
      attempted: 0,
      sent: 0,
      failed: 0,
      skippedNoContact: 0,
      remaining: events.length > 0 ? 1 : 0,
    };
  }

  // Step 3 — atomic claim. The .is("sent_at", null) guard makes
  // this idempotent under parallel dispatchers; the loser sees
  // zero rows match and does no work.
  const nowIso = new Date().toISOString();
  const eligibleIds = eligible.map((e) => e.id);
  const { data: claimedRows, error: claimErr } = await supabase
    .schema("resupply")
    .from("patient_smart_trigger_events")
    .update({ sent_at: nowIso, updated_at: nowIso })
    .in("id", eligibleIds)
    .is("sent_at", null)
    .select("id, patient_id, kind");
  if (claimErr) throw claimErr;
  const claimed = (claimedRows ?? []).map((r) => ({
    eventId: r.id,
    patientId: r.patient_id,
    kind: r.kind,
  }));

  let attempted = 0;
  let sent = 0;
  let failed = 0;

  const unclaim = async (eventId: string): Promise<void> => {
    const { error } = await supabase
      .schema("resupply")
      .from("patient_smart_trigger_events")
      .update({ sent_at: null, updated_at: new Date().toISOString() })
      .eq("id", eventId);
    if (error) {
      logger.warn(
        { event_id: eventId, err: error },
        "smart-trigger unclaim failed",
      );
    }
  };

  for (const row of claimed) {
    attempted++;
    const patient = patientMap.get(row.patientId);
    const contact = channel === "email" ? patient?.email : patient?.phoneE164;

    if (!contact) {
      // Defensive: contact removed between claim and dispatch. Unclaim
      // so the next run re-evaluates (patient may add contact later).
      await unclaim(row.eventId);
      failed++;
      logger.warn(
        { event_id: row.eventId, channel },
        "smart-trigger claimed row has no contact after batch fetch — unclaimed",
      );
      continue;
    }

    const firstName = patient?.firstName
      ? (patient.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
      : "";
    const greeting = firstName ? `Hi ${firstName}` : "Hi";

    try {
      if (channel === "email") {
        // Retry transient SendGrid failures (5xx / network) so a single
        // hiccup doesn't drop a smart-trigger nudge. Permanent 4xx
        // errors and EmailConfigError are NOT retried (the latter
        // propagates out of withRetry's predicate to the outer
        // catch where the existing config-error branch handles it).
        await withRetry(
          () =>
            sg!.sendEmail({
              to: contact,
              subject: renderers.subjectForKind(row.kind as TriggerKind),
              text: renderers.textBody(greeting, row.kind as TriggerKind),
              html: renderers.htmlBody(greeting, row.kind as TriggerKind),
              customArgs: {
                kind: "smart_trigger",
                trigger_kind: row.kind,
                event_id: row.eventId,
              },
            }),
          {
            attempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1_500,
            isRetriable: (err) => {
              if (err instanceof EmailApiError) {
                return err.status === undefined || err.status >= 500;
              }
              if (err instanceof EmailConfigError) return false;
              return true;
            },
          },
        );
      } else {
        // Same posture as checkin-dispatcher's sendSms — retry 5xx /
        // network only; 4xx (opt-out, invalid number) is permanent.
        await withRetry(
          () =>
            sms!.sendSms({
              to: contact,
              body: renderers.smsBody(firstName, row.kind as TriggerKind),
            }),
          {
            attempts: 3,
            baseDelayMs: 250,
            maxDelayMs: 1_500,
            isRetriable: (err) => {
              if (err instanceof TwilioApiError) {
                return err.status === undefined || err.status >= 500;
              }
              if (err instanceof TwilioConfigError) return false;
              return true;
            },
          },
        );
      }

      // sent_at was already stamped by the atomic claim — no UPDATE here.

      await logAudit({
        action: "patient.smart_trigger.sent",
        adminEmail: actor.adminEmail,
        adminUserId: actor.adminUserId,
        targetTable: "patient_smart_trigger_events",
        targetId: row.eventId,
        metadata: {
          patient_id: row.patientId,
          kind: row.kind,
          channel,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      }).catch((err) => {
        logger.warn({ err }, "patient.smart_trigger.sent audit write failed");
      });

      // Phase G.8 — best-effort push fan-out by email lookup. Never
      // rolls back the canonical email/SMS that already went out.
      if (patient?.email) {
        void sendPushToCustomerByEmail(patient.email, {
          title: renderers.subjectForKind(row.kind as TriggerKind),
          body: renderers.pushBody(row.kind as TriggerKind),
          url: "/account/insights",
          tag: `smart_trigger:${row.eventId}`,
        }).catch((err) => {
          logger.warn(
            {
              event_id: row.eventId,
              err: err instanceof Error ? err.message : String(err),
            },
            "smart-trigger push fan-out threw (non-fatal)",
          );
        });
      }

      sent++;
    } catch (err) {
      // Unclaim so the next cron tick can retry.
      await unclaim(row.eventId);
      failed++;
      logger.warn(
        { err, event_id: row.eventId, channel },
        "smart-trigger send failed — unclaimed for retry",
      );
    }
  }

  return {
    status: "ok",
    channel,
    attempted,
    sent,
    failed,
    skippedNoContact: 0, // contact filter is applied during candidate-eligibility
    remaining: events.length > eligible.length || claimed.length >= PER_RUN_SEND_CAP ? 1 : 0,
  };
}
