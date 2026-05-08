// Shared invite logic for the team-management routes.
//
// Mirrors the pattern used by `scripts/src/auth-bootstrap-admin.ts`:
// upsert an `resupply_auth.users` row (idempotent on email_lower), issue a
// long-TTL `password_reset` email-token, send a "set your
// password" email via the configured EmailSender, and return the
// resolved resupply_auth.users.id so the caller can link any product-level
// roster row (e.g. resupply.admin_users.auth_user_id).
//
// Both team-management routes (Resupply admin/team and Penn
// admin-users) import this helper rather than duplicating the
// upsert + token + email logic. The helper takes a Pool so each
// product can wire its own DB pool (resupply-api uses
// `getDbPool` from resupply-db; api-server uses `pool` from
// lib/db — both target the same DATABASE_URL but the import
// graph wants them to stay distinct).

import type { Pool } from "pg";

import { issueToken } from "./token";
import type { AuthDeps } from "./http/types";
import { renderPasswordResetEmail } from "./http/email-templates";
import { stripTrailingSlashes } from "./string-utils";

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
 * the store and is now being promoted) are upgraded to
 * admin/agent. The caller is responsible for any "you can't
 * promote yourself" / "this email is already a member" gating.
 */
export async function inviteTeamMember(
  pool: Pool,
  deps: AuthDeps,
  args: InviteArgs,
): Promise<InviteResult> {
  const now = new Date();
  const baseUrl = (args.publicBaseUrl ?? deps.publicBaseUrl).replace(/\/$/, "");

  // Upsert the resupply_auth.users row. Conflict on email_lower → update
  // role to the requested value AND clear status to 'invited' if
  // the row was 'revoked'. Active rows keep their email_verified_at
  // (they already proved they own the inbox); we just bump the
  // role.
  const upserted = await pool.query<{ id: string; status: string }>(
    `INSERT INTO resupply_auth.users
       (email_lower, display_name, role, status)
     VALUES ($1, $2, $3, 'invited')
     ON CONFLICT (email_lower) DO UPDATE
       SET role = EXCLUDED.role,
           display_name = COALESCE(EXCLUDED.display_name, resupply_auth.users.display_name),
           status = CASE WHEN resupply_auth.users.status = 'revoked' THEN 'invited'
                         ELSE resupply_auth.users.status END,
           updated_at = NOW()
     RETURNING id, status`,
    [args.emailLower, args.displayName, args.role],
  );
  const authUserId = upserted.rows[0]!.id;

  // Issue a fresh password_reset token. We don't revoke prior
  // tokens — they expire on their own and a user clicking an old
  // link gets a clean "expired" error from /auth/reset-password.
  const token = issueToken();
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);
  await pool.query(
    `INSERT INTO resupply_auth.email_tokens
       (token_hash, user_id, purpose, expires_at)
     VALUES ($1, $2, 'password_reset', $3)`,
    [token.hash, authUserId, expiresAt],
  );

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
 * `resupply_auth.users.status='revoked'` (which makes requireAdmin reject
 * subsequent cookies) AND revokes every active session for the
 * user (so a logged-in tab loses access on its next request).
 */
export async function revokeTeamMember(
  pool: Pool,
  authUserId: string,
): Promise<void> {
  const now = new Date();
  await pool.query(
    `UPDATE resupply_auth.users
        SET status = 'revoked', updated_at = $2
      WHERE id = $1`,
    [authUserId, now],
  );
  await pool.query(
    `UPDATE resupply_auth.sessions
        SET revoked_at = $2
      WHERE user_id = $1
        AND revoked_at IS NULL`,
    [authUserId, now],
  );
}

/**
 * Update the role on an existing resupply_auth.users row. Returns true if
 * a row was updated, false otherwise.
 */
export async function updateTeamMemberRole(
  pool: Pool,
  authUserId: string,
  role: "admin" | "agent",
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE resupply_auth.users
        SET role = $2, updated_at = NOW()
      WHERE id = $1`,
    [authUserId, role],
  );
  return (result.rowCount ?? 0) > 0;
}
