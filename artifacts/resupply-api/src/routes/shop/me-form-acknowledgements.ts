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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";
import {
  INTAKE_FORMS,
  type FormKind,
  getFormCurrentVersion,
} from "../../lib/intake-forms/catalog";

const router: IRouter = Router();

const FORM_KINDS: FormKind[] = [
  "hipaa_npp",
  "aob",
  "abn",
  "financial_responsibility",
  "supplier_standards",
];

async function resolveSinglePatientByEmail(
  customerEmail: string,
): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const escaped = customerEmail.replace(/[\\%_]/g, (c) => `\\${c}`);
  const { data: rows, error } = await supabase
    .schema("resupply")
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
    const patientId = await resolveSinglePatientByEmail(email);
    if (!patientId) {
      res.json({ patientLinked: false, forms: [] });
      return;
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
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
    res.json({
      patientLinked: true,
      forms: FORM_KINDS.map((kind) => {
        const descriptor = INTAKE_FORMS[kind];
        const ack = latest[kind] ?? null;
        return {
          kind,
          title: descriptor.title,
          body: descriptor.body,
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
    const patientId = await resolveSinglePatientByEmail(email);
    if (!patientId) {
      res.status(404).json({ error: "patient_not_linked" });
      return;
    }
    const version = getFormCurrentVersion(parsed.data.formKind);
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .schema("resupply")
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
