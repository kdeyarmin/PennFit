// /admin/referral-reviews — the Referral Reviewer.
//
// A referral packet (inbound fax or admin-uploaded PDF) gets one AI
// extraction pass (lib/referral-review/extract.ts) and lands here as a
// review the staff can edit and explicitly accept — "Do you want to
// enter this referral into the system?". Accepting creates the patient
// row, the insurance_coverages rows, splits the packet into named
// per-section PDFs filed to patient_documents, and attaches the source
// fax to the new chart. Nothing is created without the accept.
//
//   GET    /admin/referral-reviews                — review queue
//   GET    /admin/referral-reviews/:id            — detail (+ extraction)
//   GET    /admin/referral-reviews/:id/media      — stream the packet
//   POST   /admin/referral-reviews/upload-url     — manual-upload step 1
//   POST   /admin/referral-reviews                — manual-upload step 2
//   POST   /admin/referral-reviews/:id/extract    — (re-)run extraction
//   GET    /admin/referral-reviews/:id/duplicates — existing-patient guard
//   POST   /admin/referral-reviews/:id/accept     — create patient + file docs
//   POST   /admin/referral-reviews/:id/dismiss    — not a referral / discard
//
// Permissions: the read/triage surface matches the inbound-fax queue
// (`conversations.manage`); accept and upload are `patients.update`
// (they create a patient and file chart documents — same bar as the
// chart-upload and fax auto-file routes). Insurance verification has NO
// endpoint here: the SPA calls the existing patient-less
// POST /admin/billing/eligibility-quick-check with the form's edited
// values.
//
// PHI posture: responses carry the extraction (patient-identifying text
// transcribed from the packet) — that's the product. Log lines and
// audit metadata carry ONLY ids, statuses, and counts.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";
import { z } from "zod";

import { logAudit } from "@workspace/resupply-audit";
import {
  type Database,
  type Json,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";
import { timezoneForUsState } from "@workspace/resupply-domain";

import { logger } from "../../lib/logger";
import { ObjectAlreadyOwnedError } from "../../lib/object-storage/objectAcl";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";
import { computeRetentionUntilAt } from "../../lib/patient-documents/retention";
import {
  referralSectionTypes,
  type ReferralSectionType,
} from "../../lib/referral-review/extract";
import { runReviewExtraction } from "../../lib/referral-review/run";
import {
  buildSectionFilename,
  splitPdfPages,
} from "../../lib/referral-review/split-pdf";
import { REFERRAL_REVIEW_EXTRACT_JOB } from "../../worker/jobs/referral-review-extract";
import { getBoss } from "../../worker/index";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { withIdempotency } from "../../middlewares/idempotency";
import { requirePermission } from "../../middlewares/requireAdmin";

type ReferralReviewRow =
  Database["resupply"]["Tables"]["referral_reviews"]["Row"];

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

const idParam = z.object({ id: z.string().uuid() });

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // matches the fax-ingest cap

// ── Shared field shapes (mirroring routes/patients/create.ts and
//    routes/patients/insurance-coverages.ts so an accepted referral is
//    indistinguishable from a hand-keyed intake) ─────────────────────
const E164 = /^\+[1-9]\d{7,14}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const addressSchema = z
  .object({
    line1: z.string().trim().min(1).max(120),
    line2: z.string().trim().max(120).optional(),
    city: z.string().trim().min(1).max(80),
    state: z.string().trim().min(1).max(40),
    postalCode: z.string().trim().min(1).max(20),
    country: z.string().trim().min(1).max(40),
  })
  .strict();

const acceptPatientSchema = z
  .object({
    legalFirstName: z.string().trim().min(1).max(80),
    legalLastName: z.string().trim().min(1).max(80),
    dateOfBirth: z.string().regex(ISO_DATE, "must be YYYY-MM-DD"),
    phoneE164: z
      .string()
      .trim()
      .regex(E164, "must be E.164 format like +14155551212")
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v.toLowerCase())),
    address: addressSchema.nullable().optional(),
    insurancePayer: z
      .string()
      .trim()
      .max(120)
      .nullable()
      .optional()
      .transform((v) => (v === "" ? null : v)),
  })
  .strict();

const acceptInsuranceSchema = z
  .object({
    payerName: z.string().trim().min(1).max(120),
    planName: z.string().trim().max(120).nullable().optional(),
    memberId: z.string().trim().min(1).max(64),
    groupNumber: z.string().trim().max(64).nullable().optional(),
    policyholderName: z.string().trim().max(160).nullable().optional(),
    policyholderRelationship: z
      .enum(["self", "spouse", "child", "other"])
      .nullable()
      .optional(),
  })
  .strict();

const acceptDocumentSchema = z
  .object({
    type: z.enum(referralSectionTypes),
    pageStart: z.number().int().min(1).max(500),
    pageEnd: z.number().int().min(1).max(500),
    title: z.string().trim().max(120).optional(),
  })
  .strict();

const acceptBody = z
  .object({
    patient: acceptPatientSchema,
    insurance: acceptInsuranceSchema.nullable().optional(),
    secondaryInsurance: acceptInsuranceSchema.nullable().optional(),
    documents: z.array(acceptDocumentSchema).max(20).optional().default([]),
    /** Set after the UI showed the "possible existing patient" warning
     *  and the operator chose to create a new record anyway. */
    confirmDuplicateOverride: z.boolean().optional().default(false),
  })
  .strict();

const dismissBody = z
  .object({
    note: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .optional()
      .transform((v) => (v === "" || v == null ? null : v)),
  })
  .strict();

const uploadUrlBody = z
  .object({
    contentType: z.literal("application/pdf"),
    sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  })
  .strict();

const createFromUploadBody = z
  .object({
    objectPath: z.string().trim().min(1).max(2048),
  })
  .strict();

const listQuery = z.object({
  status: z
    .enum(["open", "accepted", "dismissed", "all"])
    .optional()
    .default("open"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

// Chart filing for each packet section: the patient_documents
// document_type tag (values from lib/patient-documents/
// chart-document-types.ts) and the filename label.
const SECTION_FILING: Record<
  ReferralSectionType,
  { documentType: string; label: string }
> = {
  sleep_study: { documentType: "sleep_study", label: "Sleep Study" },
  physician_order: { documentType: "prescription", label: "Physician Order" },
  demographics: { documentType: "referral", label: "Referral Demographics" },
  insurance_card: { documentType: "insurance_card", label: "Insurance Card" },
  chart_note: { documentType: "face_to_face", label: "Chart Notes" },
  other: { documentType: "referral", label: "Referral Document" },
};

function reviewToJson(row: ReferralReviewRow) {
  return {
    id: row.id,
    source: row.source,
    inboundFaxId: row.inbound_fax_id,
    hasMedia: row.media_object_key !== null,
    mediaContentType: row.media_content_type,
    mediaSizeBytes: row.media_size_bytes,
    status: row.status,
    extraction: row.extraction,
    extractionModel: row.extraction_model,
    extractedAt: row.extracted_at,
    errorReason: row.error_reason,
    createdPatientId: row.created_patient_id,
    acceptedAt: row.accepted_at,
    dismissedAt: row.dismissed_at,
    dismissNote: row.dismiss_note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Upload one server-built PDF to private object storage, owned by the
 *  patient (same ACL as a chart upload). Returns the normalized key. */
async function uploadChartPdf(
  bytes: Buffer,
  patientId: string,
): Promise<string> {
  const uploadUrl = await objectStorage.getObjectEntityUploadURL();
  const putResp = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": "application/pdf" },
    body: new Uint8Array(bytes),
  });
  if (!putResp.ok) {
    throw new Error(`chart pdf upload failed with status ${putResp.status}`);
  }
  return await objectStorage.trySetObjectEntityAclPolicy(uploadUrl, {
    owner: patientId,
    visibility: "private",
  });
}

/** Existing-patient candidates for a (phone, dob, lastName) triple.
 *  Phone matches exactly; DOB+last-name catches a patient whose phone
 *  changed. Capped small — this is a warning, not a search. */
async function findDuplicateCandidates(input: {
  phoneE164: string | null;
  dateOfBirth: string | null;
  lastName: string | null;
}) {
  const supabase = getSupabaseServiceRoleClient();
  const seen = new Set<string>();
  const candidates: Array<{
    id: string;
    legalFirstName: string | null;
    legalLastName: string | null;
    dateOfBirth: string | null;
    email: string | null;
    phoneE164: string | null;
    matchedOn: "phone" | "dob_name";
  }> = [];

  if (input.phoneE164) {
    const { data } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, email, phone_e164",
      )
      .eq("phone_e164", input.phoneE164)
      .limit(5);
    for (const p of data ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      candidates.push({
        id: p.id,
        legalFirstName: p.legal_first_name,
        legalLastName: p.legal_last_name,
        dateOfBirth: p.date_of_birth,
        email: p.email,
        phoneE164: p.phone_e164,
        matchedOn: "phone",
      });
    }
  }
  if (input.dateOfBirth && input.lastName) {
    const { data } = await supabase
      .schema("resupply")
      .from("patients")
      .select(
        "id, legal_first_name, legal_last_name, date_of_birth, email, phone_e164",
      )
      .eq("date_of_birth", input.dateOfBirth)
      .ilike("legal_last_name", input.lastName)
      .limit(5);
    for (const p of data ?? []) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      candidates.push({
        id: p.id,
        legalFirstName: p.legal_first_name,
        legalLastName: p.legal_last_name,
        dateOfBirth: p.date_of_birth,
        email: p.email,
        phoneE164: p.phone_e164,
        matchedOn: "dob_name",
      });
    }
  }
  return candidates;
}

// ── Queue + detail ──────────────────────────────────────────────────

router.get(
  "/admin/referral-reviews",
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
      .from("referral_reviews")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(q.data.limit);
    if (q.data.status === "open") {
      query = query.in("status", [
        "pending",
        "extracted",
        "failed",
        "offline",
        "unsupported",
      ]);
    } else if (q.data.status !== "all") {
      query = query.eq("status", q.data.status);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ reviews: (data ?? []).map(reviewToJson) });
  },
);

router.get(
  "/admin/referral-reviews/:id",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    // The sending fax number helps the reviewer recognize the office.
    let faxFromE164: string | null = null;
    if (row.inbound_fax_id) {
      const { data: fax } = await supabase
        .schema("resupply")
        .from("inbound_faxes")
        .select("from_e164")
        .eq("id", row.inbound_fax_id)
        .limit(1)
        .maybeSingle();
      faxFromE164 = fax?.from_e164 ?? null;
    }
    res.json({ ...reviewToJson(row), faxFromE164 });
  },
);

router.get(
  "/admin/referral-reviews/:id/media",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("id, media_object_key, media_content_type")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row || !row.media_object_key) {
      res.status(404).json({ error: "media_not_persisted" });
      return;
    }

    let file;
    try {
      file = await objectStorage.getObjectEntityFile(row.media_object_key);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(404).json({ error: "media_not_found" });
        return;
      }
      throw err;
    }

    try {
      const response = await objectStorage.downloadObject(file, 0);
      res.status(response.status);
      response.headers.forEach((value, key) => res.setHeader(key, value));
      if (row.media_content_type) {
        res.setHeader("Content-Type", row.media_content_type);
      }
      res.setHeader(
        "Content-Disposition",
        `inline; filename="referral-${row.id.slice(0, 8)}.pdf"`,
      );
      res.setHeader("Cache-Control", "no-store");
      if (response.body) {
        const nodeStream = Readable.fromWeb(
          response.body as unknown as ReadableStream<Uint8Array>,
        );
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch (err) {
      logger.error(
        { err, review_id: row.id },
        "referral_review_media_stream_failed",
      );
      res.status(500).json({ error: "download_failed" });
    }
  },
);

// ── Manual upload (step 1: presigned PUT; step 2: open the review) ──

router.post(
  "/admin/referral-reviews/upload-url",
  requirePermission("patients.update"),
  adminRateLimit({ name: "referral_reviews.upload_url", preset: "mutation" }),
  async (req, res) => {
    const body = uploadUrlBody.safeParse(req.body);
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
      const uploadURL = await objectStorage.getObjectEntityUploadURL();
      const objectPath = objectStorage.normalizeObjectEntityPath(uploadURL);
      res.json({ uploadURL, objectPath });
    } catch (err) {
      req.log.error({ err }, "referral_review_upload_url_failed");
      res.status(500).json({ error: "upload_url_failed" });
    }
  },
);

router.post(
  "/admin/referral-reviews",
  requirePermission("patients.update"),
  adminRateLimit({ name: "referral_reviews.create", preset: "mutation" }),
  async (req, res) => {
    const body = createFromUploadBody.safeParse(req.body);
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

    let normalizedPath: string;
    try {
      normalizedPath = await objectStorage.trySetObjectEntityAclPolicy(
        body.data.objectPath,
        { owner: "referral-review", visibility: "private" },
      );
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        res.status(400).json({ error: "object_missing" });
        return;
      }
      if (err instanceof ObjectAlreadyOwnedError) {
        res.status(403).json({ error: "object_already_claimed" });
        return;
      }
      req.log.warn({ err }, "referral_review_finalize_acl_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    // Trust the stored object's real metadata, not the client's claim.
    let actualSize: number;
    let actualContentType: string;
    try {
      const objectFile =
        await objectStorage.getObjectEntityFile(normalizedPath);
      const [meta] = await objectFile.getMetadata();
      actualSize =
        typeof meta.size === "string"
          ? Number.parseInt(meta.size, 10)
          : Number(meta.size ?? 0);
      actualContentType =
        typeof meta.contentType === "string" ? meta.contentType : "";
      if (
        !Number.isFinite(actualSize) ||
        actualSize <= 0 ||
        actualSize > MAX_UPLOAD_BYTES
      ) {
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_too_large" });
        return;
      }
      if (actualContentType !== "application/pdf") {
        await objectFile.delete().catch(() => undefined);
        res.status(400).json({ error: "object_invalid_content_type" });
        return;
      }
    } catch (err) {
      req.log.error({ err }, "referral_review_finalize_metadata_failed");
      res.status(500).json({ error: "finalize_failed" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: inserted, error: insErr } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .insert({
        source: "upload",
        media_object_key: normalizedPath,
        media_content_type: actualContentType,
        media_size_bytes: actualSize,
        status: "pending",
        created_by_user_id: req.adminUserId ?? null,
      })
      .select("*")
      .single();
    if (insErr) throw insErr;

    // Enqueue the extraction; if the worker isn't up the row stays
    // `pending` and the UI offers "Run extraction".
    let enqueued = false;
    const boss = getBoss();
    if (boss) {
      try {
        await boss.send(REFERRAL_REVIEW_EXTRACT_JOB, {
          reviewId: inserted.id,
        });
        enqueued = true;
      } catch (err) {
        logger.warn(
          { err, review_id_first8: inserted.id.slice(0, 8) },
          "referral_review_upload_enqueue_failed",
        );
      }
    }

    await logAudit({
      action: "referral_review.upload",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "referral_reviews",
      targetId: inserted.id,
      metadata: { size_bytes: actualSize, enqueued },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "referral_review.upload audit failed");
    });

    res.status(201).json({ ...reviewToJson(inserted), enqueued });
  },
);

// ── Extraction (synchronous re-run / recovery for stuck `pending`) ──

router.post(
  "/admin/referral-reviews/:id/extract",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "referral_reviews.extract", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const outcome = await runReviewExtraction(params.data.id, { force: true });
    if (outcome.kind === "not_found") {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (outcome.kind === "already_terminal") {
      res.status(409).json({ error: "review_settled", status: outcome.status });
      return;
    }
    if (outcome.kind === "media_missing") {
      res.status(404).json({ error: "media_not_persisted" });
      return;
    }

    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    res.json(row ? reviewToJson(row) : { id: params.data.id });
  },
);

// ── Duplicate-patient guard (pre-warn from the stored extraction) ───

router.get(
  "/admin/referral-reviews/:id/duplicates",
  requirePermission("conversations.manage"),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: row, error } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("id, extraction")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!row) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const extraction = (row.extraction ?? null) as {
      patient?: {
        phone?: string | null;
        dob?: string | null;
        lastName?: string | null;
      };
    } | null;
    const patient = extraction?.patient;
    if (!patient) {
      res.json({ candidates: [] });
      return;
    }
    const phone =
      typeof patient.phone === "string" && E164.test(patient.phone)
        ? patient.phone
        : null;
    const dob =
      typeof patient.dob === "string" && ISO_DATE.test(patient.dob)
        ? patient.dob
        : null;
    const lastName =
      typeof patient.lastName === "string" && patient.lastName.trim()
        ? patient.lastName.trim()
        : null;
    const candidates = await findDuplicateCandidates({
      phoneE164: phone,
      dateOfBirth: dob,
      lastName,
    });
    res.json({ candidates });
  },
);

// ── Accept ──────────────────────────────────────────────────────────

router.post(
  "/admin/referral-reviews/:id/accept",
  requirePermission("patients.update"),
  adminRateLimit({ name: "referral_reviews.accept", preset: "mutation" }),
  withIdempotency("POST /admin/referral-reviews/:id/accept"),
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
    const body = parsed.data;

    const supabase = getSupabaseServiceRoleClient();
    const { data: review, error: getErr } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("*")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!review) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (review.status === "accepted" || review.status === "dismissed") {
      res.status(409).json({ error: "review_settled", status: review.status });
      return;
    }

    // Duplicate guard on the EDITED (human-confirmed) values, not the
    // raw extraction — the reviewer may have corrected a misread phone.
    if (!body.confirmDuplicateOverride) {
      const candidates = await findDuplicateCandidates({
        phoneE164: body.patient.phoneE164 ?? null,
        dateOfBirth: body.patient.dateOfBirth,
        lastName: body.patient.legalLastName,
      });
      if (candidates.length > 0) {
        res.status(409).json({ error: "possible_duplicate", candidates });
        return;
      }
    }

    // 1. Create the patient (same insert shape as POST /patients).
    const nowIso = new Date().toISOString();
    const derivedTimezone = timezoneForUsState(body.patient.address?.state);
    const { data: insertedPatient, error: insErr } = await supabase
      .schema("resupply")
      .from("patients")
      .insert({
        legal_first_name: body.patient.legalFirstName,
        legal_last_name: body.patient.legalLastName,
        date_of_birth: body.patient.dateOfBirth,
        phone_e164: body.patient.phoneE164 ?? null,
        email: body.patient.email ?? null,
        address: (body.patient.address ?? null) as unknown as Json,
        ...(derivedTimezone ? { timezone: derivedTimezone } : {}),
        status: "active",
        insurance_payer:
          body.patient.insurancePayer ?? body.insurance?.payerName ?? null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id")
      .single();
    if (insErr) throw insErr;
    const patientId = insertedPatient.id;

    // Everything after the patient row exists is best-effort: a partial
    // failure must not surface as "accept failed" (the patient is
    // already created) — collect warnings the UI can show instead.
    const warnings: string[] = [];

    // 2. Insurance coverages.
    const coverageInserts = [
      body.insurance ? { rank: "primary" as const, cov: body.insurance } : null,
      body.secondaryInsurance
        ? { rank: "secondary" as const, cov: body.secondaryInsurance }
        : null,
    ].filter((c) => c !== null);
    for (const { rank, cov } of coverageInserts) {
      const { error: covErr } = await supabase
        .schema("resupply")
        .from("insurance_coverages")
        .insert({
          patient_id: patientId,
          rank,
          payer_name: cov.payerName,
          plan_name: cov.planName ?? null,
          member_id: cov.memberId,
          group_number: cov.groupNumber ?? null,
          policyholder_name: cov.policyholderName ?? null,
          policyholder_relationship: cov.policyholderRelationship ?? null,
          created_at: nowIso,
          updated_at: nowIso,
        });
      if (covErr) {
        logger.warn(
          { err: covErr.message, review_id_first8: review.id.slice(0, 8) },
          "referral_review_accept_coverage_insert_failed",
        );
        warnings.push(`${rank}_coverage_not_saved`);
      }
    }

    // 3. Split the packet into per-section PDFs and file them to the
    //    chart. A TIFF packet (or a split failure) files the whole
    //    original as one "referral" document instead.
    const documentIds: string[] = [];
    const patientName =
      `${body.patient.legalFirstName} ${body.patient.legalLastName}`.trim();
    if (review.media_object_key) {
      let mediaBytes: Buffer | null = null;
      try {
        const file = await objectStorage.getObjectEntityFile(
          review.media_object_key,
        );
        const response = await objectStorage.downloadObject(file, 0);
        mediaBytes = Buffer.from(await response.arrayBuffer());
      } catch (err) {
        logger.warn(
          { err, review_id_first8: review.id.slice(0, 8) },
          "referral_review_accept_media_download_failed",
        );
        warnings.push("documents_not_filed");
      }

      if (mediaBytes) {
        const isPdf = review.media_content_type === "application/pdf";
        type FilePlan = {
          bytes: Buffer;
          documentType: string;
          filename: string;
          contentType: string;
        };
        const plans: FilePlan[] = [];
        if (isPdf && body.documents.length > 0) {
          try {
            const parts = await splitPdfPages(
              mediaBytes,
              body.documents.map((d) => ({
                pageStart: d.pageStart,
                pageEnd: d.pageEnd,
              })),
            );
            body.documents.forEach((d, i) => {
              const filing = SECTION_FILING[d.type];
              plans.push({
                bytes: parts[i]!,
                documentType: filing.documentType,
                filename: buildSectionFilename(
                  d.title?.trim() || filing.label,
                  patientName,
                ),
                contentType: "application/pdf",
              });
            });
          } catch (err) {
            logger.warn(
              { err, review_id_first8: review.id.slice(0, 8) },
              "referral_review_accept_split_failed",
            );
            warnings.push("packet_split_failed");
          }
        }
        if (plans.length === 0) {
          // No sections (or split failed / TIFF): file the whole packet.
          plans.push({
            bytes: mediaBytes,
            documentType: "referral",
            filename: buildSectionFilename("Referral Packet", patientName),
            contentType: review.media_content_type ?? "application/pdf",
          });
        }

        for (const plan of plans) {
          try {
            const objectKey = await uploadChartPdf(plan.bytes, patientId);
            const retentionUntilAt = computeRetentionUntilAt({
              createdAt: new Date(nowIso),
              documentType: plan.documentType,
            }).toISOString();
            const { data: docRow, error: docErr } = await supabase
              .schema("resupply")
              .from("patient_documents")
              .insert({
                patient_id: patientId,
                object_key: objectKey,
                document_type: plan.documentType,
                filename: plan.filename,
                content_type: plan.contentType,
                size_bytes: plan.bytes.byteLength,
                // The reviewer just read the packet — filed-as-reviewed,
                // same as a staff chart upload.
                reviewed_at: nowIso,
                reviewed_by_admin_id: req.adminUserId ?? null,
                retention_until_at: retentionUntilAt,
                created_at: nowIso,
                updated_at: nowIso,
              })
              .select("id")
              .limit(1)
              .maybeSingle();
            if (docErr) throw docErr;
            if (docRow) documentIds.push(docRow.id);
          } catch (err) {
            logger.warn(
              { err, review_id_first8: review.id.slice(0, 8) },
              "referral_review_accept_document_file_failed",
            );
            warnings.push("document_not_filed");
          }
        }
      }
    }

    // 4. Attach the source fax to the new chart.
    if (review.inbound_fax_id) {
      const { error: faxErr } = await supabase
        .schema("resupply")
        .from("inbound_faxes")
        .update({
          status: "attached",
          attached_patient_id: patientId,
          attached_document_type: "referral",
          updated_at: nowIso,
        })
        .eq("id", review.inbound_fax_id);
      if (faxErr) {
        logger.warn(
          {
            err: faxErr.message,
            review_id_first8: review.id.slice(0, 8),
          },
          "referral_review_accept_fax_attach_failed",
        );
        warnings.push("fax_not_attached");
      }
    }

    // 5. Settle the review.
    const { error: settleErr } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .update({
        status: "accepted",
        created_patient_id: patientId,
        accepted_at: nowIso,
        accepted_by_user_id: req.adminUserId ?? null,
        updated_at: nowIso,
      })
      .eq("id", review.id);
    if (settleErr) {
      logger.warn(
        { err: settleErr.message, review_id_first8: review.id.slice(0, 8) },
        "referral_review_accept_settle_failed",
      );
      warnings.push("review_not_settled");
    }

    await logAudit({
      action: "referral_review.accept",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "referral_reviews",
      targetId: review.id,
      // PHI-safe: ids + counts only, never the intake fields.
      metadata: {
        patient_id: patientId,
        source: review.source,
        documents_filed: documentIds.length,
        coverages: coverageInserts.length,
        warnings,
      },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "referral_review.accept audit failed");
    });

    res.status(201).json({ patientId, documentIds, warnings });
  },
);

// ── Dismiss ─────────────────────────────────────────────────────────

router.post(
  "/admin/referral-reviews/:id/dismiss",
  requirePermission("conversations.manage"),
  adminRateLimit({ name: "referral_reviews.dismiss", preset: "mutation" }),
  async (req, res) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = dismissBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data: review, error: getErr } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .select("id, status")
      .eq("id", params.data.id)
      .limit(1)
      .maybeSingle();
    if (getErr) throw getErr;
    if (!review) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (review.status === "accepted") {
      res.status(409).json({ error: "review_settled", status: review.status });
      return;
    }
    const nowIso = new Date().toISOString();
    const { error: updErr } = await supabase
      .schema("resupply")
      .from("referral_reviews")
      .update({
        status: "dismissed",
        dismissed_at: nowIso,
        dismissed_by_user_id: req.adminUserId ?? null,
        dismiss_note: body.data.note,
        updated_at: nowIso,
      })
      .eq("id", review.id);
    if (updErr) throw updErr;

    await logAudit({
      action: "referral_review.dismiss",
      adminEmail: req.adminEmail ?? null,
      adminUserId: req.adminUserId ?? null,
      targetTable: "referral_reviews",
      targetId: review.id,
      metadata: { had_note: body.data.note !== null },
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
    }).catch((err) => {
      logger.warn({ err }, "referral_review.dismiss audit failed");
    });

    res.json({ id: review.id, status: "dismissed" });
  },
);

export default router;
