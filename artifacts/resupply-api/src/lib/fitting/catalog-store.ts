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
import { resolveSizeRunBuckets } from "../size-run.js";
import {
  MAGNETIC_MASK_IDS,
  maskCatalog,
  type MaskEntry,
} from "../../data/maskCatalog.js";
import {
  computeFitAdjustments,
  tallyOutcomesByMask,
} from "../storefront/mask-fit-tuning.js";
import { ADULT_PLAUSIBILITY_BOUNDS } from "./confidence.js";
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

// (The audited magnetic-model list lives with the catalog itself —
// `MAGNETIC_MASK_IDS` in data/maskCatalog.ts, mirroring migration 0492's
// manufacturer-sourced corrections — so the degraded-path flags, the
// legacy engine's maskHasMagneticHardware, and the patient-facing magnet
// warnings all read ONE source and cannot drift.)

/**
 * Project the built-in TypeScript catalog into the engine's shape.
 *
 * Used when the database is unreachable, and when a tenant has not turned
 * the DB catalog on. The size bands are a linear partition of the entry's
 * fit range, with the SAME open-edge rule as the DB catalog's derived
 * bands: the smallest size runs down to the adult plausibility floor and
 * the largest up to the ceiling. Without that, a measurement the
 * plausibility gate accepts could sit outside every band of every mask —
 * the legacy entries all carry the canonical-face ±18% envelope, so a
 * plausible 25 mm nose or 60 mm nose-to-chin would make `runTiers` report
 * `outsideValidatedRange` and, under confidence gating, withhold a
 * fitting the DB path would happily size. The degraded path serves adults
 * only (`serviceLine: "adult"` below), so the adult window is the right
 * envelope to run out to.
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
    const [windowLo, windowHi] = axisIsNose
      ? ADULT_PLAUSIBILITY_BOUNDS.noseWidth
      : ADULT_PLAUSIBILITY_BOUNDS.noseToChin;

    // "Wide sizes are not simply bigger" (migration 0511): a wide code
    // whose plain base is in the run shares the base's bucket on the
    // HEIGHT axis (wide is not taller) and steps one bucket up on the
    // WIDTH axis; a wide code with no plain base is an ordinary ladder
    // step. See lib/size-run.ts. Where a wide and its base share a
    // bucket, the base sorts first so the picker's tie-break recommends
    // the plain size — without a second axis the two are
    // indistinguishable here, and the base cut fits more faces.
    const run = resolveSizeRunBuckets(sizes, axisIsNose ? "width" : "height");

    const variants: SizeVariant[] = sizes.map((size, i) => {
      const bucket = run.bucketOf[i]!;
      const width = (range[1] - range[0]) / run.bucketCount;
      // Edge sizes run out to the plausibility window (see the header):
      // any value the gate admits lands in some band.
      const lo = bucket === 0 ? windowLo : range[0] + width * bucket;
      const hi =
        bucket === run.bucketCount - 1
          ? windowHi
          : range[0] + width * (bucket + 1);
      return {
        id: `${e.id}:${size}`,
        component: interfaceType === "nasal_pillow" ? "pillow" : "cushion",
        sizeCode: size,
        sizeLabel: size,
        // Bucket-major so the picker walks base sizes ahead of the wide
        // cut sharing their bucket (see above); display order elsewhere
        // comes from the array, which keeps the catalog's own order.
        sortOrder: bucket * 10 + (run.isWideStep[i] ? 5 : 0),
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
        manufacturerPartNumber: null,
        status: "current",
        fitDataSource: "estimated",
        needsClinicalReview: true,
      } as SizeVariant;
    });

    // The audited list first (marketing copy is NOT a safety record —
    // four genuinely magnetic masks carry no "magnet" wording at all);
    // the text heuristic stays only as belt-and-braces for a future
    // entry added without updating the audit, where erring toward
    // exclusion is the safe direction.
    const hasMagnets =
      MAGNETIC_MASK_IDS.has(e.id) ||
      /magnet/i.test([e.headgearStyle, ...(e.features ?? [])].join(" "));

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
  org_id: string | null;
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

function asRow(result: unknown): Record<string, unknown> | null {
  const r = result as Result<Record<string, unknown>>;
  if (!r || r.error || !r.data) return null;
  return r.data;
}

/**
 * Page a bulk read past PostgREST's `max_rows` cap (1000 by default). A
 * bare high `.limit()` is silently truncated to an UNORDERED first 1000
 * rows — for the variants table that means a mask whose sizes fell past
 * the window loses its geometry and gets the "no sizing data" fallback,
 * a silently wrong size rather than a visible failure. The builder MUST
 * apply a deterministic ORDER BY (unique tail) or pages can overlap.
 *
 * FAIL CLOSED by default: a page error throws, routing the caller into
 * the documented degraded path (see loadFromDb). `swallowErrors` is for
 * the one read whose failure mode is asymmetric (variant reviews).
 */
async function loadAllRows(
  label: string,
  build: (from: number, to: number) => PromiseLike<unknown>,
  maxRows: number,
  swallowErrors = false,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  const PAGE = 1000;
  for (let offset = 0; offset < maxRows; offset += PAGE) {
    const result = (await withTimeout(
      build(offset, Math.min(offset + PAGE, maxRows) - 1),
    )) as Result<Record<string, unknown>[]>;
    if (!result || result.error) {
      if (swallowErrors) return out;
      throw new Error(
        `fitting catalog load failed on ${label}: ${result?.error?.message ?? "unknown"}`,
      );
    }
    const page = result.data ?? [];
    out.push(...page);
    if (page.length < PAGE) break;
  }
  return out;
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
  //
  // FAIL CLOSED on every load except variant reviews (see below).
  //
  // PostgREST reports failures as `{ error }` on a RESOLVED promise, so a
  // failed sub-query silently becomes an empty array. That is harmless for
  // most data and actively dangerous for two of these: an empty
  // contraindications result deletes every hard clinical exclusion, and an
  // empty formulary result turns a closed formulary into an open one. Both
  // would produce a confident-looking recommendation from missing safety
  // data while still reporting `degraded: false`. Throwing (loadAllRows /
  // the formulary check below) routes the caller into the documented
  // degraded path — a visibly worse answer rather than an invisibly wrong
  // one.
  //
  // `mask_variant_reviews` is deliberately the exception. Its failure
  // mode is asymmetric: losing it leaves every variant flagged as
  // unreviewed, which routes to a human — strictly more cautious, never
  // less. Tearing the whole context down over a safe-direction failure
  // would be the worse trade.
  const [
    modelRowsRaw,
    variantRows,
    contraRows,
    formularyRows,
    availabilityRowList,
    variantReviewRows,
    screen,
  ] = await Promise.all([
    loadAllRows(
      "mask_models",
      (from, to) =>
        supabase
          .raw()
          .schema("resupply")
          .from("mask_models")
          .select(
            "id, org_id, slug, manufacturer, model_name, product_line, interface_type, service_line, therapy_modes, vented, has_magnetic_components, magnet_free_variant_slug, pressure_min_cm_h2o, pressure_max_cm_h2o, supports_supplemental_oxygen, minimal_contact, avoids_nasal_bridge, hose_position, facial_hair_tolerance, side_sleeping_tolerance, claustrophobia_tolerance, glasses_compatible, cushion_material, headgear_style, weight_grams, description, image_url, status, fit_data_source, needs_clinical_review, catalog_version",
          )
          .or(`org_id.is.null,org_id.eq.${orgId}`)
          // Only CURRENT models are recommendable. Excluding just
          // pre_release left discontinued models fully rankable: the size
          // picker skips discontinued VARIANTS (tiers.ts), but nothing
          // model-level did, so a mask a manufacturer had withdrawn could
          // still be recommended — and the refit campaign's "you're on a
          // discontinued mask" outreach would then re-fit patients onto it.
          .eq("status", "current")
          .order("id", { ascending: true })
          .range(from, to),
      4000,
    ),
    loadAllRows(
      "mask_size_variants",
      (from, to) =>
        supabase
          .raw()
          .schema("resupply")
          .from("mask_size_variants")
          .select("*")
          .eq("status", "current")
          // Deterministic order. PostgREST makes no ordering promise, and
          // with overlapping bands the size picker must not depend on row
          // arrival order (the picker sorts again, but the stored variant
          // lists — and anything else that walks them — should be stable).
          // The unique id tail is also what makes the paging exact.
          .order("sort_order", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to),
      10000,
    ),
    loadAllRows(
      "mask_contraindications",
      (from, to) =>
        supabase
          .raw()
          .schema("resupply")
          .from("mask_contraindications")
          .select("id, mask_model_id, factor, severity, rationale")
          .order("id", { ascending: true })
          .range(from, to),
      10000,
    ),
    withTimeout(
      supabase
        .from("formularies")
        .select("id, name, version, default_posture")
        .eq("status", "active")
        .limit(1)
        .maybeSingle(),
    ),
    loadAllRows(
      "mask_availability",
      (from, to) =>
        supabase
          .from("mask_availability")
          .select("id, mask_model_id, availability, margin_rank")
          .order("id", { ascending: true })
          .range(from, to),
      10000,
    ),
    // THIS tenant's clinical sign-off on the shared size bands. The
    // platform `needs_clinical_review` flag is never cleared by a
    // tenant (0482 header explains why); an approved row here clears the
    // per-tenant review flag carried on the session and the fit report.
    // (It no longer caps confidence — that gate was removed on purpose;
    // see resolveConfidence in confidence.ts.)
    loadAllRows(
      "mask_variant_reviews",
      (from, to) =>
        supabase
          .from("mask_variant_reviews")
          .select("size_variant_id, approved")
          .eq("approved", true)
          .order("size_variant_id", { ascending: true })
          .range(from, to),
      20000,
      /* swallowErrors */ true,
    ),
    loadSafetyScreen(orgId),
  ]);

  {
    // The formulary read is the one remaining single-row query; check it
    // explicitly (an empty result from a FAILED read would silently turn
    // a closed formulary into an open one).
    const err = (formularyRows as { error?: { message?: string } | null })
      .error;
    if (err) {
      throw new Error(
        `fitting catalog load failed on formularies: ${err.message ?? "unknown"}`,
      );
    }
  }

  const allModelRows = modelRowsRaw as unknown as ModelRow[];

  // A tenant may add a private model that SHADOWS a platform slug (0481
  // allows exactly that, via two partial unique indexes). Keep the tenant's
  // row and drop the platform one, or the engine ranks the same logical
  // mask twice while slug-keyed lookups — availability, the non-magnetic
  // alternative search — collapse them back into one arbitrarily.
  const modelRows: ModelRow[] = [];
  const bySlugPreferringTenant = new Map<string, ModelRow>();
  for (const row of allModelRows) {
    const existing = bySlugPreferringTenant.get(row.slug);
    if (!existing || (existing.org_id === null && row.org_id !== null)) {
      bySlugPreferringTenant.set(row.slug, row);
    }
  }
  modelRows.push(...bySlugPreferringTenant.values());

  if (modelRows.length === 0) {
    // An empty catalog is a configuration state, not an error, but it is
    // also not something to recommend from. Fall back rather than return
    // zero candidates and call it "contraindicated".
    throw new Error("mask catalog is empty");
  }

  // Size variants carry a PLATFORM `needs_clinical_review` flag meaning
  // "nobody has checked these millimetre bands." A tenant clears it for
  // itself by signing off in the catalog admin page, which writes a
  // tenant-scoped `mask_variant_reviews` row rather than mutating the
  // shared variant. So the flag the engine acts on is the AND of the two.
  const approvedVariantIds = new Set<string>();
  for (const r of variantReviewRows) {
    approvedVariantIds.add(String(r.size_variant_id));
  }

  const variantsByModel = new Map<string, SizeVariant[]>();
  for (const v of variantRows) {
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
      manufacturerPartNumber:
        (v.manufacturer_part_number as string | null) ?? null,
      status: (v.status as SizeVariant["status"]) ?? "current",
      fitDataSource: v.fit_data_source as SizeVariant["fitDataSource"],
      needsClinicalReview:
        Boolean(v.needs_clinical_review) &&
        !approvedVariantIds.has(String(v.id)),
    } as SizeVariant);
    variantsByModel.set(modelId, list);
  }

  const contrasByModel = new Map<string, CatalogMask["contraindications"]>();
  for (const c of contraRows) {
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
    const ruleRows = await loadAllRows(
      "formulary_rules",
      (from, to) =>
        supabase
          .from("formulary_rules")
          .select("*")
          .eq("formulary_id", String(formularyRow.id))
          .order("id", { ascending: true })
          .range(from, to),
      4000,
    );
    formulary = {
      id: String(formularyRow.id),
      name: String(formularyRow.name),
      version: Number(formularyRow.version ?? 1),
      defaultPosture:
        (formularyRow.default_posture as "open" | "closed") ?? "open",
      rules: ruleRows.map(
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
  for (const a of availabilityRowList) {
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

// ── Outcome-driven ranking adjustments (#22b, live path) ─────────────
//
// The tuning loop: attributed post-fit outcomes (`mask_fit_outcomes`) are
// tallied per mask and folded into a bounded ranking multiplier by
// `computeFitAdjustments()`. The admin rec-signal route has always shown
// this signal; this loader is what feeds it to the LIVE engine — the
// wiring the fit-assess route documented as "the next increment of the
// closed loop".
//
// Posture mirrors the catalog load above: short-TTL cache, hard lookup
// timeout, FAIL SOFT. Any failure returns `{}` — the engine's neutral —
// because a fitting must never be lost to the tuning signal being
// unavailable. The TTL is longer than the catalog's: the signal moves at
// the speed of patient feedback, not admin edits, and `minSamples` (10)
// means a five-minute lag can never flip a recommendation on one outcome.

const ADJUSTMENTS_CACHE_TTL_MS = 5 * 60_000;
const ADJUSTMENTS_PAGE = 1000;
/** Newest-first row window. When the table outgrows it, the signal
 *  reflects the MOST RECENT outcomes (the ones describing today's mask
 *  lineup) — same rationale as the admin rec-signal route's pagination
 *  (routes/admin/mask-fit-worklist.ts), just a tighter bound because this
 *  runs on the patient-facing path. */
const ADJUSTMENTS_MAX_ROWS = 5000;

interface AdjustmentsCacheEntry {
  /** Multipliers keyed by whatever `mask_fit_outcomes.mask_id` carried —
   *  normally the engine SLUG (migration 0203: "the recommendation-engine
   *  catalog id, e.g. 'resmed-airfit-f20'"), uuid tolerated defensively. */
  byMaskKey: Record<string, number>;
  expiresAt: number;
}

const adjustmentsCache = new Map<string, AdjustmentsCacheEntry>();

/** Drop a tenant's cached tuning signal (e.g. after a bulk outcome import). */
export function invalidateFitAdjustments(orgId?: string): void {
  if (orgId) adjustmentsCache.delete(orgId);
  else adjustmentsCache.clear();
}

/**
 * Load a tenant's outcome-driven ranking multipliers, keyed by SLUG —
 * the key `runTiers` looks up (`fitAdjustments[mask.slug]`).
 *
 * `mask_fit_outcomes.mask_id` itself carries the engine slug (migration
 * 0203; order-link.ts documents the slug/uuid split explicitly), so the
 * catalog pass below is a FILTER, not a translation: a multiplier is
 * only ever returned for a mask actually in this session's catalog. The
 * uuid is accepted as a defensive fallback for any writer that recorded
 * the model's primary key instead.
 *
 * Never throws; never returns a multiplier for a mask outside `catalog`.
 */
export async function loadFitAdjustments(
  orgId: string,
  catalog: readonly CatalogMask[],
): Promise<Record<string, number>> {
  let byMaskKey: Record<string, number>;
  const cached = adjustmentsCache.get(orgId);
  if (cached && cached.expiresAt > Date.now()) {
    byMaskKey = cached.byMaskKey;
  } else {
    try {
      byMaskKey = await loadAdjustmentsFromDb(orgId);
      adjustmentsCache.set(orgId, {
        byMaskKey,
        expiresAt: Date.now() + ADJUSTMENTS_CACHE_TTL_MS,
      });
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err : new Error(String(err)), orgId },
        "fit adjustments load failed; ranking stays neutral",
      );
      byMaskKey = {};
      // Cache the neutral answer briefly too, so an outage doesn't add a
      // timed-out round trip to every in-flight fitting.
      adjustmentsCache.set(orgId, {
        byMaskKey,
        expiresAt: Date.now() + 10_000,
      });
    }
  }

  const bySlug: Record<string, number> = {};
  for (const m of catalog) {
    const mult = byMaskKey[m.slug] ?? byMaskKey[m.id];
    if (typeof mult === "number") bySlug[m.slug] = mult;
  }
  return bySlug;
}

async function loadAdjustmentsFromDb(
  orgId: string,
): Promise<Record<string, number>> {
  const supabase = getOrgScopedClient(orgId);
  type OutcomeRow = {
    order_id: string | null;
    mask_id: string | null;
    fit_outcome: "good" | "leaking" | "uncomfortable";
  };
  const rows: OutcomeRow[] = [];
  // Page past PostgREST's max_rows cap — a bare high `.limit()` silently
  // truncates to an UNORDERED first 1000 and reports the partial tally as
  // complete (the trap the admin routes document and page around).
  for (
    let offset = 0;
    offset < ADJUSTMENTS_MAX_ROWS;
    offset += ADJUSTMENTS_PAGE
  ) {
    const result = (await withTimeout(
      supabase
        .from("mask_fit_outcomes")
        .select("order_id, mask_id, fit_outcome")
        .not("mask_id", "is", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + ADJUSTMENTS_PAGE - 1),
    )) as {
      data: OutcomeRow[] | null;
      error: { message: string } | null;
    };
    if (result.error) {
      throw new Error(`mask_fit_outcomes read failed: ${result.error.message}`);
    }
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < ADJUSTMENTS_PAGE) break;
  }

  // ONE vote per order: 0201 deliberately lets a patient re-answer their
  // survey link, and this signal now steers LIVE rankings — without the
  // dedupe, replaying one signed link (rate-limited but generous) could
  // single-handedly clear minSamples and push a mask by the full ±15%.
  // Rows arrive newest-first, so the first row seen per order is the
  // patient's latest word — the same "latest verdict" rule the refit
  // campaign applies.
  const seenOrders = new Set<string>();
  const latestPerOrder = rows.filter((r) => {
    if (!r.order_id) return true; // un-attributed legacy rows: keep as-is
    if (seenOrders.has(r.order_id)) return false;
    seenOrders.add(r.order_id);
    return true;
  });

  return computeFitAdjustments(
    tallyOutcomesByMask(
      latestPerOrder.map((r) => ({
        maskId: r.mask_id,
        fitOutcome: r.fit_outcome,
      })),
    ),
  );
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
