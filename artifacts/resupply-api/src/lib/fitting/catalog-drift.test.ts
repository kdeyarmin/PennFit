/**
 * Catalog-drift guard: the static fallback must describe the SAME masks
 * the Mask Intelligence Catalog does.
 *
 * PennFit carries two mask catalogs. The DB catalog (`mask_models` /
 * `mask_size_variants`, migrations 0481/0486/...) is the successor and
 * drives the clinical fitter. The legacy TypeScript array
 * (`data/maskCatalog.ts`) still drives `/api/recommend` + `/api/masks`
 * and the storefront chatbot — and, via `staticCatalogAsMasks()`, it is
 * what `loadFittingContext` FAILS SOFT ONTO when Postgres is unreachable
 * or a tenant has not enabled the DB catalog.
 *
 * That fallback is the whole point of this file. An outage is supposed to
 * change WHERE PennFit gets its catalog — not WHICH masks a patient can
 * be fitted for. If the two sides disagree, a database hiccup silently
 * re-fits patients against a different catalog: a size run that is a size
 * short sends the wrong cushion, a model the DB has since discontinued
 * comes back from the dead, and — the one that actually hurts — a mask
 * whose magnetic clips are recorded in only one of the two catalogs gets
 * recommended with no implanted-device warning. Migration 0512 already
 * had to hand-fix one such divergence (the DreamWear Full Face `MW` size
 * code, "the two catalog modes must agree on it"); this test is what
 * makes the next one fail in CI instead of in a fitting.
 *
 * The five fields compared per mask are the ones that change what a
 * patient is offered:
 *
 *   manufacturer · model name · status · size run · magnetic status
 *
 * Geometry is deliberately NOT compared. The two catalogs derive bands
 * differently on purpose (see `catalog-store.static.test.ts` and
 * migration 0511) — pinning millimetres here would only re-assert what
 * those already cover.
 *
 * Direction of the check: EVERY static fallback entry must have a
 * matching reference model. The reverse does not hold and must not — the
 * DB catalog is deliberately the richer one (83 platform models vs the
 * legacy array's 38), and a mask that exists only in the DB simply
 * cannot be mis-served during an outage.
 *
 * How the reference is built: the mask-catalog migrations are replayed
 * verbatim into PGlite (in-process Postgres, the same harness
 * `dedup-org-scope.integration.test.ts` uses) and the result is queried.
 * A real SQL engine applies the renames, retirements and corrections, so
 * the reference is what every database actually ends up holding rather
 * than a hand-transcribed snapshot that could itself drift. No external
 * DB, no network — this runs in CI like any other spec.
 *
 * allow-source-read: the migration .sql files are read as EXECUTABLE
 * INPUT to a real Postgres, not string-matched. There is no behavioral
 * equivalent — the DB catalog's content is not reachable from the API
 * process without a live database.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { beforeAll, describe, expect, it } from "vitest";

import { staticCatalogAsMasks } from "./catalog-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(
  __dirname,
  "../../../../../lib/resupply-db/migrations",
);

/**
 * Migrations that CREATE, ALTER or write rows to the two catalog tables.
 *
 * Discovered rather than hardcoded: a hardcoded list would go stale the
 * first time someone ships a catalog correction, and this test would
 * then compare the fallback against a reference frozen in the past —
 * passing while the real drift went unnoticed. `EXPECTED_MIGRATIONS`
 * below is the floor that keeps the discovery itself honest.
 */
const TOUCHES_CATALOG =
  /(?:CREATE TABLE(?:\s+IF NOT EXISTS)?|ALTER TABLE|INSERT INTO|UPDATE|DELETE FROM)\s+"?resupply"?\."?mask_(?:models|size_variants)"?/i;

/**
 * Catalog migrations known at the time of writing. The discovery regex
 * must keep finding all of them — if a refactor breaks it, this list
 * fails loudly instead of the suite quietly grading against an empty or
 * half-applied catalog.
 */
const EXPECTED_MIGRATIONS = [
  "0481_mask_intelligence_catalog.sql",
  "0486_mask_catalog_seed.sql",
  "0492_magnet_flag_corrections.sql",
  "0493_non_magnetic_mask_skus.sql",
  "0494_mask_catalog_seed_addendum.sql",
  "0495_variant_fit_data_provenance.sql",
  "0496_resmed_fitting_instruction_urls.sql",
  "0499_eson2_manufacturer_bands.sql",
  "0511_mask_fit_band_conventions.sql",
  "0512_mask_size_run_corrections.sql",
  "0514_for_her_size_bands.sql",
  "0515_f30i_hcpcs_correction.sql",
] as const;

/**
 * The miniature schema the catalog migrations land on.
 *
 * Only the prerequisites they actually reference, following the same
 * "build a miniature schema, run the real migration" pattern as the
 * patient-dedup integration specs — replaying all 180+ migrations would
 * pull in Supabase platform roles and the entire schema for no gain
 * here.
 *
 *   organizations        — mask_models.org_id FK (every seeded row is a
 *                          platform row with org_id NULL, so no data)
 *   hcpcs_codes          — mask_size_variants.hcpcs_code FK. 0481 seeds
 *                          the three combination codes itself; the rest
 *                          come from 0171, stubbed to the codes the seed
 *                          references.
 *   mask_variant_reviews — created by 0482 (formulary), which pulls in
 *                          locations + payer_profiles. 0511/0512 only
 *                          DELETE stale sign-offs from it, so the two
 *                          columns those statements touch are enough.
 */
const SETUP_SQL = `
  CREATE SCHEMA IF NOT EXISTS resupply;

  CREATE TABLE resupply.organizations (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE
  );

  CREATE TABLE resupply.hcpcs_codes (
    code text PRIMARY KEY NOT NULL,
    short_description text NOT NULL,
    category text NOT NULL,
    min_interval_days integer NOT NULL,
    max_quantity_per_period integer NOT NULL,
    period_days integer NOT NULL,
    active boolean DEFAULT true NOT NULL,
    notes text,
    created_at timestamptz DEFAULT now() NOT NULL,
    updated_at timestamptz DEFAULT now() NOT NULL
  );

  INSERT INTO resupply.hcpcs_codes
    (code, short_description, category,
     min_interval_days, max_quantity_per_period, period_days)
  SELECT c, c, 'mask', 90, 1, 90
  FROM unnest(ARRAY[
    'A7030','A7031','A7032','A7033','A7034',
    'A7035','A7036','A7037','A7038','A7039','A7044','A7046'
  ]) AS c;

  CREATE TABLE resupply.mask_variant_reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id uuid,
    size_variant_id uuid
  );
`;

/** One platform mask as the DB catalog ends up describing it. */
interface ReferenceMask {
  manufacturer: string;
  modelName: string;
  status: string;
  /** Current cushion/pillow size codes, in the catalog's own order. */
  sizeRun: string[];
  hasMagneticComponents: boolean;
}

let reference: Map<string, ReferenceMask>;
let discovered: string[];

beforeAll(async () => {
  discovered = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      TOUCHES_CATALOG.test(readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")),
    );

  const db = new PGlite();
  await db.exec(SETUP_SQL);
  for (const file of discovered) {
    const sql = readFileSync(
      path.join(MIGRATIONS_DIR, file),
      "utf8",
    ).replaceAll("--> statement-breakpoint", "");
    try {
      await db.exec(sql);
    } catch (cause) {
      throw new Error(
        `migration ${file} failed to replay — if it introduced a new ` +
          `prerequisite, extend SETUP_SQL above: ${(cause as Error).message}`,
        { cause },
      );
    }
  }

  // Platform rows only (org_id IS NULL). A tenant's private additions are
  // by definition not what the built-in fallback stands in for.
  //
  // Size run = the CURRENT cushion/pillow variants. Frame rows are
  // excluded because `staticCatalogAsMasks` emits none, and retired
  // variants because the engine loads current rows only — a size the
  // catalog has withdrawn is not a size a patient can be fitted for.
  const { rows } = await db.query<{
    slug: string;
    manufacturer: string;
    model_name: string;
    status: string;
    has_magnetic_components: boolean;
    size_run: string[];
  }>(`
    SELECT m.slug,
           m.manufacturer,
           m.model_name,
           m.status,
           m.has_magnetic_components,
           COALESCE(
             json_agg(v.size_code ORDER BY v.sort_order)
               FILTER (WHERE v.id IS NOT NULL
                         AND v.status = 'current'
                         AND v.component IN ('cushion', 'pillow')),
             '[]'
           ) AS size_run
    FROM resupply.mask_models m
    LEFT JOIN resupply.mask_size_variants v ON v.mask_model_id = m.id
    WHERE m.org_id IS NULL
    GROUP BY m.id, m.slug, m.manufacturer, m.model_name,
             m.status, m.has_magnetic_components
  `);

  reference = new Map(
    rows.map((r) => [
      r.slug,
      {
        manufacturer: r.manufacturer,
        modelName: r.model_name,
        status: r.status,
        sizeRun: r.size_run,
        hasMagneticComponents: r.has_magnetic_components,
      },
    ]),
  );

  await db.close();
  // The migrations are large; a cold PGlite boot plus replay is a few
  // seconds, and CI runners are slower than a laptop.
}, 120_000);

/** What the fallback actually serves — the runtime projection, not the
 *  raw array, so the adapter's own mapping is under test too. */
const FALLBACK = staticCatalogAsMasks();

describe("mask catalog drift: static fallback ⇄ Mask Intelligence Catalog", () => {
  it("replays every discovered catalog migration", () => {
    expect(discovered).toEqual(
      expect.arrayContaining([...EXPECTED_MIGRATIONS]),
    );
  });

  it("builds a non-empty reference catalog", () => {
    // Guards against a silently empty replay turning every comparison
    // below into a vacuous pass.
    expect(reference.size).toBeGreaterThanOrEqual(FALLBACK.length);
  });

  it("has masks to compare", () => {
    expect(FALLBACK.length).toBeGreaterThan(0);
  });

  describe.each(FALLBACK.map((m) => [m.slug, m] as const))(
    "%s",
    (slug, mask) => {
      it("exists in the reference catalog", () => {
        expect(
          reference.has(slug),
          `${slug} is served by the static fallback but has no platform row in ` +
            `the Mask Intelligence Catalog — during a DB outage patients would ` +
            `be fitted for a mask the real catalog does not carry`,
        ).toBe(true);
      });

      it("agrees on manufacturer", () => {
        const ref = reference.get(slug);
        if (!ref) return; // reported by the existence test above
        expect(
          mask.manufacturer,
          `${slug} manufacturer drift — the same slug is attributed to two ` +
            `different makers depending on which catalog answered`,
        ).toBe(ref.manufacturer);
      });

      it("agrees on model name", () => {
        const ref = reference.get(slug);
        if (!ref) return;
        expect(
          mask.modelName,
          `${slug} model-name drift — a fit report, order or referral would ` +
            `name a different mask depending on which catalog answered`,
        ).toBe(ref.modelName);
      });

      it("is still current in the reference catalog", () => {
        const ref = reference.get(slug);
        if (!ref) return;
        // `staticCatalogAsMasks` hardcodes status 'current', so anything the
        // DB catalog has retired would be quietly resurrected by an outage.
        expect(
          ref.status,
          `${slug} is '${ref.status}' in the Mask Intelligence Catalog but the ` +
            `static fallback still offers it as current — remove it from ` +
            `data/maskCatalog.ts`,
        ).toBe("current");
        expect(mask.status).toBe("current");
      });

      it("agrees on the size run", () => {
        const ref = reference.get(slug);
        if (!ref) return;
        const staticRun = mask.variants.map((v) => v.sizeCode);
        expect(
          staticRun,
          `${slug} size run drift — a patient sized during a DB outage would be ` +
            `offered a different set of cushions than the clinical fitter offers`,
        ).toEqual(ref.sizeRun);
      });

      it("agrees on magnetic status", () => {
        const ref = reference.get(slug);
        if (!ref) return;
        // The safety-critical one: magnetic headgear clips are contraindicated
        // alongside pacemakers, ICDs, neurostimulators and cochlear implants.
        // A mask flagged magnetic in only one catalog is recommended without
        // that warning in the other.
        expect(
          mask.hasMagneticComponents,
          `${slug} magnetic-status drift between the static fallback and the ` +
            `Mask Intelligence Catalog — one of the two would recommend it ` +
            `without the implanted-device warning`,
        ).toBe(ref.hasMagneticComponents);
      });
    },
  );
});
