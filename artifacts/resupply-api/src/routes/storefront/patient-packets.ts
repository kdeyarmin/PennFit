// Public patient-packet signing endpoints (no login — the HMAC token
// is the auth).
//
//   GET  /patient-packets/view?token=...   — fetch the packet + document
//                                            content for the signing UI
//   POST /patient-packets/sign             — submit the signature and
//                                            finalize the packet
//
// Mounted inside the storefront router (BEFORE attachSignedIn) so the
// cpap-fitter SPA reaches it at /api/patient-packets/*. The signing
// body can carry a drawn-signature PNG data URL; a dedicated 1 MB JSON
// parser is mounted for /api/patient-packets/sign in app.ts (the global
// parser caps at 100 KB).
//
// PHI / logging posture: the signature image is the signed artifact —
// it is persisted but NEVER logged. Audit rows carry counts + flags
// only.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { resolveCompanyProfile } from "../../lib/patient-packet/company";
import {
  getPacketTemplate,
  packetRequiresDateReceived,
  type DeliveryDetails,
} from "../../lib/patient-packet/templates";
import { verifyPatientPacketToken } from "../../lib/patient-packet-token";

const router: IRouter = Router();

const viewLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const signLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "rate_limited" },
});

const SIGNATURE_MAX_CHARS = 90_000; // keeps the body within the parser cap

type ResolvedPacket = {
  id: string;
  status: string;
  link_version: number;
  expires_at: string | null;
  title: string;
  recipient_name: string;
  completed_at: string | null;
  delivery_details: DeliveryDetails | null;
};

// Verify a token against a freshly-loaded packet row. Returns the
// packet when the link is valid + open, or an error code to surface.
async function resolveOpenPacket(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  token: string,
): Promise<
  | { ok: true; packet: ResolvedPacket }
  | {
      ok: false;
      code: "invalid" | "not_found" | "expired" | "voided" | "completed";
    }
> {
  const verified = verifyPatientPacketToken(token);
  if (!verified.valid) return { ok: false, code: "invalid" };

  const { data: packet, error } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .select(
      "id, status, link_version, expires_at, title, recipient_name, completed_at, delivery_details",
    )
    .eq("id", verified.packetId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!packet) return { ok: false, code: "not_found" };
  // A stale link (re-issued / voided) carries an old version.
  if (packet.link_version !== verified.linkVersion) {
    return { ok: false, code: "invalid" };
  }
  if (packet.status === "voided") return { ok: false, code: "voided" };
  if (packet.status === "completed") return { ok: false, code: "completed" };
  if (packet.expires_at && new Date(packet.expires_at).getTime() < Date.now()) {
    return { ok: false, code: "expired" };
  }
  return { ok: true, packet: packet as unknown as ResolvedPacket };
}

// ── GET /patient-packets/view ─────────────────────────────────────
router.get("/patient-packets/view", viewLimiter, async (req, res) => {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  if (!token || token.length > 600) {
    res.status(400).json({ error: "missing_token" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolveOpenPacket(supabase, token);
  if (!resolved.ok) {
    // Completed is a friendly terminal state, not an error for the UI.
    if (resolved.code === "completed") {
      res.json({ status: "completed", documents: [] });
      return;
    }
    res.status(resolved.code === "not_found" ? 404 : 410).json({
      error: resolved.code,
    });
    return;
  }
  const packet = resolved.packet;

  const { data: docs, error: docsErr } = await supabase
    .schema("resupply")
    .from("patient_packet_documents")
    .select("document_key, title, requires_signature, sort_order")
    .eq("packet_id", packet.id)
    .order("sort_order", { ascending: true });
  if (docsErr) throw docsErr;

  const company = await resolveCompanyProfile(supabase);

  // First view? Stamp it (best-effort; never blocks the read).
  if (packet.status === "sent") {
    const { error: viewStampErr } = await supabase
      .schema("resupply")
      .from("patient_packets")
      .update({
        status: "viewed",
        first_viewed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", packet.id)
      .eq("status", "sent");
    if (viewStampErr) {
      logger.warn(
        { err: viewStampErr.message, packetId: packet.id },
        "patient-packets.get: first-view stamp failed (non-fatal)",
      );
    }
  }

  const docKeys = (docs ?? []).map((d) => d.document_key);
  const buildCtx = { deliveryDetails: packet.delivery_details };

  res.json({
    status: "open",
    title: packet.title,
    recipientName: packet.recipient_name,
    company: {
      legalName: company.legalName,
      phone: company.phone,
      email: company.email,
    },
    // The signer must record the date they received the equipment when
    // the packet carries a Proof of Delivery (a Medicare POD field).
    requiresDateReceived: packetRequiresDateReceived(docKeys),
    documents: (docs ?? []).map((d) => {
      const t = getPacketTemplate(d.document_key);
      return {
        key: d.document_key,
        title: d.title,
        category: t?.category ?? "consent",
        requiresSignature: d.requires_signature,
        sections: t ? t.build(company, buildCtx) : [],
      };
    }),
  });
});

// ── POST /patient-packets/sign ────────────────────────────────────
const signBody = z
  .object({
    token: z.string().min(10).max(600),
    signerName: z.string().trim().min(2).max(160),
    signerRelationship: z
      .enum([
        "self",
        "spouse",
        "guardian",
        "power_of_attorney",
        "caregiver",
        "other",
      ])
      .default("self"),
    signatureImage: z
      .string()
      .max(SIGNATURE_MAX_CHARS)
      .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u)
      .optional()
      .nullable(),
    // Medicare: when a representative signs, the reason the beneficiary
    // could not sign must be recorded.
    signerReason: z.string().trim().max(500).optional().nullable(),
    // Medicare Proof of Delivery: the date the beneficiary received the
    // equipment (YYYY-MM-DD), distinct from the signing date.
    dateReceived: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u, "Must be a YYYY-MM-DD date")
      .optional()
      .nullable(),
    consentEsign: z.literal(true),
    acknowledgedDocumentKeys: z.array(z.string().min(1).max(64)).max(20),
  })
  .strict();

router.post("/patient-packets/sign", signLimiter, async (req, res) => {
  const parsed = signBody.safeParse(req.body ?? {});
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
  const b = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const resolved = await resolveOpenPacket(supabase, b.token);
  if (!resolved.ok) {
    if (resolved.code === "completed") {
      res.status(409).json({ error: "already_completed" });
      return;
    }
    res.status(resolved.code === "not_found" ? 404 : 410).json({
      error: resolved.code,
    });
    return;
  }
  const packet = resolved.packet;

  // Every document in the packet must be acknowledged before signing.
  const { data: docs, error: docsErr } = await supabase
    .schema("resupply")
    .from("patient_packet_documents")
    .select("document_key")
    .eq("packet_id", packet.id);
  if (docsErr) throw docsErr;
  const requiredKeys = new Set((docs ?? []).map((d) => d.document_key));
  const ackedKeys = new Set(b.acknowledgedDocumentKeys);
  const missing = [...requiredKeys].filter((k) => !ackedKeys.has(k));
  if (missing.length > 0) {
    res.status(400).json({ error: "documents_not_acknowledged", missing });
    return;
  }

  // Medicare: a representative signing on the beneficiary's behalf must
  // record the reason the beneficiary could not sign.
  const signerReason = b.signerReason?.trim() || null;
  if (b.signerRelationship !== "self" && !signerReason) {
    res.status(400).json({ error: "signer_reason_required" });
    return;
  }
  // Medicare Proof of Delivery requires the date the equipment was
  // received whenever the POD is part of the packet.
  if (packetRequiresDateReceived([...requiredKeys]) && !b.dateReceived) {
    res.status(400).json({ error: "date_received_required" });
    return;
  }

  const nowIso = new Date().toISOString();
  const ip = req.ip ?? null;
  const userAgent = (req.get("user-agent") ?? "").slice(0, 500) || null;

  const { error: sigErr } = await supabase
    .schema("resupply")
    .from("patient_packet_signatures")
    .insert({
      packet_id: packet.id,
      signer_name: b.signerName,
      signer_relationship: b.signerRelationship,
      signature_image: b.signatureImage ?? null,
      consent_esign: true,
      acknowledged_document_keys: [...requiredKeys],
      signed_at: nowIso,
      signer_ip: ip,
      signer_user_agent: userAgent,
      signer_reason: signerReason,
      date_received: b.dateReceived ?? null,
    });
  if (sigErr) throw sigErr;

  // Mark documents acknowledged.
  const { error: docUpdErr } = await supabase
    .schema("resupply")
    .from("patient_packet_documents")
    .update({ acknowledged: true, acknowledged_at: nowIso })
    .eq("packet_id", packet.id);
  if (docUpdErr) throw docUpdErr;

  // Finalize: complete + invalidate the link (bump version high).
  const { data: finalized, error: finErr } = await supabase
    .schema("resupply")
    .from("patient_packets")
    .update({
      status: "completed",
      completed_at: nowIso,
      link_version: packet.link_version + 1,
      updated_at: nowIso,
    })
    .eq("id", packet.id)
    .eq("status", packet.status) // optimistic guard against a double-submit
    .select("id");
  if (finErr) throw finErr;
  if (!finalized || finalized.length === 0) {
    res.status(409).json({ error: "concurrent_modification" });
    return;
  }

  await logAudit({
    action: "patient_packet.signed",
    targetTable: "patient_packets",
    targetId: packet.id,
    metadata: {
      document_count: requiredKeys.size,
      has_drawn_signature: Boolean(b.signatureImage),
      relationship: b.signerRelationship,
    },
    ip,
    userAgent,
  }).catch((err) => {
    logger.warn({ err }, "patient_packet.signed audit write failed");
  });

  res.json({ status: "completed", completedAt: nowIso });
});

export default router;
