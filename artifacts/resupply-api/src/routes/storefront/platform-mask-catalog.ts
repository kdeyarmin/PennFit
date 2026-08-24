// GET /api/platform/mask-catalog — PUBLIC coverage stats for the Mask
// Intelligence Catalog, for the platform marketing site (cmbreathe.com).
//
// Why this exists: a DME evaluating the fitter asks one question before any
// other — "does it already know the masks I dispense?" Until this endpoint
// the marketing site described the fitter's *reasoning* and said nothing
// about its *coverage*, so a prospect had to take "complete solution" on
// faith. This surfaces the real roster straight out of
// `resupply.mask_models` (migrations 0481/0486/0493/0494), so the number a
// prospect reads is the number the engine actually reasons over, and a
// catalog addition reaches the marketing page with no frontend redeploy.
//
// TENANCY — the rule that shapes every query here. `mask_models` has a
// NULLABLE `org_id`: NULL is a platform-published row every tenant sees,
// non-NULL is a model ONE tenant added privately for its own formulary.
// Every read below filters `org_id IS NULL`. A tenant's private additions
// are that tenant's commercial data and must never be counted into a public
// marketing figure — including indirectly, via a variant or component total
// that would let a reader difference out how many models a competitor added.
//
// STRICTLY aggregate: manufacturer names and counts. No slugs, no model
// names, no clinical bands, no tenant data. PHI: none — product facts only.
//
// Fail-soft by design (same posture as /api/platform/pricing): a DB hiccup
// returns an empty roster with a 200 so the marketing page falls back to its
// static copy instead of rendering an error to a prospect.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

const router: IRouter = Router();

interface ModelRow {
  id: string;
  manufacturer: string | null;
  status: string | null;
  interface_type: string | null;
  updated_at: string | null;
}

export interface ManufacturerCoverage {
  name: string;
  models: number;
  currentModels: number;
}

export interface MaskCatalogCoverage {
  manufacturers: ManufacturerCoverage[];
  interfaceTypes: { type: string; models: number }[];
  totals: {
    manufacturers: number;
    models: number;
    currentModels: number;
    discontinuedModels: number;
    // Null when the count query failed — the page hides the stat rather
    // than printing a zero it cannot stand behind.
    sizeVariants: number | null;
    components: number | null;
  };
  lastUpdatedAt: string | null;
}

const EMPTY: MaskCatalogCoverage = {
  manufacturers: [],
  interfaceTypes: [],
  totals: {
    manufacturers: 0,
    models: 0,
    currentModels: 0,
    discontinuedModels: 0,
    sizeVariants: null,
    components: null,
  },
  lastUpdatedAt: null,
};

type ChildTable = "mask_size_variants" | "mask_components";

/**
 * Upper bound on the id list the fallback below will put in a URL. 200 uuids
 * is roughly 8 KB of query string — under the usual proxy limit, and well
 * above the catalog's present size.
 */
const MAX_IDS_IN_URL = 200;

/**
 * Count rows in a child table, restricted to children of PLATFORM models.
 *
 * `mask_size_variants` / `mask_components` carry no `org_id` of their own, so
 * the tenancy filter has to ride the join to `mask_models` — otherwise a
 * tenant's private models would inflate a public marketing figure. The
 * `mask_models!inner(org_id)` embed is the scalable way to express that and
 * is the primary path.
 *
 * The `platformIds` fallback exists because that embed is the one query shape
 * here that cannot be exercised without a live PostgREST: if a deployment
 * rejects it, an explicit id list gets the same exact number for any catalog
 * that fits in a URL. Beyond that bound we return null and the page hides the
 * stat rather than printing a number that quietly includes tenant rows.
 */
async function countPlatformChildren(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  table: ChildTable,
  platformIds: string[],
): Promise<number | null> {
  const embedded = await supabase
    .schema("resupply")
    .from(table)
    .select("mask_model_id, mask_models!inner(org_id)", {
      count: "exact",
      head: true,
    })
    .is("mask_models.org_id", null);
  if (!embedded.error) return embedded.count ?? null;

  logger.warn(
    { event: "mask_catalog_child_count_failed", table, err: embedded.error },
    "public mask catalog child count failed; trying the id-list fallback",
  );

  if (platformIds.length === 0 || platformIds.length > MAX_IDS_IN_URL) {
    return null;
  }
  const byId = await supabase
    .schema("resupply")
    .from(table)
    .select("mask_model_id", { count: "exact", head: true })
    .in("mask_model_id", platformIds);
  if (byId.error) {
    logger.warn(
      {
        event: "mask_catalog_child_count_fallback_failed",
        table,
        err: byId.error,
      },
      "public mask catalog child count fallback failed",
    );
    return null;
  }
  return byId.count ?? null;
}

router.get("/platform/mask-catalog", async (_req, res) => {
  try {
    const supabase = getSupabaseServiceRoleClient();

    const models = await supabase
      .schema("resupply")
      .from("mask_models")
      .select("id, manufacturer, status, interface_type, updated_at")
      .is("org_id", null);

    if (models.error) {
      logger.error(
        { event: "mask_catalog_coverage_read_failed", err: models.error },
        "public mask catalog coverage read failed",
      );
      res.json(EMPTY);
      return;
    }

    const rows = (models.data ?? []) as ModelRow[];
    if (rows.length === 0) {
      res.json(EMPTY);
      return;
    }

    const byManufacturer = new Map<string, ManufacturerCoverage>();
    const byInterface = new Map<string, number>();
    let currentModels = 0;
    let discontinuedModels = 0;
    let lastUpdatedAt: string | null = null;

    for (const row of rows) {
      const name = (row.manufacturer ?? "").trim();
      if (name.length > 0) {
        const entry = byManufacturer.get(name) ?? {
          name,
          models: 0,
          currentModels: 0,
        };
        entry.models += 1;
        if (row.status === "current") entry.currentModels += 1;
        byManufacturer.set(name, entry);
      }

      const iface = (row.interface_type ?? "").trim();
      if (iface.length > 0) {
        byInterface.set(iface, (byInterface.get(iface) ?? 0) + 1);
      }

      if (row.status === "current") currentModels += 1;
      else if (row.status === "discontinued") discontinuedModels += 1;

      if (
        row.updated_at &&
        (!lastUpdatedAt || row.updated_at > lastUpdatedAt)
      ) {
        lastUpdatedAt = row.updated_at;
      }
    }

    const platformIds = rows.map((r) => r.id).filter(Boolean);
    const [sizeVariants, components] = await Promise.all([
      countPlatformChildren(supabase, "mask_size_variants", platformIds),
      countPlatformChildren(supabase, "mask_components", platformIds),
    ]);

    // Cacheable for 5 min — the catalog changes on the order of weeks and
    // the marketing page tolerates slight staleness (same posture as
    // /api/platform/pricing and /api/company-info).
    res.set("Cache-Control", "public, max-age=300");
    res.json({
      // Biggest roster first, then alphabetical, so the ordering is stable
      // between requests rather than following PostgREST's row order.
      manufacturers: [...byManufacturer.values()].sort(
        (a, b) => b.models - a.models || a.name.localeCompare(b.name),
      ),
      interfaceTypes: [...byInterface.entries()]
        .map(([type, count]) => ({ type, models: count }))
        .sort((a, b) => b.models - a.models || a.type.localeCompare(b.type)),
      totals: {
        manufacturers: byManufacturer.size,
        models: rows.length,
        currentModels,
        discontinuedModels,
        sizeVariants,
        components,
      },
      lastUpdatedAt,
    } satisfies MaskCatalogCoverage);
  } catch (err) {
    logger.error(
      { event: "mask_catalog_coverage_read_threw", err },
      "public mask catalog coverage read threw",
    );
    res.json(EMPTY);
  }
});

export default router;
