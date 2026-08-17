// /api/provider/referrals/* — the referring provider's side of the portal.
//
//   GET    /api/provider/referrals/destinations   — DMEs this provider may refer to
//   GET    /api/provider/referrals                — their own referrals, across DMEs
//   POST   /api/provider/referrals                — start one
//   GET    /api/provider/referrals/:id            — one referral + timeline + thread
//   PATCH  /api/provider/referrals/:id            — edit while still a draft
//   POST   /api/provider/referrals/:id/cancel     — withdraw it
//   POST   /api/provider/referrals/:id/messages   — message the DME
//   POST   /api/provider/referrals/:id/documents  — attach paperwork
//   DELETE /api/provider/referrals/:id/documents/:docId
//
// The clinical half of the flow — sending the fitting, reading the
// recommendation, approving a mask, signing, and submitting — lives in
// referral-workflow.ts. Same router tree, split only because one file
// covering both would be long enough that neither half reads well.
//
// THE ISOLATION PRIMITIVE — read this before changing any query here
// -----------------------------------------------------------------
// Every other tenant-scoped route in this codebase gets its org from the
// request: `req.orgId`, resolved from the host or the admin's session.
// This tree cannot work that way, and that difference is the single
// easiest thing to get wrong here.
//
// A referring physician is a CROSS-ORG identity (migration 0342:
// "providers are cross-org global directory rows") precisely because they
// refer to several DMEs. So a referral's tenant is not a property of the
// request — it is a property of the ROW. The rule is:
//
//   * WHICH rows this provider may touch is decided by their own
//     identity: `referrals.provider_id === req.providerAccount.providerId`,
//     checked on every single read and write. That is the authorization.
//   * WHICH tenant client to use is then read off the row's `org_id`.
//     That is the data path.
//
// Creating a referral is the one case with no row to read from yet, so
// the destination org comes from an ACTIVE `provider_dme_links` row for
// this provider. Without that link a provider cannot direct a referral at
// a tenant — which is what stops a global provider directory from
// becoming a way to push unsolicited PHI into any workspace on the
// platform.
//
// `attachProviderOrgId` is therefore deliberately NOT in these chains:
// pinning the host's tenant onto req.orgId would be actively misleading
// here, because the tenant that matters is the destination DME, which has
// nothing to do with which domain the provider signed in on.
//
// PHI: referrals carry demographics and insurance identifiers typed by
// the provider before a chart exists, plus a free-text clinical thread.
// Log lines carry ids, codes, and counts only — never a name, never a
// message body, never a document's contents.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import {
  requireProvider,
  requireProviderMfaEnrolled,
} from "../../middlewares/requireProvider";
import { providerPortalRateLimiter } from "./shared";
import {
  asOrgId,
  loadReferralForProvider,
  mapReferralDetail,
  mapReferralSummary,
  recordReferralEvent,
  type ReferralRow,
} from "./referral-shared.js";

const router: IRouter = Router();

const uuid = z.string().trim().uuid();

const patientBody = z
  .object({
    firstName: z.string().trim().min(1).max(120),
    lastName: z.string().trim().min(1).max(120),
    dob: z.string().date().nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9]\d{7,14}$/, "Use E.164 format, e.g. +14155550123")
      .nullable()
      .optional(),
    sex: z.enum(["female", "male", "other", "unknown"]).nullable().optional(),
    address: z
      .object({
        line1: z.string().trim().max(200).optional(),
        line2: z.string().trim().max(200).optional(),
        city: z.string().trim().max(120).optional(),
        state: z.string().trim().max(2).optional(),
        postalCode: z.string().trim().max(20).optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

const insuranceBody = z
  .object({
    payerName: z.string().trim().max(200).nullable().optional(),
    memberId: z.string().trim().max(120).nullable().optional(),
    groupNumber: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

const clinicalBody = z
  .object({
    therapyMode: z.enum(["pap", "niv"]).optional(),
    prescribedPressureCmH2O: z.number().min(0).max(40).nullable().optional(),
    diagnosisCode: z.string().trim().max(32).nullable().optional(),
    clinicalNotes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

const createBody = z
  .object({
    dmeLinkId: uuid,
    routedToLocationId: uuid.nullable().optional(),
    entryPoint: z.enum(["remote_link", "in_office", "kiosk_qr"]).optional(),
    patient: patientBody,
    insurance: insuranceBody.optional(),
    clinical: clinicalBody.optional(),
    adherenceUpdatesAuthorized: z.boolean().optional(),
  })
  .strict();

const patchBody = z
  .object({
    routedToLocationId: uuid.nullable().optional(),
    patient: patientBody.partial().optional(),
    insurance: insuranceBody.optional(),
    clinical: clinicalBody.optional(),
    adherenceUpdatesAuthorized: z.boolean().optional(),
  })
  .strict();

const messageBody = z
  .object({ body: z.string().trim().min(1).max(8000) })
  .strict();

const documentBody = z
  .object({
    docType: z.enum([
      "prescription",
      "sleep_study",
      "demographics",
      "insurance",
      "chart_note",
      "face_sheet",
      "other",
    ]),
    fileName: z.string().trim().min(1).max(255),
    storageObjectPath: z.string().trim().min(1).max(1000),
    contentType: z.string().trim().min(1).max(120),
    sizeBytes: z
      .number()
      .int()
      .min(1)
      .max(26_214_400, "Attachments are capped at 25 MB."),
    notes: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();

/** Statuses a provider may still edit or withdraw. */
const PROVIDER_EDITABLE = new Set([
  "draft",
  "awaiting_fitting",
  "fitting_complete",
  "awaiting_signature",
  "signed",
]);

const gate = [
  ...requireProvider,
  requireProviderMfaEnrolled,
  providerPortalRateLimiter,
];

// ── Destinations ─────────────────────────────────────────────────────

router.get(
  "/api/provider/referrals/destinations",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    try {
      const seedOrgId = await resolveSeedOrgId();
      if (!seedOrgId) {
        res.status(500).json({ error: "tenant_context_missing" });
        return;
      }
      // raw-org-scope-exempt: this is THE cross-tenant read, and it is the
      // point of the table. A provider refers to several DMEs, so their
      // destination picker has to span tenants. It is safely scoped by the
      // provider's own authenticated identity — `provider_id` is taken from
      // the session's provider account, never from the request — and it
      // returns nothing but the tenants that have explicitly invited this
      // provider. No PHI is reachable through it.
      const { data, error } = await getOrgScopedClient(seedOrgId)
        .raw()
        .schema("resupply")
        .from("provider_dme_links")
        .select(
          "id, org_id, display_name, default_location_id, status, organizations(name)",
        )
        .eq("provider_id", account.providerId)
        .eq("status", "active")
        .limit(200);
      if (error) {
        res.status(500).json({ error: "query_failed" });
        return;
      }
      res.json({
        destinations: (data ?? []).map((row) => {
          const r = row as Record<string, unknown>;
          const org = r.organizations as { name?: string } | null;
          return {
            dmeLinkId: String(r.id),
            name: (r.display_name as string | null) ?? org?.name ?? "DME",
            defaultLocationId: (r.default_location_id as string | null) ?? null,
          };
        }),
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)) },
        "provider referral destinations lookup failed",
      );
      res.status(500).json({ error: "query_failed" });
    }
  },
);

// ── List ─────────────────────────────────────────────────────────────

router.get("/api/provider/referrals", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const status = z
    .enum([
      "draft",
      "awaiting_fitting",
      "fitting_complete",
      "awaiting_signature",
      "signed",
      "submitted",
      "accepted",
      "in_progress",
      "dispensed",
      "declined",
      "cancelled",
    ])
    .optional()
    .safeParse(req.query.status);

  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    // raw-org-scope-exempt: a provider's own referrals span every DME
    // they refer to, so this list is keyed by the session's provider id
    // rather than by one tenant. `provider_id` comes from the
    // authenticated account and can never be supplied by the caller.
    let query = getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("referrals")
      .select(
        "id, org_id, status, patient_first_name, patient_last_name, patient_dob, routed_to_location_id, entry_point, therapy_mode, fit_session_id, approved_mask_model_id, provider_unread_count, submitted_at, accepted_at, declined_at, declined_reason, dispensed_at, created_at, updated_at, organizations(name)",
      )
      .eq("provider_id", account.providerId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (status.success && status.data) {
      query = query.eq("status", status.data);
    }
    const { data, error } = await query;
    if (error) {
      res.status(500).json({ error: "query_failed" });
      return;
    }
    res.json({
      referrals: (data ?? []).map((row) =>
        mapReferralSummary(row as unknown as ReferralRow),
      ),
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "provider referral list failed",
    );
    res.status(500).json({ error: "query_failed" });
  }
});

// ── Create ───────────────────────────────────────────────────────────

router.post("/api/provider/referrals", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const body = createBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: body.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  try {
    const seedOrgId = await resolveSeedOrgId();
    if (!seedOrgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }

    // The destination tenant comes from an ACTIVE link OWNED BY THIS
    // PROVIDER — never from the request body's own claim about a tenant.
    // This is the check that keeps the cross-org provider directory from
    // being a way to push PHI into an arbitrary workspace.
    //
    // raw-org-scope-exempt: resolving which tenant to write to is by
    // definition a cross-tenant read; it is constrained to this
    // provider's own links.
    const { data: link, error: linkError } = await getOrgScopedClient(seedOrgId)
      .raw()
      .schema("resupply")
      .from("provider_dme_links")
      .select("id, org_id, default_location_id, status")
      .eq("id", body.data.dmeLinkId)
      .eq("provider_id", account.providerId)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();
    if (linkError) {
      res.status(500).json({ error: "query_failed" });
      return;
    }
    if (!link) {
      res.status(403).json({
        error: "destination_not_authorized",
        message:
          "That provider isn't set up to receive referrals from you. Ask " +
          "them to send you an invitation.",
      });
      return;
    }

    // `String(null)` is the string "null", which `getOrgScopedClient`
    // would happily accept and then scope every query to a tenant that
    // does not exist — silently returning empty rather than failing. The
    // column is NOT NULL so this is unreachable today, but this is THE
    // line that decides which tenant a referral is written to, and a
    // silent mis-scope is the worst way for it to go wrong.
    const targetOrgId = asOrgId((link as Record<string, unknown>).org_id);
    if (!targetOrgId) {
      logger.error(
        { event: "referral_link_missing_org", dmeLinkId: body.data.dmeLinkId },
        "provider_dme_links row has no usable org_id",
      );
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(targetOrgId);
    const p = body.data.patient;
    const ins = body.data.insurance ?? {};
    const clin = body.data.clinical ?? {};

    const { data, error } = (await supabase
      .from("referrals")
      .insert({
        provider_id: account.providerId,
        created_by_account_id: account.id,
        created_by_email: account.emailLower,
        routed_to_location_id:
          body.data.routedToLocationId ??
          ((link as Record<string, unknown>).default_location_id as
            | string
            | null) ??
          null,
        patient_first_name: p.firstName,
        patient_last_name: p.lastName,
        patient_dob: p.dob ?? null,
        patient_email: p.email ?? null,
        patient_phone_e164: p.phone ?? null,
        patient_sex: p.sex ?? null,
        patient_address: p.address ?? null,
        insurance_payer_name: ins.payerName ?? null,
        insurance_member_id: ins.memberId ?? null,
        insurance_group_number: ins.groupNumber ?? null,
        entry_point: body.data.entryPoint ?? "remote_link",
        therapy_mode: clin.therapyMode ?? "pap",
        prescribed_pressure_cm_h2o: clin.prescribedPressureCmH2O ?? null,
        diagnosis_code: clin.diagnosisCode ?? null,
        clinical_notes: clin.clinicalNotes ?? null,
        adherence_updates_authorized:
          body.data.adherenceUpdatesAuthorized ?? false,
        status: "draft",
      })
      .select("id")
      .single()) as {
      data: { id: string } | null;
      error: { message: string } | null;
    };

    if (error || !data) {
      logger.warn(
        { event: "referral_create_failed", pgMessage: error?.message },
        "provider referral insert failed",
      );
      res.status(500).json({ error: "insert_failed" });
      return;
    }

    await recordReferralEvent(targetOrgId, data.id, "referral.created", {
      actorKind: "provider",
      actorEmail: account.emailLower,
      detail: { entryPoint: body.data.entryPoint ?? "remote_link" },
    });

    res.status(201).json({ id: data.id, orgId: targetOrgId, status: "draft" });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)) },
      "provider referral create failed",
    );
    res.status(500).json({ error: "insert_failed" });
  }
});

// ── Detail ───────────────────────────────────────────────────────────

router.get("/api/provider/referrals/:id", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const id = uuid.safeParse(req.params.id);
  if (!id.success) {
    res.status(400).json({ error: "invalid_id" });
    return;
  }

  const found = await loadReferralForProvider(account.providerId, id.data);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  const supabase = getOrgScopedClient(found.orgId);

  const [events, messages, documents] = await Promise.all([
    supabase
      .from("referral_events")
      .select("event_type, actor_kind, actor_email, detail, occurred_at")
      .eq("referral_id", id.data)
      .order("occurred_at", { ascending: true })
      .limit(500),
    supabase
      .from("referral_messages")
      .select("id, author_kind, author_email, author_name, body, created_at")
      .eq("referral_id", id.data)
      .order("created_at", { ascending: true })
      .limit(500),
    supabase
      .from("referral_documents")
      .select(
        "id, doc_type, file_name, content_type, size_bytes, uploaded_by_kind, uploaded_by_email, notes, created_at",
      )
      .eq("referral_id", id.data)
      .order("created_at", { ascending: true })
      .limit(200),
  ]);

  // Opening the referral clears the provider's own unread badge. The
  // DME's counter is untouched — each side clears only its own.
  if (found.row.provider_unread_count > 0) {
    await supabase
      .from("referrals")
      .update({ provider_unread_count: 0 })
      .eq("id", id.data);
  }

  res.json(
    mapReferralDetail(found.row, {
      events: rowsOf(events),
      messages: rowsOf(messages),
      documents: rowsOf(documents),
    }),
  );
});

function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = result as { data?: unknown[] | null; error?: unknown };
  return Array.isArray(r?.data) ? (r.data as Record<string, unknown>[]) : [];
}

// ── Edit (draft only) ────────────────────────────────────────────────

router.patch("/api/provider/referrals/:id", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const id = uuid.safeParse(req.params.id);
  const body = patchBody.safeParse(req.body);
  if (!id.success || !body.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const found = await loadReferralForProvider(account.providerId, id.data);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  // Once the DME has it, the provider edits by message rather than by
  // silently rewriting a record the receiving side is already working.
  if (!PROVIDER_EDITABLE.has(found.row.status)) {
    res.status(409).json({
      error: "not_editable",
      message:
        "This referral has already gone to the DME. Send them a message " +
        "with the change instead — editing it now would leave them working " +
        "from something different to what you sent.",
    });
    return;
  }

  const patch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  const b = body.data;
  if (b.routedToLocationId !== undefined) {
    patch.routed_to_location_id = b.routedToLocationId;
  }
  if (b.adherenceUpdatesAuthorized !== undefined) {
    patch.adherence_updates_authorized = b.adherenceUpdatesAuthorized;
  }
  if (b.patient) {
    const p = b.patient;
    if (p.firstName !== undefined) patch.patient_first_name = p.firstName;
    if (p.lastName !== undefined) patch.patient_last_name = p.lastName;
    if (p.dob !== undefined) patch.patient_dob = p.dob;
    if (p.email !== undefined) patch.patient_email = p.email;
    if (p.phone !== undefined) patch.patient_phone_e164 = p.phone;
    if (p.sex !== undefined) patch.patient_sex = p.sex;
    if (p.address !== undefined) patch.patient_address = p.address;
  }
  if (b.insurance) {
    const i = b.insurance;
    if (i.payerName !== undefined) patch.insurance_payer_name = i.payerName;
    if (i.memberId !== undefined) patch.insurance_member_id = i.memberId;
    if (i.groupNumber !== undefined) {
      patch.insurance_group_number = i.groupNumber;
    }
  }
  if (b.clinical) {
    const c = b.clinical;
    if (c.therapyMode !== undefined) patch.therapy_mode = c.therapyMode;
    if (c.prescribedPressureCmH2O !== undefined) {
      patch.prescribed_pressure_cm_h2o = c.prescribedPressureCmH2O;
    }
    if (c.diagnosisCode !== undefined) patch.diagnosis_code = c.diagnosisCode;
    if (c.clinicalNotes !== undefined) patch.clinical_notes = c.clinicalNotes;
  }

  const { error } = await getOrgScopedClient(found.orgId)
    .from("referrals")
    .update(patch)
    .eq("id", id.data);
  if (error) {
    res.status(500).json({ error: "update_failed" });
    return;
  }
  res.json({ ok: true });
});

// ── Cancel ───────────────────────────────────────────────────────────

router.post("/api/provider/referrals/:id/cancel", ...gate, async (req, res) => {
  const account = req.providerAccount;
  if (!account) {
    res.status(401).json({ error: "session_required" });
    return;
  }
  const id = uuid.safeParse(req.params.id);
  const reason = z
    .object({ reason: z.string().trim().max(2000).optional() })
    .strict()
    .safeParse(req.body ?? {});
  if (!id.success || !reason.success) {
    res.status(400).json({ error: "invalid_body" });
    return;
  }

  const found = await loadReferralForProvider(account.providerId, id.data);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  if (found.row.status === "dispensed" || found.row.status === "cancelled") {
    res.status(409).json({
      error: "not_cancellable",
      message:
        found.row.status === "dispensed"
          ? "This referral is already dispensed."
          : "This referral is already cancelled.",
    });
    return;
  }

  const { error } = await getOrgScopedClient(found.orgId)
    .from("referrals")
    .update({
      status: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", id.data);
  if (error) {
    res.status(500).json({ error: "update_failed" });
    return;
  }
  await recordReferralEvent(found.orgId, id.data, "referral.cancelled", {
    actorKind: "provider",
    actorEmail: account.emailLower,
    // The reason is free text and could name a patient, so only its
    // presence is recorded here; the text itself goes to the thread.
    detail: { hadReason: Boolean(reason.data.reason) },
  });
  if (reason.data.reason) {
    await postMessage(found.orgId, id.data, {
      authorKind: "provider",
      authorEmail: account.emailLower,
      body: reason.data.reason,
      /** The DME needs to see why it was withdrawn. */
      bumpSide: "dme",
    });
  }
  res.json({ ok: true });
});

// ── Messages ─────────────────────────────────────────────────────────

router.post(
  "/api/provider/referrals/:id/messages",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = messageBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const ok = await postMessage(found.orgId, id.data, {
      authorKind: "provider",
      authorEmail: account.emailLower,
      body: body.data.body,
      bumpSide: "dme",
    });
    if (!ok) {
      res.status(500).json({ error: "insert_failed" });
      return;
    }
    res.status(201).json({ ok: true });
  },
);

// ── Documents ────────────────────────────────────────────────────────

router.post(
  "/api/provider/referrals/:id/documents",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const body = documentBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: body.success
          ? []
          : body.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
      });
      return;
    }
    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const { error } = await getOrgScopedClient(found.orgId)
      .from("referral_documents")
      .insert({
        referral_id: id.data,
        doc_type: body.data.docType,
        file_name: body.data.fileName,
        storage_object_path: body.data.storageObjectPath,
        content_type: body.data.contentType,
        size_bytes: body.data.sizeBytes,
        uploaded_by_kind: "provider",
        uploaded_by_email: account.emailLower,
        notes: body.data.notes ?? null,
      });
    if (error) {
      res.status(500).json({ error: "insert_failed" });
      return;
    }
    await recordReferralEvent(found.orgId, id.data, "document.attached", {
      actorKind: "provider",
      actorEmail: account.emailLower,
      // Type and size only — a file NAME is routinely "Smith, John Rx.pdf".
      detail: { docType: body.data.docType, sizeBytes: body.data.sizeBytes },
    });
    res.status(201).json({ ok: true });
  },
);

router.delete(
  "/api/provider/referrals/:id/documents/:docId",
  ...gate,
  async (req, res) => {
    const account = req.providerAccount;
    if (!account) {
      res.status(401).json({ error: "session_required" });
      return;
    }
    const id = uuid.safeParse(req.params.id);
    const docId = uuid.safeParse(req.params.docId);
    if (!id.success || !docId.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const found = await loadReferralForProvider(account.providerId, id.data);
    if (!found) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // A provider removes their own attachments; a DME's upload is the
    // DME's record and is not theirs to delete.
    const { error } = await getOrgScopedClient(found.orgId)
      .from("referral_documents")
      .delete()
      .eq("id", docId.data)
      .eq("referral_id", id.data)
      .eq("uploaded_by_kind", "provider");
    if (error) {
      res.status(500).json({ error: "delete_failed" });
      return;
    }
    await recordReferralEvent(found.orgId, id.data, "document.removed", {
      actorKind: "provider",
      actorEmail: account.emailLower,
      detail: {},
    });
    res.json({ ok: true });
  },
);

/**
 * Append to the thread and bump the OTHER side's unread counter.
 *
 * The counter lives on `referrals` so each side's list can show a badge
 * without aggregating the message table on every page load. Best-effort
 * on the counter: a missed badge is a cosmetic problem, a lost message
 * is not, so the message insert is what decides the return value.
 */
export async function postMessage(
  orgId: string,
  referralId: string,
  input: {
    authorKind: "provider" | "staff";
    authorEmail: string | null;
    authorName?: string | null;
    body: string;
    bumpSide: "provider" | "dme";
  },
): Promise<boolean> {
  const supabase = getOrgScopedClient(orgId);
  const { error } = await supabase.from("referral_messages").insert({
    referral_id: referralId,
    author_kind: input.authorKind,
    author_email: input.authorEmail,
    author_name: input.authorName ?? null,
    body: input.body,
  });
  if (error) return false;

  try {
    const column =
      input.bumpSide === "provider"
        ? "provider_unread_count"
        : "dme_unread_count";
    const { data } = (await supabase
      .from("referrals")
      .select(column)
      .eq("id", referralId)
      .limit(1)
      .maybeSingle()) as { data: Record<string, number> | null };
    await supabase
      .from("referrals")
      .update({
        [column]: Number(data?.[column] ?? 0) + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", referralId);
  } catch {
    // Badge only.
  }

  await recordReferralEvent(orgId, referralId, "message.sent", {
    actorKind: input.authorKind,
    actorEmail: input.authorEmail,
    // Never the body — this is a clinician-to-clinician thread about a
    // named patient.
    detail: { chars: input.body.length },
  });
  return true;
}

export default router;
