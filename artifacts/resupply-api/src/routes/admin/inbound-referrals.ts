// /admin/inbound-referrals — CSR triage surface for electronic
// referral orders that landed via Parachute (and, in Phase 4, EHR
// FHIR sources).
//
// Routes
//   GET   /admin/inbound-referrals                — paginated queue
//   GET   /admin/inbound-referrals/:id            — single referral
//   GET   /admin/inbound-referrals/:id/suggested-patients
//                                                 — candidate matches
//   PATCH /admin/inbound-referrals/:id            — status / assignment
//                                                   / notes
//   POST  /admin/inbound-referrals/:id/accept     — one-click promote
//                                                   to patient + episode
//
// Triage state machine (see 0144 migration header):
//   new      -> triaged | accepted | rejected | duplicate | archived
//   triaged  -> accepted | rejected | archived | new
//   accepted -> archived
//   rejected -> archived | new
//   duplicate -> archived
//   archived -> new
//
// The `accepted` transition is gated by `POST /:id/accept` only — the
// PATCH route refuses status='accepted' so callers can't write the
// terminal state without going through the promotion flow.
//
// PHI posture: list / detail responses include legal_first/last_name
// + dob from the parsed referral so CSRs can identify the patient,
// matching the inbound_faxes pattern. The logger receives ids + the
// chosen source slug only, never patient names or HCPCS codes.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { runReferralPreflight } from "../../lib/inbound-dispatchers/preflight";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

type ReferralRow =
  Database["resupply"]["Tables"]["inbound_referral_orders"]["Row"];
type ReferralUpdate =
  Database["resupply"]["Tables"]["inbound_referral_orders"]["Update"];
type ReferralStatus = NonNullable<ReferralRow["triage_status"]>;

const router: IRouter = Router();
const idParam = z.object({ id: z.string().uuid() });

// `accepted` is set ONLY by POST /:id/accept. PATCH callers cannot
// promote a referral that way.
const VALID_PATCH_TRANSITIONS: Record<
  ReferralStatus,
  readonly ReferralStatus[]
> = {
  new: ["triaged", "rejected", "duplicate", "archived"],
  triaged: ["rejected", "archived", "new"],
  accepted: ["archived"],
  rejected: ["archived", "new"],
  duplicate: ["archived"],
  archived: ["new"],
};

const listQuery = z.object({
  status: z
    .enum([
      "new",
      "triaged",
      "accepted",
      "rejected",
      "duplicate",
      "archived",
      "open", // pseudo: not in (archived, rejected, duplicate, accepted)
    ])
    .optional()
    .default("open"),
  source: z.string().regex(/^[a-z0-9_]{2,40}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

const patchBody = z
  .object({
    status: z
      .enum(["new", "triaged", "rejected", "duplicate", "archived"])
      .optional(),
    patientMatchId: z.string().uuid().nullable().optional(),
    providerMatchId: z.string().uuid().nullable().optional(),
    assignedAdminUserId: z.string().uuid().nullable().optional(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
  })
  .strict();

const acceptBody = z
  .object({
    patientId: z.string().uuid(),
    providerId: z.string().uuid().nullable().optional(),
    /**
     * What kind of downstream record the CSR materialised the
     * referral into. Stored opaquely in accepted_order_kind so the
     * UI can deep-link to the correct record type later. Free-form
     * strings allowed (max 40 chars).
     */
    acceptedOrderKind: z.string().trim().min(1).max(40),
    acceptedOrderId: z.string().uuid(),
    notes: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
  })
  .strict();

router.get(
  "/admin/inbound-referrals",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    let query = supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .select(
        "id, source, source_order_id, triage_status, patient_match_id, patient_match_kind, provider_match_id, provider_match_kind, ai_confidence, payer_name, ordering_npi, received_at, assigned_admin_user_id, triaged_at, accepted_at, accepted_order_id, accepted_order_kind, notes",
      )
      .order("received_at", { ascending: false })
      .limit(q.data.limit);

    if (q.data.status === "open") {
      query = query.not("triage_status", "in", "(archived,rejected,duplicate,accepted)");
    } else {
      query = query.eq("triage_status", q.data.status);
    }
    if (q.data.source) {
      query = query.eq("source", q.data.source);
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({
      referrals: (data ?? []).map((r) => ({
        id: r.id,
        source: r.source,
        sourceOrderId: r.source_order_id,
        triageStatus: r.triage_status,
        patientMatchId: r.patient_match_id,
        patientMatchKind: r.patient_match_kind,
        providerMatchId: r.provider_match_id,
        providerMatchKind: r.provider_match_kind,
        aiConfidence: r.ai_confidence,
        payerName: r.payer_name,
        orderingNpi: r.ordering_npi,
        receivedAt: r.received_at,
        triagedAt: r.triaged_at,
        acceptedAt: r.accepted_at,
        acceptedOrderId: r.accepted_order_id,
        acceptedOrderKind: r.accepted_order_kind,
        notes: r.notes,
      })),
    });
  },
);

router.get(
  "/admin/inbound-referrals/:id",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const [{ data: row }, { data: docs }, { data: preflightChecks }] =
      await Promise.all([
        supabase
          .schema("resupply")
          .from("inbound_referral_orders")
          .select("*")
          .eq("id", params.data.id)
          .limit(1)
          .maybeSingle(),
        supabase
          .schema("resupply")
          .from("inbound_referral_documents")
          .select(
            "id, doc_kind, source_filename, content_type, size_bytes, source_url, source_document_id, object_key, created_at",
          )
          .eq("referral_id", params.data.id)
          .order("created_at", { ascending: true }),
        supabase
          .schema("resupply")
          .from("inbound_referral_preflight_checks")
          .select(
            "id, check_kind, outcome_status, outcome_json, produced_row_table, produced_row_id, ran_by, created_at",
          )
          .eq("referral_id", params.data.id)
          .order("created_at", { ascending: false }),
      ]);
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: row.id,
      source: row.source,
      sourceOrderId: row.source_order_id,
      inboundWebhookId: row.inbound_webhook_id,
      triageStatus: row.triage_status,
      patientMatchId: row.patient_match_id,
      patientMatchKind: row.patient_match_kind,
      providerMatchId: row.provider_match_id,
      providerMatchKind: row.provider_match_kind,
      aiClassification: row.ai_classification_json,
      aiConfidence: row.ai_confidence,
      payerName: row.payer_name,
      orderingNpi: row.ordering_npi,
      hcpcsItems: row.hcpcs_items_json,
      icd10Codes: row.icd10_codes_json,
      // Surface the parsed snapshot so the CSR sees patient
      // demographics + clinical note inline.
      parsed: row.raw_parsed_json,
      assignedAdminUserId: row.assigned_admin_user_id,
      triagedAt: row.triaged_at,
      triagedByUserId: row.triaged_by_user_id,
      acceptedAt: row.accepted_at,
      acceptedByUserId: row.accepted_by_user_id,
      acceptedOrderId: row.accepted_order_id,
      acceptedOrderKind: row.accepted_order_kind,
      notes: row.notes,
      receivedAt: row.received_at,
      createdAt: row.created_at,
      preflightCompletedAt: row.preflight_completed_at,
      documents: (docs ?? []).map((d) => ({
        id: d.id,
        kind: d.doc_kind,
        filename: d.source_filename,
        contentType: d.content_type,
        sizeBytes: d.size_bytes,
        sourceUrl: d.source_url,
        sourceDocumentId: d.source_document_id,
        objectKey: d.object_key,
        createdAt: d.created_at,
      })),
      preflightChecks: (preflightChecks ?? []).map((c) => ({
        id: c.id,
        checkKind: c.check_kind,
        outcomeStatus: c.outcome_status,
        outcomeJson: c.outcome_json,
        producedRowTable: c.produced_row_table,
        producedRowId: c.produced_row_id,
        ranBy: c.ran_by,
        createdAt: c.created_at,
      })),
    });
  },
);

router.post(
  "/admin/inbound-referrals/:id/run-preflight",
  requirePermission("conversations.manage"),
  adminRateLimit({
    name: "inbound_referrals.run_preflight",
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
      .from("inbound_referral_orders")
      .select("id, triage_status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      existing.triage_status === "archived" ||
      existing.triage_status === "rejected" ||
      existing.triage_status === "duplicate"
    ) {
      res.status(409).json({
        error: "invalid_status",
        message: `Cannot run preflight on a "${existing.triage_status}" referral.`,
      });
      return;
    }

    // Clear the stamp so the run-preflight call writes fresh history
    // rows and re-stamps on completion. The library always inserts
    // (never updates) so the CSR sees prior runs in the timeline.
    await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .update({ preflight_completed_at: null })
      .eq("id", params.data.id);

    try {
      const outcome = await runReferralPreflight({
        referralId: params.data.id,
        ranBy: req.adminEmail ?? "admin:unknown",
      });
      await logAudit({
        action: "inbound_referral.preflight.manual",
        adminEmail: req.adminEmail ?? null,
        adminUserId: req.adminUserId ?? null,
        targetTable: "inbound_referral_orders",
        targetId: params.data.id,
        metadata: {
          checks: outcome.checks.map((c) => `${c.kind}:${c.status}`),
        },
        ip: req.ip ?? null,
        userAgent: req.get("user-agent") ?? null,
      }).catch((err) => {
        logger.warn(
          { err },
          "inbound_referral.preflight.manual audit write failed",
        );
      });
      res.status(200).json({
        id: params.data.id,
        checks: outcome.checks,
      });
    } catch (err) {
      logger.warn(
        {
          referral_id: params.data.id,
          err: err instanceof Error ? err.message : String(err),
        },
        "inbound_referral.preflight.manual_failed",
      );
      res.status(500).json({ error: "preflight_failed" });
    }
  },
);

/**
 * Suggested-patients endpoint — mirrors the inbound_faxes
 * suggested-patients route. Helps the CSR resolve an ambiguous
 * patient_match_id=NULL row without retyping the demographics into
 * the patient search bar.
 */
router.get(
  "/admin/inbound-referrals/:id/suggested-patients",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row } = await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .select("id, raw_parsed_json")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = (row.raw_parsed_json ?? {}) as {
      patient?: {
        phoneE164?: string | null;
        dob?: string | null;
        lastName?: string | null;
      };
    };
    const phone = parsed.patient?.phoneE164 ?? null;
    const dob = parsed.patient?.dob ?? null;
    const lastName = parsed.patient?.lastName ?? null;

    const candidates: Array<{
      id: string;
      legalFirstName: string | null;
      legalLastName: string | null;
      email: string | null;
      phoneE164: string | null;
      dateOfBirth: string | null;
      kind: "exact_phone" | "exact_dob_last_name" | "fuzzy_phone_tail";
    }> = [];

    if (phone) {
      const { data } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name, email, phone_e164, date_of_birth")
        .eq("phone_e164", phone)
        .limit(5);
      for (const p of data ?? []) {
        candidates.push({
          id: p.id,
          legalFirstName: p.legal_first_name,
          legalLastName: p.legal_last_name,
          email: p.email,
          phoneE164: p.phone_e164,
          dateOfBirth: p.date_of_birth,
          kind: "exact_phone",
        });
      }
    }
    if (candidates.length === 0 && dob && lastName) {
      const { data } = await supabase
        .schema("resupply")
        .from("patients")
        .select("id, legal_first_name, legal_last_name, email, phone_e164, date_of_birth")
        .eq("date_of_birth", dob)
        .ilike("legal_last_name", lastName)
        .limit(5);
      for (const p of data ?? []) {
        candidates.push({
          id: p.id,
          legalFirstName: p.legal_first_name,
          legalLastName: p.legal_last_name,
          email: p.email,
          phoneE164: p.phone_e164,
          dateOfBirth: p.date_of_birth,
          kind: "exact_dob_last_name",
        });
      }
    }
    if (candidates.length === 0 && phone && phone.length >= 7) {
      const tail = phone.slice(-7);
      if (/^\d{7}$/.test(tail)) {
        const { data } = await supabase
          .schema("resupply")
          .from("patients")
          .select("id, legal_first_name, legal_last_name, email, phone_e164, date_of_birth")
          .ilike("phone_e164", `%${tail}%`)
          .limit(5);
        for (const p of data ?? []) {
          candidates.push({
            id: p.id,
            legalFirstName: p.legal_first_name,
            legalLastName: p.legal_last_name,
            email: p.email,
            phoneE164: p.phone_e164,
            dateOfBirth: p.date_of_birth,
            kind: "fuzzy_phone_tail",
          });
        }
      }
    }
    res.json({ candidates });
  },
);

router.patch(
  "/admin/inbound-referrals/:id",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "inbound_referrals.update", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
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
    const fields = parsed.data;
    if (Object.keys(fields).length === 0) {
      res.status(200).json({ changed: false });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: existing } = await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .select("id, triage_status, patient_match_id")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    if (fields.status !== undefined && fields.status !== existing.triage_status) {
      const allowed =
        VALID_PATCH_TRANSITIONS[existing.triage_status as ReferralStatus];
      if (!allowed.includes(fields.status)) {
        res.status(400).json({
          error: "invalid_transition",
          message: `Cannot transition referral from "${existing.triage_status}" to "${fields.status}".`,
        });
        return;
      }
    }

    const updates: ReferralUpdate = {};
    if (fields.status !== undefined) updates.triage_status = fields.status;
    if (fields.patientMatchId !== undefined)
      updates.patient_match_id = fields.patientMatchId;
    if (fields.providerMatchId !== undefined)
      updates.provider_match_id = fields.providerMatchId;
    if (fields.assignedAdminUserId !== undefined)
      updates.assigned_admin_user_id = fields.assignedAdminUserId;
    if (fields.notes !== undefined) updates.notes = fields.notes;
    if (
      fields.status !== undefined &&
      existing.triage_status === "new" &&
      fields.status !== "new"
    ) {
      updates.triaged_at = new Date().toISOString();
      updates.triaged_by_user_id = req.adminUserId ?? null;
    }
    updates.updated_at = new Date().toISOString();

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .update(updates)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "inbound_referral.triage",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inbound_referral_orders",
      targetId: params.data.id,
      metadata: {
        from_status: existing.triage_status,
        to_status: fields.status ?? existing.triage_status,
        updated_fields: Object.keys(fields),
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "inbound_referral.triage audit write failed");
    });

    res.status(200).json({ id: params.data.id, changed: true });
  },
);

/**
 * POST /admin/inbound-referrals/:id/accept — promote a triaged
 * referral to a real downstream record.
 *
 * The CSR has already created (or chosen) the patient + provider +
 * downstream order record (episode, shop order, etc.) in their UI;
 * this route is the audit-of-record step that links the referral to
 * what they built. Side-effect free apart from the status flip +
 * audit + denorm columns — the CSR's create-patient / open-episode
 * actions live behind their own routes.
 *
 * Caller pre-conditions:
 *   - referral exists
 *   - current status is 'new' or 'triaged'
 *   - patientId resolves to a real patient row (we re-check)
 */
router.post(
  "/admin/inbound-referrals/:id/accept",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "inbound_referrals.accept", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = acceptBody.safeParse(req.body);
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
    const { data: existing } = await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .select("id, triage_status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (
      existing.triage_status !== "new" &&
      existing.triage_status !== "triaged"
    ) {
      res.status(400).json({
        error: "invalid_transition",
        message: `Cannot accept a referral in status "${existing.triage_status}".`,
      });
      return;
    }

    // Verify the patient exists before linking. Cheap safety check;
    // catches CSR pastes of a stale id.
    const { data: patient } = await supabase
      .schema("resupply")
      .from("patients")
      .select("id")
      .eq("id", parsed.data.patientId)
      .limit(1)
      .maybeSingle();
    if (!patient) {
      res.status(400).json({ error: "patient_not_found" });
      return;
    }

    const nowIso = new Date().toISOString();
    const updates: ReferralUpdate = {
      triage_status: "accepted",
      patient_match_id: parsed.data.patientId,
      accepted_order_id: parsed.data.acceptedOrderId,
      accepted_order_kind: parsed.data.acceptedOrderKind,
      accepted_at: nowIso,
      accepted_by_user_id: req.adminUserId ?? null,
      updated_at: nowIso,
    };
    if (parsed.data.providerId !== undefined) {
      updates.provider_match_id = parsed.data.providerId;
    }
    if (parsed.data.notes !== undefined) {
      updates.notes = parsed.data.notes;
    }
    // Stamp triaged_at if the row jumped 'new' → 'accepted' without
    // a triage step. Preserves the "who first touched this" history.
    if (existing.triage_status === "new") {
      updates.triaged_at = nowIso;
      updates.triaged_by_user_id = req.adminUserId ?? null;
    }

    const { error: updErr } = await supabase
      .schema("resupply")
      .from("inbound_referral_orders")
      .update(updates)
      .eq("id", params.data.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "inbound_referral.accept",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "inbound_referral_orders",
      targetId: params.data.id,
      metadata: {
        from_status: existing.triage_status,
        accepted_order_kind: parsed.data.acceptedOrderKind,
        // Don't log patient_id or order_id — those are PHI-adjacent
        // and the audit row's targetId already lets us join.
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "inbound_referral.accept audit write failed");
    });

    res.status(200).json({ id: params.data.id, accepted: true });
  },
);

export default router;
