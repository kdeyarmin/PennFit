// /admin/fitter/catalog — the Mask Intelligence Catalog admin surface.
//
//   GET   /admin/fitter/catalog                  — browse, with filters
//   GET   /admin/fitter/catalog/:id              — one model + sizes + parts
//   PATCH /admin/fitter/catalog/:id              — edit model facts
//   PATCH /admin/fitter/catalog/variants/:id     — edit one size's mm bands
//   POST  /admin/fitter/catalog/variants/:id/review — RT sign-off
//   POST  /admin/fitter/catalog/variants/review-batch — RT sign-off, many
//
// WHY THE REVIEW ENDPOINT MATTERS
// -------------------------------
// The catalog ships with ~250 size variants whose millimetre bands are
// clinically-reasoned estimates rather than published manufacturer data,
// each flagged `needs_clinical_review`. Sign-off here records THIS
// tenant's clinical verification of a band: it clears the per-tenant
// review flag carried on sessions and printed on the fit report, and it
// is the provenance a payer or sleep lab reads. (It no longer caps the
// engine's confidence — that gate was removed deliberately; see
// resolveConfidence in lib/fitting/confidence.ts and pennfit-rules R8.)
// Gated on `formulary.manage` (a clinical permission held by clinicians
// and supervisors) and not on a generic tools permission.
//
// TENANCY — the rule that shapes every write in this file
// -------------------------------------------------------
// `mask_models` and `mask_size_variants` are platform reference data with
// a NULLABLE `org_id`: NULL is a SHARED row every tenant sees, non-NULL is
// a model one tenant added privately. Reads therefore go through `.raw()`
// with an explicit `org_id.is.null,org_id.eq.<tenant>` filter, because the
// org-scoped facade would hide every shared row.
//
// Writes are the dangerous direction, and there are exactly two kinds:
//
//   1. Edits to the catalog itself (model facts, millimetre bands) are
//      restricted to rows this tenant OWNS. A tenant cannot edit a shared
//      row, because that row is another tenant's clinical data too.
//   2. Clinical sign-off is recorded in `mask_variant_reviews`, keyed by
//      (org_id, size_variant_id), and NEVER by clearing the shared
//      `needs_clinical_review` flag. One DME's respiratory therapist
//      signing off the sizes that DME stocks must not lift the engine's
//      confidence cap for every other DME on the platform.
//
// The engine honours this by treating a variant as reviewed only when the
// platform flag is clear OR the requesting tenant has an approved review
// row — see `lib/fitting/catalog-store.ts`.
//
// PHI: none. Product facts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import {
  adminRateLimit,
  adminWriteRateLimiter,
} from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { invalidateFittingContext } from "../../lib/fitting/catalog-store";
import {
  UNION_PLAUSIBILITY_BOUNDS,
  type PlausibilityField,
} from "../../lib/fitting/confidence";

/** Which plausibility window governs each band column pair. */
const PLAUSIBILITY_FIELD_OF_COLUMN: Record<string, PlausibilityField> = {
  nose_width_min_mm: "noseWidth",
  nose_height_min_mm: "noseHeight",
  nose_to_chin_min_mm: "noseToChin",
  mouth_width_min_mm: "mouthWidth",
  face_width_min_mm: "faceWidthAtCheekbones",
};

const router: IRouter = Router();

type Row = Record<string, unknown>;

const listQuery = z
  .object({
    manufacturer: z.string().trim().max(120).optional(),
    interfaceType: z
      .enum([
        "nasal",
        "nasal_pillow",
        "nasal_cradle",
        "hybrid",
        "full_face",
        "total_face",
        "oral",
      ])
      .optional(),
    serviceLine: z.enum(["adult", "pediatric", "both"]).optional(),
    status: z.enum(["current", "discontinued", "pre_release"]).optional(),
    // NOT z.coerce.boolean(): query params arrive as strings and
    // Boolean("false") is true, so `?needsReview=false` used to turn the
    // filter ON. Parse the literal spellings instead.
    needsReview: z
      .enum(["true", "false", "1", "0"])
      .transform((v) => v === "true" || v === "1")
      .optional(),
    dispensedOnly: z
      .enum(["true", "false", "1", "0"])
      .transform((v) => v === "true" || v === "1")
      .optional(),
    search: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(300).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .strict();

const modelPatch = z
  .object({
    status: z.enum(["current", "discontinued", "pre_release"]).optional(),
    discontinuedOn: z.string().date().nullable().optional(),
    successorSlug: z.string().trim().max(120).nullable().optional(),
    hasMagneticComponents: z.boolean().optional(),
    magneticComponentNotes: z.string().trim().max(2000).nullable().optional(),
    vented: z.enum(["vented", "non_vented", "both"]).optional(),
    therapyModes: z
      .array(z.enum(["pap", "niv"]))
      .min(1)
      .max(2)
      .optional(),
    serviceLine: z.enum(["adult", "pediatric", "both"]).optional(),
    pressureMinCmH2O: z.number().min(0).max(60).nullable().optional(),
    pressureMaxCmH2O: z.number().min(0).max(60).nullable().optional(),
    supportsSupplementalOxygen: z.boolean().nullable().optional(),
    minimalContact: z.boolean().optional(),
    avoidsNasalBridge: z.boolean().optional(),
    facialHairTolerance: z.enum(["poor", "fair", "good"]).nullable().optional(),
    sideSleepingTolerance: z
      .enum(["poor", "fair", "good"])
      .nullable()
      .optional(),
    claustrophobiaTolerance: z
      .enum(["poor", "fair", "good"])
      .nullable()
      .optional(),
    glassesCompatible: z.boolean().nullable().optional(),
    fittingInstructionsUrl: z.string().url().max(500).nullable().optional(),
    fittingInstructionsVersion: z.string().trim().max(64).nullable().optional(),
    fittingInstructionsVersionDate: z.string().date().nullable().optional(),
    notes: z.string().trim().max(4000).nullable().optional(),
  })
  .strict();

const bandPatch = z
  .object({
    noseWidthMinMm: z.number().min(0).max(200).nullable().optional(),
    noseWidthMaxMm: z.number().min(0).max(200).nullable().optional(),
    noseHeightMinMm: z.number().min(0).max(200).nullable().optional(),
    noseHeightMaxMm: z.number().min(0).max(200).nullable().optional(),
    noseToChinMinMm: z.number().min(0).max(200).nullable().optional(),
    noseToChinMaxMm: z.number().min(0).max(200).nullable().optional(),
    mouthWidthMinMm: z.number().min(0).max(200).nullable().optional(),
    mouthWidthMaxMm: z.number().min(0).max(200).nullable().optional(),
    faceWidthMinMm: z.number().min(0).max(300).nullable().optional(),
    faceWidthMaxMm: z.number().min(0).max(300).nullable().optional(),
    fitDataSource: z.enum(["manufacturer", "measured", "estimated"]).optional(),
    // Provenance for the band itself (migration 0495). Required by a DB
    // CHECK whenever fitDataSource is not 'estimated'; the handler
    // enforces it up front so the operator gets a 422 with a reason
    // instead of a constraint error.
    fitDataSourceRef: z.string().trim().min(1).max(500).nullable().optional(),
    fitDataSourceDate: z.string().date().nullable().optional(),
  })
  .strict();

/**
 * Provenance for a sign-off (migration 0491).
 *
 * `clinical_judgment` is deliberately offered: a reviewer going on
 * experience rather than a document should be able to say so, instead of
 * being pushed into overclaiming a citation they don't have.
 */
const SOURCE_KINDS = [
  "manufacturer_fit_guide",
  "manufacturer_spec_sheet",
  "physical_measurement",
  "clinical_judgment",
] as const;

const reviewFields = {
  approved: z.boolean(),
  note: z.string().trim().max(2000).optional(),
  sourceKind: z.enum(SOURCE_KINDS).optional(),
  sourceRef: z.string().trim().max(500).optional(),
};

const reviewBody = z.object(reviewFields).strict();

/**
 * Batch sign-off. The catalog seeds ~250 estimated size bands and a
 * reviewer works through them a model at a time, so one-at-a-time is the
 * difference between a queue that gets cleared and one that doesn't.
 *
 * The cap is 200 — comfortably more than any single model's size run,
 * and small enough that the per-id ownership check below stays a bounded
 * amount of work.
 */
const reviewBatchBody = z
  .object({
    ...reviewFields,
    variantIds: z.array(z.string().trim().uuid()).min(1).max(200),
  })
  .strict();

const MODEL_COLUMNS =
  "id, org_id, slug, manufacturer, model_name, product_line, interface_type, service_line, therapy_modes, vented, has_magnetic_components, magnetic_component_notes, magnet_free_variant_slug, pressure_min_cm_h2o, pressure_max_cm_h2o, supports_supplemental_oxygen, minimal_contact, avoids_nasal_bridge, hose_position, facial_hair_tolerance, side_sleeping_tolerance, claustrophobia_tolerance, glasses_compatible, cushion_material, headgear_style, weight_grams, description, image_url, status, discontinued_on, successor_slug, fitting_instructions_url, fitting_instructions_version, fitting_instructions_version_date, fit_data_source, needs_clinical_review, reviewed_by_email, reviewed_at, catalog_version, notes";

function tenant(req: { orgId?: string }): string | null {
  const orgId = req.orgId;
  return orgId && orgId.trim() ? orgId : null;
}

router.get(
  "/admin/fitter/catalog",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "mask_catalog.list", preset: "query" }),
  async (req, res) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const q = parsed.data;

    // The review queue is TENANT state, not the platform flag. Filtering
    // on `mask_models.needs_clinical_review` would be a queue nobody can
    // ever empty: that column belongs to the shared row and this tenant
    // has no write access to it. So resolve which models still have a
    // size band THIS tenant has not signed off, and filter on that.
    let pendingModelIds: string[] | null = null;
    if (q.needsReview) {
      const pending = await pendingReviewModelIds(orgId);
      if (pending.error) {
        res
          .status(500)
          .json({ error: "query_failed", message: pending.error.message });
        return;
      }
      pendingModelIds = pending.modelIds;
      if (pendingModelIds.length === 0) {
        res.json({ models: [], limit: q.limit, offset: q.offset });
        return;
      }
    }

    // "Only what we dispense". Resolved BEFORE the catalog read so a
    // model-targeted formulary can narrow the query itself; a
    // manufacturer-level allow is applied to the returned rows below.
    let dispensed: Awaited<ReturnType<typeof dispensedModelIds>> | null = null;
    if (q.dispensedOnly) {
      dispensed = await dispensedModelIds(orgId);
      if (dispensed.error) {
        res
          .status(500)
          .json({ error: "query_failed", message: dispensed.error.message });
        return;
      }
      // Narrow by id only when there is no manufacturer-level allow to
      // honour — combining them here would drop the manufacturer's other
      // models before they are ever read.
      if (dispensed.modelIds && dispensed.manufacturers.length === 0) {
        if (dispensed.modelIds.length === 0) {
          res.json({
            models: [],
            limit: q.limit,
            offset: q.offset,
            dispensingConfigured: true,
          });
          return;
        }
        pendingModelIds = pendingModelIds
          ? pendingModelIds.filter((id) => dispensed!.modelIds!.includes(id))
          : dispensed.modelIds;
        if (pendingModelIds.length === 0) {
          res.json({
            models: [],
            limit: q.limit,
            offset: q.offset,
            dispensingConfigured: true,
          });
          return;
        }
      }
    }

    // Reference catalog: platform rows (org_id NULL) plus this tenant's own.
    let query = getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("mask_models")
      .select(MODEL_COLUMNS)
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .order("manufacturer", { ascending: true })
      .order("model_name", { ascending: true })
      .range(q.offset, q.offset + q.limit - 1);

    if (q.manufacturer) query = query.eq("manufacturer", q.manufacturer);
    if (q.interfaceType) query = query.eq("interface_type", q.interfaceType);
    if (q.serviceLine) query = query.eq("service_line", q.serviceLine);
    if (q.status) query = query.eq("status", q.status);
    if (pendingModelIds) query = query.in("id", pendingModelIds);
    if (q.search) query = query.ilike("model_name", `%${q.search}%`);

    const { data, error } = (await query) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }

    // The badge has to agree with the filter, so it reports the same
    // tenant-effective state rather than the shared flag.
    const pendingSet =
      pendingModelIds !== null
        ? new Set(pendingModelIds)
        : await (async () => {
            const pending = await pendingReviewModelIds(orgId);
            return pending.error ? null : new Set(pending.modelIds);
          })();

    let rows = data ?? [];
    if (q.dispensedOnly && dispensed?.modelIds) {
      const ids = new Set(dispensed.modelIds);
      const makers = new Set(dispensed.manufacturers);
      rows = rows.filter(
        (row) =>
          ids.has(String(row.id)) || makers.has(String(row.manufacturer)),
      );
    }

    res.json({
      models: rows.map((row) => mapModel(row, pendingSet?.has(String(row.id)))),
      limit: q.limit,
      offset: q.offset,
      // False means the tenant has configured neither a formulary nor
      // stock, so `dispensedOnly` could not narrow anything. The console
      // uses this to explain an unfiltered list instead of silently
      // ignoring the toggle.
      dispensingConfigured: dispensed ? dispensed.modelIds !== null : undefined,
    });
  },
);

/**
 * Models with at least one `current` size band that still needs clinical
 * review FOR THIS TENANT — the shared flag is set and this tenant has no
 * approved `mask_variant_reviews` row for it.
 *
 * Done in two reads rather than one join because PostgREST cannot express
 * an anti-join across the tenant boundary here: `mask_size_variants` is
 * shared reference data reached through `.raw()`, while
 * `mask_variant_reviews` is org-scoped. Both sets are small (~250 seeded
 * variants), so the cost is a rounding error on an admin page load.
 */
/**
 * The models this tenant actually dispenses.
 *
 * Why the sign-off queue needs this: the catalog ships ~290 estimated
 * size bands across ~86 models, and the activation runbook is explicit
 * that "a tenant only needs the models it actually dispenses". Until now
 * the console had no way to express that, so every reviewer faced the
 * whole platform catalog — which is the difference between an afternoon
 * and a project, and therefore the difference between the clinical
 * fitter being switched on and not.
 *
 * Two independent org-scoped signals count as "we dispense this", because
 * a tenant may have configured either one and neither is mandatory:
 *
 *   1. a formulary rule that ALLOWS or PREFERS the model — targeted at
 *      the model itself, or at its manufacturer;
 *   2. stock: a `mask_availability` row that is anything other than
 *      explicitly not carried.
 *
 * Deliberately NOT included: 'deny' rules (the opposite signal) and
 * 'not_stocked' / 'out' availability. A denied model is one a reviewer
 * has the least reason to spend time on.
 *
 * Returns `null` for `modelIds` when the tenant has configured NEITHER
 * signal. That is not the same as "dispenses nothing" — it is "we cannot
 * tell" — and the caller must fall back to the whole catalog rather than
 * showing a brand-new tenant an empty queue they will read as a broken
 * page.
 */
async function dispensedModelIds(orgId: string): Promise<{
  modelIds: string[] | null;
  manufacturers: string[];
  error: { message: string } | null;
}> {
  const supabase = getOrgScopedClient(orgId);
  const [rules, availability] = await Promise.all([
    supabase
      .from("formulary_rules")
      .select("target_kind, target_mask_model_id, target_manufacturer, effect")
      .in("effect", ["allow", "prefer"])
      .limit(20000),
    supabase
      .from("mask_availability")
      .select("mask_model_id, availability")
      .in("availability", ["in_stock", "low", "special_order"])
      .limit(20000),
  ]);

  const rulesResult = rules as unknown as {
    data: Row[] | null;
    error: { message: string } | null;
  };
  const availabilityResult = availability as unknown as {
    data: Row[] | null;
    error: { message: string } | null;
  };
  const error = rulesResult.error ?? availabilityResult.error;
  if (error) return { modelIds: null, manufacturers: [], error };

  const modelIds = new Set<string>();
  const manufacturers = new Set<string>();
  for (const r of rulesResult.data ?? []) {
    if (r.target_mask_model_id) {
      modelIds.add(String(r.target_mask_model_id));
    } else if (r.target_manufacturer) {
      // A manufacturer-level allow means every model from that maker, so
      // it is resolved by the caller against the rows it is already
      // reading rather than by a second catalog query here.
      manufacturers.add(String(r.target_manufacturer));
    }
  }
  for (const a of availabilityResult.data ?? []) {
    if (a.mask_model_id) modelIds.add(String(a.mask_model_id));
  }

  if (modelIds.size === 0 && manufacturers.size === 0) {
    return { modelIds: null, manufacturers: [], error: null };
  }
  return {
    modelIds: [...modelIds],
    manufacturers: [...manufacturers],
    error: null,
  };
}

async function pendingReviewModelIds(orgId: string): Promise<{
  modelIds: string[];
  error: { message: string } | null;
}> {
  const supabase = getOrgScopedClient(orgId);
  const [unreviewed, approvals] = await Promise.all([
    supabase
      .raw()
      .schema("resupply")
      .from("mask_size_variants")
      .select("id, mask_model_id")
      .eq("needs_clinical_review", true)
      .eq("status", "current")
      .limit(20000),
    supabase
      .from("mask_variant_reviews")
      .select("size_variant_id")
      .eq("approved", true)
      .limit(20000),
  ]);

  const unreviewedResult = unreviewed as {
    data: Row[] | null;
    error: { message: string } | null;
  };
  const approvalsResult = approvals as unknown as {
    data: Row[] | null;
    error: { message: string } | null;
  };
  const error = unreviewedResult.error ?? approvalsResult.error;
  if (error) return { modelIds: [], error };

  const approved = new Set(
    (approvalsResult.data ?? []).map((r) => String(r.size_variant_id)),
  );
  const modelIds = new Set<string>();
  for (const v of unreviewedResult.data ?? []) {
    if (!approved.has(String(v.id))) modelIds.add(String(v.mask_model_id));
  }
  return { modelIds: [...modelIds], error: null };
}

router.get(
  "/admin/fitter/catalog/:id",
  requireAdmin,
  requirePermission("clinical.read"),
  adminRateLimit({ name: "mask_catalog.detail", preset: "query" }),
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
    const client = getOrgScopedClient(orgId);
    const supabase = client.raw().schema("resupply");

    const [model, variants, components, contras, reviews] = await Promise.all([
      supabase
        .from("mask_models")
        .select(MODEL_COLUMNS)
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq("id", id.data)
        .limit(1)
        .maybeSingle(),
      supabase
        .from("mask_size_variants")
        .select("*")
        .eq("mask_model_id", id.data)
        .order("component", { ascending: true })
        .order("sort_order", { ascending: true }),
      supabase.from("mask_components").select("*").eq("mask_model_id", id.data),
      supabase
        .from("mask_contraindications")
        .select("*")
        .eq("mask_model_id", id.data),
      // This tenant's sign-off rows, so the table shows who cleared each
      // size and when — for this DME only.
      client
        .from("mask_variant_reviews")
        .select(
          "size_variant_id, approved, reviewed_by_email, reviewed_at, source_kind, source_ref",
        )
        .limit(20000),
    ]);

    const modelRow = (model as { data: Row | null }).data;
    if (!modelRow) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const reviewByVariant = new Map<string, Row>();
    for (const r of ((reviews as unknown as { data: Row[] | null }).data ??
      []) as Row[]) {
      reviewByVariant.set(String(r.size_variant_id), r);
    }
    const variantRows = (variants as { data: Row[] | null }).data ?? [];
    const pendingHere = variantRows.some(
      (v) =>
        v.status === "current" &&
        v.needs_clinical_review === true &&
        reviewByVariant.get(String(v.id))?.approved !== true,
    );

    res.json({
      model: mapModel(modelRow, pendingHere),
      variants: variantRows.map((v) =>
        mapVariant(v, reviewByVariant.get(String(v.id))),
      ),
      components: (components as { data: Row[] | null }).data ?? [],
      contraindications: (contras as { data: Row[] | null }).data ?? [],
      editable: modelRow.org_id === orgId,
    });
  },
);

router.patch(
  "/admin/fitter/catalog/:id",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "mask_catalog.update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = modelPatch.safeParse(req.body);
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

    const patch: Record<string, unknown> = {};
    const b = body.data;
    if (b.status !== undefined) patch.status = b.status;
    if (b.discontinuedOn !== undefined)
      patch.discontinued_on = b.discontinuedOn;
    if (b.successorSlug !== undefined) patch.successor_slug = b.successorSlug;
    if (b.hasMagneticComponents !== undefined) {
      patch.has_magnetic_components = b.hasMagneticComponents;
    }
    if (b.magneticComponentNotes !== undefined) {
      patch.magnetic_component_notes = b.magneticComponentNotes;
    }
    if (b.vented !== undefined) patch.vented = b.vented;
    if (b.therapyModes !== undefined) patch.therapy_modes = b.therapyModes;
    if (b.serviceLine !== undefined) patch.service_line = b.serviceLine;
    if (b.pressureMinCmH2O !== undefined) {
      patch.pressure_min_cm_h2o = b.pressureMinCmH2O;
    }
    if (b.pressureMaxCmH2O !== undefined) {
      patch.pressure_max_cm_h2o = b.pressureMaxCmH2O;
    }
    if (b.supportsSupplementalOxygen !== undefined) {
      patch.supports_supplemental_oxygen = b.supportsSupplementalOxygen;
    }
    if (b.minimalContact !== undefined)
      patch.minimal_contact = b.minimalContact;
    if (b.avoidsNasalBridge !== undefined) {
      patch.avoids_nasal_bridge = b.avoidsNasalBridge;
    }
    if (b.facialHairTolerance !== undefined) {
      patch.facial_hair_tolerance = b.facialHairTolerance;
    }
    if (b.sideSleepingTolerance !== undefined) {
      patch.side_sleeping_tolerance = b.sideSleepingTolerance;
    }
    if (b.claustrophobiaTolerance !== undefined) {
      patch.claustrophobia_tolerance = b.claustrophobiaTolerance;
    }
    if (b.glassesCompatible !== undefined) {
      patch.glasses_compatible = b.glassesCompatible;
    }
    if (b.fittingInstructionsUrl !== undefined) {
      patch.fitting_instructions_url = b.fittingInstructionsUrl;
    }
    if (b.fittingInstructionsVersion !== undefined) {
      patch.fitting_instructions_version = b.fittingInstructionsVersion;
    }
    if (b.fittingInstructionsVersionDate !== undefined) {
      patch.fitting_instructions_version_date =
        b.fittingInstructionsVersionDate;
    }
    if (b.notes !== undefined) patch.notes = b.notes;

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "no_fields_to_update" });
      return;
    }
    patch.updated_at = new Date().toISOString();

    const supabase = getOrgScopedClient(orgId).raw().schema("resupply");

    // Only this tenant's own private models are editable. The shared
    // platform catalog is not writable from a tenant console — read the
    // row first so "you don't own this" is a 403 rather than a silent
    // zero-row update reported as success.
    const { data: existing, error: readError } = (await supabase
      .from("mask_models")
      .select("id, org_id, catalog_version")
      .or(`org_id.is.null,org_id.eq.${orgId}`)
      .eq("id", id.data)
      .limit(1)
      .maybeSingle()) as {
      data: Row | null;
      error: { message: string } | null;
    };
    if (readError) {
      res
        .status(500)
        .json({ error: "query_failed", message: readError.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.org_id !== orgId) {
      res.status(403).json({
        error: "platform_row_read_only",
        message:
          "This is a shared platform mask. Sign off its sizes for your " +
          "organization instead, or add a private copy to edit.",
      });
      return;
    }

    // Every clinically-material edit bumps the catalog version, which is
    // what each fit report stamps — so a report can be tied back to the
    // exact product facts that produced it. `notes` is the one field that
    // is purely operator bookkeeping, so an edit touching nothing else
    // leaves the version alone.
    const substantive = Object.keys(patch).some(
      (k) => k !== "notes" && k !== "updated_at",
    );
    if (substantive) {
      patch.catalog_version = Number(existing.catalog_version ?? 1) + 1;
    }

    const { error } = (await supabase
      .from("mask_models")
      .update(patch)
      .eq("org_id", orgId)
      .eq("id", id.data)) as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({
      ok: true,
      catalogVersion: substantive
        ? Number(existing.catalog_version ?? 1) + 1
        : Number(existing.catalog_version ?? 1),
    });
  },
);

router.patch(
  "/admin/fitter/catalog/variants/:id",
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "mask_catalog.variant_update", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = bandPatch.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const b = body.data;
    const supabase = getOrgScopedClient(orgId).raw().schema("resupply");

    // Size variants hang off `mask_models`, which is SHARED reference
    // data — so ownership is the parent model's. Without this check a
    // tenant could rewrite the millimetre bands every other tenant's
    // engine fits against.
    const { data: existing, error: readError } = (await supabase
      .from("mask_size_variants")
      .select(
        "id, mask_model_id, nose_width_min_mm, nose_width_max_mm, nose_height_min_mm, nose_height_max_mm, nose_to_chin_min_mm, nose_to_chin_max_mm, mouth_width_min_mm, mouth_width_max_mm, face_width_min_mm, face_width_max_mm, fit_data_source, fit_data_source_ref, mask_models!inner(org_id)",
      )
      .eq("id", id.data)
      .limit(1)
      .maybeSingle()) as {
      data: (Row & { mask_models?: { org_id: string | null } }) | null;
      error: { message: string } | null;
    };
    if (readError) {
      res
        .status(500)
        .json({ error: "query_failed", message: readError.message });
      return;
    }
    if (!existing) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (existing.mask_models?.org_id !== orgId) {
      res.status(403).json({
        error: "platform_row_read_only",
        message:
          "These measurement ranges belong to the shared platform catalog " +
          "and are the same data every other organization fits against. " +
          "Sign the size off for your organization instead, or add a " +
          "private copy of the mask to edit its ranges.",
      });
      return;
    }

    const patch: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };
    const map: Record<string, string> = {
      noseWidthMinMm: "nose_width_min_mm",
      noseWidthMaxMm: "nose_width_max_mm",
      noseHeightMinMm: "nose_height_min_mm",
      noseHeightMaxMm: "nose_height_max_mm",
      noseToChinMinMm: "nose_to_chin_min_mm",
      noseToChinMaxMm: "nose_to_chin_max_mm",
      mouthWidthMinMm: "mouth_width_min_mm",
      mouthWidthMaxMm: "mouth_width_max_mm",
      faceWidthMinMm: "face_width_min_mm",
      faceWidthMaxMm: "face_width_max_mm",
      fitDataSource: "fit_data_source",
      fitDataSourceRef: "fit_data_source_ref",
      fitDataSourceDate: "fit_data_source_date",
    };
    for (const [key, column] of Object.entries(map)) {
      const value = (b as Record<string, unknown>)[key];
      if (value !== undefined) patch[column] = value;
    }

    // Validate the band the row will END UP with, not just the fields in
    // this request. Editing one endpoint of a stored pair — raising a
    // minimum above the maximum already on the row — is the easy way to
    // author a band no patient can ever match, and checking only the
    // submitted fields waves it straight through.
    for (const [minCol, maxCol] of [
      ["nose_width_min_mm", "nose_width_max_mm"],
      ["nose_height_min_mm", "nose_height_max_mm"],
      ["nose_to_chin_min_mm", "nose_to_chin_max_mm"],
      ["mouth_width_min_mm", "mouth_width_max_mm"],
      ["face_width_min_mm", "face_width_max_mm"],
    ] as const) {
      const min = numOrNull(
        minCol in patch ? patch[minCol] : (existing as Row)[minCol],
      );
      const max = numOrNull(
        maxCol in patch ? patch[maxCol] : (existing as Row)[maxCol],
      );
      if (min !== null && max !== null && min >= max) {
        res.status(400).json({
          error: "invalid_band",
          field: minCol,
          message:
            `${minCol.replace(/_/g, " ")} (${min}) must stay below ` +
            `${maxCol.replace(/_/g, " ")} (${max}). A size whose minimum ` +
            "is above its maximum matches no patient at all.",
        });
        return;
      }
      // Plausibility: a band entirely outside the window any face
      // measurement can produce (the classic slip is centimetres typed
      // into a millimetre field — 3.2–4.1 instead of 32–41) is never
      // rejected downstream. The engine still scores it: every patient
      // lands far outside, the size scores ~0 with inBand=false, and the
      // mask is silently de-ranked for everyone with nothing telling the
      // operator the band is physically unreachable.
      const [windowLo, windowHi] =
        UNION_PLAUSIBILITY_BOUNDS[PLAUSIBILITY_FIELD_OF_COLUMN[minCol]];
      for (const [col, value] of [
        [minCol, min],
        [maxCol, max],
      ] as const) {
        if (value !== null && (value < windowLo || value > windowHi)) {
          res.status(422).json({
            error: "implausible_band",
            field: col,
            message:
              `${col.replace(/_/g, " ")} (${value} mm) is outside the ` +
              `${windowLo}–${windowHi} mm range any face measurement can ` +
              "produce" +
              (value > 0 && value < windowLo / 2
                ? " — the value looks like centimetres typed into a millimetre field"
                : "") +
              ".",
          });
          return;
        }
      }
    }

    // Claiming manufacturer or measured provenance requires a citation —
    // the 0495 CHECK enforces it in the database, and this pre-check turns
    // the constraint violation into an actionable 422. Evaluate the state
    // the row will END UP in, same as the band validation above: the ref
    // may already be stored, or may be arriving (or being cleared) in this
    // very patch.
    const endSource =
      "fit_data_source" in patch
        ? patch.fit_data_source
        : (existing as Row).fit_data_source;
    const endRef =
      "fit_data_source_ref" in patch
        ? patch.fit_data_source_ref
        : (existing as Row).fit_data_source_ref;
    if (
      endSource !== "estimated" &&
      (endRef == null || String(endRef).trim() === "")
    ) {
      res.status(422).json({
        error: "source_ref_required",
        message:
          "A band marked as manufacturer or measured data must cite its " +
          "source (document title + revision, URL, or how it was " +
          "measured). Keep fitDataSource as 'estimated' if there is " +
          "nothing to cite.",
      });
      return;
    }

    const { error } = (await supabase
      .from("mask_size_variants")
      .update(patch)
      .eq("id", id.data)) as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
  },
);

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n =
    typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(n) ? n : null;
}

router.post(
  "/admin/fitter/catalog/variants/:id/review",
  // Pre-auth IP bucket FIRST: `requireAdmin` does a DB-backed session
  // lookup, so a limiter placed only after it leaves that read exposed to
  // an unauthenticated flood. The tighter per-actor budget layers on top.
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "mask_catalog.variant_review", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const id = z.string().trim().uuid().safeParse(req.params.id);
    const body = reviewBody.safeParse(req.body);
    if (!id.success || !body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }

    const client = getOrgScopedClient(orgId);

    // Confirm the size exists and is one this tenant can see at all
    // (shared, or its own) before recording an opinion about it.
    const { data: variant, error: readError } = (await client
      .raw()
      .schema("resupply")
      .from("mask_size_variants")
      .select("id, mask_models!inner(org_id)")
      .eq("id", id.data)
      .limit(1)
      .maybeSingle()) as {
      data: { mask_models?: { org_id: string | null } } | null;
      error: { message: string } | null;
    };
    if (readError) {
      res
        .status(500)
        .json({ error: "query_failed", message: readError.message });
      return;
    }
    const ownerOrgId = variant?.mask_models?.org_id;
    if (!variant || (ownerOrgId !== null && ownerOrgId !== orgId)) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    // Sign-off records this tenant's clinical verification of the band
    // (report provenance — no longer a confidence cap; see the header),
    // and it lands in a TENANT-scoped row rather than clearing the shared
    // `mask_size_variants.needs_clinical_review` flag. One DME's RT
    // reviewing the sizes that DME stocks must not silently speak for
    // every other DME on the same shared geometry.
    // `org_id` is forced on by the org-scoped facade — see `tag()` in
    // lib/resupply-db/src/org-scoped-client.ts.
    const { error } = (await client
      .from("mask_variant_reviews")
      .upsert(reviewRow(id.data, body.data, req.adminEmail ?? null), {
        onConflict: "org_id,size_variant_id",
      })) as unknown as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true, approved: body.data.approved });
  },
);

/**
 * Sign off several size bands at once — in practice, a whole model's size
 * run in one action.
 *
 * Identical in consequence to the single-variant route above (it records
 * this tenant's clinical verification of every id it touches), so it
 * carries the same `formulary.manage` gate and the same tenant-scoped
 * write. The only
 * difference is that the ownership check is done set-wise: every id must
 * resolve to a variant this tenant can see, and if ANY does not the whole
 * request is refused rather than partially applied. A reviewer who is told
 * "42 signed off" needs that to mean 42, not "42 of the 47 you selected".
 */
router.post(
  "/admin/fitter/catalog/variants/review-batch",
  adminWriteRateLimiter,
  requireAdmin,
  requirePermission("formulary.manage"),
  adminRateLimit({ name: "mask_catalog.review_batch", preset: "mutation" }),
  async (req, res) => {
    const orgId = tenant(req);
    if (!orgId) {
      res.status(500).json({ error: "tenant_context_missing" });
      return;
    }
    const body = reviewBatchBody.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid_body" });
      return;
    }
    const ids = [...new Set(body.data.variantIds)];

    const client = getOrgScopedClient(orgId);

    const { data: rows, error: readError } = (await client
      .raw()
      .schema("resupply")
      .from("mask_size_variants")
      .select("id, mask_models!inner(org_id)")
      .in("id", ids)) as {
      data: Array<{
        id: string;
        mask_models?: { org_id: string | null };
      }> | null;
      error: { message: string } | null;
    };
    if (readError) {
      res
        .status(500)
        .json({ error: "query_failed", message: readError.message });
      return;
    }

    const visible = new Set(
      (rows ?? [])
        .filter((r) => {
          const owner = r.mask_models?.org_id;
          return owner === null || owner === undefined || owner === orgId;
        })
        .map((r) => String(r.id)),
    );
    const unknown = ids.filter((id) => !visible.has(id));
    if (unknown.length > 0) {
      res
        .status(404)
        .json({ error: "not_found", unknownCount: unknown.length });
      return;
    }

    const reviewedByEmail = req.adminEmail ?? null;
    const { error } = (await client.from("mask_variant_reviews").upsert(
      ids.map((id) => reviewRow(id, body.data, reviewedByEmail)),
      { onConflict: "org_id,size_variant_id" },
    )) as unknown as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true, approved: body.data.approved, count: ids.length });
  },
);

/** One `mask_variant_reviews` row. `org_id` is forced on by the org-scoped
 *  facade — see `tag()` in lib/resupply-db/src/org-scoped-client.ts. */
function reviewRow(
  sizeVariantId: string,
  body: z.infer<typeof reviewBody>,
  reviewedByEmail: string | null,
): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    size_variant_id: sizeVariantId,
    approved: body.approved,
    reviewed_by_email: reviewedByEmail,
    reviewed_at: now,
    note: body.note ?? null,
    source_kind: body.sourceKind ?? null,
    source_ref: body.sourceRef ?? null,
    updated_at: now,
  };
}

/**
 * @param pendingReview tenant-effective review state — true when this
 *   tenant still has an unsigned size band on the model. Falls back to the
 *   platform flag when the caller could not compute it.
 */
function mapModel(row: Row, pendingReview?: boolean) {
  return {
    id: String(row.id),
    isPlatformRow: row.org_id === null,
    slug: row.slug,
    manufacturer: row.manufacturer,
    modelName: row.model_name,
    productLine: row.product_line,
    interfaceType: row.interface_type,
    serviceLine: row.service_line,
    therapyModes: row.therapy_modes,
    vented: row.vented,
    hasMagneticComponents: row.has_magnetic_components,
    magneticComponentNotes: row.magnetic_component_notes,
    magnetFreeVariantSlug: row.magnet_free_variant_slug,
    pressureMinCmH2O: row.pressure_min_cm_h2o,
    pressureMaxCmH2O: row.pressure_max_cm_h2o,
    supportsSupplementalOxygen: row.supports_supplemental_oxygen,
    minimalContact: row.minimal_contact,
    avoidsNasalBridge: row.avoids_nasal_bridge,
    hosePosition: row.hose_position,
    facialHairTolerance: row.facial_hair_tolerance,
    sideSleepingTolerance: row.side_sleeping_tolerance,
    claustrophobiaTolerance: row.claustrophobia_tolerance,
    glassesCompatible: row.glasses_compatible,
    cushionMaterial: row.cushion_material,
    headgearStyle: row.headgear_style,
    weightGrams: row.weight_grams,
    description: row.description,
    imageUrl: row.image_url,
    status: row.status,
    discontinuedOn: row.discontinued_on,
    successorSlug: row.successor_slug,
    fittingInstructionsUrl: row.fitting_instructions_url,
    fittingInstructionsVersion: row.fitting_instructions_version,
    fittingInstructionsVersionDate: row.fitting_instructions_version_date,
    fitDataSource: row.fit_data_source,
    needsClinicalReview: pendingReview ?? row.needs_clinical_review,
    reviewedByEmail: row.reviewed_by_email,
    reviewedAt: row.reviewed_at,
    catalogVersion: row.catalog_version,
    notes: row.notes,
  };
}

/**
 * @param review this tenant's sign-off row, when it has one. The exposed
 *   `needsClinicalReview` is the tenant-effective value — the shared flag
 *   AND-ed with the absence of a local approval — because that is what the
 *   engine acts on for this org.
 */
function mapVariant(row: Row, review?: Row) {
  return {
    id: String(row.id),
    component: row.component,
    sizeCode: row.size_code,
    sizeLabel: row.size_label,
    sortOrder: row.sort_order,
    noseWidthMinMm: row.nose_width_min_mm,
    noseWidthMaxMm: row.nose_width_max_mm,
    noseHeightMinMm: row.nose_height_min_mm,
    noseHeightMaxMm: row.nose_height_max_mm,
    noseToChinMinMm: row.nose_to_chin_min_mm,
    noseToChinMaxMm: row.nose_to_chin_max_mm,
    mouthWidthMinMm: row.mouth_width_min_mm,
    mouthWidthMaxMm: row.mouth_width_max_mm,
    faceWidthMinMm: row.face_width_min_mm,
    faceWidthMaxMm: row.face_width_max_mm,
    isDefault: row.is_default,
    hcpcsCode: row.hcpcs_code,
    manufacturerPartNumber: row.manufacturer_part_number ?? null,
    status: row.status,
    fitDataSource: row.fit_data_source,
    // Platform-band provenance (0495). NULL on an estimated band means
    // "nothing to cite", never "unrecorded".
    fitDataSourceRef: row.fit_data_source_ref ?? null,
    fitDataSourceDate: row.fit_data_source_date ?? null,
    needsClinicalReview:
      row.needs_clinical_review === true && review?.approved !== true,
    reviewedByEmail: review?.reviewed_by_email ?? null,
    reviewedAt: review?.reviewed_at ?? null,
    // Provenance (0491). NULL on sign-offs recorded before the columns
    // existed — the UI shows "source not recorded" rather than inventing one.
    reviewSourceKind: review?.source_kind ?? null,
    reviewSourceRef: review?.source_ref ?? null,
  };
}

export default router;
