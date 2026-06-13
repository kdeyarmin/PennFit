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

import { logger } from "../../lib/logger";
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
    const { error: loginStampErr } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({ last_login_at: new Date().toISOString() })
      .eq("id", account.id);
    if (loginStampErr) {
      logger.warn(
        { err: loginStampErr, accountId: account.id },
        "provider portal: last-login stamp failed",
      );
    }

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
    // 400 on garbage rather than silently coercing it to "pending" —
    // a typo'd filter returning the wrong queue is confusing to debug.
    const statusParsed = z
      .enum(["pending", "signed", "declined", "all"])
      .optional()
      .safeParse(req.query.status === undefined ? undefined : req.query.status);
    if (!statusParsed.success) {
      res.status(400).json({ error: "invalid_status" });
      return;
    }
    const statusFilter = statusParsed.data ?? "pending";
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

// Drawn-signature cap mirrors the patient-packet signing route: keeps
// the PNG data URL inside the dedicated 1 MB parser mounted for
// /api/provider/queue in app.ts.
const SIGNATURE_MAX_CHARS = 90_000;

const signCaptureFields = {
  consentEsign: z.literal(true),
  signerName: z.string().trim().min(2).max(120),
  signerTitle: z.string().trim().max(120).optional(),
  // Optional drawn signature. Typed name + consent remains the legally
  // sufficient ESIGN capture; the image is supplementary (some payers
  // prefer a wet-look signature on faxed/printed copies).
  signatureImage: z
    .string()
    .max(SIGNATURE_MAX_CHARS)
    .regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/u)
    .optional()
    .nullable(),
};

const signBody = z.object(signCaptureFields).strict();

interface SignCapture {
  signerName: string;
  signerTitle: string | null;
  signatureImage: string | null;
}

/**
 * Execute one signature: the status-guarded row update plus the
 * hash-chained "signed" event. Shared by the single-document route and
 * the batch route so the two captures can never drift. The
 * `.eq("status", "pending")` guard makes concurrent submits safe — the
 * loser sees `not_pending`.
 */
async function executeSignature(opts: {
  accountId: string;
  accountEmail: string;
  requestId: string;
  npi: string | null;
  capture: SignCapture;
  ip: string | null;
  userAgent: string | null;
  viaBatch: boolean;
}): Promise<{ ok: true; signedAt: string } | { ok: false }> {
  const supabase = getSupabaseServiceRoleClient();
  const nowIso = new Date().toISOString();
  const statement = esignStatement(opts.capture.signerName, opts.npi);

  const { data: updated, error: updErr } = await supabase
    .schema("resupply")
    .from("provider_signature_requests")
    .update({
      status: "signed",
      signed_at: nowIso,
      signer_name: opts.capture.signerName,
      signer_title: opts.capture.signerTitle,
      signer_npi: opts.npi,
      consent_esign: true,
      signature_statement: statement,
      // The drawn image is the signed artifact — persisted, NEVER
      // logged, and excluded from the hash-chained event payload.
      signature_image: opts.capture.signatureImage,
      signer_ip: opts.ip,
      signer_user_agent: opts.userAgent,
      account_id: opts.accountId,
      updated_at: nowIso,
    })
    .eq("id", opts.requestId)
    .eq("status", "pending")
    .select("id")
    .limit(1)
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) return { ok: false };

  await appendSignatureEvent({
    requestId: opts.requestId,
    eventType: "signed",
    actorKind: "provider",
    actorAccountId: opts.accountId,
    actorEmail: opts.accountEmail,
    payload: {
      signerName: opts.capture.signerName,
      signerTitle: opts.capture.signerTitle,
      signerNpi: opts.npi,
      consentEsign: true,
      hasDrawnSignature: Boolean(opts.capture.signatureImage),
      ...(opts.viaBatch ? { viaBatch: true } : {}),
      statement,
    },
    ip: opts.ip,
    userAgent: opts.userAgent,
    occurredAt: new Date(nowIso),
  });

  return { ok: true, signedAt: nowIso };
}

async function loadProviderNpi(providerId: string): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: provider } = await supabase
    .schema("resupply")
    .from("providers")
    .select("npi")
    .eq("id", providerId)
    .limit(1)
    .maybeSingle();
  return (provider?.npi as string | undefined) ?? null;
}

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

    const result = await executeSignature({
      accountId: account.id,
      accountEmail: account.emailLower,
      requestId: params.data.id,
      npi: await loadProviderNpi(account.providerId),
      capture: {
        signerName: parsed.data.signerName,
        signerTitle: parsed.data.signerTitle ?? null,
        signatureImage: parsed.data.signatureImage ?? null,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      viaBatch: false,
    });
    if (!result.ok) {
      res.status(409).json({
        error: "not_pending",
        message:
          "This document is no longer awaiting signature. Please refresh and try again.",
      });
      return;
    }

    res.json({ ok: true, status: "signed", signedAt: result.signedAt });
  },
);

// ── Batch signing ─────────────────────────────────────────────────
//
// One typed name + one ESIGN consent (+ one optional drawn signature)
// executed against several selected documents in a single submit. Each
// document is still signed INDIVIDUALLY — its own row update, its own
// statement, its own hash-chained "signed" event (flagged viaBatch) —
// so certificates and audit trails are identical to one-at-a-time
// signing. Ineligible documents (already signed / declined / voided /
// expired / not the provider's) are skipped and reported, never
// silently signed.
const signBatchBody = z
  .object({
    ids: z.array(z.string().uuid()).min(1).max(50),
    ...signCaptureFields,
  })
  .strict();

router.post(
  "/api/provider/queue/sign-batch",
  providerPortalRateLimiter,
  ...requireProvider,
  requireProviderMfaEnrolled,
  async (req, res) => {
    const account = req.providerAccount!;
    const parsed = signBatchBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        message:
          "You must select documents, type your full name, and check the consent box to e-sign.",
      });
      return;
    }
    const ids = [...new Set(parsed.data.ids)];

    const supabase = getSupabaseServiceRoleClient();
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("id, status, expires_at")
      .eq("provider_id", account.providerId)
      .in("id", ids);
    if (error) throw error;
    const byId = new Map((rows ?? []).map((r) => [r.id as string, r]));

    const capture: SignCapture = {
      signerName: parsed.data.signerName,
      signerTitle: parsed.data.signerTitle ?? null,
      signatureImage: parsed.data.signatureImage ?? null,
    };
    const npi = await loadProviderNpi(account.providerId);
    const ip = req.ip ?? null;
    const userAgent = req.get("user-agent") ?? null;

    const signed: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        skipped.push({ id, reason: "not_found" });
        continue;
      }
      if (row.status !== "pending") {
        skipped.push({ id, reason: "not_pending" });
        continue;
      }
      if (row.expires_at && new Date(row.expires_at as string) < new Date()) {
        skipped.push({ id, reason: "expired" });
        continue;
      }
      const result = await executeSignature({
        accountId: account.id,
        accountEmail: account.emailLower,
        requestId: id,
        npi,
        capture,
        ip,
        userAgent,
        viaBatch: true,
      });
      if (result.ok) signed.push(id);
      else skipped.push({ id, reason: "not_pending" });
    }

    res.json({ ok: true, signed, skipped });
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
