// /api/provider/* — authenticated provider e-signature portal.
//
//   GET  /api/provider/me              — identity + enrollment + counts
//   GET  /api/provider/queue           — outstanding documents to sign
//   GET  /api/provider/queue/:id       — one document (records a view)
//   POST /api/provider/queue/:id/sign  — e-sign (typed name + consent)
//   POST /api/provider/queue/:id/decline
//
// requireProvider gates session + CSRF + provider-account resolution.
// The PHI-bearing routes add requireProviderMfaEnrolled so a provider
// who hasn't set up two-factor is bounced to enrollment first. /me is
// reachable without MFA so the SPA can decide where to route.

import { Router, type IRouter, type Request } from "express";
import expressRateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { appendSignatureEvent } from "../../lib/provider-portal/signature-events";
import {
  requireProvider,
  requireProviderMfaEnrolled,
} from "../../middlewares/requireProvider";

const router: IRouter = Router();

// IP-keyed rate limiter in front of every provider data route. The
// /api/provider tree is not covered by the app-level admin/shop limiters,
// so this is its defence-in-depth cap (and the gate static analysis
// recognises — CodeQL js/missing-rate-limiting only credits
// express-rate-limit, not the custom session/CSRF middleware). 300/15min
// per IP is well above any honest provider session but well below a
// scripted flood.
const providerPortalRateLimiter = expressRateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? "0.0.0.0"),
  message: { error: "too_many_requests" },
});

const SUBJECT_LABELS: Record<string, string> = {
  prescription: "Prescription",
  prescription_packet: "Prescription request",
  order: "Order",
  claim: "Insurance claim",
  cmn: "Certificate of Medical Necessity",
  dwo: "Detailed Written Order",
  swo: "Standard Written Order",
  document: "Document",
};

/** Fixed ESIGN attestation, interpolated with the signer's details. */
function esignStatement(name: string, npi: string | null): string {
  const who = npi ? `${name} (NPI ${npi})` : name;
  return (
    `I, ${who}, attest that I am the ordering provider for this patient and ` +
    `that typing my name above constitutes my legal electronic signature on ` +
    `this document — the legal equivalent of my handwritten signature under ` +
    `the federal ESIGN Act and CMS / Medicare e-signature requirements.`
  );
}

router.get(
  "/api/provider/me",
  providerPortalRateLimiter,
  ...requireProvider,
  async (req, res) => {
    const account = req.providerAccount!;
    const supabase = getSupabaseServiceRoleClient();

    // Best-effort last-login stamp.
    await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", account.id);

    const { data: provider, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id, npi, legal_name, practice_name")
      .eq("id", account.providerId)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;

    const { count: pendingCount } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("id", { count: "exact", head: true })
      .eq("provider_id", account.providerId)
      .eq("status", "pending");

    res.json({
      account: {
        id: account.id,
        email: account.emailLower,
        status: account.status,
        mfaEnrolled: account.mfaEnrolledAt != null,
      },
      provider: provider
        ? {
            id: provider.id,
            npi: provider.npi,
            legalName: provider.legal_name,
            practiceName: provider.practice_name,
          }
        : null,
      pendingCount: pendingCount ?? 0,
    });
  },
);

router.get(
  "/api/provider/queue",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  async (req, res) => {
    const account = req.providerAccount!;
    const statusFilter = z
      .enum(["pending", "signed", "declined", "all"])
      .catch("pending")
      .parse(req.query.status);
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select(
        "id, subject_type, subject_id, title, patient_name_snapshot, detail, status, created_at, expires_at, signed_at",
      )
      .eq("provider_id", account.providerId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (statusFilter !== "all") query = query.eq("status", statusFilter);
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      requests: (data ?? []).map((r) => ({
        id: r.id,
        subjectType: r.subject_type,
        subjectLabel: SUBJECT_LABELS[r.subject_type] ?? r.subject_type,
        subjectId: r.subject_id,
        title: r.title,
        patientName: r.patient_name_snapshot,
        detail: r.detail,
        status: r.status,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        signedAt: r.signed_at,
      })),
    });
  },
);

const idParam = z.object({ id: z.string().uuid() });

/** Load a request that belongs to the signed-in provider, or null. */
async function loadOwnRequest(
  providerId: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("provider_signature_requests")
    .select("*")
    .eq("id", id)
    .eq("provider_id", providerId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

router.get(
  "/api/provider/queue/:id",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  async (req, res) => {
    const account = req.providerAccount!;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const row = await loadOwnRequest(account.providerId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Record a view (best-effort; never block the read).
    if (row.status === "pending") {
      await appendSignatureEvent({
        requestId: params.data.id,
        eventType: "viewed",
        actorKind: "provider",
        actorAccountId: account.id,
        actorEmail: account.emailLower,
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch(() => undefined);
    }
    res.json({
      id: row.id,
      subjectType: row.subject_type,
      subjectLabel:
        SUBJECT_LABELS[row.subject_type as string] ?? row.subject_type,
      subjectId: row.subject_id,
      title: row.title,
      patientName: row.patient_name_snapshot,
      detail: row.detail,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      signedAt: row.signed_at,
      signerName: row.signer_name,
      declineReason: row.decline_reason,
    });
  },
);

const signBody = z
  .object({
    consentEsign: z.literal(true),
    signerName: z.string().trim().min(2).max(120),
    signerTitle: z.string().trim().max(120).optional(),
  })
  .strict();

router.post(
  "/api/provider/queue/:id/sign",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  async (req, res) => {
    const account = req.providerAccount!;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = signBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "You must type your full name and check the consent box to e-sign.",
      });
      return;
    }
    const row = await loadOwnRequest(account.providerId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({
        error: "not_pending",
        message: `This document is already ${String(row.status)}.`,
      });
      return;
    }
    if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
      res
        .status(409)
        .json({ error: "expired", message: "This request has expired." });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: provider } = await supabase
      .schema("resupply")
      .from("providers")
      .select("npi")
      .eq("id", account.providerId)
      .limit(1)
      .maybeSingle();
    const npi = (provider?.npi as string | undefined) ?? null;
    const nowIso = new Date().toISOString();
    const statement = esignStatement(parsed.data.signerName, npi);
    const ip = req.ip ?? null;
    const userAgent = req.get("user-agent") ?? null;

    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .update({
        status: "signed",
        signed_at: nowIso,
        signer_name: parsed.data.signerName,
        signer_title: parsed.data.signerTitle ?? null,
        signer_npi: npi,
        consent_esign: true,
        signature_statement: statement,
        signer_ip: ip,
        signer_user_agent: userAgent,
        account_id: account.id,
        updated_at: nowIso,
      })
      .eq("id", params.data.id)
      .eq("status", "pending")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (updErr) throw updErr;
    if (!updated) {
      res.status(409).json({
        error: "not_pending",
        message:
          "This document is no longer awaiting signature. Please refresh and try again.",
      });
      return;
    }

    await appendSignatureEvent({
      requestId: params.data.id,
      eventType: "signed",
      actorKind: "provider",
      actorAccountId: account.id,
      actorEmail: account.emailLower,
      payload: {
        signerName: parsed.data.signerName,
        signerTitle: parsed.data.signerTitle ?? null,
        signerNpi: npi,
        consentEsign: true,
        statement,
      },
      ip,
      userAgent,
      occurredAt: new Date(nowIso),
    });

    res.json({ ok: true, status: "signed", signedAt: nowIso });
  },
);

const declineBody = z
  .object({ reason: z.string().trim().max(500).optional() })
  .strict();

router.post(
  "/api/provider/queue/:id/decline",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  async (req, res) => {
    const account = req.providerAccount!;
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = declineBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const row = await loadOwnRequest(account.providerId, params.data.id);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "not_pending" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .update({
        status: "declined",
        decline_reason: parsed.data.reason ?? null,
        account_id: account.id,
        updated_at: nowIso,
      })
      .eq("id", params.data.id)
      .eq("status", "pending")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (updErr) throw updErr;
    if (!updated) {
      res.status(409).json({ error: "not_pending" });
      return;
    }

    await appendSignatureEvent({
      requestId: params.data.id,
      eventType: "declined",
      actorKind: "provider",
      actorAccountId: account.id,
      actorEmail: account.emailLower,
      payload: { reason: parsed.data.reason ?? null },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      occurredAt: new Date(nowIso),
    });

    res.json({ ok: true, status: "declined" });
  },
);

export default router;
