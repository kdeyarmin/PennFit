// /shop/me/caregiver — designated authorized contact for a shop
// customer.
//
//   GET    /shop/me/caregiver   — returns the active caregiver shape
//                                  (or `{ caregiver: null }` if none).
//   PUT    /shop/me/caregiver   — set or update name + email. Stamps
//                                  caregiver_consent_at to now() iff
//                                  this is the first set or a re-opt-in
//                                  after a revoke.
//   DELETE /shop/me/caregiver   — revoke. Stamps caregiver_revoked_at
//                                  but PRESERVES name/email so an audit
//                                  trail of "who was the caregiver
//                                  during the period of consent" is
//                                  intact. The active-check on the
//                                  send-side is consent_at IS NOT NULL
//                                  AND revoked_at IS NULL.
//
// HIPAA / consent model
// ---------------------
// The patient affirms the relationship when they hit Save. The
// consent_at stamp serves as our written record. We do NOT email
// the caregiver out-of-band to confirm — that would surprise both
// parties when the patient is exploring options and hasn't truly
// committed. Instead, the first time the caregiver receives a real
// transactional email (shipping notification, post-delivery
// follow-up), the body explains how they were added and offers a
// one-tap "remove me" link back to /account.
//
// Audit
// -----
// Every state change writes an audit_log row with adminEmail set to
// the customer's own email (prefixed `customer:`) so the surface
// reconstruction is offline-verifiable. The CSR admin console
// surfaces these via the existing audit-log viewer.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const putBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
  })
  .strict();

interface CaregiverView {
  name: string;
  email: string;
  consentAt: string;
  revokedAt: string | null;
}

function rowToView(row: {
  caregiver_name: string | null;
  caregiver_email: string | null;
  caregiver_consent_at: string | null;
  caregiver_revoked_at: string | null;
}): CaregiverView | null {
  if (
    !row.caregiver_name ||
    !row.caregiver_email ||
    !row.caregiver_consent_at
  ) {
    return null;
  }
  return {
    name: row.caregiver_name,
    email: row.caregiver_email,
    consentAt: row.caregiver_consent_at,
    revokedAt: row.caregiver_revoked_at,
  };
}

router.get("/shop/me/caregiver", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select(
      "caregiver_name, caregiver_email, caregiver_consent_at, caregiver_revoked_at",
    )
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  res.json({ caregiver: data ? rowToView(data) : null });
});

router.put("/shop/me/caregiver", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  const customerEmail = req.shopCustomerEmail ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const parsed = putBody.safeParse(req.body);
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

  // Reject when the patient sets their own email as the caregiver —
  // that's a copy-paste mistake, not a designated representative.
  if (
    customerEmail &&
    parsed.data.email.toLowerCase() === customerEmail.toLowerCase()
  ) {
    res.status(400).json({
      error: "caregiver_is_self",
      message:
        "The caregiver email must be different from your own account email.",
    });
    return;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: existing } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .select(
      "caregiver_name, caregiver_email, caregiver_consent_at, caregiver_revoked_at",
    )
    .eq("customer_id", customerId)
    .limit(1)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  // Re-affirm consent timestamp when:
  //   1. There's no prior caregiver on this account, OR
  //   2. The prior caregiver was revoked (revoked_at non-null), OR
  //   3. The email changed (it's now a different person).
  const refreshConsent =
    !existing?.caregiver_consent_at ||
    !!existing?.caregiver_revoked_at ||
    (existing?.caregiver_email ?? "").toLowerCase() !==
      parsed.data.email.toLowerCase();
  const consentAt = refreshConsent
    ? nowIso
    : (existing?.caregiver_consent_at ?? nowIso);

  const { error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      caregiver_name: parsed.data.name,
      caregiver_email: parsed.data.email,
      caregiver_consent_at: consentAt,
      // Clear any prior revoke — a fresh PUT is an active opt-in.
      caregiver_revoked_at: null,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId);
  if (error) throw error;

  await logAudit({
    action: existing?.caregiver_consent_at
      ? "shop_customer.caregiver.update"
      : "shop_customer.caregiver.add",
    adminEmail: `customer:${customerEmail ?? customerId}`,
    adminUserId: null,
    targetTable: "shop_customers",
    targetId: customerId,
    metadata: {
      // We do NOT log the email or name in the audit row (that would
      // duplicate PHI). Just the fact that the field changed.
      consent_refreshed: refreshConsent,
    },
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "shop_customer.caregiver write: audit failed");
  });

  res.json({
    caregiver: {
      name: parsed.data.name,
      email: parsed.data.email,
      consentAt,
      revokedAt: null,
    },
  });
});

router.delete("/shop/me/caregiver", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  const customerEmail = req.shopCustomerEmail ?? null;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  // Stamp revoked_at but preserve email/name/consent_at so the
  // audit-trail of "who was the caregiver during the consent period"
  // remains intact.
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("shop_customers")
    .update({
      caregiver_revoked_at: nowIso,
      updated_at: nowIso,
    })
    .eq("customer_id", customerId)
    .not("caregiver_consent_at", "is", null)
    .is("caregiver_revoked_at", null)
    .select("customer_id")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    // Idempotent — already revoked or never set.
    res.json({ caregiver: null });
    return;
  }

  await logAudit({
    action: "shop_customer.caregiver.revoke",
    adminEmail: `customer:${customerEmail ?? customerId}`,
    adminUserId: null,
    targetTable: "shop_customers",
    targetId: customerId,
    metadata: {},
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  }).catch((err) => {
    logger.warn({ err }, "shop_customer.caregiver.revoke: audit failed");
  });

  res.json({ caregiver: null });
});

export default router;
