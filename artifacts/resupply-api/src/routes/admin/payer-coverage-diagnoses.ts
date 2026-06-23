// /admin/payer-coverage-diagnoses — per-payer medical-necessity coverage
// overrides (migration 0415). The hcpcs_coverage_diagnoses catalog ships a
// NATIONAL (Medicare LCD) baseline; a tenant can add payer-specific rows so
// the preflight medical-necessity warning reflects a commercial / MA plan's
// own covered ICD-10 set (which, when present for a HCPCS, REPLACES the
// national default for that HCPCS — see lib/billing/coverage-diagnosis.ts).
//
//   GET    /admin/payer-coverage-diagnoses?payerProfileId=   (reports.read)
//   POST   /admin/payer-coverage-diagnoses                   (admin.tools.manage)
//   DELETE /admin/payer-coverage-diagnoses/:id               (admin.tools.manage)
//
// The catalog table is GLOBAL (no org_id), so it is reached via `.raw()`;
// tenant isolation is enforced by validating the target `payerProfileId`
// belongs to the caller's org through the org-scoped `payer_profiles` read.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { normalizeIcd10 } from "../../lib/billing/coverage-diagnosis";
import { logger } from "../../lib/logger";
import {
  adminRateLimit,
  adminReadRateLimiter,
} from "../../middlewares/admin-rate-limit";
import { requirePermission } from "../../middlewares/requireAdmin";

const router: IRouter = Router();

const HCPCS_RE = /^[A-Z]\d{4}$/;
// Dotless ICD-10 (or a category prefix), matching the table's CHECK.
const ICD10_RE = /^[A-Z][0-9A-Z]{1,6}$/;

/** Confirm the payer profile exists AND belongs to the caller's org. The
 *  org-scoped read auto-filters by org_id, so a hit proves ownership. */
async function payerInOrg(
  scoped: ReturnType<typeof getOrgScopedClient>,
  payerProfileId: string,
): Promise<boolean> {
  const { data, error } = await scoped
    .from("payer_profiles")
    .select("id")
    .eq("id", payerProfileId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

const listQuery = z.object({ payerProfileId: z.string().uuid() });

router.get(
  "/admin/payer-coverage-diagnoses",
  adminReadRateLimiter,
  requirePermission("reports.read"),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const scoped = getOrgScopedClient(orgId);
    if (!(await payerInOrg(scoped, parsed.data.payerProfileId))) {
      res.status(404).json({ error: "payer_not_found" });
      return;
    }
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .from("hcpcs_coverage_diagnoses")
      .select("id, hcpcs_code, icd10_code, description, policy, active")
      .eq("payer_profile_id", parsed.data.payerProfileId)
      .order("hcpcs_code", { ascending: true });
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    const overrides = (data ?? []).map((r) => ({
      id: r.id,
      hcpcsCode: r.hcpcs_code,
      icd10Code: r.icd10_code,
      description: r.description,
      policy: r.policy,
      active: r.active,
    }));
    res.json({ overrides });
  },
);

const createBody = z.object({
  payerProfileId: z.string().uuid(),
  hcpcs: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => HCPCS_RE.test(s), "must be a HCPCS code like E0601"),
  icd10: z
    .string()
    .trim()
    .transform((s) => normalizeIcd10(s))
    .refine((s) => ICD10_RE.test(s), "must be an ICD-10 code like G47.33"),
  description: z.string().trim().max(200).optional(),
});

router.post(
  "/admin/payer-coverage-diagnoses",
  requirePermission("billing.manage"),
  adminRateLimit({
    name: "payer_coverage_override.create",
    preset: "mutation",
  }),
  async (req, res) => {
    const parsed = createBody.safeParse(req.body);
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
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const scoped = getOrgScopedClient(orgId);
    const q = parsed.data;
    if (!(await payerInOrg(scoped, q.payerProfileId))) {
      res.status(404).json({ error: "payer_not_found" });
      return;
    }
    const { data, error } = await scoped
      .raw()
      .schema("resupply")
      .from("hcpcs_coverage_diagnoses")
      .insert({
        payer_profile_id: q.payerProfileId,
        hcpcs_code: q.hcpcs,
        icd10_code: q.icd10,
        description: q.description ?? null,
        policy: "Payer policy",
      })
      .select("id")
      .single();
    if (error) {
      // 23505 = unique_violation (the per-payer partial unique index).
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        res.status(409).json({ error: "override_exists" });
        return;
      }
      res.status(500).json({ error: "create_failed", message: error.message });
      return;
    }
    req.log?.info(
      {
        event: "admin.payer_coverage_override.created",
        payer_profile_id: q.payerProfileId,
        hcpcs_code: q.hcpcs,
        icd10_code: q.icd10,
        adminEmail: req.adminEmail,
      },
      "admin.payer_coverage_override.created",
    );
    res.status(201).json({ id: data.id });
  },
);

const idParam = z.string().uuid();

router.delete(
  "/admin/payer-coverage-diagnoses/:id",
  requirePermission("billing.manage"),
  adminRateLimit({ name: "payer_coverage_override.delete", preset: "destroy" }),
  async (req, res) => {
    const parsed = idParam.safeParse(req.params.id);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const orgId = req.orgId;
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const scoped = getOrgScopedClient(orgId);
    // Resolve the row's payer, then validate it belongs to the caller's org
    // before deleting — the catalog table has no org_id of its own.
    const { data: row, error: rowErr } = await scoped
      .raw()
      .schema("resupply")
      .from("hcpcs_coverage_diagnoses")
      .select("id, payer_profile_id")
      .eq("id", parsed.data)
      .limit(1)
      .maybeSingle();
    if (rowErr) {
      res.status(500).json({ error: "query_failed", message: rowErr.message });
      return;
    }
    // Only payer-override rows are deletable here; never a national row.
    if (!row || !row.payer_profile_id) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }
    if (!(await payerInOrg(scoped, row.payer_profile_id))) {
      res.status(404).json({ error: "override_not_found" });
      return;
    }
    const { error: delErr } = await scoped
      .raw()
      .schema("resupply")
      .from("hcpcs_coverage_diagnoses")
      .delete()
      .eq("id", parsed.data);
    if (delErr) {
      res.status(500).json({ error: "delete_failed", message: delErr.message });
      return;
    }
    logger.info(
      { event: "admin.payer_coverage_override.deleted", id: parsed.data },
      "admin.payer_coverage_override.deleted",
    );
    res.status(204).end();
  },
);

export default router;
