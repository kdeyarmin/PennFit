// Rx-renewal dispatcher (Phase G.15 — Phase B.2 / G.3 follow-up).
// Lifts the body of POST /admin/prescriptions/send-renewal-due out
// of its route handler so both the admin "Run now" surface AND the
// daily pg-boss cron can call the same code path.
//
// Per-channel construction: an SMS-channel run never touches
// SendGrid and vice-versa, so a missing-on-one-side env doesn't
// gate the other. Returns a tagged-union outcome so the route can
// 503 on "not_configured" while the cron logs+skips.

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { renderMessage } from "@workspace/resupply-templates";

import { isOutsideSmsSendWindow } from "../comm-prefs";
import { logger } from "../logger";
import { messageTemplateLookup } from "../message-templates/lookup";
import { sendPushToCustomerByEmail } from "../web-push";
import {
  rxRenewalHtml,
  rxRenewalPushTitle,
  rxRenewalSms,
  rxRenewalSubject,
  rxRenewalText,
} from "./renderers";

/** How far before expiry the renewal nudge fires. Industry default
 *  is 30 days — long enough for a physician callback, short enough
 *  that the patient feels the urgency. */
export const RENEWAL_WINDOW_DAYS = 30;
/** Per-run cap to keep the dispatcher response time bounded. */
export const PER_RUN_CAP = 50;

export interface RxRenewalActor {
  adminEmail: string | null;
  adminUserId: string | null;
  ip: string | null;
  userAgent: string | null;
}

export type RxRenewalOutcome =
  | { status: "not_configured"; channel: "email" | "sms" }
  | {
      status: "ok";
      channel: "email" | "sms";
      attempted: number;
      sent: number;
      failed: number;
      skippedNoContact: number;
      /** SMS only: rows deferred by the 9am–8pm patient-local TCPA
       *  window. Not claimed — the next in-window run sends them. */
      skippedQuietHours: number;
      remaining: number;
      windowDays: number;
    };

export async function runRxRenewalSendDue(
  channel: "email" | "sms",
  actor: RxRenewalActor,
): Promise<RxRenewalOutcome> {
  const supabase = getSupabaseServiceRoleClient();
  const now = new Date();
  const cutoffIso = new Date(
    now.getTime() + RENEWAL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  // Original SQL path INNER-JOINed prescriptions → patients to
  // pull contact info in one round-trip. PostgREST has no JOIN, so
  // we fetch eligible prescription ids first then bulk-resolve
  // their patients via .in().
  const { data: rxRows, error: rxErr } = await supabase
    .schema("resupply")
    .from("prescriptions")
    .select("id, patient_id, valid_until")
    .eq("status", "active")
    .is("renewal_requested_at", null)
    .not("valid_until", "is", null)
    .lte("valid_until", cutoffIso)
    .order("valid_until", { ascending: true })
    .limit(PER_RUN_CAP * 4);
  if (rxErr) throw rxErr;

  const patientIds = Array.from(
    new Set(
      (rxRows ?? [])
        .map((r) => r.patient_id)
        .filter((v): v is string => v !== null),
    ),
  );
  const patientById = new Map<
    string,
    {
      firstName: string | null;
      email: string | null;
      phoneE164: string | null;
      timezone: string | null;
      zip: string | null;
    }
  >();
  if (patientIds.length > 0) {
    // status='active' only: STOP (SMS), the email stop link, and an
    // admin pause all set patients.status='paused' — this dispatcher
    // used to ignore that and contact opted-out patients anyway
    // (app-review 2026-06-10, P1-4). A non-active patient simply drops
    // out of the map, so their prescriptions are filtered out below
    // without being claimed (they resume when the patient does).
    const { data: patientRows, error: patientsErr } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id, legal_first_name, email, phone_e164, timezone, address")
      .eq("status", "active")
      .in("id", patientIds);
    if (patientsErr) throw patientsErr;
    for (const p of patientRows ?? []) {
      patientById.set(p.id, {
        firstName: p.legal_first_name,
        email: p.email,
        phoneE164: p.phone_e164,
        timezone: (p.timezone as string | null) ?? null,
        zip: ((p.address as { zip?: string } | null)?.zip ?? null) as
          | string
          | null,
      });
    }
  }

  const rows = (rxRows ?? [])
    .map((r) => {
      const patient = patientById.get(r.patient_id);
      if (!patient) return null;
      return {
        prescriptionId: r.id,
        patientId: r.patient_id,
        validUntil: r.valid_until,
        firstName: patient.firstName,
        email: patient.email,
        phoneE164: patient.phoneE164,
        timezone: patient.timezone,
        zip: patient.zip,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);

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

  let attempted = 0;
  let sent = 0;
  let failed = 0;
  let skippedNoContact = 0;
  let skippedQuietHours = 0;

  for (const row of rows) {
    if (attempted >= PER_RUN_CAP) break;
    // TCPA window gate (SMS only): never text outside 9am–8pm patient-
    // local, no matter who triggered the run (cron or an operator's
    // late-evening "Run now" click). The row is NOT claimed, so the
    // next run inside the window picks it up.
    if (
      channel === "sms" &&
      isOutsideSmsSendWindow(now, {
        timezone: row.timezone,
        shippingZip: row.zip,
      })
    ) {
      skippedQuietHours++;
      continue;
    }
    attempted++;
    const contact = channel === "email" ? row.email : row.phoneE164;
    if (!contact) {
      skippedNoContact++;
      continue;
    }
    const validUntil = row.validUntil ? new Date(row.validUntil) : null;
    const daysUntilExpiry = validUntil
      ? Math.max(
          0,
          Math.ceil(
            (validUntil.getTime() - now.getTime()) / (24 * 60 * 60 * 1000),
          ),
        )
      : 0;

    const firstName = row.firstName
      ? (row.firstName.split(/\s+/)[0]?.replace(/[<>&]/g, "") ?? "")
      : "";
    const greeting = firstName ? `Hi ${firstName}` : "Hi";

    // Claim the row atomically BEFORE calling the vendor. Two
    // concurrent workers selecting the same batch would both see
    // renewalRequestedAt IS NULL; without this guard, both would
    // send and only one would win the post-send mark — a duplicate
    // send. The .is("renewal_requested_at", null) guard collapses
    // the race: the loser's UPDATE matches 0 rows. On vendor
    // failure we attempt to undo the claim so the next cron tick
    // can retry.
    const nowIso = now.toISOString();
    const { data: claimed, error: claimErr } = await supabase
      .schema("resupply")
      .from("prescriptions")
      .update({ renewal_requested_at: nowIso, updated_at: nowIso })
      .eq("id", row.prescriptionId)
      .is("renewal_requested_at", null)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (claimErr) throw claimErr;
    if (!claimed) {
      logger.info(
        { prescription_id: row.prescriptionId, channel },
        "rx-renewal: row already claimed by concurrent worker — skipping",
      );
      continue;
    }

    // Variables exposed to the templated path. Names are
    // snake_case + ASCII per the renderMessage substitution rules.
    // The fallback strings below are pre-rendered (existing renderer
    // contract) so even with no template row present, the fallback
    // path returns the same bytes — guaranteed by the parity test
    // in renderers.template-parity.test.ts.
    const tmplVars = {
      first_name: firstName,
      days_until_expiry: String(daysUntilExpiry),
      greeting,
    };

    try {
      if (channel === "email") {
        const rendered = await renderMessage(
          {
            templateKey: "rx_renewal.email",
            channel: "email",
            // No shop_customers context here — patients !=
            // shop_customers in this stack. Per-customer
            // overrides skip; global template still applies.
            customerId: null,
            variables: tmplVars,
          },
          {
            subject: rxRenewalSubject(daysUntilExpiry),
            bodyHtml: rxRenewalHtml(greeting, daysUntilExpiry),
            bodyText: rxRenewalText(greeting, daysUntilExpiry),
          },
          messageTemplateLookup,
        );
        await sg!.sendEmail({
          to: contact,
          subject: rendered.subject ?? "",
          text: rendered.bodyText,
          html: rendered.bodyHtml ?? rendered.bodyText,
          customArgs: {
            kind: "prescription_renewal_request",
            prescription_id: row.prescriptionId,
            days_until_expiry: String(daysUntilExpiry),
          },
        });
      } else {
        const rendered = await renderMessage(
          {
            templateKey: "rx_renewal.sms",
            channel: "sms",
            customerId: null,
            variables: tmplVars,
          },
          {
            subject: null,
            bodyHtml: null,
            bodyText: rxRenewalSms(firstName, daysUntilExpiry),
          },
          messageTemplateLookup,
        );
        await sms!.sendSms({
          to: contact,
          body: rendered.bodyText,
        });
      }

      await logAudit({
        action: "prescription.renewal_requested",
        adminEmail: actor.adminEmail,
        adminUserId: actor.adminUserId,
        targetTable: "prescriptions",
        targetId: row.prescriptionId,
        metadata: {
          patient_id: row.patientId,
          days_until_expiry: daysUntilExpiry,
          channel,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      }).catch((err) => {
        logger.warn(
          { err },
          "prescription.renewal_requested audit write failed",
        );
      });

      // Phase G.9 — best-effort push fan-out by email lookup.
      const pushEmail = row.email;
      if (pushEmail) {
        // Push title goes through renderMessage so admins can edit
        // it from /admin/templates without a deploy. Body stays
        // hard-coded in this iteration; if A/B-tweaking that copy
        // becomes a need, lift it into the same template row.
        const pushRendered = await renderMessage(
          {
            templateKey: "rx_renewal.push",
            channel: "push",
            customerId: null,
            variables: tmplVars,
          },
          {
            subject: null,
            bodyHtml: null,
            bodyText: rxRenewalPushTitle(daysUntilExpiry),
          },
          messageTemplateLookup,
        );
        void sendPushToCustomerByEmail(pushEmail, {
          title: pushRendered.bodyText,
          body: "Tap to coordinate a renewal with your physician.",
          url: "/account",
          tag: `rx_renewal:${row.prescriptionId}`,
        }).catch((err) => {
          logger.warn(
            {
              prescription_id: row.prescriptionId,
              err: err instanceof Error ? err.message : String(err),
            },
            "Rx-renewal push fan-out threw (non-fatal)",
          );
        });
      }

      sent++;
    } catch (err) {
      // Undo the pre-send claim so the next cron tick can retry this row.
      // Best-effort: if the undo itself fails the row stays marked and won't
      // be retried, which ops can see in the audit log.
      const { error: undoErr } = await supabase
        .schema("resupply")
        .from("prescriptions")
        .update({ renewal_requested_at: null, updated_at: nowIso })
        .eq("id", row.prescriptionId);
      if (undoErr) {
        logger.warn(
          {
            prescription_id: row.prescriptionId,
            err: undoErr,
          },
          "rx-renewal: failed to undo claim after send error — row will not be retried automatically",
        );
      }
      failed++;
      logger.warn(
        {
          prescription_id: row.prescriptionId,
          channel,
          err: err instanceof Error ? err.message : String(err),
        },
        "Rx renewal request send failed",
      );
    }
  }

  return {
    status: "ok",
    channel,
    attempted,
    sent,
    failed,
    skippedNoContact,
    skippedQuietHours,
    remaining: rows.length > attempted ? rows.length - attempted : 0,
    windowDays: RENEWAL_WINDOW_DAYS,
  };
}
