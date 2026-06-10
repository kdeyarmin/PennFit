// Wiring layer between the resupply-api Express app and
// `@workspace/resupply-auth`. Builds the AuthDeps object that the
// in-house auth router needs:
//
//   - env: from `readAuthEnv(process.env)`.
//   - repo: supabaseAuthRepository over the shared service-role client.
//   - audit: a thin adapter over `@workspace/resupply-audit.logAudit`
//     (which writes to resupply.audit_log). Auth events go through
//     the same chokepoint as everything else for one-grep
//     incident response.
//   - email: SendGrid via `createSendgridClient()`. Failures are
//     swallowed inside the auth handler — but we LOG them here.
//   - publicBaseUrl: comes from RESUPPLY_VOICE_PUBLIC_BASE_URL or
//     SHOP_PUBLIC_BASE_URL depending on which UI is consuming the
//     dashboard auth pages.
//
// The module is lazy: nothing here runs until the API server
// asks for `getAuthDeps()`. After Stage 5a the function always
// returns a value (the kill switch is gone). The previous
// version threw on a missing/short AUTH_PASSWORD_PEPPER; the
// pepper was removed in the Task #38 follow-up so there is no
// such fail-fast check anymore. Any other required-env misconfig
// throws at first call so it surfaces at boot instead of on the
// first sign-in attempt.

import {
  createSendgridClient,
  EmailApiError,
  EmailConfigError,
} from "@workspace/resupply-email";
import { createHmac } from "node:crypto";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import { getLinkHmacKey } from "@workspace/resupply-secrets";
import {
  readAuthEnv,
  supabaseAuthRepository,
  type AuthDeps,
  type CustomerIdResolver,
  type EmailSender,
  type MfaProbe,
} from "@workspace/resupply-auth";

import { logger } from "./logger";

let cachedDeps: AuthDeps | undefined;

/**
 * Constructs and memoizes the AuthDeps object used by the authentication handlers.
 *
 * The constructed object is cached and returned on subsequent calls. Any exception
 * raised during the initial construction (for example, due to missing environment
 * configuration or repository initialization failures) will propagate to the caller.
 *
 * @returns The assembled `AuthDeps` instance; the same cached instance is returned on subsequent calls.
 */
export function getAuthDeps(): AuthDeps {
  if (cachedDeps !== undefined) return cachedDeps;
  const env = readAuthEnv(process.env);
  const repo = supabaseAuthRepository(getSupabaseServiceRoleClient());

  const audit: AuthDeps["audit"] = (event) => {
    // logAudit is async + write-through; auth handlers don't
    // await us. Forward the failure to the logger and swallow.
    void logAudit({
      action: event.action,
      adminEmail: event.adminEmail ?? null,
      adminUserId: event.adminUserId ?? null,
      metadata: event.metadata ?? {},
      ip: event.ip ?? null,
      userAgent: event.userAgent ?? null,
    }).catch((err) => {
      logger.warn(
        {
          event: "auth_audit_write_failed",
          action: event.action,
          err: err instanceof Error ? err.message : "unknown",
        },
        "auth audit write failed",
      );
    });
  };

  const email = makeSendgridSender();

  const publicBaseUrl = (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.REMINDER_PUBLIC_BASE_URL ??
    "http://localhost:5173"
  ).replace(/\/$/, "");

  // Surface fail-open rate-limit events via the structured logger so
  // ops can alert when a DB hiccup silently disables the gate.
  //
  // PII posture: `context.emailLower` carries a per-endpoint sentinel
  // for the non-sign-in flows ("__forgot:<ip>", "__reset:<ip>",
  // "__verify:<ip>") that's safe to log verbatim, but on the
  // /auth/sign-in path it carries the REAL normalized user email.
  // We surface the bucket only when it's a sentinel; otherwise we
  // emit a redaction marker so the operator can still tell the
  // sign-in flow tripped without the actual address ending up in
  // searchable log storage.
  const SENTINEL_PREFIX = "__";
  const rateLimitOnError: AuthDeps["rateLimitOnError"] = (err, context) => {
    const emailBucket = context.emailLower.startsWith(SENTINEL_PREFIX)
      ? context.emailLower
      : "<sign-in-email-redacted>";
    logger.warn(
      {
        event: "auth_rate_limit_check_failed",
        emailBucket,
        ip: context.ip,
        err: err instanceof Error ? err.message : "unknown",
      },
      "auth rate-limit check failed (fail-open)",
    );
  };

  cachedDeps = {
    env,
    repo,
    audit,
    email,
    publicBaseUrl,
    secureCookies: process.env.NODE_ENV === "production",
    allowSignUp: false, // staff-facing API: no public sign-up
    customerIdResolver: makeCustomerIdResolver(),
    mfa: makeMfaProbe(),
    mfaChallengeHmacKey: deriveMfaChallengeKey(),
    rateLimitOnError,
  };
  return cachedDeps;
}

/**
 * Resolve the admin_users.id for an auth user, or null. `staff_user_id`
 * on admin_mfa_secrets references admin_users.id, not auth.users.id;
 * the sign-in handler passes auth.users.id, so we bridge here.
 */
async function adminIdForAuthUser(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  authUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id")
    .eq("auth_user_id", authUserId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

/**
 * Resolve the provider_portal_accounts.id for an auth user, or null.
 * provider_mfa_secrets.account_id references the portal account.
 */
async function providerAccountIdForAuthUser(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  authUserId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("provider_portal_accounts")
    .select("id")
    .eq("auth_user_id", authUserId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.id as string | undefined) ?? null;
}

/**
 * MFA probe — bridges an auth.users.id to its TOTP enrollment.
 *
 * The probe is UNIFIED across both authenticated populations:
 *
 *   * Staff (admin / CSR) keyed by admin_mfa_secrets (admin_users).
 *   * Providers keyed by provider_mfa_secrets (provider_portal_accounts).
 *
 * A given auth user belongs to exactly one population, so each method
 * tries the staff tables first and falls back to the provider tables.
 * Unifying them here is a SECURITY requirement, not a convenience: the
 * same `getAuthDeps()` object is mounted on every /auth router (admin,
 * storefront, AND provider). If the probe only knew about admin secrets,
 * a provider could sign in through the storefront mount password-only —
 * bypassing the MFA the provider portal requires. With the provider
 * fallback wired here, an enrolled provider is challenged for a code on
 * EVERY sign-in surface.
 */
function makeMfaProbe(): MfaProbe {
  return {
    async findActiveSecret(userId) {
      const supabase = getSupabaseServiceRoleClient();
      // After the multi-device migration, this is "any active
      // secret" — used by sign-in to detect "does this user have
      // MFA at all?" The verify path uses findAllActiveSecrets to
      // try each device.
      const adminId = await adminIdForAuthUser(supabase, userId);
      if (adminId) {
        const { data, error } = await supabase
          .schema("resupply")
          .from("admin_mfa_secrets")
          .select("secret_base32, verified_at, last_used_counter")
          .eq("staff_user_id", adminId)
          .not("verified_at", "is", null)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        if (data) {
          return {
            secretBase32: data.secret_base32,
            lastUsedCounter: data.last_used_counter,
          };
        }
      }
      // Provider fallback.
      const accountId = await providerAccountIdForAuthUser(supabase, userId);
      if (!accountId) return null;
      const { data, error } = await supabase
        .schema("resupply")
        .from("provider_mfa_secrets")
        .select("secret_base32, verified_at, last_used_counter")
        .eq("account_id", accountId)
        .not("verified_at", "is", null)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        secretBase32: data.secret_base32,
        lastUsedCounter: data.last_used_counter,
      };
    },
    async findAllActiveSecrets(userId) {
      const supabase = getSupabaseServiceRoleClient();
      const adminId = await adminIdForAuthUser(supabase, userId);
      if (adminId) {
        const { data, error } = await supabase
          .schema("resupply")
          .from("admin_mfa_secrets")
          .select("id, secret_base32, last_used_counter")
          .eq("staff_user_id", adminId)
          .not("verified_at", "is", null)
          .order("created_at", { ascending: true });
        if (error) throw error;
        const adminSecrets = (data ?? []).map((r) => ({
          id: r.id,
          secretBase32: r.secret_base32,
          lastUsedCounter: r.last_used_counter,
        }));
        if (adminSecrets.length > 0) {
          return adminSecrets;
        }
      }
      const accountId = await providerAccountIdForAuthUser(supabase, userId);
      if (!accountId) return [];
      const { data, error } = await supabase
        .schema("resupply")
        .from("provider_mfa_secrets")
        .select("id, secret_base32, last_used_counter")
        .eq("account_id", accountId)
        .not("verified_at", "is", null)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data ?? []).map((r) => ({
        id: r.id,
        secretBase32: r.secret_base32,
        lastUsedCounter: r.last_used_counter,
      }));
    },
    async recordVerify(userId, counter, secretId) {
      const supabase = getSupabaseServiceRoleClient();
      const nowIso = new Date().toISOString();
      // Per the MfaProbe contract this is best-effort (a failure must
      // not block the sign-in — the 30s TOTP step still bounds the
      // replay) but failures MUST be logged: a silently dropped
      // counter bump is the replay-protection failing dark.
      const logBumpError = (table: string, error: { message: string }) => {
        logger.warn(
          { event: "mfa_counter_bump_failed", table, err: error.message },
          "mfa recordVerify: last_used_counter update failed",
        );
      };
      // When the verify path tells us WHICH secret matched (secretId),
      // scope the counter bump to that row. The id is unique to its
      // table; updating both tables by id is a no-op on the one that
      // doesn't own it, so we don't need to know the population.
      if (secretId) {
        const { error: adminErr } = await supabase
          .schema("resupply")
          .from("admin_mfa_secrets")
          .update({ last_used_counter: counter, last_used_at: nowIso })
          .eq("id", secretId);
        if (adminErr) logBumpError("admin_mfa_secrets", adminErr);
        const { error: provErr } = await supabase
          .schema("resupply")
          .from("provider_mfa_secrets")
          .update({ last_used_counter: counter, last_used_at: nowIso })
          .eq("id", secretId);
        if (provErr) logBumpError("provider_mfa_secrets", provErr);
        return;
      }
      // User-scoped fallback (single-device callers).
      const adminId = await adminIdForAuthUser(supabase, userId);
      if (adminId) {
        const { error: adminErr } = await supabase
          .schema("resupply")
          .from("admin_mfa_secrets")
          .update({ last_used_counter: counter, last_used_at: nowIso })
          .eq("staff_user_id", adminId);
        if (adminErr) logBumpError("admin_mfa_secrets", adminErr);
        return;
      }
      const accountId = await providerAccountIdForAuthUser(supabase, userId);
      if (!accountId) return;
      const { error: provErr } = await supabase
        .schema("resupply")
        .from("provider_mfa_secrets")
        .update({ last_used_counter: counter, last_used_at: nowIso })
        .eq("account_id", accountId);
      if (provErr) logBumpError("provider_mfa_secrets", provErr);
    },
    async findRecoveryCodeMatch(userId, codeHash) {
      const supabase = getSupabaseServiceRoleClient();
      // Spendable rows only — used_at IS NULL. The unique index on
      // code_hash means at most one row matches; the owner filter
      // prevents a code minted for one account being spent by another.
      const adminId = await adminIdForAuthUser(supabase, userId);
      if (adminId) {
        const { data, error } = await supabase
          .schema("resupply")
          .from("admin_mfa_recovery_codes")
          .select("id")
          .eq("staff_user_id", adminId)
          .eq("code_hash", codeHash)
          .is("used_at", null)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        return data ? { id: data.id } : null;
      }
      const accountId = await providerAccountIdForAuthUser(supabase, userId);
      if (!accountId) return null;
      const { data, error } = await supabase
        .schema("resupply")
        .from("provider_mfa_recovery_codes")
        .select("id")
        .eq("account_id", accountId)
        .eq("code_hash", codeHash)
        .is("used_at", null)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },
    async markRecoveryCodeUsed(rowId, ip) {
      const supabase = getSupabaseServiceRoleClient();
      const usedAt = new Date().toISOString();
      // The row lives in exactly one table; update both by id (the
      // non-owning update is a no-op). A failed update means the code
      // is NOT burned and could be replayed — log at error level.
      const { error: adminErr } = await supabase
        .schema("resupply")
        .from("admin_mfa_recovery_codes")
        .update({ used_at: usedAt, used_ip: ip ?? null })
        .eq("id", rowId);
      if (adminErr) {
        logger.error(
          {
            event: "mfa_recovery_code_mark_used_failed",
            table: "admin_mfa_recovery_codes",
            rowId,
            err: adminErr.message,
          },
          "mfa markRecoveryCodeUsed: update failed — recovery code may be reusable",
        );
      }
      const { error: provErr } = await supabase
        .schema("resupply")
        .from("provider_mfa_recovery_codes")
        .update({ used_at: usedAt, used_ip: ip ?? null })
        .eq("id", rowId);
      if (provErr) {
        logger.error(
          {
            event: "mfa_recovery_code_mark_used_failed",
            table: "provider_mfa_recovery_codes",
            rowId,
            err: provErr.message,
          },
          "mfa markRecoveryCodeUsed: update failed — recovery code may be reusable",
        );
      }
    },
    async consumeRecoveryCode(userId, codeHash, ip) {
      const supabase = getSupabaseServiceRoleClient();
      const usedAt = new Date().toISOString();
      // Atomic compare-and-set: the .is("used_at", null) clause is
      // part of the UPDATE WHERE, so Postgres only flips rows that
      // haven't been spent yet. Two concurrent submissions of the same
      // valid code can't both succeed.
      const adminId = await adminIdForAuthUser(supabase, userId);
      if (adminId) {
        const { data, error } = await supabase
          .schema("resupply")
          .from("admin_mfa_recovery_codes")
          .update({ used_at: usedAt, used_ip: ip ?? null })
          .eq("staff_user_id", adminId)
          .eq("code_hash", codeHash)
          .is("used_at", null)
          .select("id")
          .maybeSingle();
        if (error) throw error;
        return data ? { id: data.id } : null;
      }
      const accountId = await providerAccountIdForAuthUser(supabase, userId);
      if (!accountId) return null;
      const { data, error } = await supabase
        .schema("resupply")
        .from("provider_mfa_recovery_codes")
        .update({ used_at: usedAt, used_ip: ip ?? null })
        .eq("account_id", accountId)
        .eq("code_hash", codeHash)
        .is("used_at", null)
        .select("id")
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id } : null;
    },
  };
}

/**
 * Derive a domain-separated MFA challenge HMAC key from the
 * existing RESUPPLY_LINK_HMAC_KEY. We don't add a second env var
 * because:
 *   1. Deployments shouldn't have to coordinate two secrets when
 *      one is enough,
 *   2. HMAC-SHA256(link_key, "mfa-challenge-v1") isolates the
 *      keys cryptographically — a future compromise of one
 *      doesn't compromise the other.
 *
 * Returns null when RESUPPLY_LINK_HMAC_KEY isn't set (dev/test
 * environments). The auth lib's mfa branch refuses to issue a
 * challenge in that case, so a misconfigured staging deploy will
 * fail-closed visibly.
 */
function deriveMfaChallengeKey(): Buffer | undefined {
  try {
    const linkKey = getLinkHmacKey();
    return createHmac("sha256", linkKey).update("mfa-challenge-v1").digest();
  } catch {
    // Boot env-check.ts requires RESUPPLY_LINK_HMAC_KEY for prod;
    // in test setups it's typically absent and that's fine.
    return undefined;
  }
}

/**
 * Bridges an `auth.users.id` to the value the rest of the API
 * uses as the customer key (`shop_customers.customer_id`). See
 * Stage 4c plan doc.
 *
 * Behaviour:
 *   * If `shop_customers.auth_user_id = $authUserId` exists →
 *     return that row's `customer_id` (preserved across the
 *     backfill so every downstream join keeps working).
 *   * Else mint a new shop_customers row keyed by `auth.users.id`
 *     itself. The PK column is `text`, so a UUID slots in fine.
 *   * Email is taken from `auth.users.email_lower`. Display name
 *     defaults to the auth row, then to the existing customer
 *     row if any. Stripe customer creation happens lazily on
 *     first checkout (see `lib/stripe/customer.ts`).
 */
function makeCustomerIdResolver(): CustomerIdResolver {
  return async (input) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id, display_name, email_lower")
      .eq("auth_user_id", input.authUserId)
      .limit(1)
      .maybeSingle();
    if (existingErr) throw existingErr;
    if (existing) {
      return {
        customerKey: existing.customer_id,
        // Prefer auth.users.email — that's the canonical inbox
        // (rotating it goes through the in-house verify flow).
        email: input.emailLower,
        displayName: input.displayName ?? existing.display_name,
      };
    }

    // First sign-in for an in-house customer with no
    // shop_customers row yet (typical for brand-new in-house
    // sign-ups). Mint the row keyed by auth.users.id; subsequent
    // requests find it via the auth_user_id index.
    //
    // We explicitly model the original SQL's `ON CONFLICT (customer_id)
    // DO UPDATE SET auth_user_id = EXCLUDED.auth_user_id, email_lower
    // = COALESCE(EXCLUDED.email_lower, …)` semantics here. PostgREST's
    // upsert helper would clobber `display_name` with the new payload
    // (potentially null) on conflict, which can erase a curated name
    // on a row whose `customer_id` happens to match `auth.users.id`
    // (rare: a backfilled or re-bootstrapped shop_customers row). So
    // we INSERT first and only fall back to a targeted UPDATE on a
    // unique-violation, mirroring the prior behavior.
    const { error: insertErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .insert({
        customer_id: input.authUserId,
        auth_user_id: input.authUserId,
        email_lower: input.emailLower,
        display_name: input.displayName ?? null,
      });
    if (insertErr) {
      if ((insertErr as { code?: string }).code === "23505") {
        const updatePayload: {
          auth_user_id: string;
          updated_at: string;
          email_lower?: string;
        } = {
          auth_user_id: input.authUserId,
          updated_at: new Date().toISOString(),
        };
        // Mirror COALESCE(EXCLUDED.email_lower, …): only overwrite
        // when the caller actually has a value.
        if (input.emailLower) updatePayload.email_lower = input.emailLower;
        const { error: updateErr } = await supabase
          .schema("resupply")
          .from("shop_customers")
          .update(updatePayload)
          .eq("customer_id", input.authUserId);
        if (updateErr) throw updateErr;
      } else {
        throw insertErr;
      }
    }
    return {
      customerKey: input.authUserId,
      email: input.emailLower,
      displayName: input.displayName,
    };
  };
}

function makeSendgridSender(): EmailSender {
  // The `from` address is bound to the SendGrid client itself —
  // we configure it via SENDGRID_FROM_EMAIL / SENDGRID_FROM_NAME
  // and reuse the same factory pattern the order-confirmation
  // and cart-abandonment helpers use.
  return async (input) => {
    let client;
    try {
      client = createSendgridClient();
    } catch (err) {
      if (err instanceof EmailConfigError) {
        logger.warn(
          { event: "auth_email_send_skipped", reason: "config_error" },
          err.message,
        );
        return;
      }
      throw err;
    }
    try {
      await client.sendEmail({
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      });
    } catch (err) {
      if (err instanceof EmailApiError) {
        logger.warn(
          {
            event: "auth_email_send_failed",
            status: err.status,
            err: err.message,
          },
          "SendGrid rejected auth email",
        );
        return;
      }
      throw err;
    }
  };
}
