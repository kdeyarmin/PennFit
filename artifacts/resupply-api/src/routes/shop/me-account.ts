// /shop/me/account — self-serve account lifecycle for the signed-in
// storefront customer.
//
//   POST /shop/me/account/close — close ("delete") the account.
//
// Semantics: ANONYMIZE + RETAIN ORDERS (product decision).
//   * Scrub PII (name / email / phone / address / caregiver / comm-prefs)
//     from shop_customers, and the per-order PII snapshot
//     (customer_email + shipping_address_json) from shop_orders.
//   * Keep the order/financial/return RECORDS intact for accounting +
//     legal retention — only the PII fields on them are nulled.
//   * Disable login (auth user status → 'revoked') and revoke every
//     active session, then clear this request's session cookie.
//   * The auth row is kept as a disabled tombstone; its email_lower is
//     replaced with a unique placeholder so (a) the real email is gone and
//     (b) the customer can cleanly re-register later without colliding with
//     the unique login key.
//
// Re-verifies the current password before acting — same "attacker sat down
// at a logged-in machine" mitigation the change-password flow uses. The
// whole operation is idempotent: re-running scrubs already-null fields and
// re-revokes already-revoked sessions, so a client retry after a partial
// failure completes cleanly.
//
// CSRF: covered by the app-level `requireCsrfWhenSessionOnShopMutations`
// gate (app.ts) — every /shop/me mutation with a session must carry the
// pf_csrf double-submit token. PHI/log posture: customer id only, never
// the scrubbed values or the recipient.

import { Router, type IRouter } from "express";
import { z } from "zod";

import {
  SESSION_COOKIE,
  appendSetCookie,
  buildClearCookies,
  hashToken,
  readCookie,
  verifyPasswordCredential,
} from "@workspace/resupply-auth";
import { getOrgScopedClient } from "@workspace/resupply-db";

import { getAuthDeps } from "../../lib/auth-deps";
import { fireAndForgetAudit } from "../../lib/audit-fire-and-forget";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const closeBodySchema = z
  .object({
    // Re-verify the current password. A destructive, irreversible action
    // should not be one stray click away on an unattended logged-in tab.
    password: z.string().min(1).max(2048),
  })
  .strict();

router.post("/shop/me/account/close", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId!;
  const orgId = req.orgId;
  // Match the tenant-context guard convention (getOrgScopedClient throws on
  // a blank id).
  if (!orgId || !orgId.trim()) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }

  const parsed = closeBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  // Resolve the underlying auth user from the session cookie. requireSignedIn
  // exposes the customer key, not the auth user id, but the auth-side work
  // (password verify, status, session revoke) is keyed on auth.users.id.
  const deps = getAuthDeps();
  const raw = readCookie(req, SESSION_COOKIE);
  const tokenHash = raw ? hashToken(raw) : null;
  const session = tokenHash
    ? await deps.repo.findSessionByTokenHash(tokenHash)
    : null;
  if (!session) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const authUserId = session.userId;

  // Re-verify the current password against the auth credential.
  const cred = await deps.repo.findCredentialByUserId(authUserId);
  if (!cred) {
    // No password on file (shouldn't happen for a password-auth account).
    // Can't verify ⇒ refuse rather than close on an unverifiable request.
    res.status(400).json({ error: "password_unavailable" });
    return;
  }
  const { ok } = await verifyPasswordCredential(parsed.data.password, cred);
  if (!ok) {
    res.status(403).json({ error: "invalid_password" });
    return;
  }

  const nowIso = new Date().toISOString();
  const supabase = getOrgScopedClient(orgId);

  // 1) Scrub the customer's PII profile (org-scoped). Financial/clinical
  //    columns (stripe ids, membership, device/physician) are deliberately
  //    retained.
  const { error: custErr } = await supabase
    .from("shop_customers")
    .update({
      email_lower: null,
      display_name: null,
      shipping_address_json: null,
      phone_e164: null,
      phone_line_type: null,
      phone_line_type_source: null,
      phone_line_type_checked_at: null,
      caregiver_email: null,
      caregiver_name: null,
      communication_preferences: null,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId);
  if (custErr) throw custErr;

  // 2) Scrub the per-order PII snapshot but KEEP the order records.
  const { error: ordersErr } = await supabase
    .from("shop_orders")
    .update({
      customer_email: null,
      shipping_address_json: null,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId);
  if (ordersErr) throw ordersErr;

  // 3) Scrub the auth row's PII and disable login. email_lower is the unique
  //    login key, so it's replaced with a per-user placeholder rather than
  //    nulled — removes the real email AND lets the person re-register later.
  const { error: authErr } = await supabase
    .raw()
    .schema("resupply_auth")
    .from("users")
    .update({
      email_lower: `closed+${authUserId}@account.invalid`,
      display_name: null,
      updated_at: nowIso,
    })
    .eq("id", authUserId);
  if (authErr) throw authErr;
  await deps.repo.updateUserStatus(authUserId, "revoked");

  // 4) Revoke every active session so the closed account can't keep acting
  //    through an already-issued cookie elsewhere.
  await deps.repo.revokeAllUserSessions(authUserId, new Date());

  // Through the helper, not a bare `void`: `void p` silences
  // no-floating-promises but leaves a rejection UNHANDLED, and index.ts exits
  // the process on unhandledRejection. See lib/audit-fire-and-forget.ts.
  fireAndForgetAudit(
    deps.audit,
    {
      action: "auth.account_closed",
      adminUserId: authUserId,
      metadata: { customerId },
    },
    req.log,
  );

  req.log?.info?.(
    { customerId },
    "shop/me/account: account closed + anonymized by customer",
  );

  // 5) Clear the session cookie on the way out — the SPA redirects to a
  //    signed-out state.
  appendSetCookie(res, buildClearCookies({ secure: deps.secureCookies }));
  res.json({ closed: true });
});

export default router;
