// /admin/form-acknowledgements — accreditation-binder summary +
// per-patient list of HIPAA / AOB / ABN / financial-responsibility /
// supplier-standards acknowledgements.
//
//   GET /admin/form-acknowledgements/summary
//       For each form_kind in the catalog: how many active patients
//       have (a) signed the current version, (b) signed only an old
//       version, (c) never signed. Surveyors use this when they ask
//       "what's your compliance rate on HIPAA NPP?"
//
//   GET /admin/patients/:id/form-acknowledgements
//       Per-patient list of every acknowledgement on file with the
//       form catalog version it was at.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { type Database, getOrgScopedClient } from "@workspace/resupply-db";

import {
  INTAKE_FORMS,
  type FormKind,
  getFormCurrentVersion,
} from "../../lib/intake-forms/catalog";
import { logger } from "../../lib/logger";
import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FORM_KINDS = Object.keys(INTAKE_FORMS) as Array<
  keyof typeof INTAKE_FORMS
>;

// Dotted ABNs are billed dotless; the scope list stores HCPCS, not ICD-10.
const HCPCS_RE = /^[A-Z]\d{4}$/;

router.get(
  "/admin/form-acknowledgements/summary",
  // Accreditation-binder rollup — surveyor-facing read. `audit.read`
  // is the catalog's compliance-tier read perm (admin / supervisor /
  // compliance_officer / agent).
  requirePermission("audit.read"),
  async (req, res) => {
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // 1. Count active patients (denominator).
    const { count: activePatientCount, error: cntErr } = await supabase
      .from("patients")
      .select("*", { count: "exact", head: true })
      .eq("status", "active");
    if (cntErr) throw cntErr;

    // 2. Pull per-patient latest acknowledgement per form_kind.
    //    A patient with multiple rows for the same kind is collapsed
    //    in JS — Supabase's PostgREST doesn't expose DISTINCT ON.
    //    Bounded query: we read at most all rows; for an active
    //    patient population in the thousands and ≤5 forms, this is
    //    a few-thousand row fetch.
    const { data, error } = await supabase
      .from("patient_form_acknowledgements")
      .select(
        "patient_id, form_kind, form_version, signed_at, patients!inner(id, status)",
      )
      .order("signed_at", { ascending: false });
    if (error) throw error;

    // Build (patient_id, form_kind) → latest_version map, filtering
    // out non-active patients so the denominator matches.
    const latestByPatientKind = new Map<string, string>();
    for (const row of data ?? []) {
      const patientStatus = (row as { patients?: { status?: string } | null })
        .patients?.status;
      if (patientStatus !== "active") continue;
      const key = `${row.patient_id}|${row.form_kind}`;
      if (!latestByPatientKind.has(key)) {
        latestByPatientKind.set(key, row.form_version);
      }
    }

    const rows = FORM_KINDS.map((kind) => {
      const currentVersion = INTAKE_FORMS[kind].version;
      let signedCurrent = 0;
      let signedOld = 0;
      for (const [key, version] of latestByPatientKind.entries()) {
        if (!key.endsWith(`|${kind}`)) continue;
        if (version === currentVersion) signedCurrent += 1;
        else signedOld += 1;
      }
      const denom = activePatientCount ?? 0;
      const neverSigned = Math.max(0, denom - signedCurrent - signedOld);
      return {
        formKind: kind,
        title: INTAKE_FORMS[kind].title,
        currentVersion,
        activePatients: denom,
        signedCurrent,
        signedOld,
        neverSigned,
        // Operator-facing caveat (e.g. the ABN is not the official
        // CMS-R-131); null for forms without one.
        complianceNote: INTAKE_FORMS[kind].complianceNote ?? null,
      };
    });

    res.json({ summary: rows });
  },
);

router.get(
  "/admin/patients/:id/form-acknowledgements",
  // Per-patient acknowledgement list. Same compliance-tier read
  // scope as the summary endpoint.
  requirePermission("audit.read"),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("patient_form_acknowledgements")
      .select(
        "id, form_kind, form_version, signed_at, signed_from_ip, source, notes, hcpcs_codes",
      )
      .eq("patient_id", idParse.data)
      .order("signed_at", { ascending: false });
    if (error) throw error;
    res.json({
      acknowledgements: (
        (data ?? []) as Array<
          Database["resupply"]["Tables"]["patient_form_acknowledgements"]["Row"]
        >
      ).map((r) => ({
        id: r.id,
        formKind: r.form_kind,
        formVersion: r.form_version,
        signedAt: r.signed_at,
        signedFromIp: r.signed_from_ip,
        source: r.source,
        notes: r.notes,
        // ABN-only item scope (null/empty = applies to every line).
        hcpcsCodes: r.hcpcs_codes ?? null,
        currentVersion:
          INTAKE_FORMS[r.form_kind as keyof typeof INTAKE_FORMS]?.version ??
          null,
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// POST /admin/patients/:id/form-acknowledgements — record a CSR-captured
// acknowledgement (e.g. a paper ABN the patient signed in the office).
//
// For an ABN this is where item scope is set: `hcpcsCodes` limits the ABN to
// specific billed items so the modifier engine only stamps GA on those lines
// (migration 0417). Omitting `hcpcsCodes` records a GENERAL ABN that applies
// to every line — the historical patient-level behaviour. Re-recording at the
// same form version REPLACES the prior scope (upsert), so the operator submits
// the full item list each time rather than appending.
// ---------------------------------------------------------------------------
const recordBody = z
  .object({
    formKind: z.enum([
      "hipaa_npp",
      "aob",
      "abn",
      "financial_responsibility",
      "supplier_standards",
    ]),
    hcpcsCodes: z
      .array(
        z
          .string()
          .trim()
          .transform((s) => s.toUpperCase())
          .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
      )
      .max(50)
      .optional(),
    notes: z.string().trim().max(500).optional(),
  })
  .strict();

router.post(
  "/admin/patients/:id/form-acknowledgements",
  requirePermission("patients.update"),
  adminRateLimit({ name: "form_acknowledgement.record", preset: "mutation" }),
  async (req, res) => {
    const idParse = z.string().uuid().safeParse(req.params.id);
    if (!idParse.success) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const parsed = recordBody.safeParse(req.body);
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
    const { formKind, notes } = parsed.data;
    // Item scope only makes sense for an ABN — reject it on other forms so
    // the column never carries meaningless data.
    if (parsed.data.hcpcsCodes && formKind !== "abn") {
      res.status(400).json({ error: "hcpcs_scope_abn_only" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);

    // Confirm the patient belongs to the caller's org before writing.
    const { data: patient, error: patErr } = await supabase
      .from("patients")
      .select("id")
      .eq("id", idParse.data)
      .limit(1)
      .maybeSingle();
    if (patErr) throw patErr;
    if (!patient) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Dedupe + drop empties; an empty list is treated as "no scope" (general).
    const codes = parsed.data.hcpcsCodes
      ? [...new Set(parsed.data.hcpcsCodes)]
      : null;
    const hcpcsCodes = codes && codes.length > 0 ? codes : null;
    const formVersion = getFormCurrentVersion(formKind as FormKind);

    const { data, error } = await supabase
      .from("patient_form_acknowledgements")
      .upsert(
        {
          patient_id: idParse.data,
          form_kind: formKind,
          form_version: formVersion,
          source: "csr_recorded",
          signed_from_ip: req.ip ?? null,
          notes: notes ?? null,
          hcpcs_codes: hcpcsCodes,
        },
        { onConflict: "patient_id,form_kind,form_version" },
      )
      .select("id")
      .single();
    if (error) {
      res.status(500).json({ error: "record_failed", message: error.message });
      return;
    }

    logger.info(
      {
        event: "admin.form_acknowledgement.recorded",
        patient_id: idParse.data,
        form_kind: formKind,
        // HCPCS are billing codes, not PHI — but log the count, not the list.
        hcpcs_scope_count: hcpcsCodes?.length ?? 0,
        adminEmail: req.adminEmail,
      },
      "admin.form_acknowledgement.recorded",
    );
    res.status(201).json({
      id: data.id,
      formKind,
      formVersion,
      hcpcsCodes,
    });
  },
);

export default router;
