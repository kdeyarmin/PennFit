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

import {
  buildOtpauthUri,
  generateBase32Secret,
  generateRecoveryCodes,
  verifyTotpCode,
} from "@workspace/resupply-auth";

import { logger } from "../../lib/logger";
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

/** MFA enforcement mode — env-var-gated so an org can flip the
 *  toggle without a code change. "required" means surveyors see a
 *  mandatory MFA story and the SPA forces unenrolled admins to
 *  /admin/security on every nav. "off" preserves the original
 *  Phase A posture where enrollment is optional. */
type EnforcementMode = "off" | "required";
function getEnforcementMode(): EnforcementMode {
  const v = process.env.AUTH_REQUIRE_MFA_FOR_ADMINS?.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes" ? "required" : "off";
}

router.get("/admin/mfa/status", requireAdmin, async (req, res) => {
  const adminUserId = req.adminUserId;
  if (!adminUserId) {
    // requireAdmin should have populated this. Guard defensively.
    res.status(500).json({ error: "admin_user_id_missing" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  // Multi-device: pull EVERY row for this admin so the SPA can
  // render the device list (one row per enrolled device, plus any
  // in-progress unverified row).
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .select(
      "id, verified_at, last_used_at, created_at, device_label",
    )
    .eq("staff_user_id", adminUserId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  const allRows = rows ?? [];
  const verifiedRows = allRows.filter((r) => r.verified_at);
  const inProgress = allRows.find((r) => !r.verified_at) ?? null;

  let recoveryCodesRemaining = 0;
  if (verifiedRows.length > 0) {
    const { count } = await supabase
      .schema("resupply")
      .from("admin_mfa_recovery_codes")
      .select("id", { count: "exact", head: true })
      .eq("staff_user_id", adminUserId)
      .is("used_at", null);
    recoveryCodesRemaining = count ?? 0;
  }

  const enforcementMode = getEnforcementMode();
  const enrolled = verifiedRows.length > 0;
  // First-verified row drives the legacy "verifiedAt / createdAt"
  // fields so existing SPA code keeps working without a refactor.
  const primary = verifiedRows[0] ?? null;
  // Most-recent last_used_at across devices.
  const lastUsedAt =
    verifiedRows
      .map((r) => r.last_used_at)
      .filter((v): v is string => v != null)
      .sort()
      .pop() ?? null;

  res.json({
    enrolled,
    inProgressEnrollment: inProgress != null,
    verifiedAt: primary?.verified_at ?? null,
    lastUsedAt,
    createdAt: primary?.created_at ?? null,
    recoveryCodesRemaining,
    enforcementMode,
    mustEnroll: enforcementMode === "required" && !enrolled,
    // Multi-device list. Each entry is one verified device the
    // admin has enrolled — the SPA renders a per-row "Remove"
    // button alongside the existing "Disable all" / "Regenerate
    // codes" actions.
    devices: verifiedRows.map((r) => ({
      id: r.id,
      label: r.device_label,
      verifiedAt: r.verified_at,
      lastUsedAt: r.last_used_at,
      createdAt: r.created_at,
    })),
  });
});

const beginBody = z
  .object({
    deviceLabel: z.string().trim().min(1).max(64).optional(),
  })
  .strict()
  .optional();

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
    const parsedBody = beginBody.safeParse(req.body);
    if (!parsedBody.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const deviceLabel = parsedBody.data?.deviceLabel ?? null;

    const supabase = getSupabaseServiceRoleClient();
    // Multi-device (migration 0091): admins can enroll multiple
    // devices. We DO still consolidate any in-progress unverified
    // row — if the admin clicked "begin" twice without finishing,
    // the second click overwrites the abandoned row rather than
    // accumulating draft rows.
    const { data: existingInProgress, error: existingErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("id")
      .eq("staff_user_id", adminUserId)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existingErr) {
      logger.error(
        { err: existingErr },
        "auth.mfa.enroll_begin: enrollment check failed",
      );
      res.status(500).json({
        error: "enrollment_check_failed",
        message: "Failed to verify enrollment status — database error.",
      });
      return;
    }

    const secretBase32 = generateBase32Secret();
    const nowIso = new Date().toISOString();
    if (existingInProgress) {
      const { error: updErr } = await supabase
        .schema("resupply")
        .from("admin_mfa_secrets")
        .update({
          secret_base32: secretBase32,
          device_label: deviceLabel,
          updated_at: nowIso,
        })
        .eq("id", existingInProgress.id);
      if (updErr) throw updErr;
    } else {
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("admin_mfa_secrets")
        .insert({
          staff_user_id: adminUserId,
          secret_base32: secretBase32,
          verified_at: null,
          last_used_at: null,
          last_used_counter: null,
          device_label: deviceLabel,
          updated_at: nowIso,
        });
      if (insErr) throw insErr;
    }

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

    // Multi-device: the in-progress enrollment is the most recent
    // unverified row (created or refreshed by /begin). Pick that.
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("id, secret_base32, verified_at, last_used_counter")
      .eq("staff_user_id", adminUserId)
      .is("verified_at", null)
      .order("created_at", { ascending: false })
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

    // Recovery codes are minted ONLY on the very first verified
    // device. Subsequent devices (Phase 0091 multi-device) reuse
    // the existing batch — codes are user-scoped, not device-
    // scoped. Detect "is this the first verified row across all
    // of the admin's enrollments?" by counting prior verified rows.
    const { count: priorVerifiedCount } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("id", { count: "exact", head: true })
      .eq("staff_user_id", adminUserId)
      .not("verified_at", "is", null);
    const isFirstVerify = (priorVerifiedCount ?? 0) === 0;
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

    // On FIRST successful verify (i.e. enrollment completion) mint
    // a batch of recovery codes. We do this AFTER the secret-row
    // update so a partial failure leaves enrollment in a sane
    // state: either the secret is verified AND recovery codes
    // exist, or the secret is verified but recovery codes are
    // empty (admin can hit /recovery-codes/regenerate later — but
    // that endpoint is deferred; for now they'd have to disable
    // and re-enroll). We accept this trade because the alternative
    // (mint codes first, then verify the secret) leaks codes to
    // someone whose TOTP didn't pass — strictly worse.
    let plaintextRecoveryCodes: string[] | undefined;
    if (isFirstVerify) {
      // Defensive: wipe any stale rows from a previous enrollment
      // (shouldn't exist — disable cleans them — but cheap safety).
      const { error: delStaleErr } = await supabase
        .schema("resupply")
        .from("admin_mfa_recovery_codes")
        .delete()
        .eq("staff_user_id", adminUserId);
      if (delStaleErr) {
        logger.warn(
          { err: delStaleErr },
          "auth.mfa.enroll_verify: stale recovery-code cleanup failed",
        );
      }
      const batch = generateRecoveryCodes();
      const { error: insErr } = await supabase
        .schema("resupply")
        .from("admin_mfa_recovery_codes")
        .insert(
          batch.map((c) => ({
            staff_user_id: adminUserId,
            code_hash: c.hash,
          })),
        );
      if (insErr) {
        // Don't roll back the secret verification — enrollment is
        // still effectively done. Surface a soft warning to the
        // SPA so it can prompt the admin to disable + re-enroll
        // if they want recovery codes.
        logger.error(
          { err: insErr },
          "auth.mfa.enroll_verify: recovery-codes insert failed",
        );
      } else {
        plaintextRecoveryCodes = batch.map((c) => c.display);
      }
    }

    await logAudit({
      action: row.verified_at
        ? "auth.mfa.verify_success"
        : "auth.mfa.enroll_completed",
      adminEmail,
      adminUserId,
      targetTable: "admin_mfa_secrets",
      targetId: row.id,
      // Recovery-code COUNT only — never log the codes themselves.
      metadata: plaintextRecoveryCodes
        ? { recoveryCodesIssued: plaintextRecoveryCodes.length }
        : {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "auth.mfa.verify audit failed");
    });

    res.json({
      ok: true,
      enrolled: true,
      // ONLY present on the first verify (enrollment completion).
      // Subsequent calls (verify_success) omit this field — the
      // codes have already been shown and can't be re-displayed.
      recoveryCodes: plaintextRecoveryCodes,
    });
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
  // Multi-device: pull ALL verified secrets and accept any code
  // that matches. A user disabling MFA after losing one device
  // shouldn't have to know WHICH device is still working — they
  // just type a code.
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .select("id, secret_base32, verified_at, last_used_counter")
    .eq("staff_user_id", adminUserId)
    .not("verified_at", "is", null);
  if (error) throw error;
  if (!rows || rows.length === 0) {
    res.status(404).json({
      error: "not_enrolled",
      message: "MFA is not active on this account; nothing to disable.",
    });
    return;
  }

  const matched = rows.some((r) => {
    const res = verifyTotpCode(r.secret_base32, parsed.data.code, {
      window: 1,
      minCounter: r.last_used_counter ?? undefined,
    });
    return res.ok;
  });
  if (!matched) {
    res.status(400).json({
      error: "invalid_code",
      message: "Code didn't match — refusing to disable.",
    });
    return;
  }
  // Synthetic "row" used by the downstream audit log so the
  // existing single-row logging stays sensible. Disable wipes
  // every device for the admin.
  const row = { id: rows[0]!.id } as { id: string };

  const { error: delErr } = await supabase
    .schema("resupply")
    .from("admin_mfa_secrets")
    .delete()
    .eq("staff_user_id", adminUserId);
  if (delErr) throw delErr;

  // Best-effort: wipe outstanding recovery codes too. They're
  // useless after the secret row is gone (the sign-in verify
  // refuses on `mfa_not_enrolled` first), but leaving them in the
  // table inflates the table and confuses the audit picture.
  const { error: delCodesErr } = await supabase
    .schema("resupply")
    .from("admin_mfa_recovery_codes")
    .delete()
    .eq("staff_user_id", adminUserId);
  if (delCodesErr) {
    logger.warn(
      { err: delCodesErr },
      "auth.mfa.disable: recovery-code cleanup failed (non-fatal)",
    );
  }

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

// ────────────────────────────────────────────────────────────────
// POST /admin/mfa/devices/:id/disable — remove a SINGLE enrolled
// device. Requires a current TOTP code from ANY remaining device
// (same protect-against-compromised-session posture as /disable).
// Refuses to remove the last device — use /disable for that
// (it also wipes the recovery codes batch atomically).
// ────────────────────────────────────────────────────────────────
const deviceIdParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/mfa/devices/:id/disable",
  requireAdmin,
  async (req, res) => {
    const adminUserId = req.adminUserId;
    const adminEmail = req.adminEmail;
    if (!adminUserId || !adminEmail) {
      res.status(500).json({ error: "admin_context_missing" });
      return;
    }
    const params = deviceIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "A valid current TOTP code is required to remove a device.",
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .select("id, secret_base32, verified_at, last_used_counter, device_label")
      .eq("staff_user_id", adminUserId)
      .not("verified_at", "is", null);
    if (error) throw error;
    const verifiedRows = rows ?? [];
    if (verifiedRows.length === 0) {
      res.status(404).json({
        error: "not_enrolled",
        message: "MFA is not active on this account.",
      });
      return;
    }
    const target = verifiedRows.find((r) => r.id === params.data.id);
    if (!target) {
      res.status(404).json({
        error: "device_not_found",
        message: "That device isn't on your account.",
      });
      return;
    }
    if (verifiedRows.length === 1) {
      res.status(409).json({
        error: "last_device",
        message:
          "Cannot remove your only enrolled device. Use Disable MFA to turn off two-factor entirely.",
      });
      return;
    }
    // TOTP gate — any remaining device's code is acceptable.
    const matched = verifiedRows.some((r) => {
      const result = verifyTotpCode(r.secret_base32, parsed.data.code, {
        window: 1,
        minCounter: r.last_used_counter ?? undefined,
      });
      return result.ok;
    });
    if (!matched) {
      res.status(400).json({
        error: "invalid_code",
        message: "Code didn't match — refusing to remove.",
      });
      return;
    }
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .delete()
      .eq("id", target.id);
    if (delErr) throw delErr;

    await logAudit({
      action: "auth.mfa.device_removed",
      adminEmail,
      adminUserId,
      targetTable: "admin_mfa_secrets",
      targetId: target.id,
      metadata: { device_label: target.device_label ?? null },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "auth.mfa.device_removed audit failed");
    });

    res.json({ ok: true });
  },
);

// ────────────────────────────────────────────────────────────────
// POST /admin/mfa/recovery-codes/regenerate — mint a fresh batch
// without going through disable+re-enroll. Gated behind a current
// TOTP code (same posture as disable) so a compromised session
// can't quietly rotate the codes out from under the user.
//
// Operationally: an admin who has spent a few codes wants the
// roster back at 10. Today they'd disable MFA, re-enroll, and
// re-show the QR — which leaks more than necessary and means
// briefly unenrolled time. This endpoint preserves the secret +
// last_used_counter, only the recovery batch changes.
// ────────────────────────────────────────────────────────────────
router.post(
  "/admin/mfa/recovery-codes/regenerate",
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
        message:
          "A valid current TOTP code is required to regenerate recovery codes.",
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
        message:
          "MFA is not active on this account; nothing to regenerate.",
      });
      return;
    }

    const result = verifyTotpCode(row.secret_base32, parsed.data.code, {
      window: 1,
      minCounter: row.last_used_counter ?? undefined,
    });
    if (!result.ok || result.counter == null) {
      res.status(400).json({
        error: "invalid_code",
        message: "Code didn't match — refusing to regenerate.",
      });
      return;
    }

    // Burn the counter advance from this verify so the same code
    // can't be replayed against /disable.
    await supabase
      .schema("resupply")
      .from("admin_mfa_secrets")
      .update({
        last_used_counter: result.counter,
        last_used_at: new Date().toISOString(),
      })
      .eq("id", row.id);

    // Wipe the entire old batch (used + spendable). Surveyors are
    // OK with this: the audit_log entry records the regenerate
    // moment and the count, which is what they actually ask for.
    // Keeping the used rows around after a regenerate would
    // confuse the "codes remaining" badge in /admin/security.
    const { error: delErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_recovery_codes")
      .delete()
      .eq("staff_user_id", adminUserId);
    if (delErr) throw delErr;

    const batch = generateRecoveryCodes();
    const { error: insErr } = await supabase
      .schema("resupply")
      .from("admin_mfa_recovery_codes")
      .insert(
        batch.map((c) => ({
          staff_user_id: adminUserId,
          code_hash: c.hash,
        })),
      );
    if (insErr) throw insErr;

    await logAudit({
      action: "auth.mfa.recovery_codes_regenerated",
      adminEmail,
      adminUserId,
      targetTable: "admin_mfa_recovery_codes",
      targetId: null,
      metadata: { count: batch.length },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "auth.mfa.recovery_codes_regenerated audit failed",
      );
    });

    res.json({
      ok: true,
      // Same shape as enroll-verify's recovery branch: plain-text
      // display codes, shown ONCE. The SPA must surface them and
      // dismiss; there's no read API to retrieve them later.
      recoveryCodes: batch.map((c) => c.display),
    });
  },
);

export default router;
