// Shared invite logic for the team-management routes.
//
// Mirrors the pattern used by `scripts/src/auth-bootstrap-admin.ts`:
// upsert a `resupply_auth.users` row (idempotent on email_lower),
// issue a long-TTL `password_reset` email-token, send a welcome /
// "set up your account" email via the configured EmailSender, and
// return the resolved `resupply_auth.users.id` so the caller can link
// any product-level roster row (e.g. `resupply.admin_users.auth_user_id`).
//
// The email is `renderTeamInviteEmail` — a proper welcome that
// explains the app, the member's username + role, and the attached
// getting-started guides. (It historically reused the password-RESET
// template, so brand-new employees were told "we received a request
// to reset your password" — wrong task, confusing first touch.)
//
// Ported from raw `pg.Pool.query` to the Supabase JS service-role
// client. The original three-statement
// upsert (INSERT … ON CONFLICT (email_lower) DO UPDATE …) becomes a
// read-then-write pair: read the existing row, compute the merged
// values, then `.upsert(..., { onConflict: 'email_lower' })`. The
// `display_name` COALESCE and the `'revoked' → 'invited'` reset CASE
// are computed in JS rather than SQL. The race window between read
// and write is the same one the original UPSERT had — two concurrent
// invites for the same email resolve last-write-wins, which is the
// intended semantics.

import { issueToken } from "./token";
import { hashPassword } from "./password";
import { validatePassword } from "./password-policy";
import type { AuthDeps, EmailAttachment } from "./http/types";
import { renderTeamInviteEmail } from "./http/email-templates";
import { stripTrailingSlashes } from "./string-utils";
import { bufferToHexBytea } from "./bytea";
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

/** Invite tokens are valid for 7 days. Long enough that an
 *  operator can run an invite ahead of telling the user to
 *  expect the email. */
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an admin-typed password (set via the "Set their password
 * for them" team-invite path) remains valid before the sign-in
 * handler refuses it. Mirrors `INVITE_TOKEN_TTL_MS` so the two
 * operator paths — email invite and out-of-band password — have the
 * same window. Exported so the sign-in handler and any UI surface
 * can reference the same number.
 */
export const ADMIN_PASSWORD_TTL_MS = INVITE_TOKEN_TTL_MS;
export const ADMIN_PASSWORD_TTL_DAYS = 7;

export interface InviteResult {
  /** resupply_auth.users.id for the resolved row. */
  authUserId: string;
  /** True iff the email was actually delivered to SendGrid. */
  emailSent: boolean;
  /** The raw reset link, useful for logs / out-of-band delivery.
   *  Empty string when `initialPassword` is used (no token issued). */
  inviteLink: string;
  /** True iff the caller supplied an `initialPassword` and the
   *  account is immediately sign-in-ready. The email/token branch
   *  is skipped in that case. */
  signInReady: boolean;
}

export interface InviteArgs {
  emailLower: string;
  role: "admin" | "agent";
  displayName: string | null;
  productName: string;
  /**
   * Company name rendered as the closing signature of the invite
   * email, e.g. "Penn Home Medical Supply". Optional; omitted →
   * no signature block.
   */
  signatureName?: string;
  /**
   * Human-readable role label shown in the welcome email's
   * account-details block (e.g. "Customer service rep"). Callers with
   * a granular role catalog should pass the same label their UI
   * renders; when omitted, a default is derived from the coarse
   * `role` ("Super admin" / "Customer service rep").
   */
  roleLabel?: string;
  /**
   * Public base URL for the app the invite link should point at.
   * Falls back to `deps.publicBaseUrl` when omitted.
   */
  publicBaseUrl?: string;
  /**
   * UI path prefix prepended to `/reset-password` in the invite
   * link. Use `"/admin"` for staff/admin invites so the link
   * lands on the admin SPA's reset page; leave undefined for
   * customer-facing invites. Must start with `/` and have no
   * trailing slash.
   */
  uiPathPrefix?: string;
  /**
   * Optional. When provided, the account is created/updated as
   * status='active' with email_verified_at stamped to now and a
   * password credential set to this value. No email is sent and
   * no email_token is minted — the admin is expected to convey
   * the password out-of-band (in person, secure chat, etc.) so
   * the user can sign in immediately. Must be at least 8 chars.
   *
   * This is the "skip the broken invite email" escape hatch for
   * cases where SendGrid delivery is unreliable or the admin
   * already has a secure channel to the user.
   */
  initialPassword?: string;
  /**
   * Optional files attached to the invite email — used to ship the
   * new team member their role-specific getting-started help
   * documents. Ignored on the `initialPassword` path (no email is
   * sent). Forwarded verbatim to `deps.email`; a host whose wired
   * sender drops attachments simply sends the email without them.
   */
  attachments?: ReadonlyArray<EmailAttachment>;
}

/**
 * Mint or refresh an `resupply_auth.users` row for an invited team
 * member, issue a 7-day password_reset email-token, and send the
 * email. Idempotent: re-inviting the same email upgrades the
 * existing row's role + reissues the token.
 *
 * Customer-role rows in resupply_auth.users (e.g. someone who shopped at
 * the store and is now being promoted) are upgraded to admin/agent.
 * The caller is responsible for any "you can't promote yourself" /
 * "this email is already a member" gating.
 */
export async function inviteTeamMember(
  supabase: ResupplySupabaseClient,
  deps: AuthDeps,
  args: InviteArgs,
): Promise<InviteResult> {
  const now = new Date();
  const baseUrl = (args.publicBaseUrl ?? deps.publicBaseUrl).replace(/\/$/, "");

  const useInitialPassword =
    typeof args.initialPassword === "string" && args.initialPassword.length > 0;
  if (useInitialPassword) {
    // Use the same policy as sign-up / reset / change-password so
    // operator-set passwords are no weaker than user-set ones.
    const check = validatePassword(args.initialPassword);
    if (!check.ok) {
      throw new Error(`initialPassword: ${check.error.message}`);
    }
  }

  // When initialPassword is supplied, the account is provisioned
  // sign-in-ready: status=active and email_verified_at=now. The
  // email-token branch is skipped entirely (see step 2 below).
  const targetStatus = useInitialPassword ? "active" : "invited";
  const nowIso = now.toISOString();

  // 1. Read existing row (if any) to compute the merged update.
  const { data: existing, error: readErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, status, display_name, email_verified_at")
    .eq("email_lower", args.emailLower)
    .limit(1)
    .maybeSingle<{
      id: string;
      status: string;
      display_name: string | null;
      email_verified_at: string | null;
    }>();
  if (readErr) throw readErr;

  let authUserId: string;
  if (existing) {
    // Upgrade-style update: role moves to the requested value;
    // display_name keeps the existing value when caller passes null
    // (COALESCE semantics from the original SQL).
    //
    // Status:
    //   * initialPassword path → force to 'active' so sign-in works.
    //   * email-invite path    → flip 'revoked' back to 'invited',
    //                            otherwise leave the existing status
    //                            alone (an already-active user just
    //                            getting role-bumped stays active).
    let status: string;
    if (useInitialPassword) {
      status = "active";
    } else if (existing.status === "revoked") {
      status = "invited";
    } else {
      status = existing.status;
    }

    const update: {
      role: string;
      display_name: string | null;
      status: string;
      updated_at: string;
      email_verified_at?: string;
    } = {
      role: args.role,
      display_name: args.displayName ?? existing.display_name,
      status,
      updated_at: nowIso,
    };
    // Stamp email_verified_at on the initialPassword path so the
    // sign-in handler's `!user.emailVerifiedAt` gate lets the user
    // through. Don't overwrite an existing timestamp.
    if (useInitialPassword && existing.email_verified_at == null) {
      update.email_verified_at = nowIso;
    }

    const { error: updErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .update(update)
      .eq("id", existing.id);
    if (updErr) throw updErr;
    authUserId = existing.id;
  } else {
    const insert: {
      email_lower: string;
      display_name: string | null;
      role: string;
      status: string;
      email_verified_at?: string;
    } = {
      email_lower: args.emailLower,
      display_name: args.displayName,
      role: args.role,
      status: targetStatus,
    };
    if (useInitialPassword) insert.email_verified_at = nowIso;
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .insert(insert)
      .select("id")
      .single<{ id: string }>();
    if (insErr) throw insErr;
    authUserId = inserted.id;
  }

  // initialPassword path: set the credential and return. No token
  // is minted and no email is sent — the admin conveys the
  // password to the user out-of-band.
  if (useInitialPassword) {
    const passwordHash = await hashPassword(args.initialPassword!);
    const { error: credErr } = await supabase
      .schema("resupply_auth")
      .from("password_credentials")
      .upsert(
        {
          user_id: authUserId,
          password_hash: passwordHash,
          must_change: true,
          // Stamp the moment this operator-typed password landed
          // on the row. The sign-in handler pairs this with
          // must_change=true to refuse credentials whose owner
          // never signed in inside ADMIN_PASSWORD_TTL_MS — see
          // lib/resupply-auth/src/http/sign-in.ts. Cleared back
          // to NULL on a successful password change / reset.
          set_by_admin_at: nowIso,
          updated_at: nowIso,
        },
        { onConflict: "user_id" },
      );
    if (credErr) throw credErr;

    void deps.audit({
      action: "auth.invite_password_set",
      adminEmail: args.emailLower,
      adminUserId: authUserId,
      metadata: { role: args.role, mode: "initial_password" },
    });

    return {
      authUserId,
      emailSent: false,
      inviteLink: "",
      signInReady: true,
    };
  }

  // 2. Issue a fresh password_reset token, expiring any prior live
  //    ones first. Re-inviting (or re-sending) must not leave a stack
  //    of concurrently valid links in old emails — a user clicking a
  //    superseded link gets a clean "expired" error from
  //    /auth/reset-password.
  const token = issueToken();
  const { error: expireErr } = await supabase
    .schema("resupply_auth")
    .from("email_tokens")
    .update({ expires_at: nowIso })
    .eq("user_id", authUserId)
    .eq("purpose", "password_reset")
    .is("consumed_at", null)
    .gt("expires_at", nowIso);
  if (expireErr) throw expireErr;
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);
  const { error: tokErr } = await supabase
    .schema("resupply_auth")
    .from("email_tokens")
    .insert({
      token_hash: bufferToHexBytea(token.hash),
      user_id: authUserId,
      purpose: "password_reset",
      expires_at: expiresAt.toISOString(),
    });
  if (tokErr) throw tokErr;

  const safePrefix = stripTrailingSlashes(args.uiPathPrefix ?? "");
  const inviteLink = `${baseUrl}${safePrefix}/reset-password?token=${encodeURIComponent(token.raw)}`;
  const rendered = renderTeamInviteEmail(
    {
      productName: args.productName,
      signatureName: args.signatureName,
      publicBaseUrl: baseUrl,
      uiPathPrefix: args.uiPathPrefix,
    },
    {
      rawToken: token.raw,
      ttlMs: INVITE_TOKEN_TTL_MS,
      email: args.emailLower,
      displayName: args.displayName,
      roleLabel:
        args.roleLabel ??
        (args.role === "admin" ? "Super admin" : "Customer service rep"),
      attachmentFilenames: args.attachments?.map((a) => a.filename),
    },
  );

  let emailSent = false;
  try {
    await deps.email({
      to: args.emailLower,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
      ...(args.attachments && args.attachments.length > 0
        ? { attachments: args.attachments }
        : {}),
    });
    emailSent = true;
  } catch {
    // The configured EmailSender is responsible for its own
    // logging. We just surface emailSent=false so the caller can
    // expose `inviteLink` to the operator UI for out-of-band
    // delivery.
  }

  void deps.audit({
    action: "auth.invite_issued",
    adminEmail: args.emailLower,
    adminUserId: authUserId,
    metadata: { role: args.role, expiresAt: expiresAt.toISOString() },
  });

  return { authUserId, emailSent, inviteLink, signInReady: false };
}

/**
 * Revoke an invited or active team member. Sets
 * `resupply_auth.users.status='revoked'` (which makes requireAdmin
 * reject subsequent cookies) AND revokes every active session for
 * the user (so a logged-in tab loses access on its next request).
 */
export async function revokeTeamMember(
  supabase: ResupplySupabaseClient,
  authUserId: string,
): Promise<void> {
  const nowIso = new Date().toISOString();
  const { error: userErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .update({ status: "revoked", updated_at: nowIso })
    .eq("id", authUserId);
  if (userErr) throw userErr;

  const { error: sessionsErr } = await supabase
    .schema("resupply_auth")
    .from("sessions")
    .update({ revoked_at: nowIso })
    .eq("user_id", authUserId)
    .is("revoked_at", null);
  if (sessionsErr) throw sessionsErr;
}

export interface DeleteTeamMemberResult {
  /** True iff the resupply_auth.users row was hard-deleted (the
   *  cascading FKs from 0022 remove password_credentials, sessions,
   *  and email_tokens with it). */
  authUserDeleted: boolean;
  /** True iff the identity row was kept because it is shared with a
   *  customer account, and was demoted back to role='customer'
   *  instead of deleted. */
  authUserDemotedToCustomer: boolean;
}

/**
 * Erase the auth-side footprint of a team invite / membership, as if
 * the invite never happened. Counterpart to `revokeTeamMember`, which
 * keeps the row around as an audit trail — this one removes it.
 *
 * Two modes, chosen by the caller (which owns the product-side
 * roster and knows whether the identity is shared):
 *
 *   * `preserveAsCustomer: false` — the row exists only because of
 *     the invite. Hard-delete it; `password_credentials`, `sessions`,
 *     and `email_tokens` all CASCADE (migration 0022), which also
 *     kills any outstanding invite link.
 *
 *   * `preserveAsCustomer: true` — the same resupply_auth.users row
 *     backs a non-staff login: a shop-customer account, a
 *     patient-portal login, or a provider-portal account (all three
 *     are created with role='customer' and may share the row with a
 *     later staff invite, since invites reuse rows by email_lower).
 *     Deleting it would destroy that login, so instead: demote the
 *     role back to 'customer', restore status from the
 *     email-verification state ('revoked'/'invited' would lock the
 *     person out), expire any unconsumed password_reset tokens (dead
 *     invite links, audit rows kept), and revoke live sessions so a
 *     staff-scoped cookie can't linger.
 */
export async function deleteTeamMember(
  supabase: ResupplySupabaseClient,
  authUserId: string,
  opts: { preserveAsCustomer: boolean },
): Promise<DeleteTeamMemberResult> {
  if (!opts.preserveAsCustomer) {
    const { error } = await supabase
      .schema("resupply_auth")
      .from("users")
      .delete()
      .eq("id", authUserId);
    if (error) throw error;
    return { authUserDeleted: true, authUserDemotedToCustomer: false };
  }

  const { data: user, error: readErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, email_verified_at")
    .eq("id", authUserId)
    .limit(1)
    .maybeSingle<{ id: string; email_verified_at: string | null }>();
  if (readErr) throw readErr;
  if (!user) {
    return { authUserDeleted: false, authUserDemotedToCustomer: false };
  }

  const nowIso = new Date().toISOString();
  const { error: updErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .update({
      role: "customer",
      // A verified customer goes back to 'active'; an unverified one
      // back to 'invited' (sign-in refuses unverified accounts either
      // way). Leaving 'revoked' in place would lock them out of their
      // own customer account.
      status: user.email_verified_at ? "active" : "invited",
      updated_at: nowIso,
    })
    .eq("id", authUserId);
  if (updErr) throw updErr;

  // Dead-letter the invite's set-password links. Only unconsumed
  // password_reset tokens — consumed rows are audit trail, and the
  // customer's own signup_verify tokens are untouched.
  const { error: tokErr } = await supabase
    .schema("resupply_auth")
    .from("email_tokens")
    // Preserve audit trail: dead-letter invite/reset links by expiring them,
    // rather than deleting rows.
    .update({ expires_at: nowIso })
    .eq("user_id", authUserId)
    .eq("purpose", "password_reset")
    .is("consumed_at", null);
  if (tokErr) throw tokErr;

  const { error: sessErr } = await supabase
    .schema("resupply_auth")
    .from("sessions")
    .update({ revoked_at: nowIso })
    .eq("user_id", authUserId)
    .is("revoked_at", null);
  if (sessErr) throw sessErr;

  return { authUserDeleted: false, authUserDemotedToCustomer: true };
}

/**
 * Update the role on an existing resupply_auth.users row. Returns
 * true if a row was updated, false otherwise.
 */
export async function updateTeamMemberRole(
  supabase: ResupplySupabaseClient,
  authUserId: string,
  role: "admin" | "agent",
): Promise<boolean> {
  const { data, error } = await supabase
    .schema("resupply_auth")
    .from("users")
    .update({ role, updated_at: new Date().toISOString() })
    .eq("id", authUserId)
    .select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}
