// /admin/mfa/* — TOTP enrollment for admin/CSR accounts.
//
// Phase A scope (this sprint):
//   GET    /admin/mfa/status               — does the caller have
//                                             active MFA?
//   POST   /admin/mfa/enroll/begin         — mint a fresh secret +
//                                             return base32 + otpauth
//                                             URI (for the QR code)
//   POST   /admin/mfa/enroll/verify        — accept a code; if it
//                                             matches the just-issued
//                                             secret, set verified_at
//                                             and bump
//                                             last_used_counter
//   POST   /admin/mfa/disable              — remove the row after a
//                                             valid verify code,
//                                             gating against accidental
//                                             disable
//
// Phase B will hook the sign-in flow into this table. The sign-in
// handler is NOT modified in this sprint.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  buildOtpauthUri,
  generateBase32Secret,
  verifyTotpCode,
} from "../../lib/mfa/totp";
import { requireAdmin } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const verifyBody = z
  .object({
    code: z.string().trim().regex(/^\d{6}$/, "must be 6 digits"),
  })
  .strict();

/** Issuer string shown by authenticator apps. Env-overridable so a
 *  staging deploy doesn't shadow the prod app's entry. */
function getIssuerLabel(): string {
  return process.env.RESUPPLY_PRACTICE_NAME?.trim() || "PennPaps";
}

router.get("/admin/mfa/status", requireAdmin, async (req, res) => {
  const adminUserId = req.adminUserId;
  if (!adminUserId) {
    // requireAdmin should have populated this. Guard defensively.
    res.status(500).json({ error: "admin_user_id_missing" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .select("verified_at, last_used_at, created_at")
    .eq("staff_user_id", adminUserId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  res.json({
    enrolled: !!data?.verified_at,
    inProgressEnrollment: !!data && !data.verified_at,
    verifiedAt: data?.verified_at ?? null,
    lastUsedAt: data?.last_used_at ?? null,
    createdAt: data?.created_at ?? null,
  });
});

router.post(
  "/admin/mfa/enroll/begin",
  requireAdmin,
  async (req, res) => {
    const adminUserId = req.adminUserId;
    const adminEmail = req.adminEmail;
    if (!adminUserId || !adminEmail) {
      res.status(500).json({ error: "admin_context_missing" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    // Refuse if already enrolled — caller must disable first. Keeps
    // the lifecycle explicit: an admin who's lost their phone walks
    // through disable (which requires a valid code from the OLD
    // authenticator) before they can re-enroll. The recovery path
    // is a separate Phase-B "reset by another admin" surface.
    const { data: existing, error: existingErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("verified_at")
      .eq("staff_user_id", adminUserId)
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      logger.error({ err: existingErr }, "auth.mfa.enroll_begin: enrollment check failed");
      res.status(500).json({
        error: "enrollment_check_failed",
        message: "Failed to verify enrollment status — database error.",
      });
      return;
    }
    if (existing?.verified_at) {
      res.status(409).json({
        error: "already_enrolled",
        message:
          "MFA is already enrolled for this account. Disable it first to enroll a new device.",
      });
      return;
    }

    // Mint a fresh secret. Overwrites any in-progress row so a
    // reload of the enrollment UI gets a clean QR each time.
    const secretBase32 = generateBase32Secret();
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .upsert(
        {
          staff_user_id: adminUserId,
          secret_base32: secretBase32,
          verified_at: null,
          last_used_at: null,
          last_used_counter: null,
          updated_at: nowIso,
        },
        { onConflict: "staff_user_id" },
      );
    if (upsertErr) throw upsertErr;

    const issuer = getIssuerLabel();
    const otpauthUri = buildOtpauthUri({
      label: adminEmail,
      issuer,
      secret: secretBase32,
    });

    await logAudit({
      action: "auth.mfa.enroll_begin",
      adminEmail,
      adminUserId,
      targetTable: "admin_mfa_secrets",
      targetId: adminUserId,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "auth.mfa.enroll_begin audit failed");
    });

    // Response carries the SECRET (so the SPA can render the QR
    // code or copy the manual-entry string). This is the ONE
    // moment in the lifecycle when the secret crosses the API
    // boundary; subsequent reads only return enrollment metadata.
    res.json({
      secretBase32,
      otpauthUri,
      issuer,
      label: adminEmail,
    });
  },
);

router.post(
  "/admin/mfa/enroll/verify",
  requireAdmin,
  async (req, res) => {
    const adminUserId = req.adminUserId;
    const adminEmail = req.adminEmail;
    if (!adminUserId || !adminEmail) {
      res.status(500).json({ error: "admin_context_missing" });
      return;
    }
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();

    const { data: row, error } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("id, secret_base32, verified_at, last_used_counter")
      .eq("staff_user_id", adminUserId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({
        error: "no_enrollment_in_progress",
        message:
          "No enrollment is in progress for this account. Start one via /admin/mfa/enroll/begin.",
      });
      return;
    }

    const result = verifyTotpCode(row.secret_base32, parsed.data.code, {
      window: 1,
      // Even during initial enrollment we honor the
      // last_used_counter so a CSR can't have their first verify
      // code shoulder-surfed and replayed by an attacker who
      // raced to /enroll/verify before they did.
      minCounter: row.last_used_counter ?? undefined,
    });
    if (!result.ok || result.counter == null) {
      await logAudit({
        action: "auth.mfa.enroll_verify_failed",
        adminEmail,
        adminUserId,
        targetTable: "admin_mfa_secrets",
        targetId: adminUserId,
        metadata: {},
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn({ err }, "auth.mfa.enroll_verify_failed audit failed");
      });
      res.status(400).json({
        error: "invalid_code",
        message: "Code didn't match. Check the time on your phone and retry.",
      });
      return;
    }

    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .update({
        verified_at: row.verified_at ?? nowIso,
        last_used_at: nowIso,
        last_used_counter: result.counter,
      })
      .eq("id", row.id);
    if (updErr) throw updErr;

    await logAudit({
      action: row.verified_at
        ? "auth.mfa.verify_success"
        : "auth.mfa.enroll_completed",
      adminEmail,
      adminUserId,
      targetTable: "admin_mfa_secrets",
      targetId: row.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "auth.mfa.verify audit failed");
    });

    res.json({ ok: true, enrolled: true });
  },
);

router.post("/admin/mfa/disable", requireAdmin, async (req, res) => {
  const adminUserId = req.adminUserId;
  const adminEmail = req.adminEmail;
  if (!adminUserId || !adminEmail) {
    res.status(500).json({ error: "admin_context_missing" });
    return;
  }
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      message:
        "A valid current TOTP code is required to disable MFA. This protects against accidental or unauthorized disable.",
    });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .select("id, secret_base32, verified_at, last_used_counter")
    .eq("staff_user_id", adminUserId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row || !row.verified_at) {
    res.status(404).json({
      error: "not_enrolled",
      message: "MFA is not active on this account; nothing to disable.",
    });
    return;
  }

  const result = verifyTotpCode(row.secret_base32, parsed.data.code, {
    window: 1,
    minCounter: row.last_used_counter ?? undefined,
  });
  if (!result.ok) {
    res.status(400).json({
      error: "invalid_code",
      message: "Code didn't match — refusing to disable.",
    });
    return;
  }

  const { error: delErr } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .delete()
    .eq("id", row.id);
  if (delErr) throw delErr;

  await logAudit({
    action: "auth.mfa.disabled",
    adminEmail,
    adminUserId,
    targetTable: "admin_mfa_secrets",
    targetId: row.id,
    metadata: {},
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "auth.mfa.disabled audit failed");
  });

  res.json({ ok: true, enrolled: false });
});

export default router;
