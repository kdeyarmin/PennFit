// /shop/me/form-acknowledgements — patient e-sign of intake forms.
//
//   GET  /shop/me/form-acknowledgements
//          List of forms in the catalog + the patient's most recent
//          acknowledgement on each (so the UI can render "needs to
//          re-sign" when the version has bumped).
//   POST /shop/me/form-acknowledgements
//          Body: { formKind }
//          Records an acknowledgement at the current catalog version.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  applyCompanyIdentityToText,
  getCompanyInfo,
  type CompanyInfo,
} from "../../lib/company-info";
import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  INTAKE_FORMS,
  type FormKind,
  getFormCurrentVersion,
} from "../../lib/intake-forms/catalog";

const router: IRouter = Router();

/**
 * True only when the tenant's own legal entity is configured — i.e. the
 * resolved identity is NOT the neutral platform fallback. `getCompanyInfo`
 * returns `source: "fallback"` (the CareMetric platform default) ONLY for an
 * unconfigured non-seed tenant; the seed / single-tenant deployment resolves
 * to `"database"` (its dme_organization row) or `"environment"` (its
 * env-folded practice identity), both of which ARE the correct legal entity
 * whose name the catalog text already carries. The intake/consent forms
 * (HIPAA notice, assignment of benefits, etc.) name a legal entity, so they
 * must not be served (or signed) for a `"fallback"` tenant — that would put
 * the SEED company (or, if we substituted, the wrong platform entity) into a
 * patient's HIPAA/insurance-billing authorization. Both the GET (display) and
 * POST (record) paths gate on this.
 */
function isPracticeLegalEntityConfigured(info: CompanyInfo): boolean {
  return info.source !== "fallback" && Boolean(info.legalName?.trim());
}

const FORM_KINDS: FormKind[] = [
  "hipaa_npp",
  "aob",
  "abn",
  "financial_responsibility",
  "supplier_standards",
];

async function resolveSinglePatientByEmail(
  orgId: string,
  customerEmail: string,
): Promise<string | null> {
  const supabase = getOrgScopedClient(orgId);
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .from("patients")
    .select("id")
    .ilike("email", escaped)
    .limit(2);
  if (error) throw error;
  if (!rows || rows.length !== 1) return null;
  return rows[0]!.id;
}

router.get(
  "/shop/me/form-acknowledgements",
  requireSignedIn,
  async (req, res) => {
    const email = req.shopCustomerEmail;
    if (!email) {
      res.json({ patientLinked: false, forms: [] });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const patientId = await resolveSinglePatientByEmail(orgId, email);
    if (!patientId) {
      res.json({ patientLinked: false, forms: [] });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("patient_form_acknowledgements")
      .select("form_kind, form_version, signed_at, source")
      .eq("patient_id", patientId)
      .order("signed_at", { ascending: false });
    if (error) throw error;
    const latest: Record<string, { version: string; signedAt: string }> = {};
    for (const row of data ?? []) {
      if (!latest[row.form_kind]) {
        latest[row.form_kind] = {
          version: row.form_version,
          signedAt: row.signed_at,
        };
      }
    }
    // Resolve THIS patient's tenant identity so the form copy carries
    // their own practice name, not the seed tenant's (the sync default).
    const companyInfo = await getCompanyInfo(orgId);
    // GATE: only serve the legal form BODIES once the tenant's own legal
    // entity is configured (a saved dme_organization with a legal name).
    // Until then the catalog text names the SEED entity
    // ("Penn Home Medical Supply") and applyCompanyIdentityToText is a no-op
    // for an unconfigured tenant — so serving it would put the WRONG legal
    // entity into a non-seed tenant patient's HIPAA notice / insurance-billing
    // authorization. We gate rather than guess: substituting the platform's
    // name into a billing-authorization is equally wrong (the platform isn't
    // the DME billing the patient's insurance). The seed org and any
    // configured tenant resolve source === "database", so they are unaffected.
    if (!isPracticeLegalEntityConfigured(companyInfo)) {
      res.json({ patientLinked: true, practiceConfigured: false, forms: [] });
      return;
    }
    res.json({
      patientLinked: true,
      practiceConfigured: true,
      forms: FORM_KINDS.map((kind) => {
        const descriptor = INTAKE_FORMS[kind];
        const ack = latest[kind] ?? null;
        return {
          kind,
          title: descriptor.title,
          // The catalog text carries the historical company name;
          // rewrite it to the tenant's saved identity at serve time.
          body: applyCompanyIdentityToText(descriptor.body, companyInfo),
          currentVersion: descriptor.version,
          lastSignedVersion: ack?.version ?? null,
          lastSignedAt: ack?.signedAt ?? null,
          upToDate: ack ? ack.version === descriptor.version : false,
        };
      }),
    });
  },
);

const body = z
  .object({
    formKind: z.enum([
      "hipaa_npp",
      "aob",
      "abn",
      "financial_responsibility",
      "supplier_standards",
    ]),
  })
  .strict();

router.post(
  "/shop/me/form-acknowledgements",
  requireSignedIn,
  async (req, res) => {
    const email = req.shopCustomerEmail;
    if (!email) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }
    const parsed = body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const patientId = await resolveSinglePatientByEmail(orgId, email);
    if (!patientId) {
      res.status(404).json({ error: "patient_not_linked" });
      return;
    }
    // Gate: refuse to record a legal acknowledgement until the tenant's own
    // legal entity is configured (see isPracticeLegalEntityConfigured). The
    // GET path doesn't serve the form text in this state, so a normal patient
    // never reaches a signable form; this closes the direct-API path too.
    const companyInfo = await getCompanyInfo(orgId);
    if (!isPracticeLegalEntityConfigured(companyInfo)) {
      res.status(409).json({ error: "practice_not_configured" });
      return;
    }
    const version = getFormCurrentVersion(parsed.data.formKind);
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = await supabase
      .from("patient_form_acknowledgements")
      .insert({
        patient_id: patientId,
        form_kind: parsed.data.formKind,
        form_version: version,
        signed_from_ip: req.ip ?? null,
        source: "patient_portal",
      })
      .select("id")
      .single();
    if (error) {
      const code =
        typeof error === "object" && error && "code" in error
          ? (error as { code?: string }).code
          : undefined;
      if (code === "23505") {
        // Dupe = already signed this version. Idempotent success.
        res.status(200).json({ id: null, created: false });
        return;
      }
      throw error;
    }
    res.status(201).json({ id: data.id, created: true });
  },
);

export default router;
