// /admin/organization/phone-settings — a tenant's (DME company's) own
// voice + SMS phone numbers.
//
//   GET   /admin/organization/phone-settings
//         Returns the tenant's voice number, SMS number, Messaging Service
//         SID (if any), and whether the platform can auto-provision one.
//
//   POST  /admin/organization/phone-settings/provision
//         Body: { areaCode?, assign?: ("voice"|"sms")[] }
//         Buys a voice+SMS-capable number from Twilio, points its inbound
//         webhooks at the platform endpoints, and stamps it onto the chosen
//         organizations columns. 409 if a targeted slot already has a number.
//
//   PATCH /admin/organization/phone-settings
//         Body: { voiceNumber?, smsNumber?, messagingServiceSid? } (each
//         string | null, only the provided fields change)
//         Manually set (a ported / pre-existing DID, or a Messaging Service)
//         or clear (null) the tenant's numbers. 409 on a uniqueness
//         collision with another tenant.
//
// Voice + SMS ride on Twilio (fax went to Telnyx — Twilio retired
// Programmable Fax; see fax-settings.ts). The tenant's numbers then flow
// through the tenant-aware SMS/voice SEND path
// (resolveTenantSmsFrom / resolveTenantVoiceFrom) and the inbound routing
// (resolveOrgIdByCalledNumber), all keyed on
// organizations.sms_from_number / voice_from_number /
// twilio_messaging_service_sid (migration 0364).
//
// PHI / log posture: a tenant's own DID is business data, not PHI. The
// audit envelope carries the action + number only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  createTwilioNumberClient,
  TwilioApiError,
  TwilioConfigError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger.js";
import { invalidateTenantTelecomCache } from "../../lib/messaging/tenant-telecom.js";
import { readVoicePublicBaseUrlOrNull } from "../../lib/voice/voice-config.js";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit.js";
import { requirePermission } from "../../middlewares/requireAdmin.js";

const router: IRouter = Router();

const E164 = /^\+[1-9]\d{6,14}$/;
const MESSAGING_SERVICE_SID = /^MG[0-9a-fA-F]{32}$/;

const provisionBody = z
  .object({
    // US area code to keep the number local to the tenant. Optional —
    // Twilio picks one when omitted.
    areaCode: z
      .string()
      .trim()
      .regex(/^\d{3}$/, "areaCode must be a 3-digit US area code")
      .optional(),
    // Which slots the purchased number fills. Defaults to both (one DID
    // serves calls and texts), which is what a small DME wants.
    assign: z
      .array(z.enum(["voice", "sms"]))
      .nonempty()
      .optional(),
  })
  .strict();

const patchBody = z
  .object({
    // Each field is optional; only provided keys change. `null` clears.
    voiceNumber: z
      .string()
      .trim()
      .regex(E164, "must be E.164")
      .nullable()
      .optional(),
    smsNumber: z
      .string()
      .trim()
      .regex(E164, "must be E.164")
      .nullable()
      .optional(),
    messagingServiceSid: z
      .string()
      .trim()
      .regex(
        MESSAGING_SERVICE_SID,
        "must be a Twilio Messaging Service SID (MG…)",
      )
      .nullable()
      .optional(),
  })
  .strict()
  .refine(
    (b) =>
      b.voiceNumber !== undefined ||
      b.smsNumber !== undefined ||
      b.messagingServiceSid !== undefined,
    { message: "Provide at least one field to change." },
  );

/**
 * True when the platform can auto-buy a number (Twilio account creds set).
 * Distinct from the full voice/SMS send pipeline — a tenant can be GIVEN a
 * number even before every voice secret (OpenAI, public base URL) is wired.
 */
function canProvisionPhone(): boolean {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID?.trim() &&
    process.env.TWILIO_AUTH_TOKEN?.trim(),
  );
}

interface OrgPhoneRow {
  voice_from_number: string | null;
  sms_from_number: string | null;
  twilio_messaging_service_sid: string | null;
  slug: string | null;
}

async function loadOrgPhone(orgId: string): Promise<OrgPhoneRow | null> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .from("organizations")
    .select(
      "voice_from_number, sms_from_number, twilio_messaging_service_sid, slug",
    )
    .eq("id", orgId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as OrgPhoneRow | null) ?? null;
}

function viewOf(row: OrgPhoneRow | null) {
  return {
    voiceNumber: row?.voice_from_number ?? null,
    smsNumber: row?.sms_from_number ?? null,
    messagingServiceSid: row?.twilio_messaging_service_sid ?? null,
    canProvision: canProvisionPhone(),
  };
}

// ---------------------------------------------------------------------------
// GET — current numbers + provisioning capability
// ---------------------------------------------------------------------------
router.get(
  "/admin/organization/phone-settings",
  adminReadRateLimiter,
  requirePermission("admin.tools.manage"),
  async (req, res) => {
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    res.json(viewOf(await loadOrgPhone(orgId)));
  },
);

// ---------------------------------------------------------------------------
// POST /provision — buy a voice+SMS-capable number for this tenant
// ---------------------------------------------------------------------------

// Buying a number is a live, billable Twilio call that assigns a real DID.
// Keep the limit tight so a stuck button can't buy a stack of numbers.
const provisionLimiter = adminRateLimit({
  name: "phone_provision",
  preset: "sensitive",
});

router.post(
  "/admin/organization/phone-settings/provision",
  requirePermission("admin.tools.manage"),
  provisionLimiter,
  async (req, res) => {
    const parsed = provisionBody.safeParse(req.body ?? {});
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
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    if (!canProvisionPhone()) {
      res.status(503).json({ error: "phone_provisioning_not_configured" });
      return;
    }

    const assign = parsed.data.assign ?? ["voice", "sms"];
    const wantVoice = assign.includes("voice");
    const wantSms = assign.includes("sms");

    const existing = await loadOrgPhone(orgId);
    // Refuse to buy a second number into an already-filled slot. Operator
    // clears it first (PATCH …Number:null) to re-provision.
    if (
      (wantVoice && existing?.voice_from_number) ||
      (wantSms && existing?.sms_from_number)
    ) {
      res.status(409).json({
        error: "phone_already_provisioned",
        voiceNumber: existing?.voice_from_number ?? null,
        smsNumber: existing?.sms_from_number ?? null,
      });
      return;
    }

    // Wire the purchased number's inbound webhooks at the platform
    // endpoints so the tenant's calls/texts reach the app (which routes by
    // called number). Best-effort: omitted when no public base URL is set.
    const baseUrl = readVoicePublicBaseUrlOrNull();
    const voiceUrl =
      baseUrl && wantVoice
        ? `${baseUrl}/resupply-api/voice/inbound-reorder`
        : undefined;
    const smsUrl =
      baseUrl && wantSms ? `${baseUrl}/resupply-api/sms/inbound` : undefined;

    let result: { sid: string; phoneNumber: string };
    try {
      const client = createTwilioNumberClient();
      result = await client.provisionNumber({
        areaCode: parsed.data.areaCode,
        voice: wantVoice,
        sms: wantSms,
        friendlyName: existing?.slug ? `org:${existing.slug}` : `org:${orgId}`,
        voiceUrl,
        smsUrl,
      });
    } catch (err) {
      if (err instanceof TwilioConfigError) {
        res.status(503).json({ error: "phone_provisioning_not_configured" });
        return;
      }
      const msg =
        err instanceof TwilioApiError
          ? err.message
          : "Twilio number provisioning failed";
      logger.warn(
        { event: "phone_provision_failed", orgId },
        "phone-settings: Twilio provisioning failed",
      );
      res.status(502).json({ error: "phone_provision_failed", detail: msg });
      return;
    }

    const update: Record<string, string> = {};
    if (wantVoice) update.voice_from_number = result.phoneNumber;
    if (wantSms) update.sms_from_number = result.phoneNumber;

    const { error: updErr } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .update(update)
      .eq("id", orgId);
    if (updErr) {
      // The number is bought but we couldn't persist it — log the DID +
      // SID so an operator can reconcile rather than orphaning a paid DID.
      logger.error(
        {
          event: "phone_provision_persist_failed",
          orgId,
          twilioSid: result.sid,
          err: updErr,
        },
        "phone-settings: number bought but DB write failed — manual reconcile",
      );
      res.status(500).json({
        error: "phone_provision_persist_failed",
        twilioSid: result.sid,
      });
      return;
    }

    invalidateTenantTelecomCache();

    await logAudit({
      action: "organization.phone_provisioned",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: {
        twilio_sid: result.sid,
        // The DID is business data, not PHI — safe to record.
        phone_number: result.phoneNumber,
        assigned: assign,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn(
        { err: auditErr },
        "organization.phone_provisioned audit write failed",
      );
    });

    res.status(201).json({
      ...viewOf(await loadOrgPhone(orgId)),
      provisioned: result.phoneNumber,
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH — manually set / clear voice number, SMS number, Messaging Service
// ---------------------------------------------------------------------------
router.patch(
  "/admin/organization/phone-settings",
  requirePermission("admin.tools.manage"),
  adminRateLimit({ name: "phone_settings.patch", preset: "sensitive" }),
  async (req, res) => {
    const parsed = patchBody.safeParse(req.body);
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
    const orgId = req.orgId?.trim();
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    const { voiceNumber, smsNumber, messagingServiceSid } = parsed.data;
    const update: Record<string, string | null> = {};
    if (voiceNumber !== undefined) update.voice_from_number = voiceNumber;
    if (smsNumber !== undefined) update.sms_from_number = smsNumber;
    if (messagingServiceSid !== undefined)
      update.twilio_messaging_service_sid = messagingServiceSid;

    // CROSS-COLUMN collision check, before the write.
    //
    // The unique partial indexes are PER COLUMN, so they stop two tenants
    // claiming a DID for the same channel and allow tenant A to hold it
    // for SMS while tenant B holds it for voice. That is not a harmless
    // overlap: it is one number with two owners, and an inbound event on
    // it belongs to whichever tenant the resolver happens to probe first.
    // (The resolver is now channel-aware, so it answers correctly — but a
    // number with two owners is a configuration nobody should be able to
    // create in the first place.)
    const claimed = [voiceNumber, smsNumber].filter(
      (n): n is string => typeof n === "string" && n.trim() !== "",
    );
    if (claimed.length > 0) {
      const { data: conflicts, error: conflictErr } = await getOrgScopedClient(
        orgId,
      )
        .raw()
        .schema("resupply")
        .from("organizations")
        .select("id")
        .neq("id", orgId)
        // Safe to interpolate: Zod has already pinned each value to
        // /^\+[1-9]\d{6,14}$/, so it carries no comma, paren, or dot —
        // the metacharacters that could otherwise reshape this filter
        // against the GLOBAL organizations directory.
        .or(
          claimed
            .map(
              (n) =>
                `voice_from_number.eq.${n},sms_from_number.eq.${n},fax_from_number.eq.${n}`,
            )
            .join(","),
        )
        .limit(1);
      if (conflictErr) throw conflictErr;
      if ((conflicts ?? []).length > 0) {
        res.status(409).json({
          error: "phone_number_in_use",
          message:
            "Another practice on this platform already uses that number. A number can only belong to one practice, on any channel.",
        });
        return;
      }
    }

    const { error: updErr } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("organizations")
      .update(update)
      .eq("id", orgId);
    if (updErr) {
      // Unique partial index collision → another tenant owns this number.
      if ((updErr as { code?: string }).code === "23505") {
        res.status(409).json({ error: "phone_number_in_use" });
        return;
      }
      throw updErr;
    }

    invalidateTenantTelecomCache();

    await logAudit({
      action: "organization.phone_numbers_updated",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "organizations",
      targetId: orgId,
      metadata: {
        voice_number: voiceNumber ?? null,
        sms_number: smsNumber ?? null,
        messaging_service_sid: messagingServiceSid ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((auditErr: unknown) => {
      logger.warn(
        { err: auditErr },
        "organization.phone_numbers_updated audit write failed",
      );
    });

    res.json(viewOf(await loadOrgPhone(orgId)));
  },
);

export default router;
