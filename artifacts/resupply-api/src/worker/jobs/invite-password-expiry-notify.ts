// pg-boss job: warn invited team members before (and at) the moment
// their operator-typed temporary password expires.
//
// Background
// ----------
// `lib/resupply-auth/src/team-invite.ts` "Set their password for them"
// path writes `resupply_auth.password_credentials` with
// `must_change=true` and stamps `set_by_admin_at`. The sign-in handler
// (lib/resupply-auth/src/http/sign-in.ts) refuses those credentials
// after `ADMIN_PASSWORD_TTL_MS` (7 days). The admin UI surfaces the
// countdown — but the invited user only learns about it when they
// finally try to sign in and get the "invite_expired" error.
//
// This sweep closes the loop: a heads-up reminder ~2 days before
// expiry, plus a final "your invite has expired, ask for a new one"
// email once the TTL crosses. Both writes use a conditional UPDATE on
// the same `password_credentials` row as the idempotency guard, so a
// re-run of the cron never double-sends.
//
// Eligibility
// -----------
// A credential is eligible iff it still looks like an unconsumed
// admin-typed invite at the moment the sweep runs:
//   * `must_change = true`
//   * `set_by_admin_at IS NOT NULL`
// `writeUserChosenPassword` clears both fields on every user-typed
// password write (sign-up / reset / change), so a user who has
// signed in and rotated their password drops out of the eligible
// set even if our stamp columns are still NULL — no double-send.
//
// Re-invite handling
// ------------------
// Re-inviting the same account stamps a NEW `set_by_admin_at` via
// the upsert in team-invite.ts but does NOT clear the notify stamps
// added by this sweep. We treat any stamp that PREDATES the current
// `set_by_admin_at` as stale and ignore it — that way the second
// invite gets its own reminder + expiry pair without us having to
// teach team-invite.ts about the notifier.

import type PgBoss from "pg-boss";

import {
  createSendgridClient,
  DEFAULT_SENDGRID_FROM_EMAIL,
} from "@workspace/resupply-email";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { ADMIN_PASSWORD_TTL_MS } from "@workspace/resupply-auth";

import { logger } from "../../lib/logger";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

const NOTIFY_JOB = "invite-password.expiry-notify";
// Hourly at :23 — staggered off the top-of-hour bursts the reminders
// + maintenance jobs already use, and frequent enough that a reminder
// scheduled for "T-2 days" lands within an hour of its target.
const NOTIFY_CRON = "23 * * * *";
// Send the heads-up email once the credential is at least this old.
// Two days before the 7-day TTL elapses gives the user a workday or
// two of buffer to chase down the admin or click their original
// invite link before sign-in starts failing.
const REMINDER_LEAD_MS = 2 * 86_400_000;
// Per-run cap so a backlog (e.g. first deploy of this sweep against
// production) doesn't burst SendGrid. The cron picks the rest up on
// the next tick.
const BATCH_SIZE = 200;

interface NotifyStats {
  scannedReminders: number;
  scannedExpired: number;
  remindersSent: number;
  expiredSent: number;
  skippedNoConfig: number;
  skippedNoEmail: number;
  skippedAlreadyClaimed: number;
  errors: number;
}

interface MessagingConfig {
  sendgridApiKey: string | null;
  sendgridFromEmail: string;
  sendgridFromName: string | null;
  practiceName: string;
  publicBaseUrl: string;
}

export function readNotifyMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): MessagingConfig {
  return {
    sendgridApiKey: env.SENDGRID_API_KEY ?? null,
    sendgridFromEmail:
      env.SENDGRID_FROM_EMAIL?.trim() || DEFAULT_SENDGRID_FROM_EMAIL,
    sendgridFromName: env.SENDGRID_FROM_NAME ?? null,
    practiceName: env.RESUPPLY_PRACTICE_NAME ?? "PennPaps",
    publicBaseUrl:
      (env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
        (env.RAILWAY_PUBLIC_DOMAIN
          ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
          : "")) ||
      "",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Compose the day-5 heads-up email. Exported for tests. */
export function composeReminderEmail(opts: {
  practiceName: string;
  publicBaseUrl: string;
  displayName: string | null;
  hoursRemaining: number;
}): { subject: string; html: string; text: string } {
  const greeting = opts.displayName ? `Hi ${opts.displayName},` : "Hi,";
  const signInUrl = opts.publicBaseUrl
    ? `${opts.publicBaseUrl.replace(/\/$/, "")}/admin/sign-in`
    : "";
  const hours = Math.max(1, Math.round(opts.hoursRemaining));
  const subject = `Your ${opts.practiceName} invite expires soon`;
  const text = [
    greeting,
    "",
    `An administrator at ${opts.practiceName} set up a temporary password for you,`,
    `but the invite expires in about ${hours} hours. After that you'll need to ask`,
    "the administrator who invited you to send a new invite.",
    "",
    signInUrl ? `Sign in here to set your own password: ${signInUrl}` : "",
    "",
    "If you've already signed in and chosen your own password, you can ignore this email.",
  ]
    .filter((l) => l !== null)
    .join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>${escapeHtml(greeting)}</p>
    <p>An administrator at <strong>${escapeHtml(opts.practiceName)}</strong> set up a
       temporary password for you, but the invite expires in about
       <strong>${hours} hours</strong>. After that you'll need to ask
       the administrator who invited you to send a new invite.</p>
    ${
      signInUrl
        ? `<p><a href="${escapeHtml(signInUrl)}" style="display:inline-block;padding:10px 18px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:6px;">Sign in and set your password</a></p>`
        : ""
    }
    <p style="color:#666;font-size:13px;">If you've already signed in and chosen your
       own password, you can ignore this email.</p>
  </div>`;
  return { subject, html, text };
}

/** Compose the post-expiry "ask your admin" email. Exported for tests. */
export function composeExpiredEmail(opts: {
  practiceName: string;
  displayName: string | null;
}): { subject: string; html: string; text: string } {
  const greeting = opts.displayName ? `Hi ${opts.displayName},` : "Hi,";
  const subject = `Your ${opts.practiceName} invite has expired`;
  const text = [
    greeting,
    "",
    `The temporary password an administrator at ${opts.practiceName} set up for you`,
    "has expired. Please reach out to the administrator who invited you and",
    "ask them to send a new invite.",
    "",
    "No action is needed if you've already signed in and chosen your own password.",
  ].join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>${escapeHtml(greeting)}</p>
    <p>The temporary password an administrator at
       <strong>${escapeHtml(opts.practiceName)}</strong> set up for you has expired.
       Please reach out to the administrator who invited you and ask them to send a
       new invite.</p>
    <p style="color:#666;font-size:13px;">No action is needed if you've already
       signed in and chosen your own password.</p>
  </div>`;
  return { subject, html, text };
}

interface CandidateRow {
  user_id: string;
  set_by_admin_at: string;
  expiry_reminder_sent_at: string | null;
  expired_notice_sent_at: string | null;
}

interface UserRow {
  id: string;
  email_lower: string;
  display_name: string | null;
}

/** Run a single notify sweep. Exported for tests. */
export async function runInvitePasswordExpiryNotifySweep(
  cfg: MessagingConfig = readNotifyMessagingConfig(),
): Promise<NotifyStats> {
  const stats: NotifyStats = {
    scannedReminders: 0,
    scannedExpired: 0,
    remindersSent: 0,
    expiredSent: 0,
    skippedNoConfig: 0,
    skippedNoEmail: 0,
    skippedAlreadyClaimed: 0,
    errors: 0,
  };
  if (!cfg.sendgridApiKey || !cfg.sendgridFromName) {
    stats.skippedNoConfig = 1;
    logger.warn(
      { event: "invite-password.expiry-notify.skipped_no_config" },
      "invite-password-expiry-notify: skipping run, SendGrid config incomplete",
    );
    return stats;
  }

  const supabase = getSupabaseServiceRoleClient();
  const now = Date.now();
  // A credential becomes "reminder due" when its age crosses
  // `TTL - LEAD_MS` (i.e. ~day 5 with the default 7-day TTL +
  // 2-day lead) and stays due until it expires.
  const reminderCutoff = new Date(
    now - (ADMIN_PASSWORD_TTL_MS - REMINDER_LEAD_MS),
  ).toISOString();
  // A credential is "expired" once its age exceeds the TTL.
  const expiredCutoff = new Date(now - ADMIN_PASSWORD_TTL_MS).toISOString();

  // 1. Heads-up reminder candidates: admin-typed, still inside the
  //    TTL window, never reminded for THIS invite (we re-check the
  //    `set_by_admin_at` vs. `expiry_reminder_sent_at` ordering in
  //    JS to handle re-invites that reused the row).
  const { data: reminderRows, error: reminderErr } = await supabase
    .schema("resupply_auth")
    .from("password_credentials")
    .select(
      "user_id, set_by_admin_at, expiry_reminder_sent_at, expired_notice_sent_at",
    )
    .eq("must_change", true)
    .not("set_by_admin_at", "is", null)
    .lt("set_by_admin_at", reminderCutoff)
    .gt("set_by_admin_at", expiredCutoff)
    .limit(BATCH_SIZE);
  if (reminderErr) throw reminderErr;

  const reminderCandidates = (reminderRows ?? [])
    .filter(
      (r): r is CandidateRow =>
        typeof r.set_by_admin_at === "string" && typeof r.user_id === "string",
    )
    .filter((r) => {
      if (!r.expiry_reminder_sent_at) return true;
      // Re-invite: the new set_by_admin_at is newer than our stamp,
      // so this row deserves a fresh reminder.
      return (
        new Date(r.expiry_reminder_sent_at).getTime() <
        new Date(r.set_by_admin_at).getTime()
      );
    });

  // 2. Expired-notice candidates: TTL elapsed, never notified for
  //    THIS invite.
  const { data: expiredRows, error: expiredErr } = await supabase
    .schema("resupply_auth")
    .from("password_credentials")
    .select(
      "user_id, set_by_admin_at, expiry_reminder_sent_at, expired_notice_sent_at",
    )
    .eq("must_change", true)
    .not("set_by_admin_at", "is", null)
    .lte("set_by_admin_at", expiredCutoff)
    .limit(BATCH_SIZE);
  if (expiredErr) throw expiredErr;

  const expiredCandidates = (expiredRows ?? [])
    .filter(
      (r): r is CandidateRow =>
        typeof r.set_by_admin_at === "string" && typeof r.user_id === "string",
    )
    .filter((r) => {
      if (!r.expired_notice_sent_at) return true;
      return (
        new Date(r.expired_notice_sent_at).getTime() <
        new Date(r.set_by_admin_at).getTime()
      );
    });

  stats.scannedReminders = reminderCandidates.length;
  stats.scannedExpired = expiredCandidates.length;
  if (reminderCandidates.length === 0 && expiredCandidates.length === 0) {
    return stats;
  }

  // Bulk-fetch user rows for both candidate sets in one round-trip.
  const userIds = Array.from(
    new Set([
      ...reminderCandidates.map((r) => r.user_id),
      ...expiredCandidates.map((r) => r.user_id),
    ]),
  );
  const { data: userRows, error: userErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, email_lower, display_name, status")
    .in("id", userIds);
  if (userErr) throw userErr;
  const usersById = new Map<string, UserRow>();
  for (const u of userRows ?? []) {
    // Skip revoked accounts — re-inviting them is the admin's
    // explicit action, not ours to nudge.
    if (u.status === "revoked") continue;
    if (typeof u.email_lower !== "string" || u.email_lower.length === 0) {
      continue;
    }
    usersById.set(u.id, {
      id: u.id,
      email_lower: u.email_lower,
      display_name: u.display_name ?? null,
    });
  }

  const sendgrid = createSendgridClient({
    apiKey: cfg.sendgridApiKey,
    fromEmail: cfg.sendgridFromEmail,
    fromName: cfg.sendgridFromName,
  });

  // --- Heads-up reminders ---
  for (const row of reminderCandidates) {
    const user = usersById.get(row.user_id);
    if (!user) {
      stats.skippedNoEmail += 1;
      continue;
    }

    // Atomic claim — only stamp if the column is still in the
    // "needs reminder" state (NULL or older than the current
    // invite). This is the duplicate-send guard for two workers
    // racing on the same row.
    const nowIso = new Date().toISOString();
    const claim = supabase
      .schema("resupply_auth")
      .from("password_credentials")
      .update({ expiry_reminder_sent_at: nowIso })
      .eq("user_id", row.user_id)
      .eq("must_change", true)
      .eq("set_by_admin_at", row.set_by_admin_at);
    const claimQuery = row.expiry_reminder_sent_at
      ? claim.eq("expiry_reminder_sent_at", row.expiry_reminder_sent_at)
      : claim.is("expiry_reminder_sent_at", null);
    const { data: claimResult, error: claimErr } =
      await claimQuery.select("user_id");

    if (claimErr) {
      logger.warn(
        { err: claimErr, userId: row.user_id },
        "invite-password-expiry-notify: reminder claim failed",
      );
      stats.errors += 1;
      continue;
    }
    if (!claimResult || claimResult.length === 0) {
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    const ageMs = now - new Date(row.set_by_admin_at).getTime();
    const hoursRemaining = Math.max(
      0,
      (ADMIN_PASSWORD_TTL_MS - ageMs) / 3_600_000,
    );
    const { subject, html, text } = composeReminderEmail({
      practiceName: cfg.practiceName,
      publicBaseUrl: cfg.publicBaseUrl,
      displayName: user.display_name,
      hoursRemaining,
    });
    try {
      await sendgrid.sendEmail({
        to: user.email_lower,
        subject,
        html,
        text,
      });
      stats.remindersSent += 1;
    } catch (err) {
      logger.warn(
        { err, userId: row.user_id },
        "invite-password-expiry-notify: reminder send failed",
      );
      stats.errors += 1;
      // Stamp stays — one attempt per invite. Better to skip a
      // single user than risk repeated spam on a transient
      // SendGrid outage.
    }
  }

  // --- Expired notices ---
  for (const row of expiredCandidates) {
    const user = usersById.get(row.user_id);
    if (!user) {
      stats.skippedNoEmail += 1;
      continue;
    }

    const nowIso = new Date().toISOString();
    const claim = supabase
      .schema("resupply_auth")
      .from("password_credentials")
      .update({ expired_notice_sent_at: nowIso })
      .eq("user_id", row.user_id)
      .eq("must_change", true)
      .eq("set_by_admin_at", row.set_by_admin_at);
    const claimQuery = row.expired_notice_sent_at
      ? claim.eq("expired_notice_sent_at", row.expired_notice_sent_at)
      : claim.is("expired_notice_sent_at", null);
    const { data: claimResult, error: claimErr } =
      await claimQuery.select("user_id");

    if (claimErr) {
      logger.warn(
        { err: claimErr, userId: row.user_id },
        "invite-password-expiry-notify: expired claim failed",
      );
      stats.errors += 1;
      continue;
    }
    if (!claimResult || claimResult.length === 0) {
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    const { subject, html, text } = composeExpiredEmail({
      practiceName: cfg.practiceName,
      displayName: user.display_name,
    });
    try {
      await sendgrid.sendEmail({
        to: user.email_lower,
        subject,
        html,
        text,
      });
      stats.expiredSent += 1;
    } catch (err) {
      logger.warn(
        { err, userId: row.user_id },
        "invite-password-expiry-notify: expired send failed",
      );
      stats.errors += 1;
    }
  }

  return stats;
}

export async function registerInvitePasswordExpiryNotifyJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, NOTIFY_JOB, VENDOR_SEND_QUEUE_OPTS);
  await boss.work(NOTIFY_JOB, async () => {
    try {
      const stats = await runInvitePasswordExpiryNotifySweep();
      logger.info(
        { event: "invite-password.expiry-notify.completed", ...stats },
        "invite-password-expiry-notify: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "invite-password-expiry-notify: failed",
      );
      throw err;
    }
  });
  await boss.schedule(NOTIFY_JOB, NOTIFY_CRON);
  logger.info({ cron: NOTIFY_CRON }, "invite-password.expiry-notify scheduled");
}
