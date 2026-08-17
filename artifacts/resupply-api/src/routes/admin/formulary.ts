// /admin/fitter/formulary — the multi-axis provider formulary.
//
//   GET    /admin/fitter/formulary              — the active formulary + rules
//   POST   /admin/fitter/formulary/rules        — add a rule
//   DELETE /admin/fitter/formulary/rules/:id    — remove a rule
//   PATCH  /admin/fitter/formulary              — posture / name / notes
//   POST   /admin/fitter/formulary/publish      — bump the version
//   POST   /admin/fitter/formulary/simulate     — dry-run against synthetic faces
//
// THE PUBLISH PRE-FLIGHT IS THE POINT OF THIS FILE
// ------------------------------------------------
// A `closed` formulary with no `allow` rules denies everything, which
// turns every patient into a `contraindicated` outcome — a
// misconfiguration that looks like a clinical finding. So `publish` runs
// the resolver over a panel of synthetic faces first and refuses with 409
// `formulary_would_exclude_all` if any of them ends up with nothing.
// `simulate` exposes the same machinery so an operator can see what a rule
// does BEFORE saving it; multi-axis precedence is not something a human
// can evaluate by reading a rule list.
//
// The simulation panel is synthetic by construction — it accepts no
// patient identifier and reads no patient data, so a configuration tool
// stays outside the PHI blast radius.
//
// PHI: none.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import {
  invalidateFittingContext,
  loadFittingContext,
} from "../../lib/fitting/catalog-store";
import { resolveFormulary } from "../../lib/fitting/formulary";
import type { FitContext, FitMeasurements } from "../../lib/fitting/types";

const router: IRouter = Router();

type Row = Record<string, unknown>;

const ruleBody = z
  .object({
    locationId: z.string().trim().uuid().nullable().optional(),
    payerProfileId: z.string().trim().uuid().nullable().optional(),
    contractRef: z.string().trim().max(120).nullable().optional(),
    serviceLine: z.enum(["adult", "pediatric"]).nullable().optional(),
    therapyMode: z.enum(["pap", "niv"]).nullable().optional(),
    targetKind: z.enum([
      "manufacturer",
      "interface_type",
      "mask_model",
      "size_variant",
      "all",
    ]),
    targetManufacturer: z.string().trim().max(120).nullable().optional(),
    targetInterfaceType: z
      .enum([
        "nasal",
        "nasal_pillow",
        "nasal_cradle",
        "hybrid",
        "full_face",
        "total_face",
        "oral",
      ])
      .nullable()
      .optional(),
    targetMaskModelId: z.string().trim().uuid().nullable().optional(),
    targetSizeVariantId: z.string().trim().uuid().nullable().optional(),
    effect: z.enum(["allow", "deny", "prefer", "deprioritize"]),
    preferenceRank: z.number().int().min(1).max(99).nullable().optional(),
    reasonCode: z.string().trim().max(64).nullable().optional(),
    reasonNote: z.string().trim().max(2000).nullable().optional(),
    effectiveFrom: z.string().date().nullable().optional(),
    effectiveTo: z.string().date().nullable().optional(),
  })
  .strict()
  .refine((v) => v.effect !== "prefer" || v.preferenceRank != null, {
    message: "A 'prefer' rule needs a preference rank (1 = most preferred).",
    path: ["preferenceRank"],
  });

const formularyPatch = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    defaultPosture: z.enum(["open", "closed"]).optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

const simulateBody = z
  .object({
    locationId: z.string().trim().uuid().nullable().optional(),
    payerProfileId: z.string().trim().uuid().nullable().optional(),
    contractRef: z.string().trim().max(120).nullable().optional(),
    population: z.enum(["adult", "pediatric"]).default("adult"),
    therapyMode: z.enum(["pap", "niv"]).default("pap"),
  })
  .strict();

/**
 * A synthetic panel spanning the measurement space — small, average, and
 * large faces, adult and pediatric. Entirely fabricated numbers: this
 * exists so a configuration tool never has to touch a real patient.
 */
const SIMULATION_PANEL: Array<{ label: string; m: FitMeasurements }> = [
  {
    label: "Small adult face",
    m: {
      noseWidth: 27,
      noseHeight: 36,
      noseToChin: 52,
      mouthWidth: 40,
      faceWidthAtCheekbones: 124,
    },
  },
  {
    label: "Average adult face",
    m: {
      noseWidth: 34,
      noseHeight: 45,
      noseToChin: 65,
      mouthWidth: 50,
      faceWidthAtCheekbones: 142,
    },
  },
  {
    label: "Large adult face",
    m: {
      noseWidth: 42,
      noseHeight: 54,
      noseToChin: 78,
      mouthWidth: 60,
      faceWidthAtCheekbones: 162,
    },
  },
  {
    label: "Pediatric face",
    m: {
      noseWidth: 20,
      noseHeight: 26,
      noseToChin: 40,
      mouthWidth: 30,
      faceWidthAtCheekbones: 100,
    },
  },
];

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

async function activeFormularyId(orgId: string): Promise<string | null> {
  const { data } = (await getOrgScopedClient(orgId)
    .from("formularies")
    .select("id")
    .eq("status", "active")
    .limit(1)
    .maybeSingle()) as { data: Row | null };
  return data ? String(data.id) : null;
}

router.get(
  "/admin/fitter/formulary",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "formulary.read", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: formulary, error } = (await supabase
      .from("formularies")
      .select("*")
      .eq("status", "active")
      .limit(1)
      .maybeSingle()) as {
      data: Row | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    if (!formulary) {
      res.json({ formulary: null, rules: [] });
      return;
    }
    const { data: rules } = (await supabase
      .from("formulary_rules")
      .select("*")
      .eq("formulary_id", String(formulary.id))
      .order("created_at", { ascending: false })) as { data: Row[] | null };

    res.json({
      formulary: {
        id: String(formulary.id),
        name: formulary.name,
        status: formulary.status,
        defaultPosture: formulary.default_posture,
        version: formulary.version,
        publishedAt: formulary.published_at,
        publishedByEmail: formulary.published_by_email,
        notes: formulary.notes,
      },
      rules: (rules ?? []).map(mapRule),
    });
  },
);

router.patch(
  "/admin/fitter/formulary",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = formularyPatch.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const formularyId = await activeFormularyId(orgId);
    if (!formularyId) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    if (body.data.name !== undefined) patch.name = body.data.name;
    if (body.data.defaultPosture !== undefined) {
      patch.default_posture = body.data.defaultPosture;
    }
    if (body.data.notes !== undefined) patch.notes = body.data.notes;

    const { error } = await getOrgScopedClient(orgId)
      .from("formularies")
      .update(patch)
      .eq("id", formularyId);
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
  },
);

router.post(
  "/admin/fitter/formulary/rules",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.rule_create", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = ruleBody.safeParse(req.body);
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
    const formularyId = await activeFormularyId(orgId);
    if (!formularyId) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    const b = body.data;
    // The database enforces the one-hot target too; normalising here gives
    // the operator a clear 400 instead of a constraint-violation 500.
    const targetsByKind: Record<string, unknown> = {
      manufacturer: b.targetManufacturer,
      interface_type: b.targetInterfaceType,
      mask_model: b.targetMaskModelId,
      size_variant: b.targetSizeVariantId,
      all: null,
    };
    if (b.targetKind !== "all" && !targetsByKind[b.targetKind]) {
      res.status(400).json({
        error: "invalid_body",
        issues: [
          {
            path: "targetKind",
            message: `A '${b.targetKind}' rule needs its matching target value.`,
          },
        ],
      });
      return;
    }

    const { data, error } = (await getOrgScopedClient(orgId)
      .from("formulary_rules")
      .insert({
        formulary_id: formularyId,
        location_id: b.locationId ?? null,
        payer_profile_id: b.payerProfileId ?? null,
        contract_ref: b.contractRef ?? null,
        service_line: b.serviceLine ?? null,
        therapy_mode: b.therapyMode ?? null,
        target_kind: b.targetKind,
        target_manufacturer:
          b.targetKind === "manufacturer" ? b.targetManufacturer : null,
        target_interface_type:
          b.targetKind === "interface_type" ? b.targetInterfaceType : null,
        target_mask_model_id:
          b.targetKind === "mask_model" ? b.targetMaskModelId : null,
        target_size_variant_id:
          b.targetKind === "size_variant" ? b.targetSizeVariantId : null,
        effect: b.effect,
        preference_rank: b.effect === "prefer" ? b.preferenceRank : null,
        reason_code: b.reasonCode ?? null,
        reason_note: b.reasonNote ?? null,
        effective_from: b.effectiveFrom ?? null,
        effective_to: b.effectiveTo ?? null,
        created_by_email: req.adminEmail ?? null,
      })
      .select("id")
      .single()) as { data: Row | null; error: { message: string } | null };

    if (error || !data) {
      res.status(500).json({
        error: "insert_failed",
        message: error?.message ?? "unknown",
      });
      return;
    }
    invalidateFittingContext(orgId);
    res.status(201).json({ id: String(data.id) });
  },
);

router.delete(
  "/admin/fitter/formulary/rules/:id",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.rule_delete", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    if (!id.success) {
      res.status(400).json({ error: "invalid_id" });
      return;
    }
    const { error } = await getOrgScopedClient(orgId)
      .from("formulary_rules")
      .delete()
      .eq("id", id.data);
    if (error) {
      res.status(500).json({ error: "delete_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
  },
);

router.post(
  "/admin/fitter/formulary/simulate",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "formulary.simulate", preset: "query" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = simulateBody.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const result = await simulate(orgId, {
      locationId: body.data.locationId ?? null,
      payerProfileId: body.data.payerProfileId ?? null,
      contractRef: body.data.contractRef ?? null,
      population: body.data.population,
      therapyMode: body.data.therapyMode,
      asOf: new Date().toISOString().slice(0, 10),
    });
    res.json(result);
  },
);

router.post(
  "/admin/fitter/formulary/publish",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "formulary.publish", preset: "sensitive" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const supabase = getOrgScopedClient(orgId);
    const { data: formulary } = (await supabase
      .from("formularies")
      .select("id, version")
      .eq("status", "active")
      .limit(1)
      .maybeSingle()) as { data: Row | null };
    if (!formulary) {
      res.status(404).json({ error: "no_active_formulary" });
      return;
    }

    // Pre-flight. A formulary that leaves a synthetic face with nothing to
    // dispense is a misconfiguration, and it would surface to patients as
    // a clinical "contraindicated" verdict — so refuse to publish it.
    const preflight = await simulate(orgId, {
      locationId: null,
      payerProfileId: null,
      contractRef: null,
      population: "adult",
      therapyMode: "pap",
      asOf: new Date().toISOString().slice(0, 10),
    });
    const starved = preflight.panel.filter((p) => p.allowedCount === 0);
    if (starved.length > 0) {
      res.status(409).json({
        error: "formulary_would_exclude_all",
        message:
          "This formulary leaves at least one patient profile with no dispensable mask. Add an allow rule, or switch the default posture back to open, before publishing.",
        starvedProfiles: starved.map((p) => p.label),
      });
      return;
    }

    const { error } = await supabase
      .from("formularies")
      .update({
        version: Number(formulary.version ?? 1) + 1,
        published_at: new Date().toISOString(),
        published_by_email: req.adminEmail ?? null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", String(formulary.id));
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true, version: Number(formulary.version ?? 1) + 1 });
  },
);

interface SimulationResult {
  formulary: { name: string; version: number; defaultPosture: string };
  panel: Array<{
    label: string;
    allowedCount: number;
    deniedCount: number;
    preferred: Array<{ mask: string; rank: number | null }>;
    denied: Array<{
      mask: string;
      reasonCode: string | null;
      ruleIds: string[];
    }>;
  }>;
}

/**
 * Run the resolver over the synthetic panel.
 *
 * Reports the matched rule ids per decision, because "this mask is denied"
 * is not actionable but "this mask is denied by rule X" is.
 */
async function simulate(
  orgId: string,
  context: FitContext,
): Promise<SimulationResult> {
  const ctx = await loadFittingContext(orgId);
  const panel = SIMULATION_PANEL.filter((p) =>
    context.population === "pediatric" ? true : p.label !== "Pediatric face",
  ).map((face) => {
    let allowedCount = 0;
    const preferred: Array<{ mask: string; rank: number | null }> = [];
    const denied: Array<{
      mask: string;
      reasonCode: string | null;
      ruleIds: string[];
    }> = [];

    for (const mask of ctx.catalog) {
      if (mask.status === "discontinued") continue;
      if (
        mask.serviceLine !== "both" &&
        mask.serviceLine !== context.population
      ) {
        continue;
      }
      const decision = resolveFormulary(ctx.formulary, mask, null, context);
      if (decision.allowed) {
        allowedCount += 1;
        if (decision.preferenceRank !== null) {
          preferred.push({
            mask: `${mask.manufacturer} ${mask.modelName}`,
            rank: decision.preferenceRank,
          });
        }
      } else {
        denied.push({
          mask: `${mask.manufacturer} ${mask.modelName}`,
          reasonCode: decision.denyReasonCode,
          ruleIds: decision.matchedRuleIds,
        });
      }
    }

    preferred.sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    return {
      label: face.label,
      allowedCount,
      deniedCount: denied.length,
      preferred: preferred.slice(0, 10),
      denied: denied.slice(0, 25),
    };
  });

  return {
    formulary: {
      name: ctx.formulary.name,
      version: ctx.formulary.version,
      defaultPosture: ctx.formulary.defaultPosture,
    },
    panel,
  };
}

function mapRule(row: Row) {
  return {
    id: String(row.id),
    locationId: row.location_id,
    payerProfileId: row.payer_profile_id,
    contractRef: row.contract_ref,
    serviceLine: row.service_line,
    therapyMode: row.therapy_mode,
    targetKind: row.target_kind,
    targetManufacturer: row.target_manufacturer,
    targetInterfaceType: row.target_interface_type,
    targetMaskModelId: row.target_mask_model_id,
    targetSizeVariantId: row.target_size_variant_id,
    effect: row.effect,
    preferenceRank: row.preference_rank,
    reasonCode: row.reason_code,
    reasonNote: row.reason_note,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    createdByEmail: row.created_by_email,
    createdAt: row.created_at,
  };
}

export default router;
