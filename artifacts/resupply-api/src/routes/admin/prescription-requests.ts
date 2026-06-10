// /admin/prescription-requests — CSR workflow for creating and
// faxing a pre-populated prescription packet that the ordering
// physician signs and returns.
//
// Routes
// ------
//   POST   /admin/patients/:id/prescription-requests
//          Create a draft packet for a patient. Body carries the
//          pre-populated equipment lines, dx codes, settings, and
//          a return-fax override.
//
//   GET    /admin/patients/:id/prescription-requests
//          List all packets for a patient (most recent first).
//
//   GET    /admin/prescription-requests/needs-signature
//          ?providerId=… | ?practiceName=… — JSON manifest of every
//          outstanding packet still awaiting a signature for one
//          provider or practice.
//
//   GET    /admin/prescription-requests/needs-signature/pdf
//          Same scoping; returns ONE combined PDF (hand-delivery cover
//          checklist + each packet's signable order) so the whole
//          stack can be printed and hand-carried for in-person signing.
//
//   GET    /admin/prescription-requests/:id
//          Single-packet detail.
//
//   GET    /admin/prescription-requests/:id/pdf
//          Admin-side preview of the rendered PDF. Distinct from
//          the public /rx-request/document/:token route — the
//          admin route does NOT require a token; auth is the
//          admin session.
//
//   POST   /admin/prescription-requests/:id/send-fax
//          First dispatch via Telnyx. Only valid from status=draft or
//          status=failed; a packet already in flight (sent_fax /
//          delivered) returns 409 — use /resend-fax for a deliberate
//          follow-up.
//
//   POST   /admin/prescription-requests/:id/resend-fax
//          Deliberate re-dispatch of an in-flight packet (status
//          sent_fax or delivered) when the physician hasn't returned
//          it — re-renders the same packet and re-faxes it. Refuses
//          terminal states (signed / void / expired); for draft /
//          failed use /send-fax. Audited as a distinct
//          `prescription_request.resent_fax` action so a re-send is
//          never mistaken for an accidental double-send.
//
//   POST   /admin/prescription-requests/:id/mark-signed
//          CSR stamps when the signed PDF returns via fax /
//          email / scan upload. Body may carry signed_object_key
//          when the scan was uploaded through the existing
//          object-storage flow.
//
//   POST   /admin/prescription-requests/:id/void
//          Cancel a draft / unsent / sent packet that the CSR
//          determined was incorrect.
//
// Permissions: patients.update for all writes (mirrors the
// physician-fax-outreach scope). Reads gated by patients.read.
//
// PHI posture: list/detail responses include patient + provider
// identifiers (PHI). The logger emits packet id + status only.

import { Router, type IRouter, type Request, type Response } from "express";
import PDFDocument from "pdfkit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import {
  createTelnyxFaxClient,
  TelnyxApiError,
} from "@workspace/resupply-telecom";

import { logger } from "../../lib/logger";
import {
  type PrescriptionRequestInputs,
  renderPrescriptionRequest,
  validatePrescriptionRequestInputs,
} from "../../lib/prescription-request-pdf";
import { resolvePrescriptionRequestInputs } from "../../lib/prescription-request-resolver";
import { signPrescriptionRequestToken } from "../../lib/prescription-request-token";
import {
  type SignatureTarget,
  aggregatePacketsNeedingSignature,
} from "../../lib/prescription-signature-aggregation";
import {
  type SignatureBatchCoverItem,
  renderSignatureBatchCover,
} from "../../lib/prescription-signature-batch-pdf";
import {
  markTrackingCanceled,
  markTrackingReturned,
  recordTrackingSent,
  registerSignatureTracking,
} from "../../lib/signature-tracking/service";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";
import { getFaxPublicBaseUrl } from "./physician-fax-outreach";

type PacketRow =
  Database["resupply"]["Tables"]["prescription_request_packets"]["Row"];
type PacketUpdate =
  Database["resupply"]["Tables"]["prescription_request_packets"]["Update"];

const router: IRouter = Router();
const idParam = z.object({ id: z.string().uuid() });
const patientParam = z.object({ id: z.string().uuid() });
const E164 = /^\+[1-9]\d{6,14}$/;

const hcpcsLineSchema = z
  .object({
    hcpcs: z
      .string()
      .trim()
      .regex(/^[A-Z]\d{4}$/u, "HCPCS must be like E0601"),
    description: z.string().trim().min(1).max(200),
    quantity: z.number().int().min(1).max(50),
    cadenceDays: z.number().int().min(0).max(3650).nullable().optional(),
    modifiers: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z0-9]{2}$/u),
      )
      .max(4)
      .optional(),
  })
  .strict();

const settingsSchema = z
  .object({
    deviceClass: z.enum(["cpap", "auto_cpap", "bipap", "bipap_st", "asv"]),
    pressureCmh2o: z.number().min(0).max(30).nullable().optional(),
    pressureMinCmh2o: z.number().min(0).max(30).nullable().optional(),
    pressureMaxCmh2o: z.number().min(0).max(30).nullable().optional(),
    ipapCmh2o: z.number().min(0).max(30).nullable().optional(),
    epapCmh2o: z.number().min(0).max(30).nullable().optional(),
    rampMinutes: z.number().int().min(0).max(45).nullable().optional(),
    rampStartCmh2o: z.number().min(0).max(30).nullable().optional(),
    humidifierSetting: z.number().int().min(0).max(8).nullable().optional(),
    heatedTube: z.boolean().optional(),
    backupRateBpm: z.number().int().min(0).max(40).nullable().optional(),
  })
  .strict();

const createBody = z
  .object({
    providerId: z.string().uuid(),
    sourcePrescriptionId: z.string().uuid().optional(),
    hcpcsLines: z.array(hcpcsLineSchema).min(1).max(20),
    icd10Codes: z
      .array(
        z
          .string()
          .trim()
          .regex(/^[A-Z]\d{2}(\.\d{1,4})?$/u),
      )
      .min(1)
      .max(10),
    settings: settingsSchema.nullable().optional(),
    lengthOfNeedMonths: z.number().int().min(1).max(99).default(99),
    returnFaxE164: z.string().trim().regex(E164).nullable().optional(),
    returnEmail: z.string().trim().email().max(240).nullable().optional(),
    clinicalNotes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/prescription-requests",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "prescription_requests.create",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = patientParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const parsed = createBody.safeParse(req.body);
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

    // Verify patient + provider exist before insert so the FK
    // failure returns a clear 4xx rather than a 500.
    const [{ data: patient }, { data: provider }] = await Promise.all([
      supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name")
        .eq("id", params.data.id)
        .limit(1)
        .maybeSingle(),
      supabase
        .schema("resupply")
        .from("providers")
        .select("id, fax_e164, legal_name, practice_name")
        .eq("id", parsed.data.providerId)
        .limit(1)
        .maybeSingle(),
    ]);
    if (!patient) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    if (!provider) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }

    const returnFax = parsed.data.returnFaxE164 ?? provider.fax_e164 ?? null;

    const { data: inserted, error: insertErr } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .insert({
        patient_id: params.data.id,
        provider_id: parsed.data.providerId,
        source_prescription_id: parsed.data.sourcePrescriptionId ?? null,
        hcpcs_items_json: parsed.data.hcpcsLines as unknown as Json,
        icd10_codes_json: parsed.data.icd10Codes as unknown as Json,
        device_settings_json: (parsed.data.settings ??
          null) as unknown as Json | null,
        length_of_need_months: parsed.data.lengthOfNeedMonths,
        return_fax_e164: returnFax,
        return_email: parsed.data.returnEmail ?? null,
        clinical_notes: parsed.data.clinicalNotes ?? null,
        status: "draft",
        created_by_email: req.adminEmail ?? "admin:unknown",
      })
      .select("id")
      .maybeSingle();
    if (insertErr || !inserted) {
      logger.warn(
        { err_code: insertErr?.code, patient_id: params.data.id },
        "prescription_request.create_failed",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    // Register the signature-tracking row so the packet gets a stable
    // tracking code + barcode and shows up in the outstanding-signatures
    // dashboard. Snapshot the provider/patient labels for at-a-glance
    // rendering. Best-effort: a tracking failure must not fail the
    // packet create (the PDF just renders without a barcode).
    let trackingCode: string | null = null;
    try {
      const reg = await registerSignatureTracking(supabase, {
        kind: "prescription_request",
        documentId: inserted.id,
        title: "Prescription request",
        patientId: params.data.id,
        providerId: parsed.data.providerId,
        patientLabel: formatPatientLabel(
          patient.legal_first_name,
          patient.legal_last_name,
        ),
        providerLabel: provider.legal_name ?? null,
        practiceName: provider.practice_name ?? null,
        returnFaxE164: returnFax,
        createdByEmail: req.adminEmail ?? null,
      });
      trackingCode = reg.trackingCode;
    } catch (err) {
      logger.warn({ err }, "prescription_request.tracking_register failed");
    }

    await logAudit({
      action: "prescription_request.created",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: inserted.id,
      metadata: {
        patient_id: params.data.id,
        provider_id: parsed.data.providerId,
        hcpcs_count: parsed.data.hcpcsLines.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prescription_request.created audit write failed");
    });

    res.status(201).json({ id: inserted.id, trackingCode });
  },
);

router.get(
  "/admin/patients/:id/prescription-requests",
  requirePermission("patients.read"),
  async (req, res) => {
    const params = patientParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select(
        "id, provider_id, status, return_fax_e164, sent_to_fax_e164, sent_at, delivered_at, signed_at, failed_at, failure_reason, created_at",
      )
      .eq("patient_id", params.data.id)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw error;
    res.json({ packets: (data ?? []).map(projectListItem) });
  },
);

// Batch view of every outstanding packet still awaiting a signature
// for one provider or one practice. Two routes share the same query
// contract (exactly one of providerId / practiceName):
//
//   GET .../needs-signature      → JSON manifest (counts + list)
//   GET .../needs-signature/pdf  → one combined PDF: a hand-delivery
//                                  cover checklist followed by each
//                                  packet's signable order, for printing
//                                  the whole stack at once.
//
// Registered before the "/:id" routes so the static "needs-signature"
// path is not captured by the ":id" param.
const needsSignatureQuery = z
  .object({
    providerId: z.string().uuid().optional(),
    practiceName: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
  })
  .refine((q) => Boolean(q.providerId) !== Boolean(q.practiceName), {
    message: "Provide exactly one of providerId or practiceName",
  });

function targetFromQuery(q: {
  providerId?: string;
  practiceName?: string;
}): SignatureTarget {
  return q.providerId
    ? { kind: "provider", providerId: q.providerId }
    : { kind: "practice", practiceName: q.practiceName! };
}

router.get(
  "/admin/prescription-requests/needs-signature",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = needsSignatureQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const aggregation = await aggregatePacketsNeedingSignature(
      supabase,
      targetFromQuery(parsed.data),
      { limit: parsed.data.limit },
    );
    res.json(aggregation);
  },
);

router.get(
  "/admin/prescription-requests/needs-signature/pdf",
  requirePermission("patients.read"),
  async (req, res) => {
    const parsed = needsSignatureQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_query",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }
    const target = targetFromQuery(parsed.data);
    const supabase = getSupabaseServiceRoleClient();
    const aggregation = await aggregatePacketsNeedingSignature(
      supabase,
      target,
      {
        limit: parsed.data.limit,
      },
    );
    if (aggregation.count === 0) {
      res.status(404).json({ error: "no_outstanding_packets" });
      return;
    }

    // Resolve each packet to renderer inputs, preserving order. A packet
    // whose inputs don't resolve (missing patient/provider) or fail
    // validation (e.g. no NPI) can't be rendered into a signable order —
    // it's listed on the cover as "excluded" rather than silently
    // dropped, so the CSR knows to fix it before the visit.
    const resolved = await Promise.all(
      aggregation.packets.map(async (packet) => ({
        packet,
        outcome: await resolvePrescriptionRequestInputs(supabase, packet.id),
      })),
    );

    const coverItems: SignatureBatchCoverItem[] = [];
    const renderable: PrescriptionRequestInputs[] = [];
    for (const { packet, outcome } of resolved) {
      if (outcome.kind === "ok") {
        const validated = validatePrescriptionRequestInputs(outcome.inputs);
        if (validated.ok) {
          renderable.push(validated.inputs);
          coverItems.push({
            patientName: packet.patientName,
            status: packet.status,
          });
          continue;
        }
      }
      coverItems.push({
        patientName: packet.patientName,
        status: packet.status,
        excluded: true,
        excludedReason:
          outcome.kind === "not_found" ? "not found" : "incomplete order",
      });
    }

    if (renderable.length === 0) {
      res.status(422).json({ error: "no_renderable_packets" });
      return;
    }

    const doc = new PDFDocument({ margin: 72, size: "LETTER" });
    res.setHeader("Content-Type", "application/pdf");
    const filenameStem =
      target.kind === "provider"
        ? `provider-${target.providerId.slice(0, 8)}`
        : "practice";
    res.setHeader(
      "Content-Disposition",
      `inline; filename="rx-signature-batch-${filenameStem}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    doc.pipe(res);
    renderSignatureBatchCover(doc, {
      label: aggregation.label,
      includedCount: renderable.length,
      items: coverItems,
      generatedOn: new Date(),
    });
    for (const inputs of renderable) {
      doc.addPage();
      renderPrescriptionRequest(doc, inputs);
    }
    doc.end();

    await logAudit({
      action: "prescription_request.batch_previewed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: null,
      metadata: {
        target_kind: target.kind,
        included: renderable.length,
        excluded: coverItems.length - renderable.length,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        "prescription_request.batch_previewed audit write failed",
      );
    });
  },
);

router.get(
  "/admin/prescription-requests/:id",
  requirePermission("patients.read"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json(projectDetail(data));
  },
);

router.get(
  "/admin/prescription-requests/:id/pdf",
  requirePermission("patients.read"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const resolved = await resolvePrescriptionRequestInputs(
      supabase,
      params.data.id,
    );
    if (resolved.kind === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (resolved.kind === "invalid_inputs") {
      res
        .status(422)
        .json({ error: "invalid_inputs", missing: resolved.missing });
      return;
    }
    const validated = validatePrescriptionRequestInputs(resolved.inputs);
    if (!validated.ok) {
      res
        .status(422)
        .json({ error: "invalid_inputs", missing: validated.missing });
      return;
    }

    const doc = new PDFDocument({ margin: 72, size: "LETTER" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="rx-request-${params.data.id.slice(0, 8)}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    doc.pipe(res);
    renderPrescriptionRequest(doc, validated.inputs);
    doc.end();

    await logAudit({
      action: "prescription_request.previewed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: params.data.id,
      metadata: {},
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prescription_request.previewed audit write failed");
    });
  },
);

/**
 * Shared Telnyx dispatch for a prescription packet, used by both the
 * first send (`/send-fax`) and the deliberate re-send (`/resend-fax`).
 * The status guard differs per route (which lifecycle states are
 * eligible) and is checked by the caller; this helper owns the
 * render-verify → config-check → dispatch → stamp → audit pipeline so
 * the two routes can't drift apart. `isResend` only changes the audit
 * action and the logged event name — the wire behaviour is identical
 * (re-render the same packet, re-fax to the return number).
 */
async function dispatchPacketFax(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  packet: { id: string; return_fax_e164: string | null },
  req: Request,
  res: Response,
  { isResend }: { isResend: boolean },
): Promise<void> {
  if (!packet.return_fax_e164) {
    res.status(409).json({ error: "no_return_fax" });
    return;
  }

  // Verify inputs render before dispatch so we don't fire a Telnyx
  // bill on a packet that the public fetch would 422 on.
  const resolved = await resolvePrescriptionRequestInputs(supabase, packet.id);
  if (resolved.kind !== "ok") {
    res.status(422).json({
      error: "invalid_inputs",
      missing:
        resolved.kind === "invalid_inputs" ? resolved.missing : ["unknown"],
    });
    return;
  }
  const validated = validatePrescriptionRequestInputs(resolved.inputs);
  if (!validated.ok) {
    res
      .status(422)
      .json({ error: "invalid_inputs", missing: validated.missing });
    return;
  }

  // Configuration check: same posture as physician-fax-outreach
  // (TELNYX_API_KEY + TELNYX_FAX_CONNECTION_ID + TELNYX_FAX_FROM_NUMBER
  // + TELNYX_PUBLIC_KEY + public base URL). TELNYX_PUBLIC_KEY is required
  // because without it the webhook router rejects every status callback,
  // so a sent packet would never get its delivered/failed update. When
  // unconfigured, leave the packet status untouched so the CSR can re-fire
  // after env is set; surface a 503 so the UI can show an actionable error.
  const baseUrl = getFaxPublicBaseUrl();
  const fromNumber = process.env.TELNYX_FAX_FROM_NUMBER?.trim();
  if (
    !process.env.TELNYX_API_KEY?.trim() ||
    !process.env.TELNYX_FAX_CONNECTION_ID?.trim() ||
    !process.env.TELNYX_PUBLIC_KEY?.trim() ||
    !fromNumber ||
    !baseUrl
  ) {
    res.status(503).json({ error: "fax_not_configured" });
    return;
  }

  const token = signPrescriptionRequestToken(packet.id);
  const mediaUrl = `${baseUrl}/resupply-api/rx-request/document/${token}`;
  const statusCallbackUrl = `${baseUrl}/resupply-api/fax/webhook`;
  const faxClient = createTelnyxFaxClient();
  const nowIso = new Date().toISOString();
  try {
    const result = await faxClient.sendFax({
      to: packet.return_fax_e164,
      from: fromNumber,
      mediaUrl,
      statusCallbackUrl,
    });
    const update: PacketUpdate = {
      status: "sent_fax",
      sent_to_fax_e164: packet.return_fax_e164,
      sent_at: nowIso,
      // A re-send clears the prior in-flight delivery/failure stamps so
      // the webhook callback for THIS dispatch lands on a clean slate.
      delivered_at: null,
      failed_at: null,
      failure_reason: null,
      vendor_ref: result.id,
      vendor_name: "telnyx",
      updated_at: nowIso,
    };
    const { error: stampErr } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .update(update)
      .eq("id", packet.id);
    if (stampErr) {
      logger.warn(
        {
          packet_id: packet.id,
          vendor_ref: result.id,
          err: stampErr,
        },
        "prescription_request.send.db_stamp_failed",
      );
    }
    await recordTrackingSent(
      supabase,
      "prescription_request",
      packet.id,
      "fax",
    ).catch((err) => {
      logger.warn({ err }, "prescription_request.tracking_sent failed");
    });
    await logAudit({
      action: isResend
        ? "prescription_request.resent_fax"
        : "prescription_request.sent_fax",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: packet.id,
      metadata: { vendor_ref: result.id, resend: isResend },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn(
        { err },
        `prescription_request.${isResend ? "resent_fax" : "sent_fax"} audit write failed`,
      );
    });
    res.status(200).json({
      status: "sent_fax",
      vendorRef: result.id,
      resent: isResend,
    });
  } catch (err) {
    const msg =
      err instanceof TelnyxApiError
        ? `Telnyx fax error: ${err.message}`
        : `Fax dispatch error: ${String(err)}`;
    const { error: failStampErr } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .update({
        status: "failed",
        failed_at: nowIso,
        failure_reason: msg.slice(0, 2000),
        updated_at: nowIso,
      })
      .eq("id", packet.id);
    if (failStampErr) {
      logger.error(
        { err: failStampErr.message, packetId: packet.id },
        "prescription_request.send.failed: could not stamp failure — packet may remain in sending state",
      );
    }
    logger.warn({ packet_id: packet.id }, "prescription_request.send.failed");
    res.status(502).json({ error: "fax_dispatch_failed", message: msg });
  }
}

router.post(
  "/admin/prescription-requests/:id/send-fax",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "prescription_requests.send_fax",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: packet } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select("id, status, return_fax_e164")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (packet.status !== "draft" && packet.status !== "failed") {
      res.status(409).json({
        error: "invalid_status",
        message:
          packet.status === "sent_fax" || packet.status === "delivered"
            ? `Packet already sent — use re-send for a deliberate follow-up.`
            : `Cannot dispatch a packet in status "${packet.status.replace(/_/g, " ")}".`,
      });
      return;
    }
    await dispatchPacketFax(supabase, packet, req, res, { isResend: false });
  },
);

router.post(
  "/admin/prescription-requests/:id/resend-fax",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "prescription_requests.resend_fax",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: packet } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select("id, status, return_fax_e164")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!packet) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Re-send is only meaningful for a packet that's already in flight
    // and awaiting the physician's signature. draft / failed haven't
    // been sent yet (use /send-fax); signed / void / expired are
    // terminal.
    if (packet.status !== "sent_fax" && packet.status !== "delivered") {
      res.status(409).json({
        error: "invalid_status",
        message:
          packet.status === "draft" || packet.status === "failed"
            ? `Packet has not been sent yet — use send-fax for the first dispatch.`
            : `Cannot re-send a packet in status "${packet.status.replace(/_/g, " ")}".`,
      });
      return;
    }
    await dispatchPacketFax(supabase, packet, req, res, { isResend: true });
  },
);

router.post(
  "/admin/prescription-requests/:id/mark-signed",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "prescription_requests.mark_signed",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = z
      .object({
        signedObjectKey: z
          .string()
          .trim()
          .min(1)
          .max(500)
          .nullable()
          .optional(),
      })
      .strict()
      .safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select("id, status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      existing.status !== "sent_fax" &&
      existing.status !== "delivered" &&
      existing.status !== "draft" // allow stamping when fax was sent out-of-band
    ) {
      res.status(409).json({
        error: "invalid_status",
        message: `Cannot mark a packet in status "${existing.status.replace(/_/g, " ")}" as signed.`,
      });
      return;
    }
    const nowIso = new Date().toISOString();
    const update: PacketUpdate = {
      status: "signed",
      signed_at: nowIso,
      updated_at: nowIso,
    };
    if (body.data.signedObjectKey !== undefined) {
      update.signed_object_key = body.data.signedObjectKey;
    }
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .update(update)
      .eq("id", params.data.id);
    if (updErr) throw updErr;
    await markTrackingReturned(
      supabase,
      "prescription_request",
      params.data.id,
    ).catch((err) => {
      logger.warn({ err }, "prescription_request.tracking_returned failed");
    });
    await logAudit({
      action: "prescription_request.signed",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: params.data.id,
      metadata: { from_status: existing.status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prescription_request.signed audit write failed");
    });
    res.status(200).json({ status: "signed" });
  },
);

router.post(
  "/admin/prescription-requests/:id/void",
  requirePermission("patients.update"),
  adminRateLimit({
    name: "prescription_requests.void",
    preset: "mutation",
  }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: existing } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .select("id, status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.status === "signed" || existing.status === "void") {
      res.status(409).json({
        error: "invalid_status",
        message: `Cannot void a packet in status "${existing.status.replace(/_/g, " ")}".`,
      });
      return;
    }
    const { error } = await supabase
      .schema("resupply")
      .from("prescription_request_packets")
      .update({
        status: "void",
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.data.id);
    if (error) throw error;
    await markTrackingCanceled(
      supabase,
      "prescription_request",
      params.data.id,
    ).catch((err) => {
      logger.warn({ err }, "prescription_request.tracking_canceled failed");
    });
    await logAudit({
      action: "prescription_request.void",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "prescription_request_packets",
      targetId: params.data.id,
      metadata: { from_status: existing.status },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "prescription_request.void audit write failed");
    });
    res.status(200).json({ status: "void" });
  },
);

function formatPatientLabel(
  first: string | null,
  last: string | null,
): string | null {
  const f = (first ?? "").trim();
  const l = (last ?? "").trim();
  if (l && f) return `${l}, ${f}`;
  return l || f || null;
}

function projectListItem(
  r: Pick<
    PacketRow,
    | "id"
    | "provider_id"
    | "status"
    | "return_fax_e164"
    | "sent_to_fax_e164"
    | "sent_at"
    | "delivered_at"
    | "signed_at"
    | "failed_at"
    | "failure_reason"
    | "created_at"
  >,
) {
  return {
    id: r.id,
    providerId: r.provider_id,
    status: r.status,
    returnFaxE164: r.return_fax_e164,
    sentToFaxE164: r.sent_to_fax_e164,
    sentAt: r.sent_at,
    deliveredAt: r.delivered_at,
    signedAt: r.signed_at,
    failedAt: r.failed_at,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
  };
}

function projectDetail(r: PacketRow) {
  return {
    ...projectListItem(r),
    patientId: r.patient_id,
    sourcePrescriptionId: r.source_prescription_id,
    hcpcsLines: r.hcpcs_items_json,
    icd10Codes: r.icd10_codes_json,
    settings: r.device_settings_json,
    lengthOfNeedMonths: r.length_of_need_months,
    returnEmail: r.return_email,
    clinicalNotes: r.clinical_notes,
    validThrough: r.valid_through,
    vendorRef: r.vendor_ref,
    vendorName: r.vendor_name,
    signedObjectKey: r.signed_object_key,
    createdByEmail: r.created_by_email,
    updatedAt: r.updated_at,
  };
}

export default router;
