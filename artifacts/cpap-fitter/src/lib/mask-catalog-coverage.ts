import { useEffect, useState } from "react";

// Mask Intelligence Catalog coverage — the shape behind the manufacturer
// roster on /breathe/mask-fitting.
//
// Lives here rather than inside the page so the parsing and the static
// snapshot are unit-testable without mounting the marketing shell, and so a
// second marketing surface can quote the same numbers without a second
// hand-typed copy of them.
//
// Source of truth is GET /api/platform/mask-catalog
// (artifacts/resupply-api/src/routes/storefront/platform-mask-catalog.ts),
// which counts PLATFORM catalog rows only. Everything here is aggregate
// product facts — no tenant data, no PHI.

export interface ManufacturerCoverage {
  name: string;
  models: number;
  currentModels: number;
}

export interface CatalogCoverage {
  manufacturers: ManufacturerCoverage[];
  interfaceTypes: { type: string; models: number }[];
  totals: {
    manufacturers: number;
    models: number;
    currentModels: number;
    discontinuedModels: number;
    // Null means "we could not count this" — the page hides the stat
    // rather than printing a zero it cannot stand behind.
    sizeVariants: number | null;
    components: number | null;
  };
  lastUpdatedAt: string | null;
}

/**
 * Static snapshot — the platform catalog as of 2026-08-24, verified against
 * `resupply.mask_models` (seeded by migrations 0486 + 0493 + 0494).
 *
 * `sizeVariants` counts only variants that actually carry a millimetre band
 * (248 of 301 rows — the rest are dimensionless, mostly tube-up frames), to
 * match the label the page prints and the filter the endpoint applies.
 *
 * This is the pre-fetch first paint AND the fetch-failure state, so a
 * prospect never sees a spinner, a zero, or an empty roster. The live fetch
 * is what carries day-to-day additions; refresh this when the seeded catalog
 * changes materially.
 */
export const FALLBACK_COVERAGE: CatalogCoverage = {
  manufacturers: [
    { name: "ResMed", models: 25, currentModels: 20 },
    { name: "Philips Respironics", models: 17, currentModels: 16 },
    { name: "Fisher & Paykel", models: 13, currentModels: 10 },
    { name: "React Health", models: 8, currentModels: 8 },
    { name: "Rain8", models: 5, currentModels: 5 },
    { name: "Sleepnet", models: 5, currentModels: 5 },
    { name: "Circadiance", models: 4, currentModels: 4 },
    { name: "Inogen", models: 3, currentModels: 3 },
    { name: "Bleep Sleep", models: 2, currentModels: 2 },
    { name: "Hans Rudolph", models: 1, currentModels: 1 },
  ],
  interfaceTypes: [
    { type: "nasal", models: 32 },
    { type: "full_face", models: 28 },
    { type: "nasal_pillow", models: 18 },
    { type: "hybrid", models: 4 },
    { type: "total_face", models: 1 },
  ],
  totals: {
    manufacturers: 10,
    models: 83,
    currentModels: 74,
    discontinuedModels: 9,
    sizeVariants: 248,
    components: 244,
  },
  lastUpdatedAt: null,
};

const INTERFACE_LABELS: Record<string, string> = {
  full_face: "Full face",
  nasal: "Nasal",
  nasal_pillow: "Nasal pillow",
  nasal_cradle: "Nasal cradle",
  hybrid: "Hybrid",
  total_face: "Total face",
  oral: "Oral",
};

/**
 * Human label for a catalog `interface_type`. Falls back to title-casing the
 * raw value so a classification added to the catalog after this deploy still
 * renders as prose rather than as `nasal_cradle`.
 */
export function interfaceLabel(type: string): string {
  return (
    INTERFACE_LABELS[type] ??
    type.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())
  );
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function countOrNull(v: unknown): number | null {
  return isFiniteNumber(v) ? v : null;
}

function countOrZero(v: unknown): number {
  return isFiniteNumber(v) ? v : 0;
}

/**
 * Validate an `/api/platform/mask-catalog` body into a `CatalogCoverage`.
 *
 * Returns null — meaning "keep the static snapshot" — for anything that
 * would degrade the page: a non-object, a missing roster, or the endpoint's
 * own fail-soft empty response. A roster that is present but partly
 * malformed is salvaged row by row rather than discarded whole.
 */
export function normalizeCoverage(body: unknown): CatalogCoverage | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.manufacturers)) return null;
  const manufacturers = b.manufacturers
    .filter(
      (m): m is Record<string, unknown> => typeof m === "object" && m !== null,
    )
    .map((m) => ({
      name: typeof m.name === "string" ? m.name.trim() : "",
      models: countOrZero(m.models),
      currentModels: countOrZero(m.currentModels),
    }))
    .filter((m) => m.name.length > 0 && m.models > 0);
  if (manufacturers.length === 0) return null;
  // Salvaging the roster row by row means the server's own headline totals
  // may now count rows we are NOT rendering. Derive them instead — the big
  // number must never disagree with the rows beneath it, and the page would
  // otherwise badge a mismatched payload as a live count.
  const salvaged = manufacturers.length !== b.manufacturers.length;

  const interfaceTypes = Array.isArray(b.interfaceTypes)
    ? b.interfaceTypes
        .filter(
          (t): t is Record<string, unknown> =>
            typeof t === "object" && t !== null,
        )
        .map((t) => ({
          type: typeof t.type === "string" ? t.type : "",
          models: countOrZero(t.models),
        }))
        .filter((t) => t.type.length > 0 && t.models > 0)
    : [];

  const rawTotals =
    typeof b.totals === "object" && b.totals !== null
      ? (b.totals as Record<string, unknown>)
      : {};
  // Derive the headline totals from the roster whenever the server omits them
  // OR we dropped a row above, so the panel's big numbers can never disagree
  // with the rows beneath them.
  const rosterModels = manufacturers.reduce((sum, m) => sum + m.models, 0);

  return {
    manufacturers,
    interfaceTypes,
    totals: {
      manufacturers:
        !salvaged && isFiniteNumber(rawTotals.manufacturers)
          ? rawTotals.manufacturers
          : manufacturers.length,
      models:
        !salvaged && isFiniteNumber(rawTotals.models)
          ? rawTotals.models
          : rosterModels,
      currentModels: countOrZero(rawTotals.currentModels),
      discontinuedModels: countOrZero(rawTotals.discontinuedModels),
      sizeVariants: countOrNull(rawTotals.sizeVariants),
      components: countOrNull(rawTotals.components),
    },
    lastUpdatedAt:
      typeof b.lastUpdatedAt === "string" && b.lastUpdatedAt.length > 0
        ? b.lastUpdatedAt
        : null,
  };
}

/**
 * Fetch the live roster once on mount, falling back to `FALLBACK_COVERAGE`.
 *
 * `isLive` reports whether real numbers actually landed. Every surface that
 * calls these figures "counted" must gate that claim on it — the section's
 * whole argument is that the numbers are read rather than asserted, and a
 * "live" badge above the static snapshot would quietly break it.
 *
 * Shared by /breathe (the fitter band's one-line teaser) and
 * /breathe/mask-fitting (the full roster) so the two can never disagree.
 * The endpoint sets a 5-minute cache header, so the second surface a visitor
 * opens is served from cache.
 */
export function useMaskCatalogCoverage(): {
  coverage: CatalogCoverage;
  isLive: boolean;
} {
  const [data, setData] = useState<CatalogCoverage | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/platform/mask-catalog", {
      headers: { Accept: "application/json" },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: unknown) => {
        if (cancelled) return;
        // null means "unusable or empty" — the endpoint's own fail-soft
        // shape included. Keep the static snapshot rather than blanking the
        // section in front of a prospect.
        const next = normalizeCoverage(body);
        if (next) setData(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return { coverage: data ?? FALLBACK_COVERAGE, isLive: data !== null };
}

/**
 * "ResMed, Philips Respironics, Fisher & Paykel and React Health, plus 6
 * more" — the roster compressed to one clause for a teaser line. Degrades
 * correctly for a short roster (no dangling "plus 0 more", no stray "and").
 */
export function summariseManufacturers(
  manufacturers: ManufacturerCoverage[],
  named = 4,
): string {
  const names = manufacturers.slice(0, Math.max(1, named)).map((m) => m.name);
  if (names.length === 0) return "";
  const rest = manufacturers.length - names.length;
  const lead =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return rest > 0 ? `${lead}, plus ${rest} more` : lead;
}
