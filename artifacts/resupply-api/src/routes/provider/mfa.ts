// /api/provider/mfa/* — TOTP enrollment for provider-portal accounts.
//
// Provider-scoped mirror of /admin/mfa/* (routes/admin/mfa.ts). Keyed
// to provider_portal_accounts instead of admin_users. Single active
// device per account (providers don't need the admin multi-device
// story); a provider re-enrolls by disabling first.
//
//   GET  /api/provider/mfa/status               — enrollment state
//   POST /api/provider/mfa/enroll/begin         — mint secret + otpauth
//   POST /api/provider/mfa/enroll/verify        — confirm code, mint
//                                                 recovery codes
//   POST /api/provider/mfa/disable              — remove (gated on code)
//   POST /api/provider/mfa/recovery-codes/regenerate
//
// MFA is REQUIRED for providers: the data routes 403 until a verified
// secret exists (requireProviderMfaEnrolled), and an enrolled provider
// is challenged for a code on every sign-in (the unified probe in
// lib/auth-deps.ts).

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  buildOtpauthUri,
  generateBase32Secret,
  generateRecoveryCodes,
  verifyTotpCode,
} from "@workspace/resupply-auth";

import { logger } from "../../lib/logger";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireProvider } from "../../middlewares/requireProvider";

const router: IRouter = Router();

// Per-account TOTP-attempt cap. 30/hr is far above an honest workflow
// (one provider typing into a phone) but well below a brute-force
// script. Keyed by the portal account so two providers on the same
// office NAT don't share a bucket.
const providerMfaCodeAttemptLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  name: "provider_mfa_code_attempt",
  keyFn: (req) => req.providerAccount?.id ?? "unknown",
});

// IP-keyed `express-rate-limit` gate so static analysis recognises the
// endpoints as rate-limited and a stranger hammering enrollment from
// one IP gets capped pre-auth.
const providerMfaIpRateLimiter = expressRateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

const verifyBody = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, "must be 6 digits"),
  })
  .strict();

function getIssuerLabel(): string {
  return process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
}

router.get(
  "/api/provider/mfa/status",
  providerMfaIpRateLimiter,
  ...requireProvider,
  async (req, res) => {
    const account = req.providerAccount!;
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id, verified_at, last_used_at, created_at")
      .eq("account_id", account.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const all = rows ?? [];
    const verified = all.find((r) => r.verified_at) ?? null;
    const inProgress = all.find((r) => !r.verified_at) ?? null;

    let recoveryCodesRemaining = 0;
    if (verified) {
      const { count } = await supabase
        .schema("resupply")
        .from("provider_mfa_recovery_codes")
        .select("id", { count: "exact", head: true })
        .eq("account_id", account.id)
        .is("used_at", null);
      recoveryCodesRemaining = count ?? 0;
    }

    res.json({
      enrolled: verified != null,
      inProgressEnrollment: inProgress != null,
      verifiedAt: verified?.verified_at ?? null,
      lastUsedAt: verified?.last_used_at ?? null,
      recoveryCodesRemaining,
      // MFA is mandatory for providers.
      mustEnroll: verified == null,
    });
  },
);

router.post(
  "/api/provider/mfa/enroll/begin",
  providerMfaIpRateLimiter,
  ...requireProvider,
  async (req, res) => {
    const account = req.providerAccount!;
    const supabase = getSupabaseServiceRoleClient();

    // Refuse if already fully enrolled — re-enroll goes through disable.
    const { data: existingVerified, error: vErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id")
      .eq("account_id", account.id)
      .not("verified_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (vErr) throw vErr;
    if (existingVerified) {
      res.status(409).json({
        error: "already_enrolled",
        message:
          "Two-factor is already set up. Disable it first if you need to switch devices.",
      });
      return;
    }

    const secretBase32 = generateBase32Secret();
    const nowIso = new Date().toISOString();

    // Reuse the in-progress row if one exists (clicked begin twice).
    const { data: inProgress, error: ipErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id")
      .eq("account_id", account.id)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ipErr) throw ipErr;

    if (inProgress) {
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("provider_mfa_secrets")
        .update({ secret_base32: secretBase32, updated_at: nowIso })
        .eq("id", inProgress.id);
      if (updErr) throw updErr;
    } else {
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("provider_mfa_secrets")
        .insert({
          account_id: account.id,
          secret_base32: secretBase32,
          verified_at: null,
          updated_at: nowIso,
        });
      if (insErr) throw insErr;
    }

    const issuer = getIssuerLabel();
    const otpauthUri = buildOtpauthUri({
      label: account.emailLower,
      issuer,
      secret: secretBase32,
    });
    res.json({ secretBase32, otpauthUri, issuer, label: account.emailLower });
  },
);

router.post(
  "/api/provider/mfa/enroll/verify",
  providerMfaIpRateLimiter,
  ...requireProvider,
  providerMfaCodeAttemptLimiter,
  async (req, res) => {
    const account = req.providerAccount!;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id, secret_base32, last_used_counter")
      .eq("account_id", account.id)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "no_enrollment_in_progress" });
      return;
    }
    const result = verifyTotpCode(row.secret_base32, parsed.data.code, {
      window: 1,
      minCounter: row.last_used_counter ?? undefined,
    });
    if (!result.ok || result.counter == null) {
      res.status(400).json({
        error: "invalid_code",
        message: "Code didn't match. Check the time on your phone and retry.",
      });
      return;
    }
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .update({
        verified_at: nowIso,
        last_used_at: nowIso,
        last_used_counter: result.counter,
      })
      .eq("id", row.id);
    if (updErr) throw updErr;

    // Mark the account active + record enrollment timestamp.
    await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({ mfa_enrolled_at: nowIso, status: "active", updated_at: nowIso })
      .eq("id", account.id)
      .eq("status", "invited");
    await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({ mfa_enrolled_at: nowIso, updated_at: nowIso })
      .eq("id", account.id)
      .is("mfa_enrolled_at", null);

    // Mint a one-time recovery-code batch (shown once).
    let recoveryCodes: string[] | undefined;
    const { error: delStaleErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_recovery_codes")
      .delete()
      .eq("account_id", account.id);
    if (delStaleErr) {
      logger.warn(
        { err: delStaleErr },
        "provider mfa: stale recovery-code cleanup failed",
      );
    }
    const batch = generateRecoveryCodes();
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_recovery_codes")
      .insert(
        batch.map((c) => ({ account_id: account.id, code_hash: c.hash })),
      );
    if (insErr) {
      logger.error(
        { err: insErr },
        "provider mfa: recovery-codes insert failed",
      );
    } else {
      recoveryCodes = batch.map((c) => c.display);
    }

    res.json({ ok: true, enrolled: true, recoveryCodes });
  },
);

router.post(
  "/api/provider/mfa/disable",
  providerMfaIpRateLimiter,
  ...requireProvider,
  providerMfaCodeAttemptLimiter,
  async (req, res) => {
    const account = req.providerAccount!;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message: "A valid current code is required to disable two-factor.",
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id, secret_base32, last_used_counter")
      .eq("account_id", account.id)
      .not("verified_at", "is", null);
    if (error) throw error;
    if (!rows || rows.length === 0) {
      res.status(404).json({ error: "not_enrolled" });
      return;
    }
    const matched = rows.some(
      (r) =>
        verifyTotpCode(r.secret_base32, parsed.data.code, {
          window: 1,
          minCounter: r.last_used_counter ?? undefined,
        }).ok,
    );
    if (!matched) {
      res.status(400).json({
        error: "invalid_code",
        message: "Code didn't match — refusing to disable.",
      });
      return;
    }
    const nowIso = new Date().toISOString();
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .delete()
      .eq("account_id", account.id);
    if (delErr) throw delErr;
    const { error: delCodesErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_recovery_codes")
      .delete()
      .eq("account_id", account.id);
    if (delCodesErr) {
      logger.warn(
        { err: delCodesErr },
        "provider mfa: recovery cleanup failed",
      );
    }
    await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({ mfa_enrolled_at: null, updated_at: nowIso })
      .eq("id", account.id);
    res.json({ ok: true, enrolled: false });
  },
);

router.post(
  "/api/provider/mfa/recovery-codes/regenerate",
  providerMfaIpRateLimiter,
  ...requireProvider,
  providerMfaCodeAttemptLimiter,
  async (req, res) => {
    const account = req.providerAccount!;
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .select("id, secret_base32, verified_at, last_used_counter")
      .eq("account_id", account.id)
      .not("verified_at", "is", null)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_enrolled" });
      return;
    }
    const result = verifyTotpCode(row.secret_base32, parsed.data.code, {
      window: 1,
      minCounter: row.last_used_counter ?? undefined,
    });
    if (!result.ok || result.counter == null) {
      res.status(400).json({ error: "invalid_code" });
      return;
    }
    await supabase
      .schema("resupply")
      .from("provider_mfa_secrets")
      .update({
        last_used_counter: result.counter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", row.id);
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_recovery_codes")
      .delete()
      .eq("account_id", account.id);
    if (delErr) throw delErr;
    const batch = generateRecoveryCodes();
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("provider_mfa_recovery_codes")
      .insert(
        batch.map((c) => ({ account_id: account.id, code_hash: c.hash })),
      );
    if (insErr) throw insErr;
    res.json({ ok: true, recoveryCodes: batch.map((c) => c.display) });
  },
);

export default router;
