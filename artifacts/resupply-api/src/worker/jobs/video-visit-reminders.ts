// pg-boss job: pre-visit reminder for scheduled telehealth video visits.
//
// Staff often schedule a video visit hours or days out; the invite the
// patient received at creation time is easy to lose in a message
// thread. This sweep re-sends the join link as a short "starting soon"
// SMS/email when the visit's start time is inside the reminder window.
//
// Scheduling: every 10 minutes. Each run claims visits whose
// scheduled_at falls within the next REMINDER_WINDOW (60 min), so a
// reminder lands 50-60 minutes before the start for most visits.
//
// Claim semantics: at-most-once. The sweep stamps reminder_sent_at
// BEFORE sending (the dispatcher atomic-claim convention) — a transient
// vendor failure drops that one courtesy reminder rather than risking
// a duplicate-spam loop; the original invite link remains valid either
// way.
//
// Gating: telehealth.video must be ON, plus the per-channel reminder
// flags (sms.reminders / email.reminders) the other outbound reminder
// dispatchers honor. SMS to a non-active patient is refused (TCPA/STOP,
// mirroring the invite path); guests have no STOP ledger.
//
// PHI / log posture: stats + visit ids only — never recipient contact
// info or the signed link.

import type PgBoss from "pg-boss";

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createSendgridClient,
  EmailConfigError,
} from "@workspace/resupply-email";
import {
  createTwilioSmsClient,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { createTenantSendgridClient } from "../../lib/email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantBaseUrl,
} from "../../lib/tenant-branding.js";
import { recordOutboundMessageUsage } from "../../lib/metering/usage.js";
import { resolveTenantSmsClientOptions } from "../../lib/messaging/tenant-telecom";
import { signVideoVisitToken } from "../../lib/video/video-visit-token";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const REMINDER_JOB = "video-visits.reminder-sweep";
const REMINDER_CRON = "*/10 * * * *";
/** Remind when the visit starts within the next hour. */
const REMINDER_WINDOW_MS = 60 * 60 * 1000;
/** Per-run send cap; the 10-minute cadence picks up any overflow. */
const BATCH_SIZE = 50;

export interface ReminderSweepStats {
  scanned: number;
  sent: number;
  skippedNoChannel: number;
  skippedClaimRace: number;
  errors: number;
}

export interface ReminderVisitRow {
  id: string;
  link_version: number;
  scheduled_at: string;
  invite_channel: string | null;
  guest_name: string | null;
  guest_email: string | null;
  guest_phone_e164: string | null;
  patients: {
    status: string;
    email: string | null;
    phone_e164: string | null;
    legal_first_name: string | null;
  } | null;
}

export interface ReminderTarget {
  channel: "sms" | "email";
  to: string;
  firstName: string | null;
}

/** Which channels this environment can actually deliver on right now
 *  (feature flag ON and the vendor client constructible). Folded into
 *  target selection so an undeliverable preferred channel FALLS BACK
 *  to the other one — and so a row is never claimed for a channel
 *  that can't send (review feedback: claiming before checking
 *  deliverability permanently suppressed the reminder). */
export interface ChannelAvailability {
  sms: boolean;
  email: boolean;
}

/**
 * Resolve who to remind and over which channel. Preference order: the
 * channel the original invite used, falling back to whatever contact
 * exists on a deliverable channel. SMS is never picked for a
 * non-active chart-backed patient (TCPA/STOP); guests carry their own
 * contact info. Returns null when there is no usable channel
 * (link-only visits with no contact, or nothing deliverable).
 */
export function pickReminderTarget(
  v: ReminderVisitRow,
  avail: ChannelAvailability,
): ReminderTarget | null {
  const isGuest = !v.patients;
  const smsAllowed = isGuest || v.patients?.status === "active";
  const phone = isGuest ? v.guest_phone_e164 : v.patients?.phone_e164;
  const email = isGuest
    ? (v.guest_email ?? null)
    : (v.patients?.email?.toLowerCase() ?? null);
  const firstName = isGuest
    ? (v.guest_name?.split(/\s+/)[0] ?? null)
    : (v.patients?.legal_first_name ?? null);

  const smsTarget: ReminderTarget | null =
    avail.sms && smsAllowed && phone
      ? { channel: "sms", to: phone, firstName }
      : null;
  const emailTarget: ReminderTarget | null =
    avail.email && email ? { channel: "email", to: email, firstName } : null;

  if (v.invite_channel === "email") return emailTarget ?? smsTarget;
  return smsTarget ?? emailTarget;
}

function formatStartTime(scheduledAt: string): string {
  return new Date(scheduledAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function publicBaseUrl(
  override?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return (
    override ??
    env.SHOP_PUBLIC_BASE_URL ??
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://cmbreathe.com")
  ).replace(/\/$/, "");
}

export function composeReminder(opts: {
  firstName: string | null;
  practiceName: string;
  scheduledAt: string;
  link: string;
}): { sms: string; subject: string; text: string; html: string } {
  const greeting = opts.firstName?.trim() ? opts.firstName.trim() : "there";
  const when = formatStartTime(opts.scheduledAt);
  const sms = `Hi ${greeting}, a reminder from ${opts.practiceName}: your video visit starts at ${when}. Join from your phone or computer: ${opts.link}`;
  const subject = `Your video visit starts soon`;
  const text = [
    `Hi ${greeting},`,
    "",
    `A quick reminder from ${opts.practiceName}: your video visit starts at`,
    `${when}. Join from your phone, tablet, or computer — no app needed:`,
    "",
    opts.link,
    "",
    `— The ${opts.practiceName} team`,
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>Hi ${escapeHtml(greeting)},</p>
    <p>A quick reminder from <strong>${escapeHtml(opts.practiceName)}</strong> —
    your video visit starts at <strong>${escapeHtml(when)}</strong>.</p>
    <p style="margin:20px 0"><a href="${escapeHtml(opts.link)}" style="background:#0b2a4a;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block">Join your video visit</a></p>
    <p style="color:#666;font-size:13px;">No app to install — just a phone,
    tablet, or computer with a camera and microphone.</p>
  </div>`;
  return { sms, subject, text, html };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function emptyReminderStats(): ReminderSweepStats {
  return {
    scanned: 0,
    sent: 0,
    skippedNoChannel: 0,
    skippedClaimRace: 0,
    errors: 0,
  };
}

/** Vendor clients are global today (per-tenant telecom is G7), so they're
 *  built once per run and threaded into every tenant's sweep. The PER-TENANT
 *  feature flags decide whether each tenant is swept and over which channels. */
interface VendorClients {
  twilio: ReturnType<typeof createTwilioSmsClient> | null;
  sendgrid: ReturnType<typeof createSendgridClient> | null;
}

/**
 * Run the video-visit reminder sweep for a SINGLE tenant, accumulating into
 * the shared `stats`. Extracted so the cron can fan out across every active
 * tenant — `video_visits` (and the joined `patients`) are tenant-scoped, so
 * each tenant is swept on its own org-scoped client and a reminder never
 * reaches another tenant's patient. The telehealth + per-channel reminder
 * flags are checked PER TENANT (`feature_flags` is `(org_id, key)`), so one
 * tenant's opt-out never sweeps another's visits.
 */
async function videoVisitReminderSweepForOrg(
  orgId: string,
  now: Date,
  clients: VendorClients,
  stats: ReminderSweepStats,
): Promise<void> {
  if (!(await isFeatureEnabled("telehealth.video", orgId))) return;
  const [smsFlag, emailFlag] = await Promise.all([
    isFeatureEnabled("sms.reminders", orgId),
    isFeatureEnabled("email.reminders", orgId),
  ]);
  // Deliverability = this tenant's flag ON and the vendor client
  // constructible. Computed BEFORE any row is claimed so a row is never
  // claimed for a channel that can't send.
  const avail: ChannelAvailability = {
    sms: !!clients.twilio && smsFlag,
    email: !!clients.sendgrid && emailFlag,
  };
  if (!avail.sms && !avail.email) return;

  // Send under the tenant's own number / Messaging Service when it has
  // one (G7); falls back to the platform default otherwise. The global
  // `clients.twilio` proves SMS is constructible (availability gate
  // above); we build a tenant-scoped sender for the actual send.
  const tenantTwilio = avail.sms
    ? createTwilioSmsClient(await resolveTenantSmsClientOptions(orgId))
    : null;

  // Send under the tenant's own From identity (G6); the global
  // `clients.sendgrid` already proved constructibility in the avail gate,
  // mirroring the tenant SMS pattern above. For the seed tenant this resolves
  // to the platform default From, so single-tenant behavior is unchanged.
  const tenantSendgrid = avail.email
    ? await createTenantSendgridClient(orgId)
    : null;

  const supabase = getOrgScopedClient(orgId);
  const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MS).toISOString();
  const { data, error } = await supabase
    .from("video_visits")
    .select(
      "id, link_version, scheduled_at, invite_channel, guest_name, guest_email, guest_phone_e164, patients(status, email, phone_e164, legal_first_name)",
    )
    .eq("status", "scheduled")
    .is("reminder_sent_at", null)
    .gte("scheduled_at", now.toISOString())
    .lte("scheduled_at", windowEnd)
    .order("scheduled_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  const visits = (data ?? []) as unknown as ReminderVisitRow[];
  // Brand the reminder copy with the tenant's own storefront name (G6); for
  // the seed tenant this resolves to "PennPaps" so single-tenant copy is
  // unchanged.
  const brand = await resolveBrandingByOrgId(orgId);
  const practiceName = brand.storefrontName;
  // Build patient links from the tenant's own storefront origin (its verified
  // custom domain) when it has one; the seed tenant falls through to the env/
  // default, so single-tenant is unchanged. Resolved once per tenant sweep.
  const base = publicBaseUrl((await resolveTenantBaseUrl(orgId)) ?? undefined);

  for (const visit of visits) {
    stats.scanned += 1;
    try {
      const target = pickReminderTarget(visit, avail);
      if (!target) {
        stats.skippedNoChannel += 1;
        continue;
      }

      // Atomic claim: stamp before sending so a crash or vendor retry
      // can never double-text a patient. Re-asserting status=scheduled
      // skips rows cancelled/completed between the select above and
      // this update (a cancel may have revoked the link version); the
      // `is null` predicate makes the claim race-safe if a second
      // worker instance ever appears.
      const { data: claimed, error: claimErr } = await supabase
        .from("video_visits")
        .update({
          reminder_sent_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", visit.id)
        .eq("status", "scheduled")
        .is("reminder_sent_at", null)
        .select("id");
      if (claimErr) throw claimErr;
      if (!claimed || claimed.length === 0) {
        stats.skippedClaimRace += 1;
        continue;
      }

      const token = signVideoVisitToken(
        visit.id,
        "patient",
        visit.link_version,
      );
      const link = `${base}/video-visit?token=${encodeURIComponent(token)}`;
      const message = composeReminder({
        firstName: target.firstName,
        practiceName,
        scheduledAt: visit.scheduled_at,
        link,
      });

      if (target.channel === "sms") {
        // Non-null by construction: avail.sms implied tenantTwilio above.
        await tenantTwilio!.sendSms({ to: target.to, body: message.sms });
      } else {
        // Non-null by construction: avail.email implied tenantSendgrid above.
        await tenantSendgrid!.sendEmail({
          to: target.to,
          // No PHI in the subject line.
          subject: message.subject,
          html: message.html,
          text: message.text,
        });
      }
      stats.sent += 1;
      recordOutboundMessageUsage({
        orgId,
        channel: target.channel === "sms" ? "sms" : "email",
        source: "video_visit_reminder",
      });
    } catch (err) {
      stats.errors += 1;
      logger.warn(
        {
          event: "video-visits.reminder-sweep.send_failed",
          visitId: visit.id,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "video-visit reminder send failed",
      );
    }
  }
}

/**
 * Run the video-visit reminder sweep for EVERY active tenant. Builds the
 * vendor clients once, then fans out with per-tenant failure isolation
 * (forEachActiveOrg), aggregating each tenant's tally. Exported for tests.
 */
export async function runVideoVisitReminderSweep(
  now: Date = new Date(),
): Promise<ReminderSweepStats> {
  const stats = emptyReminderStats();

  // Build the vendor clients once (global telecom today). If NEITHER is
  // constructible there is nothing deliverable anywhere — skip the fan-out.
  const clients: VendorClients = {
    twilio: tryCreateTwilioSms(),
    sendgrid: tryCreateSendgrid(),
  };
  if (!clients.twilio && !clients.sendgrid) return stats;

  await forEachActiveOrg(
    async (orgId) => {
      await videoVisitReminderSweepForOrg(orgId, now, clients, stats);
    },
    { jobName: REMINDER_JOB },
  );

  return stats;
}

function tryCreateSendgrid(): ReturnType<typeof createSendgridClient> | null {
  try {
    return createSendgridClient();
  } catch (err) {
    if (err instanceof EmailConfigError) return null;
    throw err;
  }
}

function tryCreateTwilioSms(): ReturnType<typeof createTwilioSmsClient> | null {
  try {
    return createTwilioSmsClient();
  } catch (err) {
    if (err instanceof TwilioConfigError) return null;
    throw err;
  }
}

export async function registerVideoVisitReminderJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, REMINDER_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(REMINDER_JOB, async () => {
    try {
      const stats = await runVideoVisitReminderSweep();
      if (stats.scanned > 0 || stats.errors > 0) {
        logger.info(
          { event: "video-visits.reminder-sweep.completed", ...stats },
          "video-visits.reminder-sweep: completed",
        );
      }
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "video-visits.reminder-sweep: failed",
      );
      throw err;
    }
  });
  await boss.schedule(REMINDER_JOB, REMINDER_CRON);
  logger.info({ cron: REMINDER_CRON }, "video-visits.reminder-sweep scheduled");
}
