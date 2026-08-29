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
// This sweep reads none of them.
//
// Which invite, and whose
// -----------------------
// Both answers come off the TOKEN, stamped at mint time by the flow that
// issued it (migration 0535): `invite_kind` says which portal, and
// `invite_org_id` says which tenant.
//
// Neither can be inferred safely, which is why the columns exist:
//   * "Is this an invite?" — four invite flows and the ordinary
//     forgot-password flow all write `purpose='password_reset'`, and an
//     invitee stays `status='invited'` until a reset completes, so the
//     acceptance gate does not separate them. Chasing a recovery token is
//     not hypothetical: this job's own CTA sends people to forgot-password.
//   * "Whose invite?" — `resupply_auth` has no org_id, and the roster
//     tables cannot stand in for one. A portal identity is reused by
//     `email_lower`, so someone who is a patient at two DMEs is ONE auth row
//     with TWO `resupply.patients` rows (a non-unique index), and
//     `provider_portal_accounts` has no org_id at all.
//
// A token with no provenance — a genuine password reset, a verify link, or
// anything minted before 0535 — is simply never chased. That is the safe
// direction, and the pre-0535 set drains within the 7-day token lifetime.
//
// Why the scan starts from the token side
// ---------------------------------------
// `resupply_auth` carries no `org_id`, so this is a global sweep (same
// posture as `invite-password-expiry-notify` and the dedup-key prune) rather
// than a `forEachActiveOrg` fan-out. Starting from live invite tokens keeps
// the candidate set naturally tiny — outstanding invites only — instead of
// walking every tenant's roster and patient list every hour.
//
// Scope: staff/team invites (including platform-issued tenant-admin invites),
// patient-portal invites, and provider-portal invites. The provider copy
// routes recovery through the tenant's coordinator rather than a
// self-service link, because that portal deliberately has no reset flow —
// see `recoveryPathFor`.

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
 * Per-run cap on EMAILS SENT — not on rows scanned. A backlog (the first
 * deploy of this sweep against production, say) is drained an hour at a time
 * rather than bursting SendGrid in one tick.
 */
const SEND_CAP = 200;
/** Rows per token-scan page. */
const SCAN_PAGE_SIZE = 200;
/**
 * Ceiling on pages walked per tick, so one run can't scan unboundedly when
 * almost every candidate is already stamped. SCAN_PAGE_SIZE * MAX_SCAN_PAGES
 * is the most tokens a single tick will look at.
 */
const MAX_SCAN_PAGES = 25;

/**
 * Which invite flow minted this token. Stamped on `email_tokens.invite_kind`
 * at mint time (migration 0535) and mirrored by a DB CHECK; selects the
 * account wording and the recovery CTA.
 */
type InviteKind = "staff" | "patient" | "provider";

interface ReminderStats {
  /** Live, unconsumed INVITE tokens inspected (non-invite tokens are
   *  excluded by the query and never counted). */
  scannedTokens: number;
  /** Of those, the ones whose owner still hasn't accepted. */
  pendingInvites: number;
  remindersSent: number;
  finalRemindersSent: number;
  skippedNoTenant: number;
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
    skippedAlreadyClaimed: 0,
    errors: 0,
  };
}

export interface InviteReminderConfig {
  /** Platform fallback for tenants whose link base resolves to the platform host. */
  publicBaseUrl: string;
}

/**
 * Same precedence as `getAuthDeps().publicBaseUrl` (SHOP_PUBLIC_BASE_URL →
 * REMINDER_PUBLIC_BASE_URL), with the voice/Railway hosts kept as a tail
 * fallback.
 *
 * This deliberately does NOT copy the sibling notify job's reader, which
 * starts at RESUPPLY_VOICE_PUBLIC_BASE_URL. A deployment that sets only
 * SHOP_PUBLIC_BASE_URL sends invites fine (the invite flows read
 * getAuthDeps), but that reader would return "" here — and for a tenant
 * with no verified custom domain `resolveTenantLinkBaseUrl` then hands
 * back the empty fallback, silently skipping every reminder for invites
 * that were themselves delivered successfully. A follow-up must resolve
 * the same host the invitation did.
 */
export function readInviteReminderConfig(
  env: NodeJS.ProcessEnv = process.env,
): InviteReminderConfig {
  const railway = env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
    : "";
  return {
    publicBaseUrl: (
      env.SHOP_PUBLIC_BASE_URL?.trim() ||
      env.REMINDER_PUBLIC_BASE_URL?.trim() ||
      env.RESUPPLY_VOICE_PUBLIC_BASE_URL?.trim() ||
      railway ||
      ""
    ).replace(/\/$/, ""),
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
 * The self-service recovery page for this kind of invitee, or null when the
 * portal deliberately has none.
 *
 * Staff live under the admin SPA, portal patients on the storefront root —
 * both have a working `/forgot-password`. The PROVIDER portal does not, by
 * design: `provider-sign-in.tsx` links to no reset flow and recovery is
 * routed through the DME's coordinator. `/api/provider/auth/forgot-password`
 * exists but is reachable only by an unauthenticated direct POST, so
 * pointing a clinician at it would send them to a page that does not exist.
 * Their nudge names the coordinator route instead.
 */
function recoveryPathFor(kind: InviteKind): string | null {
  if (kind === "staff") return "/admin/forgot-password";
  if (kind === "patient") return "/forgot-password";
  return null;
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
  const recoveryPath = recoveryPathFor(opts.kind);
  const recoverUrl = recoveryPath ? `${base}${recoveryPath}` : null;
  const remaining = formatRemaining(opts.msRemaining);
  // The account is named in the BODY, not just the subject: someone who is
  // mid-onboarding with more than one provider (or who was invited to both a
  // team seat and a patient portal) otherwise can't tell which invite this
  // is chasing, and the CTA goes to a host they may not recognise.
  const account =
    opts.kind === "staff"
      ? `${opts.practiceName} team account`
      : opts.kind === "patient"
        ? `${opts.practiceName} patient portal account`
        : `${opts.practiceName} provider portal account`;

  const subject = opts.final
    ? `Last chance to set up your ${account}`
    : `Finish setting up your ${account}`;

  const lead = opts.final
    ? `Your invitation to set up your ${account} expires in about ${remaining}. After that you'll need to ask us for a new one.`
    : `You haven't finished setting up your ${account} yet. The invitation we emailed you is still good for about another ${remaining}.`;
  // Clinicians get pointed at their coordinator rather than a self-service
  // page, because the provider portal has none — see recoveryPathFor.
  const action = recoverUrl
    ? "Open that invitation email and click the set-up link. If you can't find it, you can send yourself a fresh link here:"
    : `Open that invitation email and click the set-up link. If you can't find it, contact your ${opts.practiceName} coordinator and they'll send a new invitation.`;

  const text = [
    greeting,
    "",
    lead,
    "",
    action,
    ...(recoverUrl ? [recoverUrl] : []),
    "",
    "Already signed in and set your password? Then you're all set — you can ignore this.",
  ].join("\n");

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px;line-height:1.45;">
    <p>${escapeHtml(greeting)}</p>
    <p>${escapeHtml(lead)}</p>
    <p>${escapeHtml(action)}</p>
    ${
      recoverUrl
        ? `<p><a href="${escapeHtml(recoverUrl)}" style="display:inline-block;padding:10px 18px;background:#1e3a8a;color:#fff;text-decoration:none;border-radius:6px;">Send me a new set-up link</a></p>`
        : ""
    }
    <p style="color:#666;font-size:13px;">Already signed in and set your password? Then you're all set — you can
       ignore this.</p>
  </div>`;

  return { subject, html, text };
}

interface InviteTokenRow {
  user_id: string;
  expires_at: string;
  created_at: string;
  /** Non-null on any row that passes {@link isInviteToken}. */
  invite_org_id: string;
  invite_kind: InviteKind;
}

const INVITE_KINDS: ReadonlySet<string> = new Set([
  "staff",
  "patient",
  "provider",
]);

/**
 * Narrow a raw token row to one carrying complete invite provenance.
 *
 * A DB CHECK (migration 0535) already keeps `invite_kind` and `invite_org_id`
 * set or unset together, so a half-stamped row shouldn't exist — but this
 * sweep sends mail in a tenant's name, and "the constraint says it can't
 * happen" is not a reason to hand an undefined org to the branding resolver.
 */
function isInviteToken(r: unknown): r is InviteTokenRow {
  const t = r as Partial<InviteTokenRow> | null;
  return (
    !!t &&
    typeof t.user_id === "string" &&
    typeof t.expires_at === "string" &&
    typeof t.created_at === "string" &&
    typeof t.invite_org_id === "string" &&
    t.invite_org_id.length > 0 &&
    typeof t.invite_kind === "string" &&
    INVITE_KINDS.has(t.invite_kind)
  );
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

  // Cache of organizations.status, so a page full of one tenant's invitees
  // costs one lookup rather than one per recipient.
  const orgActive = new Map<string, boolean>();
  const isOrgActive = async (orgId: string): Promise<boolean> => {
    const hit = orgActive.get(orgId);
    if (hit !== undefined) return hit;
    const { data, error } = await supabase
      .raw()
      .schema("resupply")
      .from("organizations")
      .select("id, status")
      .eq("id", orgId)
      .limit(1)
      .maybeSingle();
    // Fail CLOSED: if we can't confirm the tenant is active we don't send
    // mail in its name. A read error retries on the next tick; a suspended
    // tenant must not keep emailing.
    const active =
      !error && (data as { status?: string } | null)?.status === "active";
    orgActive.set(orgId, active);
    return active;
  };

  // Page over the windowed tokens rather than taking one fixed slice.
  //
  // The send cap has to count SENDS, not rows scanned. Claiming a nudge
  // stamps `resupply_auth.users`, which does nothing to remove the token from
  // this query — so a single fixed page would return the same already-stamped
  // rows every hour. With a same-day onboarding batch larger than one page
  // (every invite sharing an expiry, so the tie-break order is stable), the
  // first page would hold the window open until it expired and everyone
  // behind it would age out without ever being nudged.
  let sent = 0;
  for (let page = 0; page < MAX_SCAN_PAGES && sent < SEND_CAP; page += 1) {
    const from = page * SCAN_PAGE_SIZE;
    const { data: tokenRows, error: tokenErr } = await supabase
      .raw()
      .schema("resupply_auth")
      .from("email_tokens")
      .select("user_id, expires_at, created_at, invite_org_id, invite_kind")
      // Provenance IS the filter. `purpose='password_reset'` is shared with
      // the ordinary forgot-password flow, and an invitee stays
      // status='invited' until they finish a reset — so the acceptance gate
      // downstream cannot separate the two. Only a token that declared itself
      // an invitation at mint time is chased; anything else (a recovery
      // token, a verify token, anything issued before migration 0535) reads
      // as NULL and is ignored. Matches the partial index from 0535.
      .not("invite_kind", "is", null)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .lte("expires_at", reminderCutoff)
      // Soonest-to-expire first, so the invites that can least afford to wait
      // a tick — the ones in their final 24 hours — are always served first.
      .order("expires_at", { ascending: true })
      .range(from, from + SCAN_PAGE_SIZE - 1);
    if (tokenErr) throw tokenErr;

    const inviteTokens = (tokenRows ?? []).filter(isInviteToken);
    if ((tokenRows ?? []).length === 0) break;
    stats.scannedTokens += inviteTokens.length;
    if (inviteTokens.length === 0) continue;

    const userIds = Array.from(new Set(inviteTokens.map((t) => t.user_id)));

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
    stats.pendingInvites += pendingById.size;
    if (pendingById.size === 0) continue;

    const pendingIds = Array.from(pendingById.keys());

    // Re-read each candidate's live invite tokens with NO upper bound on
    // expiry, and keep the newest.
    //
    // The windowed query above cannot do this on its own: a patient-portal
    // RESEND inserts a new token WITHOUT expiring the old one
    // (patient-portal-invite.ts, unlike team-invite.ts which does expire the
    // prior ones). So the superseded token enters the 4-day window days
    // before the live one does. Acting on it would send "expires tomorrow"
    // about a link the patient has already been sent a replacement for, and
    // then stamp the user — which, because the stamp would post-date the
    // newer token, would suppress that token's real reminders entirely.
    const { data: allTokenRows, error: allTokenErr } = await supabase
      .raw()
      .schema("resupply_auth")
      .from("email_tokens")
      .select("user_id, expires_at, created_at, invite_org_id, invite_kind")
      .not("invite_kind", "is", null)
      .is("consumed_at", null)
      .gt("expires_at", nowIso)
      .in("user_id", pendingIds);
    if (allTokenErr) throw allTokenErr;

    const newestByUser = new Map<string, InviteTokenRow>();
    for (const t of (allTokenRows ?? []).filter(isInviteToken)) {
      const prior = newestByUser.get(t.user_id);
      if (
        !prior ||
        new Date(t.created_at).getTime() > new Date(prior.created_at).getTime()
      ) {
        newestByUser.set(t.user_id, t);
      }
    }

    for (const userId of pendingIds) {
      if (sent >= SEND_CAP) break;
      const user = pendingById.get(userId);
      const token = newestByUser.get(userId);
      if (!user || !token) continue;

      // Tenant and portal come straight off the token, stamped at mint time
      // by whichever invite flow issued it (migration 0535). This used to be
      // reverse-looked-up through `resupply.admin_users` and
      // `resupply.patients`, which could not answer it: a portal identity is
      // reused by `email_lower`, so one person who is a patient at two DMEs
      // is ONE auth row with TWO roster rows, and nothing said whose invite
      // was outstanding. Those identities had to be dropped, and
      // provider-portal invites — whose accounts carry no org_id at all —
      // could not be handled. The token knows.
      const mapping = { orgId: token.invite_org_id, kind: token.invite_kind };

      // A suspended tenant must not keep sending mail in its own name — the
      // same contract `listActiveOrgIds` gives every forEachActiveOrg sweep
      // for free, which this global sweep has to apply for itself.
      if (!(await isOrgActive(mapping.orgId))) {
        stats.skippedNoTenant += 1;
        continue;
      }

      const msRemaining = new Date(token.expires_at).getTime() - now;
      // The newest token may sit outside the nudge window even though an
      // older one pulled this user into the page. Leave it — it earns its own
      // reminders when it gets there.
      if (msRemaining <= 0 || msRemaining > REMINDER_REMAINING_MS) continue;
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

      // Counts against the cap whatever the vendor does next: the stamp is
      // already spent, so this recipient is done for this window either way.
      sent += 1;
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
        // The stamp stays. One attempt per nudge window: re-sending on the
        // next tick after a transient SendGrid failure risks hammering an
        // invitee hourly for the rest of the window, which is worse than a
        // missed nudge (the other window still gets its own attempt).
      }
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
  logger.info({ cron: REMINDER_CRON }, "invite.acceptance-reminder scheduled");
}
