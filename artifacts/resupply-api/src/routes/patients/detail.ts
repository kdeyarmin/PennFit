// GET /patients/:id — full patient detail for the admin console.
//
// Returns the patient header (name; phone/email surfaced only as
// boolean reachability flags) plus, in one round-trip per related
// table:
//   * all prescriptions
//   * all episodes (denormalising the prescription's itemSku for
//     display so the patient detail tab doesn't need a second
//     table reference)
//   * the 10 most recent conversations (no message bodies — those
//     come from /conversations/:id)
//   * the 10 most recent fulfillments
//
// Writes one `patient.view` audit row with the patient id as
// target. This is a PHI read, so it is auditable per ADR; we do
// not include the patient name in metadata (the metadata
// sanitiser would drop it anyway, but it costs nothing to be
// explicit at the call site).

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { adminReadRateLimiter } from "../../middlewares/admin-rate-limit";
import { requireAdmin } from "../../middlewares/requireAdmin";

const idParam = z.object({ id: z.string().uuid() });

const router: IRouter = Router();

router.get(
  "/patients/:id",
  adminReadRateLimiter,
  requireAdmin,
  async (req, res) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { id } = parsed.data;

    const supabase = getSupabaseServiceRoleClient();

    // Five independent reads (header + four child collections), each
    // keyed on the patient id. Run them concurrently so the detail
    // page pays max(query) latency rather than sum(query). The
    // original SQL path's LEFT JOINs (header → patient_latest_message
    // and patients → auth.users) become bulk-fetch + JS merges; both
    // joins are 1-to-1, so a separate `.maybeSingle()` lookup keyed on
    // the relevant id is the simplest equivalent.
    const [
      patientRes,
      prescriptionsRes,
      episodesRes,
      conversationsRes,
      fulfillmentsRes,
    ] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select(
          "id, pacware_id, legal_first_name, legal_last_name, status, phone_e164, email, insurance_payer, cadence_override_days, channel_preference, created_at, updated_at, portal_auth_user_id, portal_invited_at",
        )
        .eq("id", id)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("prescriptions")
        .select(
          "id, item_sku, hcpcs_code, provider_id, cadence_days, valid_from, valid_until, status, created_at, attachment_filename, attachment_content_type, attachment_size_bytes, attachment_uploaded_at",
        )
        .eq("patient_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .schema("resupply")
        .from("episodes")
        .select("id, prescription_id, status, due_at, expires_at, created_at")
        .eq("patient_id", id)
        .order("created_at", { ascending: false }),
      supabase
        .schema("resupply")
        .from("conversations")
        .select("id, episode_id, channel, status, last_message_at, created_at")
        .eq("patient_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
      supabase
        .schema("resupply")
        .from("fulfillments")
        .select(
          "id, episode_id, item_sku, quantity, status, pacware_order_ref, submitted_at, shipped_at, delivered_at, created_at",
        )
        .eq("patient_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
    ]);
    if (patientRes.error) throw patientRes.error;
    if (prescriptionsRes.error) throw prescriptionsRes.error;
    if (episodesRes.error) throw episodesRes.error;
    if (conversationsRes.error) throw conversationsRes.error;
    if (fulfillmentsRes.error) throw fulfillmentsRes.error;

    const patient = patientRes.data;
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // The header used to LEFT JOIN patient_latest_message + auth.users
    // — fetch both small lookups now that we have the patient row.
    // Episodes used to LEFT JOIN prescriptions for itemSku — bulk-fetch
    // by the prescription_id list pulled from this page's episodes.
    const episodePrescriptionIds = Array.from(
      new Set(
        (episodesRes.data ?? [])
          .map((e) => e.prescription_id)
          .filter((v): v is string => v !== null),
      ),
    );
    const [latestMsgRes, authRes, episodeRxRes, linkedCustomerRes] =
      await Promise.all([
        supabase
          .schema("resupply")
          .from("patient_latest_message")
          .select(
            "last_message_at, last_message_direction, last_message_preview",
          )
          .eq("patient_id", id)
          .limit(1)
          .maybeSingle(),
        patient.portal_auth_user_id
          ? supabase
              .schema("resupply_auth")
              .from("users")
              .select("email_verified_at")
              .eq("id", patient.portal_auth_user_id)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as const),
        episodePrescriptionIds.length > 0
          ? supabase
              .schema("resupply")
              .from("prescriptions")
              .select("id, item_sku")
              .in("id", episodePrescriptionIds)
          : Promise.resolve({ data: [], error: null } as const),
        // The storefront shop-customer that shares this patient's portal
        // login, if any. Patients and shop customers are otherwise
        // unlinked; the only deterministic correlation is a shared
        // in-house auth user (patients.portal_auth_user_id ===
        // shop_customers.auth_user_id). Surfacing the customer's id lets
        // the detail page offer a real "view their customer record" jump.
        patient.portal_auth_user_id
          ? supabase
              .schema("resupply")
              .from("shop_customers")
              .select("customer_id")
              .eq("auth_user_id", patient.portal_auth_user_id)
              .limit(1)
              .maybeSingle()
          : Promise.resolve({ data: null, error: null } as const),
      ]);
    if (latestMsgRes.error) throw latestMsgRes.error;
    if (authRes.error) throw authRes.error;
    if (episodeRxRes.error) throw episodeRxRes.error;
    if (linkedCustomerRes.error) throw linkedCustomerRes.error;
    const itemSkuByRxId = new Map<string, string>();
    for (const rx of episodeRxRes.data ?? []) {
      itemSkuByRxId.set(rx.id, rx.item_sku);
    }

    try {
      await logAudit({
        action: "patient.view",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "patients",
        targetId: id,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
        metadata: { source: "console" },
      });
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "patients.detail: audit write failed",
      );
    }

    // Compute portal status from linked auth row (no stored status column).
    const portalStatus = !patient.portal_auth_user_id
      ? "not_invited"
      : authRes.data?.email_verified_at
        ? "active"
        : "pending";

    res.status(200).json({
      id: patient.id,
      pacwareId: patient.pacware_id,
      firstName: patient.legal_first_name ?? "",
      lastName: patient.legal_last_name ?? "",
      status: patient.status,
      hasPhone: patient.phone_e164 != null,
      hasEmail: patient.email != null,
      insurancePayer: patient.insurance_payer,
      cadenceOverrideDays: patient.cadence_override_days,
      channelPreference: patient.channel_preference,
      createdAt: patient.created_at,
      updatedAt: patient.updated_at,
      lastMessageAt: latestMsgRes.data?.last_message_at ?? null,
      lastMessageDirection: latestMsgRes.data?.last_message_direction ?? null,
      lastMessagePreview: latestMsgRes.data?.last_message_preview ?? null,
      portalStatus,
      portalInvitedAt: patient.portal_invited_at,
      // The shop-customer userId that shares this patient's portal login
      // (null when the patient has no portal account or no matching
      // customer). Drives the "view customer record" link.
      linkedCustomerUserId: linkedCustomerRes.data?.customer_id ?? null,
      prescriptions: (prescriptionsRes.data ?? []).map((p) => ({
        id: p.id,
        itemSku: p.item_sku,
        hcpcsCode: p.hcpcs_code,
        providerId: p.provider_id,
        cadenceDays: p.cadence_days,
        // valid_from/valid_until are `date` columns; PostgREST returns
        // them as `YYYY-MM-DD` strings, no Date conversion needed.
        validFrom: p.valid_from,
        validUntil: p.valid_until,
        status: p.status,
        createdAt: p.created_at,
        // Forward the bounded attachment metadata. The dashboard uses
        // `attachmentFilename` truthiness to switch between "Attach"
        // and "Download/Remove" UI states; the other three fields are
        // for display only. Object key is intentionally NOT forwarded.
        attachmentFilename: p.attachment_filename,
        attachmentContentType: p.attachment_content_type,
        attachmentSizeBytes: p.attachment_size_bytes,
        attachmentUploadedAt: p.attachment_uploaded_at,
      })),
      episodes: (episodesRes.data ?? []).map((e) => ({
        id: e.id,
        prescriptionId: e.prescription_id,
        itemSku: itemSkuByRxId.get(e.prescription_id) ?? "",
        status: e.status,
        dueAt: e.due_at,
        expiresAt: e.expires_at,
        createdAt: e.created_at,
      })),
      conversations: (conversationsRes.data ?? []).map((c) => ({
        id: c.id,
        episodeId: c.episode_id,
        channel: c.channel,
        status: c.status,
        lastMessageAt: c.last_message_at,
        createdAt: c.created_at,
      })),
      fulfillments: (fulfillmentsRes.data ?? []).map((f) => ({
        id: f.id,
        episodeId: f.episode_id,
        itemSku: f.item_sku,
        quantity: f.quantity,
        status: f.status,
        pacwareOrderRef: f.pacware_order_ref,
        submittedAt: f.submitted_at,
        shippedAt: f.shipped_at,
        deliveredAt: f.delivered_at,
        createdAt: f.created_at,
      })),
    });
  },
);

export default router;
