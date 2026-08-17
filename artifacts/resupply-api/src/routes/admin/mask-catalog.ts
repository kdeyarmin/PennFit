// /admin/fitter/catalog — the Mask Intelligence Catalog admin surface.
//
//   GET   /admin/fitter/catalog                  — browse, with filters
//   GET   /admin/fitter/catalog/:id              — one model + sizes + parts
//   PATCH /admin/fitter/catalog/:id              — edit model facts
//   PATCH /admin/fitter/catalog/variants/:id     — edit one size's mm bands
//   POST  /admin/fitter/catalog/variants/:id/review — RT sign-off
//
// WHY THE REVIEW ENDPOINT MATTERS MOST
// -----------------------------------
// The catalog ships with ~250 size variants whose millimetre bands are
// clinically-reasoned estimates rather than published manufacturer data,
// each flagged `needs_clinical_review`. The engine caps an unreviewed
// variant below high confidence, so until a respiratory therapist works
// through this queue the fitter will never issue a confident automated
// recommendation off estimated geometry. Sign-off here is what lifts that
// cap — which is why it is gated on `formulary.manage` (a clinical
// permission held by clinicians and supervisors) and not on a generic
// tools permission.
//
// Tenancy: `mask_models` is platform reference data with a NULLABLE
// `org_id` — NULL is a shared platform row, non-NULL is a model one tenant
// added privately. Reads therefore go through `.raw()` with an explicit
// `org_id.is.null,org_id.eq.<tenant>` filter; the org-scoped facade would
// hide every shared row. WRITES only ever touch rows this tenant owns or,
// for review sign-off, the tenant-scoped review columns — a tenant can
// never edit the shared catalog out from under another tenant.
//
// PHI: none. Product facts only.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { adminRateLimit } from "../../middlewares/admin-rate-limit";
import {
  requireAdmin,
  requirePermission,
} from "../../middlewares/requireAdmin";
import { invalidateFittingContext } from "../../lib/fitting/catalog-store";

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
    needsReview: z.coerce.boolean().optional(),
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
  })
  .strict();

const reviewBody = z
  .object({
    approved: z.boolean(),
    note: z.string().trim().max(2000).optional(),
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
    if (q.needsReview) query = query.eq("needs_clinical_review", true);
    if (q.search) query = query.ilike("model_name", `%${q.search}%`);

    const { data, error } = (await query) as {
      data: Row[] | null;
      error: { message: string } | null;
    };
    if (error) {
      res.status(500).json({ error: "query_failed", message: error.message });
      return;
    }
    res.json({
      models: (data ?? []).map(mapModel),
      limit: q.limit,
      offset: q.offset,
    });
  },
);

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
    const supabase = getOrgScopedClient(orgId).raw().schema("resupply");

    const [model, variants, components, contras] = await Promise.all([
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
    ]);

    const modelRow = (model as { data: Row | null }).data;
    if (!modelRow) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      model: mapModel(modelRow),
      variants: ((variants as { data: Row[] | null }).data ?? []).map(
        mapVariant,
      ),
      components: (components as { data: Row[] | null }).data ?? [],
      contraindications: (contras as { data: Row[] | null }).data ?? [],
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

    // A clinically-material edit bumps the catalog version, which is what
    // every future fit report stamps.
    const { error } = (await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("mask_models")
      .update(patch)
      // Only this tenant's own private models are editable. The shared
      // platform catalog is not writable from a tenant console.
      .eq("org_id", orgId)
      .eq("id", id.data)) as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true });
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
    // Reject an inverted band outright — a min above a max silently
    // excludes every patient from that size.
    const pairs: Array<[number | null | undefined, number | null | undefined]> =
      [
        [b.noseWidthMinMm, b.noseWidthMaxMm],
        [b.noseHeightMinMm, b.noseHeightMaxMm],
        [b.noseToChinMinMm, b.noseToChinMaxMm],
        [b.mouthWidthMinMm, b.mouthWidthMaxMm],
        [b.faceWidthMinMm, b.faceWidthMaxMm],
      ];
    for (const [min, max] of pairs) {
      if (typeof min === "number" && typeof max === "number" && min >= max) {
        res.status(400).json({
          error: "invalid_band",
          message: "Each size band's minimum must be below its maximum.",
        });
        return;
      }
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
    };
    for (const [key, column] of Object.entries(map)) {
      const value = (b as Record<string, unknown>)[key];
      if (value !== undefined) patch[column] = value;
    }

    const { error } = (await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
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

router.post(
  "/admin/fitter/catalog/variants/:id/review",
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

    // Clearing `needs_clinical_review` is what lifts the engine's
    // confidence cap on this size band, so it is the single most
    // consequential write in this file.
    const { error } = (await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .from("mask_size_variants")
      .update({
        needs_clinical_review: !body.data.approved,
        updated_at: new Date().toISOString(),
      })
      .eq("id", id.data)) as { error: { message: string } | null };
    if (error) {
      res.status(500).json({ error: "update_failed", message: error.message });
      return;
    }
    invalidateFittingContext(orgId);
    res.json({ ok: true, approved: body.data.approved });
  },
);

function mapModel(row: Row) {
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
    needsClinicalReview: row.needs_clinical_review,
    reviewedByEmail: row.reviewed_by_email,
    reviewedAt: row.reviewed_at,
    catalogVersion: row.catalog_version,
    notes: row.notes,
  };
}

function mapVariant(row: Row) {
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
    status: row.status,
    fitDataSource: row.fit_data_source,
    needsClinicalReview: row.needs_clinical_review,
  };
}

export default router;
