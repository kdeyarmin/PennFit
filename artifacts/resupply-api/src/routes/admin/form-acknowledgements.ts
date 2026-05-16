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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { INTAKE_FORMS } from "../../lib/intake-forms/catalog";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const FORM_KINDS = Object.keys(INTAKE_FORMS) as Array<
  keyof typeof INTAKE_FORMS
>;

router.get(
  "/admin/form-acknowledgements/summary",
  // Accreditation-binder rollup — surveyor-facing read. `audit.read`
  // is the catalog's compliance-tier read perm (admin / supervisor /
  // compliance_officer / agent).
  requirePermission("audit.read"),
  async (_req, res) => {
    const supabase = getSupabaseServiceRoleClient();

    // 1. Count active patients (denominator).
    const { count: activePatientCount, error: cntErr } = await supabase
      .schema("resupply")
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
      .schema("resupply")
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
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
      .from("patient_form_acknowledgements")
      .select(
        "id, form_kind, form_version, signed_at, signed_from_ip, source, notes",
      )
      .eq("patient_id", idParse.data)
      .order("signed_at", { ascending: false });
    if (error) throw error;
    res.json({
      acknowledgements: (data ?? []).map((r) => ({
        id: r.id,
        formKind: r.form_kind,
        formVersion: r.form_version,
        signedAt: r.signed_at,
        signedFromIp: r.signed_from_ip,
        source: r.source,
        notes: r.notes,
        currentVersion:
          INTAKE_FORMS[r.form_kind as keyof typeof INTAKE_FORMS]?.version ??
          null,
      })),
    });
  },
);

export default router;
