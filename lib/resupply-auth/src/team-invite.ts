// Shared invite logic for the team-management routes.
//
// Mirrors the pattern used by `scripts/src/auth-bootstrap-admin.ts`:
// upsert a `resupply_auth.users` row (idempotent on email_lower),
// issue a long-TTL `password_reset` email-token, send a "set your
// password" email via the configured EmailSender, and return the
// resolved `resupply_auth.users.id` so the caller can link any
// product-level roster row (e.g. `resupply.admin_users.auth_user_id`).
//
// Ported from raw `pg.Pool.query` to the Supabase JS service-role
// client (Drizzle → Supabase migration). The original three-statement
// upsert (INSERT … ON CONFLICT (email_lower) DO UPDATE …) becomes a
// read-then-write pair: read the existing row, compute the merged
// values, then `.upsert(..., { onConflict: 'email_lower' })`. The
// `display_name` COALESCE and the `'revoked' → 'invited'` reset CASE
// are computed in JS rather than SQL. The race window between read
// and write is the same one the original UPSERT had — two concurrent
// invites for the same email resolve last-write-wins, which is the
// intended semantics.

import { issueToken } from "./token";
import type { AuthDeps } from "./http/types";
import { renderPasswordResetEmail } from "./http/email-templates";
import { stripTrailingSlashes } from "./string-utils";
import { bufferToHexBytea } from "./bytea";
import type { ResupplySupabaseClient } from "@workspace/resupply-db";

/** Invite tokens are valid for 7 days. Long enough that an
 *  operator can run an invite ahead of telling the user to
 *  expect the email. */
const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface InviteResult {
  /** resupply_auth.users.id for the resolved row. */
  authUserId: string;
  /** True iff the email was actually delivered to SendGrid. */
  emailSent: boolean;
  /** The raw reset link, useful for logs / out-of-band delivery. */
  inviteLink: string;
}

export interface InviteArgs {
  emailLower: string;
  role: "admin" | "agent";
  displayName: string | null;
  productName: string;
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

  // 1. Read existing row (if any) to compute the merged update.
  const { data: existing, error: readErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, status, display_name")
    .eq("email_lower", args.emailLower)
    .limit(1)
    .maybeSingle<{ id: string; status: string; display_name: string | null }>();
  if (readErr) throw readErr;

  let authUserId: string;
  if (existing) {
    // Upgrade-style update: role moves to the requested value;
    // display_name keeps the existing value when caller passes null
    // (COALESCE semantics from the original SQL); status flips back
    // to 'invited' if previously 'revoked', otherwise unchanged.
    const status = existing.status === "revoked" ? "invited" : existing.status;
    const { error: updErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .update({
        role: args.role,
        display_name: args.displayName ?? existing.display_name,
        status,
        updated_at: now.toISOString(),
      })
      .eq("id", existing.id);
    if (updErr) throw updErr;
    authUserId = existing.id;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .insert({
        email_lower: args.emailLower,
        display_name: args.displayName,
        role: args.role,
        status: "invited",
      })
      .select("id")
      .single<{ id: string }>();
    if (insErr) throw insErr;
    authUserId = inserted.id;
  }

  // 2. Issue a fresh password_reset token. We don't revoke prior
  //    tokens — they expire on their own and a user clicking an old
  //    link gets a clean "expired" error from /auth/reset-password.
  const token = issueToken();
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
  const rendered = renderPasswordResetEmail(
    {
      productName: args.productName,
      publicBaseUrl: baseUrl,
      uiPathPrefix: args.uiPathPrefix,
    },
    token.raw,
  );

  let emailSent = false;
  try {
    await deps.email({
      to: args.emailLower,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
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

  return { authUserId, emailSent, inviteLink };
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
