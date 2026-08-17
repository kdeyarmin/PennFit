/**
 * Catalog + formulary loading — the ONLY impure module in `lib/fitting/`.
 *
 * Everything else here is pure and takes its data as arguments. This file
 * is what fetches that data, and it is imported by routes, never by the
 * tier modules.
 *
 * Posture mirrors `lib/tenant-branding.ts`, deliberately:
 *   * short TTL cache, so a public per-fitting read adds no real DB load;
 *   * a hard lookup timeout, so a slow database cannot hang a patient;
 *   * FAIL SOFT — any error or timeout degrades to the built-in static
 *     catalog and a fully open formulary, and the caller stamps
 *     `degraded: true` on the session and the report.
 *
 * That last point is the service-boot contract: the storefront must never
 * hard-depend on the database. A patient mid-fitting during a Postgres
 * hiccup gets the pre-existing behaviour, not a 500.
 */

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { maskCatalog, type MaskEntry } from "../../data/maskCatalog.js";
import { OPEN_FORMULARY } from "./formulary.js";
import type {
  CatalogMask,
  Formulary,
  FormularyRule,
  InterfaceType,
  MaskAvailability,
  SafetyScreen,
  SizeVariant,
  TherapyMode,
  Tolerance,
} from "./types.js";

const CACHE_TTL_MS = 60_000;
const LOOKUP_TIMEOUT_MS = 1_500;

export interface FittingContext {
  catalog: CatalogMask[];
  formulary: Formulary;
  availability: Record<string, MaskAvailability>;
  safetyScreen: SafetyScreen | null;
  /** True when any part of the load failed and a fallback is in play. */
  degraded: boolean;
}

class LookupTimeout extends Error {
  constructor() {
    super("fitting_catalog_lookup_timeout");
    this.name = "LookupTimeout";
  }
}

async function withTimeout<T>(p: PromiseLike<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LookupTimeout()), LOOKUP_TIMEOUT_MS);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── Static fallback ──────────────────────────────────────────────────

const LEGACY_INTERFACE: Record<string, InterfaceType> = {
  fullFace: "full_face",
  nasal: "nasal",
  nasalPillow: "nasal_pillow",
  hybrid: "hybrid",
};

/**
 * Project the built-in TypeScript catalog into the engine's shape.
 *
 * Used when the database is unreachable, and when a tenant has not turned
 * the DB catalog on. The size bands are the same linear partition the
 * previous engine used, so the degraded path reproduces the old behaviour
 * rather than inventing a different one.
 */
export function staticCatalogAsMasks(
  entries: readonly MaskEntry[] = maskCatalog,
): CatalogMask[] {
  return entries.map((e) => {
    const interfaceType = LEGACY_INTERFACE[e.type] ?? "nasal";
    const sizes = e.sizesAvailable.length > 0 ? e.sizesAvailable : ["Standard"];
    const axisIsNose =
      interfaceType === "nasal" || interfaceType === "nasal_pillow";
    const range = axisIsNose
      ? ([e.fitRanges.noseWidthMin, e.fitRanges.noseWidthMax] as const)
      : ([e.fitRanges.noseToChinMin, e.fitRanges.noseToChinMax] as const);

    const variants: SizeVariant[] = sizes.map((size, i) => {
      const width = (range[1] - range[0]) / sizes.length;
      const lo = range[0] + width * i;
      const hi = lo + width;
      return {
        id: `${e.id}:${size}`,
        component: interfaceType === "nasal_pillow" ? "pillow" : "cushion",
        sizeCode: size,
        sizeLabel: size,
        sortOrder: i * 10,
        noseWidthMin: axisIsNose ? round1(lo) : null,
        noseWidthMax: axisIsNose ? round1(hi) : null,
        noseHeightMin: null,
        noseHeightMax: null,
        noseToChinMin: axisIsNose ? null : round1(lo),
        noseToChinMax: axisIsNose ? null : round1(hi),
        mouthWidthMin: null,
        mouthWidthMax: null,
        faceWidthMin: null,
        faceWidthMax: null,
        nostrilWidthMin: null,
        nostrilWidthMax: null,
        isDefault: i === Math.floor(sizes.length / 2),
        hcpcsCode: null,
        status: "current",
        fitDataSource: "estimated",
        needsClinicalReview: true,
      } as SizeVariant;
    });

    const hasMagnets = /magnet/i.test(
      [e.headgearStyle, ...(e.features ?? [])].join(" "),
    );

    return {
      id: e.id,
      slug: e.id,
      manufacturer: e.manufacturer,
      modelName: e.name,
      productLine: null,
      interfaceType,
      serviceLine: "adult",
      therapyModes: ["pap"] as TherapyMode[],
      vented: "vented",
      hasMagneticComponents: hasMagnets,
      magnetFreeVariantSlug: null,
      pressureMin: e.pressureRangeMin,
      pressureMax: e.pressureRangeMax,
      supportsSupplementalOxygen: null,
      minimalContact:
        interfaceType === "nasal_pillow" || e.hoseConnection === "top",
      avoidsNasalBridge: interfaceType === "nasal_pillow",
      hosePosition: e.hoseConnection,
      facialHairTolerance: toleranceFrom(e, "facial hair"),
      sideSleepingTolerance: e.hoseConnection === "top" ? "good" : "fair",
      claustrophobiaTolerance: toleranceFrom(e, "claustrophob"),
      glassesCompatible: e.hoseConnection === "top",
      cushionMaterial: e.cushionMaterial,
      headgearStyle: e.headgearStyle,
      weightGrams: e.weightGrams,
      description: e.description,
      imageUrl: e.imageUrl,
      status: "current",
      fitDataSource: "estimated",
      needsClinicalReview: true,
      catalogVersion: 0,
      variants,
      contraindications: [],
    } satisfies CatalogMask;
  });
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function toleranceFrom(e: MaskEntry, needle: string): Tolerance {
  const text = (e.contraindications ?? []).join(" ").toLowerCase();
  return text.includes(needle) ? "poor" : "fair";
}

// ── DB load ──────────────────────────────────────────────────────────

interface CacheEntry {
  value: FittingContext;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop a tenant's cached context after an admin edits catalog/formulary. */
export function invalidateFittingContext(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

type ModelRow = {
  id: string;
  slug: string;
  manufacturer: string;
  model_name: string;
  product_line: string | null;
  interface_type: InterfaceType;
  service_line: "adult" | "pediatric" | "both";
  therapy_modes: string[] | null;
  vented: "vented" | "non_vented" | "both";
  has_magnetic_components: boolean;
  magnet_free_variant_slug: string | null;
  pressure_min_cm_h2o: number | string | null;
  pressure_max_cm_h2o: number | string | null;
  supports_supplemental_oxygen: boolean | null;
  minimal_contact: boolean;
  avoids_nasal_bridge: boolean;
  hose_position: "front" | "top" | "side" | null;
  facial_hair_tolerance: Tolerance | null;
  side_sleeping_tolerance: Tolerance | null;
  claustrophobia_tolerance: Tolerance | null;
  glasses_compatible: boolean | null;
  cushion_material: string | null;
  headgear_style: string | null;
  weight_grams: number | null;
  description: string | null;
  image_url: string | null;
  status: "current" | "discontinued" | "pre_release";
  fit_data_source: "manufacturer" | "measured" | "estimated";
  needs_clinical_review: boolean;
  catalog_version: number;
};

function num(v: number | string | null): number | null {
  if (v === null) return null;
  const n = typeof v === "number" ? v : Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Load a tenant's fitting context.
 *
 * Never throws. On any failure the caller gets the static catalog, an open
 * formulary, no availability data, and `degraded: true`.
 */
export async function loadFittingContext(
  orgId: string,
): Promise<FittingContext> {
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const value = await loadFromDb(orgId);
    cache.set(orgId, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err : new Error(String(err)), orgId },
      "fitting catalog load failed; falling back to the built-in catalog",
    );
    const fallback: FittingContext = {
      catalog: staticCatalogAsMasks(),
      formulary: OPEN_FORMULARY,
      availability: {},
      safetyScreen: null,
      degraded: true,
    };
    // Cache the fallback briefly too, so a database outage doesn't turn
    // every in-flight fitting into its own timed-out round trip.
    cache.set(orgId, { value: fallback, expiresAt: Date.now() + 10_000 });
    return fallback;
  }
}

/**
 * The org-scoped facade returns an untyped builder, so PostgREST results
 * arrive as `unknown`. Narrow them at the boundary rather than sprinkling
 * casts through the mapping code.
 */
type Result<T> = { data: T | null; error: { message: string } | null };

function asRows(result: unknown): Record<string, unknown>[] {
  const r = result as Result<Record<string, unknown>[]>;
  if (!r || r.error || !Array.isArray(r.data)) return [];
  return r.data;
}

function asRow(result: unknown): Record<string, unknown> | null {
  const r = result as Result<Record<string, unknown>>;
  if (!r || r.error || !r.data) return null;
  return r.data;
}

async function loadFromDb(orgId: string): Promise<FittingContext> {
  const supabase = getOrgScopedClient(orgId);

  // The catalog tables are PLATFORM reference data with a NULLABLE org_id
  // (NULL = platform row, non-NULL = a model this tenant added privately),
  // exactly like resupply.hcpcs_codes. They are reached through `.raw()`
  // because the org-scoped facade would append `org_id = <tenant>` and hide
  // every platform row. The tenant boundary is preserved by the explicit
  // `org_id.is.null,org_id.eq.<tenant>` filter below — a tenant can see the
  // shared catalog and its own additions, never another tenant's.
  const [models, variants, contras, formularyRows, availabilityRows, screen] =
    await Promise.all([
      withTimeout(
        supabase
          .raw()
          .schema("resupply")
          .from("mask_models")
          .select(
            "id, slug, manufacturer, model_name, product_line, interface_type, service_line, therapy_modes, vented, has_magnetic_components, magnet_free_variant_slug, pressure_min_cm_h2o, pressure_max_cm_h2o, supports_supplemental_oxygen, minimal_contact, avoids_nasal_bridge, hose_position, facial_hair_tolerance, side_sleeping_tolerance, claustrophobia_tolerance, glasses_compatible, cushion_material, headgear_style, weight_grams, description, image_url, status, fit_data_source, needs_clinical_review, catalog_version",
          )
          .or(`org_id.is.null,org_id.eq.${orgId}`)
          .neq("status", "pre_release")
          .limit(2000),
      ),
      withTimeout(
        supabase
          .raw()
          .schema("resupply")
          .from("mask_size_variants")
          .select("*")
          .eq("status", "current")
          .limit(5000),
      ),
      withTimeout(
        supabase
          .raw()
          .schema("resupply")
          .from("mask_contraindications")
          .select("mask_model_id, factor, severity, rationale")
          .limit(5000),
      ),
      withTimeout(
        supabase
          .from("formularies")
          .select("id, name, version, default_posture")
          .eq("status", "active")
          .limit(1)
          .maybeSingle(),
      ),
      withTimeout(
        supabase
          .from("mask_availability")
          .select("mask_model_id, availability, margin_rank")
          .limit(5000),
      ),
      loadSafetyScreen(orgId),
    ]);

  if (models.error) throw models.error;
  const modelRows = (models.data ?? []) as ModelRow[];
  if (modelRows.length === 0) {
    // An empty catalog is a configuration state, not an error, but it is
    // also not something to recommend from. Fall back rather than return
    // zero candidates and call it "contraindicated".
    throw new Error("mask catalog is empty");
  }

  const variantsByModel = new Map<string, SizeVariant[]>();
  for (const v of (variants.data ?? []) as Record<string, unknown>[]) {
    const modelId = String(v.mask_model_id);
    const list = variantsByModel.get(modelId) ?? [];
    list.push({
      id: String(v.id),
      component: v.component as SizeVariant["component"],
      sizeCode: String(v.size_code),
      sizeLabel: String(v.size_label),
      sortOrder: Number(v.sort_order ?? 0),
      noseWidthMin: num(v.nose_width_min_mm as never),
      noseWidthMax: num(v.nose_width_max_mm as never),
      noseHeightMin: num(v.nose_height_min_mm as never),
      noseHeightMax: num(v.nose_height_max_mm as never),
      noseToChinMin: num(v.nose_to_chin_min_mm as never),
      noseToChinMax: num(v.nose_to_chin_max_mm as never),
      mouthWidthMin: num(v.mouth_width_min_mm as never),
      mouthWidthMax: num(v.mouth_width_max_mm as never),
      faceWidthMin: num(v.face_width_min_mm as never),
      faceWidthMax: num(v.face_width_max_mm as never),
      isDefault: Boolean(v.is_default),
      hcpcsCode: (v.hcpcs_code as string | null) ?? null,
      status: (v.status as SizeVariant["status"]) ?? "current",
      fitDataSource: v.fit_data_source as SizeVariant["fitDataSource"],
      needsClinicalReview: Boolean(v.needs_clinical_review),
    } as SizeVariant);
    variantsByModel.set(modelId, list);
  }

  const contrasByModel = new Map<string, CatalogMask["contraindications"]>();
  for (const c of (contras.data ?? []) as Record<string, unknown>[]) {
    const modelId = String(c.mask_model_id);
    const list = contrasByModel.get(modelId) ?? [];
    list.push({
      factor: c.factor as never,
      severity: c.severity as "exclude" | "caution",
      rationale: String(c.rationale),
    });
    contrasByModel.set(modelId, list);
  }

  const catalog: CatalogMask[] = modelRows.map((m) => ({
    id: m.id,
    slug: m.slug,
    manufacturer: m.manufacturer,
    modelName: m.model_name,
    productLine: m.product_line,
    interfaceType: m.interface_type,
    serviceLine: m.service_line,
    therapyModes: ((m.therapy_modes ?? ["pap"]) as TherapyMode[]).filter(
      (t): t is TherapyMode => t === "pap" || t === "niv",
    ),
    vented: m.vented,
    hasMagneticComponents: m.has_magnetic_components,
    magnetFreeVariantSlug: m.magnet_free_variant_slug,
    pressureMin: num(m.pressure_min_cm_h2o),
    pressureMax: num(m.pressure_max_cm_h2o),
    supportsSupplementalOxygen: m.supports_supplemental_oxygen,
    minimalContact: m.minimal_contact,
    avoidsNasalBridge: m.avoids_nasal_bridge,
    hosePosition: m.hose_position,
    facialHairTolerance: m.facial_hair_tolerance,
    sideSleepingTolerance: m.side_sleeping_tolerance,
    claustrophobiaTolerance: m.claustrophobia_tolerance,
    glassesCompatible: m.glasses_compatible,
    cushionMaterial: m.cushion_material,
    headgearStyle: m.headgear_style,
    weightGrams: m.weight_grams,
    description: m.description,
    imageUrl: m.image_url,
    status: m.status,
    fitDataSource: m.fit_data_source,
    needsClinicalReview: m.needs_clinical_review,
    catalogVersion: m.catalog_version,
    variants: variantsByModel.get(m.id) ?? [],
    contraindications: contrasByModel.get(m.id) ?? [],
  }));

  const formularyRow = asRow(formularyRows);
  let formulary: Formulary = OPEN_FORMULARY;
  if (formularyRow) {
    const rules = await withTimeout(
      supabase
        .from("formulary_rules")
        .select("*")
        .eq("formulary_id", String(formularyRow.id))
        .limit(2000),
    );
    formulary = {
      id: String(formularyRow.id),
      name: String(formularyRow.name),
      version: Number(formularyRow.version ?? 1),
      defaultPosture:
        (formularyRow.default_posture as "open" | "closed") ?? "open",
      rules: asRows(rules).map(
        (r) =>
          ({
            id: String(r.id),
            locationId: (r.location_id as string | null) ?? null,
            payerProfileId: (r.payer_profile_id as string | null) ?? null,
            contractRef: (r.contract_ref as string | null) ?? null,
            serviceLine: (r.service_line as never) ?? null,
            therapyMode: (r.therapy_mode as never) ?? null,
            targetKind: r.target_kind as never,
            targetManufacturer:
              (r.target_manufacturer as string | null) ?? null,
            targetInterfaceType:
              (r.target_interface_type as string | null) ?? null,
            targetMaskModelId:
              (r.target_mask_model_id as string | null) ?? null,
            targetSizeVariantId:
              (r.target_size_variant_id as string | null) ?? null,
            effect: r.effect as never,
            preferenceRank: (r.preference_rank as number | null) ?? null,
            reasonCode: (r.reason_code as string | null) ?? null,
            reasonNote: (r.reason_note as string | null) ?? null,
            effectiveFrom: (r.effective_from as string | null) ?? null,
            effectiveTo: (r.effective_to as string | null) ?? null,
            createdAt: String(r.created_at ?? ""),
          }) satisfies FormularyRule,
      ),
    };
  }

  const bySlug = new Map(catalog.map((m) => [m.id, m.slug]));
  const availability: Record<string, MaskAvailability> = {};
  for (const a of asRows(availabilityRows)) {
    const slug = bySlug.get(String(a.mask_model_id));
    if (!slug) continue;
    availability[slug] = {
      availability: a.availability as MaskAvailability["availability"],
      marginRank: (a.margin_rank as number | null) ?? null,
    };
  }

  return {
    catalog,
    formulary,
    availability,
    safetyScreen: screen,
    degraded: false,
  };
}

async function loadSafetyScreen(orgId: string): Promise<SafetyScreen | null> {
  const supabase = getOrgScopedClient(orgId);
  try {
    // Platform-published question sets have a NULL org_id — same reference-
    // data pattern as the catalog above, and the same explicit filter.
    const { data, error } = await withTimeout(
      supabase
        .raw()
        .schema("resupply")
        .from("safety_screen_versions")
        .select("id, slug, version, title, intro_copy, attestation_copy")
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq("slug", "magnetic_implant")
        .eq("status", "active")
        // A tenant's own set (non-null org_id) sorts first, so it wins.
        .order("org_id", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
    );
    if (error || !data) return null;

    const questions = await withTimeout(
      supabase
        .raw()
        .schema("resupply")
        .from("safety_screen_questions")
        .select("*")
        .eq("screen_version_id", String(data.id))
        .order("sort_order", { ascending: true }),
    );
    if (questions.error) return null;

    return {
      slug: String(data.slug),
      version: String(data.version),
      title: String(data.title),
      introCopy: (data.intro_copy as string | null) ?? null,
      attestationCopy: String(data.attestation_copy),
      questions: ((questions.data ?? []) as Record<string, unknown>[]).map(
        (q) => ({
          questionKey: String(q.question_key),
          prompt: String(q.prompt),
          helpText: (q.help_text as string | null) ?? null,
          subject: q.subject as "patient" | "household",
          sortOrder: Number(q.sort_order ?? 0),
          riskFlag: String(q.risk_flag),
          disqualifiesAttribute:
            (q.disqualifies_attribute as "has_magnetic_components" | null) ??
            null,
          severity: q.severity as "exclude" | "warn",
          unsureBehavesAs: q.unsure_behaves_as as "exclude" | "warn" | "ignore",
        }),
      ),
    };
  } catch {
    // A missing safety screen is not fatal; the caller decides what to do
    // with it (and the magnet flag is off by default anyway).
    return null;
  }
}
