// /admin/provider-portal/* — employee console for the provider
// e-signature portal.
//
// Two halves:
//
//   Accounts — invite a provider into the portal (mints a
//   resupply_auth.users row + emails a "set your password" link, then
//   links it to the resupply.providers record), enable/disable access,
//   resend the invite.
//
//   Signature requests — stage the documents a provider must e-sign,
//   track the post-signature fulfillment lifecycle (ready-to-print →
//   returned-signed → attached-to-chart → released), and print the
//   tamper-evident signature audit log (per document or per provider)
//   to send to a payer / Medicare.
//
// Gated by requirePermission("provider_portal.manage") (admins + CSRs).
// Every state change appends to the hash-chained provider_signature_events
// log via appendSignatureEvent.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";
import {
  bufferToHexBytea,
  issueToken,
  renderPasswordResetEmail,
} from "@workspace/resupply-auth";

import { getAuthDeps } from "../../lib/auth-deps";
import { logger } from "../../lib/logger";
import {
  appendSignatureEvent,
  verifySignatureChain,
  type ChainEvent,
} from "../../lib/provider-portal/signature-events";
import {
  renderSignatureLogPdf,
  type SignatureLogItem,
} from "../../lib/provider-portal/signature-log-pdf";
import { requirePermission } from "../../middlewares/requireAdmin";
import {
  adminReadRateLimiter,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";

const router: IRouter = Router();

const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function practiceName(): string {
  return (
    process.env.RESUPPLY_PRACTICE_NAME?.trim() || "Penn Home Medical Supply"
  );
}

// ── Accounts ──────────────────────────────────────────────────────

router.get(
  "/admin/provider-portal/accounts",
  adminReadRateLimiter,
  requirePermission("provider_portal.manage"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select(
        "id, provider_id, email_lower, status, mfa_enrolled_at, last_login_at, invited_by_email, created_at, providers(legal_name, npi, practice_name)",
      )
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    res.json({
      accounts: (data ?? []).map((r) => {
        const p = (r as { providers?: unknown }).providers as {
          legal_name?: string | null;
          npi?: string | null;
          practice_name?: string | null;
        } | null;
        return {
          id: r.id,
          providerId: r.provider_id,
          email: r.email_lower,
          status: r.status,
          mfaEnrolled: r.mfa_enrolled_at != null,
          lastLoginAt: r.last_login_at,
          invitedByEmail: r.invited_by_email,
          createdAt: r.created_at,
          providerName: p?.legal_name ?? null,
          providerNpi: p?.npi ?? null,
          practiceName: p?.practice_name ?? null,
        };
      }),
    });
  },
);

const inviteBody = z
  .object({
    providerId: z.string().uuid(),
    email: z.string().trim().email().max(254).optional(),
  })
  .strict();

/** Mint/refresh an auth user for the provider and email a set-password
 *  link. Returns the auth user id + whether the email was delivered. */
async function inviteProviderUser(
  emailLower: string,
  displayName: string | null,
): Promise<{ authUserId: string; emailSent: boolean; inviteLink: string }> {
  const supabase = getSupabaseServiceRoleClient();
  const deps = getAuthDeps();
  const now = new Date();
  const nowIso = now.toISOString();

  // Resolve / create the auth user. Providers are role 'customer' (the
  // lowest privilege — they can never pass requireAdmin); their
  // portal access comes purely from the provider_portal_accounts link.
  const { data: existing, error: readErr } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, status")
    .eq("email_lower", emailLower)
    .limit(1)
    .maybeSingle<{ id: string; status: string }>();
  if (readErr) throw readErr;

  let authUserId: string;
  if (existing) {
    // Re-activate a revoked row; never touch the role (could be staff).
    if (existing.status === "revoked") {
      const { error: reactivateErr } = await supabase
        .schema("resupply_auth")
        .from("users")
        .update({ status: "invited", updated_at: nowIso })
        .eq("id", existing.id);
      if (reactivateErr) throw reactivateErr;
    }
    authUserId = existing.id;
  } else {
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply_auth")
      .from("users")
      .insert({
        email_lower: emailLower,
        display_name: displayName,
        role: "customer",
        status: "invited",
      })
      .select("id")
      .single<{ id: string }>();
    if (insErr) throw insErr;
    authUserId = inserted.id;
  }

  // Issue a 7-day password_reset token and email the set-password link.
  const token = issueToken();
  const expiresAt = new Date(now.getTime() + INVITE_TOKEN_TTL_MS);
  const { error: tokErr } = await supabase
    .schema("resupply_auth")
    .from("email_tokens")
    .insert({
      token_hash: bufferToHexBytea(token.hash),
      user_id: authUserId,
      purpose: "password_reset",
      expires_at: expiresAt.toISOString(),
    });
  if (tokErr) throw tokErr;

  const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
  const inviteLink = `${baseUrl}/reset-password?token=${encodeURIComponent(token.raw)}`;
  const rendered = renderPasswordResetEmail(
    { productName: "PennFit Provider Portal", publicBaseUrl: baseUrl },
    token.raw,
    INVITE_TOKEN_TTL_MS,
  );
  let emailSent = false;
  try {
    await deps.email({
      to: emailLower,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    });
    emailSent = true;
  } catch {
    // EmailSender logs its own failures; surface the link for
    // out-of-band delivery.
  }
  return { authUserId, emailSent, inviteLink };
}

router.post(
  "/admin/provider-portal/accounts/invite",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const parsed = inviteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: provider, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id, legal_name, email")
      .eq("id", parsed.data.providerId)
      .limit(1)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!provider) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }
    const email = (parsed.data.email ?? provider.email ?? "")
      .trim()
      .toLowerCase();
    if (!email) {
      res.status(400).json({
        error: "email_required",
        message:
          "This provider has no email on file. Add one to the provider record or supply it here.",
      });
      return;
    }

    const { authUserId, emailSent, inviteLink } = await inviteProviderUser(
      email,
      (provider.legal_name as string | null) ?? null,
    );

    // Link (or refresh) the portal account.
    const { data: existingAccount } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("id")
      .eq("provider_id", parsed.data.providerId)
      .limit(1)
      .maybeSingle();
    const nowIso = new Date().toISOString();
    if (existingAccount) {
      const { error: accountUpdateErr } = await supabase
        .schema("resupply")
        .from("provider_portal_accounts")
        .update({
          auth_user_id: authUserId,
          email_lower: email,
          status: "invited",
          disabled_at: null,
          disabled_by_email: null,
          updated_at: nowIso,
        })
        .eq("id", existingAccount.id);
      if (accountUpdateErr) throw accountUpdateErr;
    } else {
      const { error: accountInsertErr } = await supabase
        .schema("resupply")
        .from("provider_portal_accounts")
        .insert({
          auth_user_id: authUserId,
          provider_id: parsed.data.providerId,
          email_lower: email,
          status: "invited",
          invited_by_email: req.adminEmail ?? null,
        });
      if (accountInsertErr) throw accountInsertErr;
    }

    res.json({ ok: true, email, emailSent, inviteLink });
  },
);

const accountIdParam = z.object({ id: z.string().uuid() });

router.post(
  "/admin/provider-portal/accounts/:id/disable",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = accountIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    const { data, error } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({
        status: "disabled",
        disabled_at: nowIso,
        disabled_by_email: req.adminEmail ?? null,
        updated_at: nowIso,
      })
      .eq("id", params.data.id)
      .select("auth_user_id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // Revoke any live sessions so an open provider tab loses access.
    // Security-relevant: a silent failure would leave a disabled
    // provider's sessions usable — surface it as a 500 so the admin
    // re-runs disable (idempotent).
    const { error: revokeErr } = await supabase
      .schema("resupply_auth")
      .from("sessions")
      .update({ revoked_at: nowIso })
      .eq("user_id", data.auth_user_id)
      .is("revoked_at", null);
    if (revokeErr) throw revokeErr;
    res.json({ ok: true });
  },
);

router.post(
  "/admin/provider-portal/accounts/:id/enable",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = accountIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const nowIso = new Date().toISOString();
    // Re-enable to 'active' if MFA already enrolled, else 'invited'.
    const { data: acct } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("mfa_enrolled_at")
      .eq("id", params.data.id)
      .maybeSingle();
    const nextStatus = acct?.mfa_enrolled_at ? "active" : "invited";
    const { data, error } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .update({
        status: nextStatus,
        disabled_at: null,
        disabled_by_email: null,
        updated_at: nowIso,
      })
      .eq("id", params.data.id)
      .select("id")
      .maybeSingle();
    if (error) throw error;
    if (!data) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ ok: true, status: nextStatus });
  },
);

// ── Signature requests ────────────────────────────────────────────

const listQuery = z.object({
  status: z.enum(["pending", "signed", "declined", "void", "all"]).optional(),
  providerId: z.string().uuid().optional(),
});

router.get(
  "/admin/provider-portal/signature-requests",
  adminReadRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select(
        "id, provider_id, subject_type, subject_id, title, patient_name_snapshot, status, created_at, signed_at, expires_at, ready_to_print_at, returned_signed_at, attached_to_chart_at, released_at, release_kind, providers(legal_name, npi)",
      )
      .order("created_at", { ascending: false })
      .limit(300);
    const status = parsed.data.status ?? "all";
    if (status !== "all") query = query.eq("status", status);
    if (parsed.data.providerId) {
      query = query.eq("provider_id", parsed.data.providerId);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({
      requests: (data ?? []).map((r) => {
        const p = (r as { providers?: unknown }).providers as {
          legal_name?: string | null;
          npi?: string | null;
        } | null;
        return {
          id: r.id,
          providerId: r.provider_id,
          providerName: p?.legal_name ?? null,
          providerNpi: p?.npi ?? null,
          subjectType: r.subject_type,
          subjectId: r.subject_id,
          title: r.title,
          patientName: r.patient_name_snapshot,
          status: r.status,
          createdAt: r.created_at,
          signedAt: r.signed_at,
          expiresAt: r.expires_at,
          readyToPrintAt: r.ready_to_print_at,
          returnedSignedAt: r.returned_signed_at,
          attachedToChartAt: r.attached_to_chart_at,
          releasedAt: r.released_at,
          releaseKind: r.release_kind,
        };
      }),
    });
  },
);

const createBody = z
  .object({
    providerId: z.string().uuid(),
    subjectType: z.enum([
      "prescription",
      "prescription_packet",
      "order",
      "claim",
      "cmn",
      "dwo",
      "swo",
      "document",
    ]),
    subjectId: z.string().trim().max(120).optional(),
    title: z.string().trim().min(2).max(200),
    patientId: z.string().uuid().optional(),
    patientName: z.string().trim().max(160).optional(),
    detail: z.record(z.string(), z.unknown()).optional(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

router.post(
  "/admin/provider-portal/signature-requests",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: "invalid_body", issues: parsed.error.issues });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: provider, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("id")
      .eq("id", parsed.data.providerId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!provider) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }

    // Snapshot the patient name (so the queue + certificate render
    // without re-joining live PHI). Prefer the explicit value; else
    // best-effort decode from the patient row.
    let patientName = parsed.data.patientName ?? null;
    if (!patientName && parsed.data.patientId) {
      const { data: pt } = await supabase
        .schema("resupply")
        .from("patients")
        .select("legal_first_name, legal_last_name")
        .eq("id", parsed.data.patientId)
        .maybeSingle();
      if (pt) {
        patientName =
          [pt.legal_first_name, pt.legal_last_name].filter(Boolean).join(" ") ||
          null;
      }
    }

    // Link an existing portal account for this provider (if any).
    const { data: account } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("id")
      .eq("provider_id", parsed.data.providerId)
      .maybeSingle();

    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .insert({
        provider_id: parsed.data.providerId,
        account_id: account?.id ?? null,
        patient_id: parsed.data.patientId ?? null,
        subject_type: parsed.data.subjectType,
        subject_id: parsed.data.subjectId ?? null,
        title: parsed.data.title,
        patient_name_snapshot: patientName,
        detail: parsed.data.detail ?? {},
        status: "pending",
        expires_at: parsed.data.expiresAt ?? null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;

    await appendSignatureEvent({
      requestId: inserted.id,
      eventType: "created",
      actorKind: "employee",
      actorEmail: req.adminEmail ?? null,
      payload: {
        subjectType: parsed.data.subjectType,
        subjectId: parsed.data.subjectId ?? null,
        title: parsed.data.title,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });

    res.status(201).json({ ok: true, id: inserted.id });
  },
);

const reqIdParam = z.object({ id: z.string().uuid() });

/** Load the events for a request and report chain integrity. */
async function loadEvents(
  requestId: string,
): Promise<{ events: ChainEvent[]; rows: Array<Record<string, unknown>> }> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .schema("resupply")
    .from("provider_signature_events")
    .select(
      "seq, event_type, actor_kind, actor_email, payload, ip, user_agent, prev_hash, event_hash, occurred_at",
    )
    .eq("request_id", requestId)
    .order("seq", { ascending: true });
  if (error) throw error;
  const rows = data ?? [];
  const events: ChainEvent[] = rows.map((r) => ({
    seq: r.seq as number,
    prevHash: r.prev_hash as string,
    eventHash: r.event_hash as string,
    core: {
      requestId,
      seq: r.seq as number,
      eventType: r.event_type as ChainEvent["core"]["eventType"],
      actorKind: r.actor_kind as ChainEvent["core"]["actorKind"],
      actorEmail: (r.actor_email as string | null) ?? null,
      payload: (r.payload as Record<string, unknown>) ?? {},
      ip: (r.ip as string | null) ?? null,
      userAgent: (r.user_agent as string | null) ?? null,
      occurredAt: r.occurred_at as string,
    },
  }));
  return { events, rows };
}

router.get(
  "/admin/provider-portal/signature-requests/:id",
  adminReadRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = reqIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("*, providers(legal_name, npi, practice_name)")
      .eq("id", params.data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const { events, rows } = await loadEvents(params.data.id);
    const chain = verifySignatureChain(events);
    res.json({
      request: row,
      chainOk: chain.ok,
      events: rows.map((r) => ({
        seq: r.seq,
        eventType: r.event_type,
        actorKind: r.actor_kind,
        actorEmail: r.actor_email,
        occurredAt: r.occurred_at,
        eventHash: r.event_hash,
      })),
    });
  },
);

/** Shared helper for the simple employee state-stamp actions. */
async function stampAction(
  req: Request,
  res: Response,
  opts: {
    requireStatus?: string;
    update: Record<string, unknown>;
    eventType: Parameters<typeof appendSignatureEvent>[0]["eventType"];
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const params = reqIdParam.safeParse(req.params);
  if (!params.success) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: row, error } = await supabase
    .schema("resupply")
    .from("provider_signature_requests")
    .select("id, status")
    .eq("id", params.data.id)
    .maybeSingle();
  if (error) throw error;
  if (!row) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (opts.requireStatus && row.status !== opts.requireStatus) {
    res.status(409).json({
      error: "wrong_status",
      message: `This action requires status '${opts.requireStatus}', but the document is '${String(row.status)}'.`,
    });
    return;
  }
  const { data: updated, error: updErr } = await supabase
    .schema("resupply")
    .from("provider_signature_requests")
    .update({ ...opts.update, updated_at: new Date().toISOString() })
    .eq("id", params.data.id)
    .eq("status", opts.requireStatus ?? String(row.status))
    .select("id")
    .limit(1)
    .maybeSingle();
  if (updErr) throw updErr;
  if (!updated) {
    res.status(409).json({
      error: "wrong_status",
      message: "This document’s status changed. Please refresh and try again.",
    });
    return;
  }
  await appendSignatureEvent({
    requestId: params.data.id,
    eventType: opts.eventType,
    actorKind: "employee",
    actorEmail: req.adminEmail ?? null,
    payload: opts.payload ?? {},
    ip: req.ip ?? null,
    userAgent: req.get("user-agent") ?? null,
  });
  res.json({ ok: true });
}

router.post(
  "/admin/provider-portal/signature-requests/:id/void",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    await stampAction(req, res, {
      requireStatus: "pending",
      update: { status: "void" },
      eventType: "voided",
    });
  },
);

router.post(
  "/admin/provider-portal/signature-requests/:id/ready-to-print",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    await stampAction(req, res, {
      requireStatus: "signed",
      update: {
        ready_to_print_at: new Date().toISOString(),
        ready_to_print_by_email: req.adminEmail ?? null,
      },
      eventType: "ready_to_print",
    });
  },
);

router.post(
  "/admin/provider-portal/signature-requests/:id/returned-signed",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    await stampAction(req, res, {
      requireStatus: "signed",
      update: {
        returned_signed_at: new Date().toISOString(),
        returned_signed_by_email: req.adminEmail ?? null,
      },
      eventType: "returned_signed",
    });
  },
);

router.post(
  "/admin/provider-portal/signature-requests/:id/attach-to-chart",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    await stampAction(req, res, {
      requireStatus: "signed",
      update: {
        attached_to_chart_at: new Date().toISOString(),
        attached_to_chart_by_email: req.adminEmail ?? null,
      },
      eventType: "attached_to_chart",
    });
  },
);

const releaseBody = z
  .object({
    releaseKind: z.enum(["claim", "item"]),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

router.post(
  "/admin/provider-portal/signature-requests/:id/release",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const parsed = releaseBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    await stampAction(req, res, {
      requireStatus: "signed",
      update: {
        released_at: new Date().toISOString(),
        released_by_email: req.adminEmail ?? null,
        release_kind: parsed.data.releaseKind,
        release_note: parsed.data.note ?? null,
      },
      eventType: "released",
      payload: {
        releaseKind: parsed.data.releaseKind,
        note: parsed.data.note ?? null,
      },
    });
  },
);

router.post(
  "/admin/provider-portal/signature-requests/:id/remind",
  adminWriteRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = reqIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("id, status, title, account_id, provider_id")
      .eq("id", params.data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (row.status !== "pending") {
      res.status(409).json({ error: "not_pending" });
      return;
    }
    // Best-effort reminder email to the linked provider account.
    let emailSent = false;
    const { data: account } = await supabase
      .schema("resupply")
      .from("provider_portal_accounts")
      .select("email_lower")
      .eq("provider_id", row.provider_id)
      .maybeSingle();
    if (account?.email_lower) {
      const deps = getAuthDeps();
      const baseUrl = deps.publicBaseUrl.replace(/\/$/, "");
      try {
        await deps.email({
          to: account.email_lower,
          subject: `Action needed: a document is awaiting your signature`,
          html: `<p>You have a document awaiting your electronic signature in the ${practiceName()} provider portal.</p><p><a href="${baseUrl}/provider/sign-in">Sign in to review and sign</a></p>`,
          text: `You have a document awaiting your electronic signature in the ${practiceName()} provider portal. Sign in at ${baseUrl}/provider/sign-in`,
        });
        emailSent = true;
      } catch (err) {
        logger.warn({ err }, "provider signature reminder email failed");
      }
    }
    await appendSignatureEvent({
      requestId: params.data.id,
      eventType: "reminded",
      actorKind: "employee",
      actorEmail: req.adminEmail ?? null,
      payload: { emailSent },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    });
    res.json({ ok: true, emailSent });
  },
);

// ── Signature-log / certificate PDFs ──────────────────────────────

/** Build a SignatureLogItem from a request row + its event chain. */
async function buildLogItem(
  row: Record<string, unknown>,
): Promise<SignatureLogItem> {
  const { events, rows } = await loadEvents(row.id as string);
  const chain = verifySignatureChain(events);
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
  return {
    title: row.title as string,
    subjectLabel:
      SUBJECT_LABELS[row.subject_type as string] ??
      (row.subject_type as string),
    patientName: (row.patient_name_snapshot as string | null) ?? null,
    status: row.status as string,
    signedAt: (row.signed_at as string | null) ?? null,
    signerName: (row.signer_name as string | null) ?? null,
    signerTitle: (row.signer_title as string | null) ?? null,
    signerNpi: (row.signer_npi as string | null) ?? null,
    signatureStatement: (row.signature_statement as string | null) ?? null,
    signerIp: (row.signer_ip as string | null) ?? null,
    consentEsign: Boolean(row.consent_esign),
    chainOk: chain.ok,
    events: rows.map((r) => ({
      seq: r.seq as number,
      eventType: r.event_type as string,
      actorKind: r.actor_kind as string,
      actorEmail: (r.actor_email as string | null) ?? null,
      occurredAt: r.occurred_at as string,
      eventHash: r.event_hash as string,
    })),
  };
}

router.get(
  "/admin/provider-portal/signature-requests/:id/certificate.pdf",
  adminReadRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = reqIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("*, providers(legal_name, npi, practice_name)")
      .eq("id", params.data.id)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const provider = (row as { providers?: unknown }).providers as {
      legal_name?: string | null;
      npi?: string | null;
      practice_name?: string | null;
    } | null;
    const pdf = await renderSignatureLogPdf({
      scope: "certificate",
      practiceName: practiceName(),
      provider: {
        legalName: provider?.legal_name ?? "Unknown provider",
        npi: provider?.npi ?? null,
        practiceName: provider?.practice_name ?? null,
      },
      generatedOn: new Date(),
      generatedByEmail: req.adminEmail ?? null,
      items: [await buildLogItem(row)],
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="signature-certificate-${params.data.id}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  },
);

const providerIdParam = z.object({ providerId: z.string().uuid() });

router.get(
  "/admin/provider-portal/providers/:providerId/signature-log.pdf",
  adminReadRateLimiter,
  requirePermission("provider_portal.manage"),
  async (req, res) => {
    const params = providerIdParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: provider, error: pErr } = await supabase
      .schema("resupply")
      .from("providers")
      .select("legal_name, npi, practice_name")
      .eq("id", params.data.providerId)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!provider) {
      res.status(404).json({ error: "provider_not_found" });
      return;
    }
    // Every SIGNED document for this provider, newest first.
    const { data: rows, error } = await supabase
      .schema("resupply")
      .from("provider_signature_requests")
      .select("*")
      .eq("provider_id", params.data.providerId)
      .eq("status", "signed")
      .order("signed_at", { ascending: false })
      .limit(200);
    if (error) throw error;
    const items: SignatureLogItem[] = [];
    for (const row of rows ?? []) {
      items.push(await buildLogItem(row));
    }
    const pdf = await renderSignatureLogPdf({
      scope: "log",
      practiceName: practiceName(),
      provider: {
        legalName: provider.legal_name ?? "Unknown provider",
        npi: provider.npi ?? null,
        practiceName: provider.practice_name ?? null,
      },
      generatedOn: new Date(),
      generatedByEmail: req.adminEmail ?? null,
      items,
    });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `inline; filename="signature-log-${params.data.providerId}.pdf"`,
    );
    res.setHeader("Cache-Control", "no-store");
    res.send(pdf);
  },
);

export default router;
