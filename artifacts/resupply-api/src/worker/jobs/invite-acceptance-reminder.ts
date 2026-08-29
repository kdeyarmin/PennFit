// pg-boss job: nudge people who were sent an invitation and never signed in.
//
// Background
// ----------
// `lib/resupply-auth/src/team-invite.ts` has two operator paths. The one
// where an admin TYPES a temporary password is already covered by
// `invite-password-expiry-notify.ts` (migration 0143). This job covers the
// other — and far more common — one: mint a 7-day `password_reset`
// email_token, mail a `.../reset-password?token=…` link, and hope. Nothing
// followed up. If the recipient never clicked, the invite expired in
// silence: no second email to them, no signal to the operator, and the
// account sat at `status='invited'` forever.
//
// Two nudges per invite, both inside the link's own lifetime:
//   * a mid-window reminder once the link has <= 4 days left, and
//   * a final "expires tomorrow" once it has <= 24 hours left.
//
// Thresholds are expressed as time REMAINING (read off the token's own
// `expires_at`) rather than as an age, so they stay correct if
// `INVITE_TOKEN_TTL_MS` is ever retuned. The two windows are mutually
// exclusive, so one sweep never sends both to the same person.
//
// What counts as "never logged in"
// --------------------------------
// `resupply_auth.users.status = 'invited' AND email_verified_at IS NULL`.
// That pair is the ONLY reliable signal, and it is written by
// `markEmailVerified()` (lib/resupply-auth/src/supabase-repository.ts) when
// the invitee consumes their set-password token.
//
// The roster-side columns look tempting and are traps:
//   * `resupply.admin_users.accepted_at` is written only at provisioning
//     time (and only on the typed-password path) — never on acceptance.
//   * `resupply.admin_users.last_login_at` has NO writer anywhere in the
//     codebase. It is dead data; every row reads NULL.
//   * `resupply.admin_users.status` is never flipped 'pending' → 'active',
//     so an accepted member still reads 'pending' there. `platform/tenants.ts`
//     documents the same trap.
// So the roster tables are used ONLY to answer "which tenant is this, and
// which portal were they invited to" — never "did they accept".
//
// Why the scan starts from the token side
// ---------------------------------------
// `resupply_auth` carries no `org_id`, so this is a global sweep (same
// posture as `invite-password-expiry-notify` and the dedup-key prune) rather
// than a `forEachActiveOrg` fan-out. Starting from live `password_reset`
// tokens keeps the candidate set naturally tiny — outstanding invites only —
// instead of walking every tenant's roster and patient list every hour.
//
// A `password_reset` token is ALSO minted by the ordinary "I forgot my
// password" flow. Those belong to accounts that are already `status='active'`
// with `email_verified_at` set, so the acceptance gate above excludes them:
// nobody who merely reset their password gets told they never accepted an
// invite.
//
// Scope: staff/team invites (including platform-issued tenant-admin invites)
// and patient-portal invites. Provider-portal invites are deliberately NOT
// nudged — see PROVIDER_PORTAL_EXCLUDED below.

import type PgBoss from "pg-boss";

import { EmailConfigError } from "@workspace/resupply-email";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { createTenantSendgridClient } from "../../lib/email/tenant-sender.js";
import {
  resolveBrandingByOrgId,
  resolveTenantLinkBaseUrl,
} from "../../lib/tenant-branding.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

const REMINDER_JOB = "invite.acceptance-reminder";
// Hourly at :47 — the next free minute in the staggered set the other hourly
// sweeps use (:07 :13 :19 :23 :29 :37 :43), so this doesn't stack onto
// another job's SendGrid burst. Hourly (rather than daily) so a nudge lands
// within an hour of the window it was scheduled for, matching the cadence
// invite-password-expiry-notify already runs at.
const REMINDER_CRON = "47 * * * *";

/**
 * Nudge once the invite link has this much time or less left on it. With the
 * standard 7-day `INVITE_TOKEN_TTL_MS` this fires on day 3 — late enough that
 * it isn't nagging someone who simply hasn't opened their mail yet, early
 * enough that they can still act on it during a work week.
 */
const REMINDER_REMAINING_MS = 4 * 86_400_000;
/** Final nudge once the link has a day or less left. */
const FINAL_REMAINING_MS = 86_400_000;
/**
 * Per-run cap, applied to the token scan. A backlog (the first deploy of
 * this sweep against production, say) is drained an hour at a time rather
 * than bursting SendGrid in one tick.
 */
const BATCH_SIZE = 200;

/**
 * Provider-portal invites (`resupply.provider_portal_accounts`) are out of
 * scope, for two independent reasons:
 *
 *  1. That table has no `org_id` — a clinician is a global NPI login linked
 *     to any number of tenants through `provider_dme_links`, so there is no
 *     single tenant whose name and sending domain the nudge could go out
 *     under.
 *  2. The provider portal deliberately has no self-service recovery flow at
 *     all (`provider-sign-in.tsx` links to none; recovery is routed through a
 *     coordinator). The one action this email can offer — "request a fresh
 *     link yourself" — does not exist for them, so the nudge would either be
 *     a dead end or would have to contradict that decision.
 *
 * Their invites still expire quietly. Closing that gap means giving the
 * coordinator a stalled-invite view, not emailing the clinician.
 */
const PROVIDER_PORTAL_EXCLUDED = true;

/** Which invite flow minted this token — selects the recovery CTA. */
type InviteKind = "staff" | "patient";

interface ReminderStats {
  /** Live, unconsumed password_reset tokens inspected. */
  scannedTokens: number;
  /** Of those, the ones whose owner still hasn't accepted. */
  pendingInvites: number;
  remindersSent: number;
  finalRemindersSent: number;
  skippedNoTenant: number;
  skippedUnmappedUser: number;
  skippedAlreadyClaimed: number;
  errors: number;
}

function emptyStats(): ReminderStats {
  return {
    scannedTokens: 0,
    pendingInvites: 0,
    remindersSent: 0,
    finalRemindersSent: 0,
    skippedNoTenant: 0,
    skippedUnmappedUser: 0,
    skippedAlreadyClaimed: 0,
    errors: 0,
  };
}

export interface InviteReminderConfig {
  /** Platform fallback for tenants whose link base resolves to the platform host. */
  publicBaseUrl: string;
}

export function readInviteReminderConfig(
  env: NodeJS.ProcessEnv = process.env,
): InviteReminderConfig {
  return {
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

/**
 * The sign-in surface an invitee of this kind belongs on. Staff live under
 * the admin SPA; portal patients on the storefront root.
 */
function pathPrefixFor(kind: InviteKind): string {
  return kind === "staff" ? "/admin" : "";
}

function formatRemaining(msRemaining: number): string {
  const hours = Math.max(1, Math.round(msRemaining / 3_600_000));
  if (hours < 48) return `${hours} hours`;
  return `${Math.round(hours / 24)} days`;
}

/**
 * Compose an invite nudge. Exported for tests.
 *
 * Deliberately carries NO set-password link. `email_tokens` stores only the
 * SHA-256 of the token, so the original link is unreconstructable here — and
 * minting a replacement would silently extend a credential-granting link's
 * lifetime on a background job's say-so, which is the operator's call, not
 * this sweep's. Instead the email points at forgot-password, which mints a
 * fresh link on demand; that endpoint explicitly works for unverified
 * accounts (lib/resupply-auth/src/http/forgot-password.ts) and marks the
 * address verified on success, so it completes the invite properly.
 */
export function composeInviteReminderEmail(opts: {
  practiceName: string;
  publicBaseUrl: string;
  displayName: string | null;
  kind: InviteKind;
  msRemaining: number;
  final: boolean;
}): { subject: string; html: string; text: string } {
  const greeting = opts.displayName ? `Hi ${opts.displayName},` : "Hi,";
  const base = opts.publicBaseUrl.replace(/\/$/, "");
  const prefix = pathPrefixFor(opts.kind);
  const recoverUrl = `${base}${prefix}/forgot-password`;
  const remaining = formatRemaining(opts.msRemaining);
  // The account is named in the BODY, not just the subject: someone who is
  // mid-onboarding with more than one provider (or who was invited to both a
  // team seat and a patient portal) otherwise can't tell which invite this
  // is chasing, and the CTA goes to a host they may not recognise.
  const account =
    opts.kind === "staff"
      ? `${opts.practiceName} team account`
      : `${opts.practiceName} patient portal account`;

  const subject = opts.final
    ? `Last chance to set up your ${account}`
    : `Finish setting up your ${account}`;

  const lead = opts.final
    ? `Your invitation to set up your ${account} expires in about ${remaining}. After that you'll need to ask us for a new one.`
    : `You haven't finished setting up your ${account} yet. The invitation we emailed you is still good for about another ${remaining}.`;
  const action =
    "Open that invitation email and click the set-up link. If you can't find it, you can send yourself a fresh link here:";

  const text = [
    greeting,
    "",
    lead,
    "",
    action,
    recoverUrl,
    "",
    "Already signed in and set your password? Then you're all set — you can ignore this.",
  ].join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(lead)}</p>
    <p>${escapeHtml(action)}</p>
    <p><a href="${escapeHtml(recoverUrl)}" style="display:inline-block;padding:10px 18px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:6px;">Send me a new set-up link</a></p>
    <p style="color:#666;font-size:13px;">Already signed in and set your password? Then you're all set — you can
       ignore this.</p>
  </div>`;

  return { subject, html, text };
}

interface TokenRow {
  user_id: string;
  expires_at: string;
  created_at: string;
}

interface PendingUser {
  id: string;
  email_lower: string;
  display_name: string | null;
  invite_reminder_sent_at: string | null;
  invite_final_reminder_sent_at: string | null;
}

/**
 * True when `stamp` does not account for the CURRENT invite — i.e. this
 * nudge is still owed. Two ways that happens:
 *
 *   * `stamp` is NULL — we have never sent this nudge to this person; or
 *   * `stamp` PREDATES the live token — they were re-invited (or the
 *     operator hit "resend") after we last nudged them, so the newer invite
 *     has not been nudged yet.
 *
 * The second case is the reason this is a comparison rather than a NULL
 * check: nothing ever clears the stamps, so without it a re-invite would
 * silently inherit the previous invite's "already nudged" state.
 */
function nudgeStillOwed(stamp: string | null, tokenCreatedAt: string): boolean {
  if (!stamp) return true;
  return new Date(stamp).getTime() < new Date(tokenCreatedAt).getTime();
}

/** Run a single invite-reminder sweep. Exported for tests. */
export async function runInviteAcceptanceReminderSweep(
  cfg: InviteReminderConfig = readInviteReminderConfig(),
): Promise<ReminderStats> {
  const stats = emptyStats();
  // The chokepoint idiom for a global sweep (same as
  // invite-password-expiry-notify and the dedup-key prune): resolve any org to
  // obtain a client, then read through `.raw()`. Every read below is
  // DELIBERATELY cross-tenant — `resupply_auth` has no org_id at all, and the
  // two roster reads have to span tenants because the sweep is driven by the
  // global token table, not by one tenant's roster. Tenancy is honoured where
  // it actually matters: each recipient's own org decides the sender, the
  // brand, and the host its CTA points at (see the send loop).
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return stats;
  const supabase = getOrgScopedClient(seedOrgId);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  // Only tokens still inside their own lifetime: an expired link can't be
  // acted on, and telling someone to hurry up on a dead invite is worse than
  // saying nothing. The already-expired case is the operator's to re-send.
  const reminderCutoff = new Date(now + REMINDER_REMAINING_MS).toISOString();

  const { data: tokenRows, error: tokenErr } = await supabase
    .raw()
    .schema("resupply_auth")
    .from("email_tokens")
    .select("user_id, expires_at, created_at")
    .eq("purpose", "password_reset")
    .is("consumed_at", null)
    .gt("expires_at", nowIso)
    .lte("expires_at", reminderCutoff)
    // Soonest-to-expire first. BATCH_SIZE truncates the scan, and an
    // unordered truncation would let a backlog starve exactly the invites
    // that can least afford to wait a tick — the ones in the final 24 hours.
    .order("expires_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (tokenErr) throw tokenErr;

  const tokens = (tokenRows ?? []).filter(
    (r): r is TokenRow =>
      typeof r.user_id === "string" &&
      typeof r.expires_at === "string" &&
      typeof r.created_at === "string",
  );
  stats.scannedTokens = tokens.length;
  if (tokens.length === 0) return stats;

  // A resend leaves the superseded token rows behind with their expires_at
  // pushed to now (team-invite.ts expires rather than deletes, for audit), so
  // in principle a user can appear more than once. Keep the newest live one.
  const liveTokenByUser = new Map<string, TokenRow>();
  for (const t of tokens) {
    const prior = liveTokenByUser.get(t.user_id);
    if (
      !prior ||
      new Date(t.created_at).getTime() > new Date(prior.created_at).getTime()
    ) {
      liveTokenByUser.set(t.user_id, t);
    }
  }
  const userIds = Array.from(liveTokenByUser.keys());

  // The acceptance gate. Anyone who consumed their invite is already
  // status='active' with email_verified_at stamped and drops out here.
  const { data: userRows, error: userErr } = await supabase
    .raw()
    .schema("resupply_auth")
    .from("users")
    .select(
      "id, email_lower, display_name, invite_reminder_sent_at, invite_final_reminder_sent_at",
    )
    .in("id", userIds)
    .eq("status", "invited")
    .is("email_verified_at", null);
  if (userErr) throw userErr;

  const pendingById = new Map<string, PendingUser>();
  for (const u of userRows ?? []) {
    if (typeof u.email_lower !== "string" || u.email_lower.length === 0) {
      continue;
    }
    pendingById.set(u.id, {
      id: u.id,
      email_lower: u.email_lower,
      display_name: u.display_name ?? null,
      invite_reminder_sent_at: u.invite_reminder_sent_at ?? null,
      invite_final_reminder_sent_at: u.invite_final_reminder_sent_at ?? null,
    });
  }
  stats.pendingInvites = pendingById.size;
  if (pendingById.size === 0) return stats;

  const pendingIds = Array.from(pendingById.keys());

  // Tenant + kind. Both roster tables are read cross-tenant (this sweep is
  // global), and are consulted ONLY for org_id and for which portal the
  // person belongs on — never for whether they accepted.
  const kindByUser = new Map<string, { orgId: string; kind: InviteKind }>();

  const { data: staffRows, error: staffErr } = await supabase
    .raw()
    .schema("resupply")
    .from("admin_users")
    .select("auth_user_id, org_id, status")
    .in("auth_user_id", pendingIds);
  if (staffErr) throw staffErr;
  for (const row of (staffRows ?? []) as Array<{
    auth_user_id: string | null;
    org_id: string | null;
    status: string | null;
  }>) {
    // A revoked seat is the operator's explicit decision to un-invite. Don't
    // chase someone to finish joining a team they've been removed from.
    if (row.status === "revoked") continue;
    if (row.auth_user_id && row.org_id) {
      kindByUser.set(row.auth_user_id, { orgId: row.org_id, kind: "staff" });
    }
  }

  const { data: patientRows, error: patientErr } = await supabase
    .raw()
    .schema("resupply")
    .from("patients")
    .select("portal_auth_user_id, org_id")
    .in("portal_auth_user_id", pendingIds);
  if (patientErr) throw patientErr;
  for (const row of (patientRows ?? []) as Array<{
    portal_auth_user_id: string | null;
    org_id: string | null;
  }>) {
    if (!row.portal_auth_user_id || !row.org_id) continue;
    // A staff seat wins if the same identity somehow holds both: staff copy
    // points at /admin, which is where that person actually signs in.
    if (kindByUser.has(row.portal_auth_user_id)) continue;
    kindByUser.set(row.portal_auth_user_id, {
      orgId: row.org_id,
      kind: "patient",
    });
  }

  for (const userId of pendingIds) {
    const user = pendingById.get(userId);
    const token = liveTokenByUser.get(userId);
    if (!user || !token) continue;

    // Unmapped: a provider-portal invite (excluded above), or an identity
    // whose roster row was hard-deleted. Either way there is no tenant to
    // send as, so there is nothing safe to send.
    const mapping = kindByUser.get(userId);
    if (!mapping) {
      stats.skippedUnmappedUser += 1;
      continue;
    }

    const msRemaining = new Date(token.expires_at).getTime() - now;
    if (msRemaining <= 0) continue;
    // The two windows are mutually exclusive, so a single sweep never sends
    // both nudges to one person.
    const final = msRemaining <= FINAL_REMAINING_MS;
    const stampCol = final
      ? "invite_final_reminder_sent_at"
      : "invite_reminder_sent_at";
    const priorStamp = final
      ? user.invite_final_reminder_sent_at
      : user.invite_reminder_sent_at;
    if (!nudgeStillOwed(priorStamp, token.created_at)) {
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    // Brand + host must both come from the invitee's own tenant: the CTA is a
    // forgot-password link, and a platform-host link would resolve to the
    // wrong org. A tenant with no verified domain is skipped rather than sent
    // a link that lands somewhere else.
    const brand = await resolveBrandingByOrgId(mapping.orgId);
    const base = await resolveTenantLinkBaseUrl(
      mapping.orgId,
      cfg.publicBaseUrl,
    );
    if (!base) {
      stats.skippedNoTenant += 1;
      logger.info(
        { orgId: mapping.orgId },
        "invite-acceptance-reminder: skipped (no tenant domain)",
      );
      continue;
    }

    // Resolve the tenant's sender BEFORE claiming the stamp, not after.
    // `createSendgridClient` throws EmailConfigError at CONSTRUCTION rather
    // than at first send (see lib/resupply-email/src/client.ts), and a
    // missing key is a condition that gets FIXED later — so claiming first
    // would burn the nudge on every pending invite the first time this runs
    // without SendGrid configured (a preview environment, or a production
    // deploy before the key lands) and, since nothing clears the stamps,
    // those invites would never be nudged even once it is configured.
    // Same ordering rationale as lib/resupply-reminders/src/send-email.ts,
    // which constructs SendGrid before its `conversations` insert.
    let sendgrid: Awaited<ReturnType<typeof createTenantSendgridClient>>;
    try {
      sendgrid = await createTenantSendgridClient(mapping.orgId);
    } catch (err) {
      // Not an error to retry — a tenant that can't send mail yet.
      if (err instanceof EmailConfigError) {
        stats.skippedNoTenant += 1;
        continue;
      }
      throw err;
    }

    // Atomic claim. Stamping BEFORE the send, conditional on the column still
    // holding the value we read, is what stops two workers racing the same
    // row into a double-send. `updated_at` is deliberately not bumped — it
    // marks identity changes, and "we emailed them" is not one.
    // Spelled out rather than built with a computed key: the generated row
    // types reject an index-signature payload, and a literal also keeps the
    // "only ever one stamp column per write" property visible.
    const stampPatch = final
      ? { invite_final_reminder_sent_at: nowIso }
      : { invite_reminder_sent_at: nowIso };
    const claim = supabase
      .raw()
      .schema("resupply_auth")
      .from("users")
      .update(stampPatch)
      .eq("id", userId)
      .eq("status", "invited");
    const claimQuery = priorStamp
      ? claim.eq(stampCol, priorStamp)
      : claim.is(stampCol, null);
    const { data: claimed, error: claimErr } = await claimQuery.select("id");
    if (claimErr) {
      logger.warn(
        { err: claimErr, userId },
        "invite-acceptance-reminder: claim failed",
      );
      stats.errors += 1;
      continue;
    }
    if (!claimed || claimed.length === 0) {
      stats.skippedAlreadyClaimed += 1;
      continue;
    }

    const { subject, html, text } = composeInviteReminderEmail({
      practiceName: brand.storefrontName,
      publicBaseUrl: base,
      displayName: user.display_name,
      kind: mapping.kind,
      msRemaining,
      final,
    });

    try {
      await sendgrid.sendEmail({
        to: user.email_lower,
        subject,
        html,
        text,
      });
      if (final) stats.finalRemindersSent += 1;
      else stats.remindersSent += 1;
    } catch (err) {
      logger.warn({ err, userId }, "invite-acceptance-reminder: send failed");
      stats.errors += 1;
      // The stamp stays. One attempt per nudge window: re-sending on the next
      // tick after a transient SendGrid failure risks hammering an invitee
      // hourly for the rest of the window, which is worse than a missed nudge
      // (the other window still gets its own attempt).
    }
  }

  return stats;
}

export async function registerInviteAcceptanceReminderJob(
  boss: PgBoss,
): Promise<void> {
  // Bulk sweep rather than a single vendor send, so two overrides on the
  // vendor preset (same reasoning as the maintenance-nudge sweep):
  //   * policy "singleton" — a manual re-trigger or a retry landing near the
  //     next cron tick can't run concurrently with an in-flight sweep.
  //   * retryLimit 1 — the preset's 5 retries would re-sweep the whole
  //     backlog up to 5x. Per-recipient send errors are already caught inline
  //     and never throw, so the only thing that retries is a DB-level failure.
  await createQueueWithDlq(boss, REMINDER_JOB, VENDOR_SEND_QUEUE_OPTS, {
    policy: "singleton",
    retryLimit: 1,
  });
  await boss.work(REMINDER_JOB, async () => {
    try {
      const stats = await runInviteAcceptanceReminderSweep();
      logger.info(
        { event: "invite.acceptance-reminder.completed", ...stats },
        "invite-acceptance-reminder: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "invite-acceptance-reminder: failed",
      );
      throw err;
    }
  });
  await boss.schedule(REMINDER_JOB, REMINDER_CRON);
  logger.info(
    { cron: REMINDER_CRON, providerPortalExcluded: PROVIDER_PORTAL_EXCLUDED },
    "invite.acceptance-reminder scheduled",
  );
}
