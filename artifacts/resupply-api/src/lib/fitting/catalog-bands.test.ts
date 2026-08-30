/**
 * The shipped catalog geometry, held to the axis the pipeline measures on.
 *
 * Every band in `mask_size_variants` is compared against millimetres the
 * browser derives from MediaPipe landmarks. If a band is authored on a
 * different anatomical convention than the landmark pair that produces
 * the number, the mismatch is invisible from the outside: the patient's
 * measurement simply lands outside every size and the fitter reports a
 * poor fit, which reads as an unusual face rather than a broken catalog.
 *
 * That is exactly what shipped. The 0486 seed authored nose-to-chin on a
 * subnasale->menton scale (~65 mm on an average adult) while the pipeline
 * reports nose TIP -> menton (~89 mm), and 42 of the 52 Fisher & Paykel /
 * ResMed / Philips Respironics models could not return a single in-band
 * size for an average adult face. Migration 0511 re-derived every band on
 * the pipeline's own conventions; this file is what stops it regressing.
 *
 * The assertions run against the committed migration text rather than a
 * database, so they hold in CI with no Postgres — 0511 rewrites every
 * platform cushion and pillow band, so its table IS the current geometry.
 * A later migration that edits bands has to extend `BAND_SOURCES` below.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ADULT_PLAUSIBILITY_BOUNDS,
  PEDIATRIC_PLAUSIBILITY_BOUNDS,
  UNION_PLAUSIBILITY_BOUNDS,
} from "./confidence.js";
import { scoreVariant } from "./tiers.js";
import type { FitMeasurements, InterfaceType, SizeVariant } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "lib",
  "resupply-db",
  "migrations",
);
const read = (file: string) =>
  readFileSync(path.join(MIGRATIONS, file), "utf8");

/** Migrations that define the platform catalog's models. */
const MODEL_SOURCES = [
  "0486_mask_catalog_seed.sql",
  "0494_mask_catalog_seed_addendum.sql",
  "0522_mask_catalog_manufacturer_audit_corrections.sql",
];
/**
 * Migrations that state platform cushion/pillow bands, oldest first.
 * A later migration that restates a model's bands OWNS that model:
 * its rows replace the earlier file's rows for that (model, component)
 * wholesale, which is exactly what the SQL does to the database —
 * renamed codes disappear rather than lingering next to their
 * replacements. A migration that edits bands after 0512 must be
 * appended here.
 */
const BAND_SOURCES = [
  "0511_mask_fit_band_conventions.sql",
  "0512_mask_size_run_corrections.sql",
  "0514_for_her_size_bands.sql",
  "0522_mask_catalog_manufacturer_audit_corrections.sql",
];

/**
 * Runs that deliberately do NOT tile to the window ceiling: the model
 * ships only the LOWER rungs of its shared cushion platform's ladder
 * (the "For Her" subset runs — 0514). Stretching the top band to the
 * ceiling was the defect: a face the shared platform bands at L was
 * confidently dispensed the M cushion with inBand=true. A face above
 * the run's top is genuinely outside every size this model ships, and
 * the honest outcomes are "closest available size — verify in person"
 * or a model that actually ships their size out-ranking it. Tiling is
 * still required from the window floor to the run's own top.
 */
const TOP_OPEN_RUNS = new Set([
  "resmed-airfit-f20-for-her|cushion",
  "resmed-airfit-p10-for-her|pillow",
  "resmed-mirage-fx-for-her|cushion",
]);
/**
 * Models retired outright — status='discontinued' at the MODEL level,
 * bands nulled — because the product could not be verified to exist.
 * catalog-store loads only current models, so these are structurally
 * unrecommendable; the fit expectations below skip them.
 */
const RETIRED_MODELS = new Set([
  // 0512: "DreamWear Full Face Gel" — no such Philips product; the
  // DreamWear line's gel option is the gel PILLOWS cushion.
  "philips-dreamwear-ff-gel",
]);

// ── Ground truth ─────────────────────────────────────────────────────

/**
 * Vertices of MediaPipe's `canonical_face_model.obj` (cm -> mm) for the
 * landmarks the five measured spans touch. Same fixture as
 * `plausibility-windows.test.ts`, reproduced rather than imported so a
 * change to either table shows up as a diff here.
 */
const CANONICAL_FACE_MM: Record<number, readonly [number, number, number]> = {
  4: [0, -4.63, 75.87], // nose tip
  6: [0, 24.73, 57.89], // nose bridge
  61: [-24.56, -43.43, 42.84], // left mouth corner
  129: [-17.86, -9.78, 48.5], // left alar
  152: [0, -94.03, 42.64], // chin (menton)
  291: [24.56, -43.43, 42.84], // right mouth corner
  358: [17.86, -9.78, 48.5], // right alar
  234: [-76.64, 6.73, -24.36], // left face side
  454: [76.64, 6.73, -24.36], // right face side
};

/** The production landmark pairs (`MEASUREMENT_LANDMARKS`, face-measurements.ts). */
const MEASURED_PAIRS = {
  noseWidth: [129, 358],
  noseHeight: [6, 4],
  noseToChin: [4, 152],
  mouthWidth: [61, 291],
  faceWidthAtCheekbones: [234, 454],
} as const;

function frontalSpanMm(a: number, b: number): number {
  const [ax, ay] = CANONICAL_FACE_MM[a]!;
  const [bx, by] = CANONICAL_FACE_MM[b]!;
  return Math.hypot(ax - bx, ay - by);
}

/** The average adult face, as this pipeline measures it. */
const CANONICAL_ADULT: FitMeasurements = {
  noseWidth: frontalSpanMm(...MEASURED_PAIRS.noseWidth),
  noseHeight: frontalSpanMm(...MEASURED_PAIRS.noseHeight),
  noseToChin: frontalSpanMm(...MEASURED_PAIRS.noseToChin),
  mouthWidth: frontalSpanMm(...MEASURED_PAIRS.mouthWidth),
  faceWidthAtCheekbones: frontalSpanMm(...MEASURED_PAIRS.faceWidthAtCheekbones),
};

// ── Migration parsing ────────────────────────────────────────────────

type Population = "adult" | "pediatric" | "both";

interface Model {
  slug: string;
  manufacturer: string;
  interfaceType: InterfaceType;
  serviceLine: Population;
}

const MODEL_ROW =
  /\(NULL, '([a-z0-9-]+)', '([^']+)', '(?:[^']|'')+', (?:NULL|'[^']*'),\s*'(\w+)', '(\w+)'/g;

function parseModels(): Map<string, Model> {
  const out = new Map<string, Model>();
  for (const file of MODEL_SOURCES) {
    const sql = read(file);
    const block = sql.slice(
      sql.indexOf('INSERT INTO "resupply"."mask_models"'),
      sql.indexOf('INSERT INTO "resupply"."mask_size_variants"'),
    );
    for (const m of block.matchAll(MODEL_ROW)) {
      out.set(m[1]!, {
        slug: m[1]!,
        manufacturer: m[2]!,
        interfaceType: m[3] as InterfaceType,
        serviceLine: m[4] as Population,
      });
    }
  }
  // 0493 clones two magnet-free twins straight off their parents, so they
  // carry the parent's interface, population and size run.
  for (const [parent, twin] of [
    ["resmed-airfit-f20", "resmed-airfit-f20-non-magnetic"],
    ["resmed-airfit-f30i", "resmed-airfit-f30i-non-magnetic"],
  ] as const) {
    const p = out.get(parent);
    if (p) out.set(twin, { ...p, slug: twin });
  }
  return out;
}

const num = (raw: string): number | null =>
  raw === "NULL" ? null : Number(raw);

const N = String.raw`(NULL|-?[\d.]+)`;
const BAND_ROW = new RegExp(
  String.raw`^\s*\('([a-z0-9-]+)', '(\w+)', '([^']+)', ` +
    [N, N, N, N, N, N, N, N].join(", ") +
    String.raw`\),?$`,
  "gm",
);

/** Eson 2 keeps manufacturer-sourced nose-width bands; 0511 restates them. */
const ESON2_ROW = /^\s*\('([SML])', ([\d.]+), ([\d.]+)\),?$/gm;

interface Band {
  slug: string;
  component: SizeVariant["component"];
  sizeCode: string;
  variant: SizeVariant;
}

function variantOf(
  component: SizeVariant["component"],
  sizeCode: string,
  bands: (number | null)[],
): SizeVariant {
  const [nwMin, nwMax, nhMin, nhMax, ncMin, ncMax, mwMin, mwMax] = bands;
  return {
    id: `${component}:${sizeCode}`,
    component,
    sizeCode,
    sizeLabel: sizeCode,
    sortOrder: 0,
    noseWidthMin: nwMin ?? null,
    noseWidthMax: nwMax ?? null,
    noseHeightMin: nhMin ?? null,
    noseHeightMax: nhMax ?? null,
    noseToChinMin: ncMin ?? null,
    noseToChinMax: ncMax ?? null,
    mouthWidthMin: mwMin ?? null,
    mouthWidthMax: mwMax ?? null,
    faceWidthMin: null,
    faceWidthMax: null,
    isDefault: false,
    hcpcsCode: null,
    manufacturerPartNumber: null,
    status: "current",
    fitDataSource: "estimated",
    needsClinicalReview: true,
  };
}

/** Bands stated by one migration file, grouped per (slug, component). */
function parseFileBands(file: string): Map<string, Band[]> {
  const sql = read(file);
  const groups = new Map<string, Band[]>();
  const push = (band: Band) => {
    const key = `${band.slug}|${band.component}`;
    const list = groups.get(key) ?? [];
    list.push(band);
    groups.set(key, list);
  };
  for (const m of sql.matchAll(BAND_ROW)) {
    const component = m[2] as SizeVariant["component"];
    push({
      slug: m[1]!,
      component,
      sizeCode: m[3]!,
      variant: variantOf(
        component,
        m[3]!,
        m.slice(4, 12).map((v) => num(v!)),
      ),
    });
  }
  for (const m of sql.matchAll(ESON2_ROW)) {
    push({
      slug: "fisher-paykel-eson2",
      component: "cushion",
      sizeCode: m[1]!,
      variant: variantOf("cushion", m[1]!, [
        Number(m[2]),
        Number(m[3]),
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    });
  }
  return groups;
}

function parseBands(): Band[] {
  // Later files override earlier ones per (slug, component) — see the
  // BAND_SOURCES note.
  const merged = new Map<string, Band[]>();
  for (const file of BAND_SOURCES) {
    for (const [key, bands] of parseFileBands(file)) {
      merged.set(key, bands);
    }
  }
  return [...merged.values()].flat();
}

const MODELS = parseModels();
const BANDS = parseBands();

/** One entry per (model, component) — the set a size is picked from. */
const RUNS = (() => {
  const map = new Map<string, { model: Model; bands: Band[] }>();
  for (const band of BANDS) {
    const model = MODELS.get(band.slug);
    if (!model || RETIRED_MODELS.has(band.slug)) continue;
    const key = `${band.slug}|${band.component}`;
    const entry = map.get(key) ?? { model, bands: [] };
    entry.bands.push(band);
    map.set(key, entry);
  }
  return map;
})();

const boundsFor = (p: Population) =>
  p === "adult"
    ? ADULT_PLAUSIBILITY_BOUNDS
    : p === "pediatric"
      ? PEDIATRIC_PLAUSIBILITY_BOUNDS
      : UNION_PLAUSIBILITY_BOUNDS;

const BAND_FIELDS = [
  ["noseWidth", "noseWidthMin", "noseWidthMax"],
  ["noseHeight", "noseHeightMin", "noseHeightMax"],
  ["noseToChin", "noseToChinMin", "noseToChinMax"],
  ["mouthWidth", "mouthWidthMin", "mouthWidthMax"],
] as const;

// ── The tests ────────────────────────────────────────────────────────

describe("the shipped catalog parses", () => {
  it("finds the platform models and every band row", () => {
    expect(MODELS.size).toBeGreaterThanOrEqual(80);
    expect(BANDS.length).toBeGreaterThanOrEqual(200);
    // Nothing may reference a model the seed does not define.
    const orphans = BANDS.filter((b) => !MODELS.has(b.slug)).map((b) => b.slug);
    expect([...new Set(orphans)]).toEqual([]);
  });

  it("agrees with plausibility-windows.test.ts on the canonical face", () => {
    // If these drift, the bands below were derived against a face this
    // pipeline no longer reports and every other assertion is theatre.
    expect(CANONICAL_ADULT.noseWidth).toBeCloseTo(35.72, 2);
    expect(CANONICAL_ADULT.noseHeight).toBeCloseTo(29.36, 2);
    expect(CANONICAL_ADULT.noseToChin).toBeCloseTo(89.4, 2);
    expect(CANONICAL_ADULT.mouthWidth).toBeCloseTo(49.12, 2);
  });
});

describe("an average adult face fits every adult mask", () => {
  // THE regression test. Before migration 0511 this failed for 42 of the
  // 52 masks from the three largest manufacturers, and the symptom was
  // indistinguishable from "this patient has an unusual face".
  const adultRuns = [...RUNS.entries()].filter(
    ([, r]) => r.model.serviceLine !== "pediatric",
  );

  it.each(adultRuns.map(([key]) => key))("%s", (key) => {
    const run = RUNS.get(key)!;
    const scored = run.bands
      .map((b) => ({
        code: b.sizeCode,
        ...scoreVariant(b.variant, CANONICAL_ADULT),
      }))
      .filter((s) => s.score !== undefined);
    // A run whose every size carries no geometry cannot claim a fit, and
    // `scoreVariant` returning null for all of them is the safe outcome —
    // but a run that HAS geometry must be able to place an average face.
    expect(scored.length).toBeGreaterThan(0);
    expect(scored.some((s) => s.inBand)).toBe(true);
  });
});

describe("every band sits inside its population's plausibility window", () => {
  // A band edge outside the window is unreachable: `measurementsOutOfBounds`
  // rejects the measurement as a scan failure before it can ever be scored.
  // The AirFit N20's seeded 'Large Wide' and Eson 2's imported Large both
  // sat there.
  it.each([...RUNS.keys()])("%s", (key) => {
    const { model, bands } = RUNS.get(key)!;
    const bounds = boundsFor(model.serviceLine);
    for (const band of bands) {
      for (const [field, minKey, maxKey] of BAND_FIELDS) {
        const min = band.variant[minKey];
        const max = band.variant[maxKey];
        if (min === null || max === null) continue;
        const [lo, hi] = bounds[field];
        const where = `${band.sizeCode} ${field}`;
        expect(min, where).toBeGreaterThanOrEqual(lo);
        expect(max, where).toBeLessThanOrEqual(hi);
        // `bandsFor` drops a band whose max <= min, so an inverted or
        // zero-width band silently stops gating rather than failing loudly.
        expect(max, where).toBeGreaterThan(min);
      }
    }
  });
});

describe("the size run tiles its population window with no gaps", () => {
  // `bandsFor` skips a NULL band, so a hole in one dimension silently
  // stops that dimension gating. Stepping at 0.1 mm — the precision the
  // client rounds measurements to — proves no reachable value falls
  // between two sizes.
  it.each([...RUNS.keys()])("%s", (key) => {
    const { model, bands } = RUNS.get(key)!;
    const bounds = boundsFor(model.serviceLine);
    for (const [field, minKey, maxKey] of BAND_FIELDS) {
      const spans = bands
        .map((b) => [b.variant[minKey], b.variant[maxKey]] as const)
        .filter(
          (s): s is readonly [number, number] => s[0] !== null && s[1] !== null,
        );
      if (spans.length === 0) continue;
      const [lo, hi] = bounds[field];
      // A subset run's top is open by design (see TOP_OPEN_RUNS): tiling
      // is required up to the run's own ceiling, not the window's.
      const hiBound = TOP_OPEN_RUNS.has(key)
        ? Math.min(hi, Math.max(...spans.map(([, b]) => b)))
        : hi;
      const gaps: number[] = [];
      for (
        let x = lo;
        x <= hiBound + 1e-9;
        x = Math.round((x + 0.1) * 10) / 10
      ) {
        if (!spans.some(([a, b]) => a - 1e-9 <= x && x <= b + 1e-9))
          gaps.push(x);
      }
      expect({ field, gaps: gaps.slice(0, 5) }).toEqual({ field, gaps: [] });
    }
  });
});

describe("only the dimensions that size an interface gate it", () => {
  // A nasal cushion is sized by the nose; a nasal pillow by the nostrils.
  // Neither is gated by how far the chin sits from the nose, and
  // `scoreVariant` averages every non-NULL dimension — so a band that
  // does not size the mask does not merely add nothing, it dilutes the
  // dimensions that do. Migration 0499 set this precedent for Eson 2.
  const NASAL: InterfaceType[] = ["nasal", "nasal_cradle", "nasal_pillow"];
  const FACE: InterfaceType[] = ["full_face", "hybrid", "total_face"];

  it("no nasal or pillow mask gates on nose-to-chin or mouth width", () => {
    const offenders = [...RUNS.values()]
      .filter((r) => NASAL.includes(r.model.interfaceType))
      .flatMap(({ model, bands }) =>
        bands
          .filter(
            (b) =>
              b.variant.noseToChinMin !== null ||
              b.variant.mouthWidthMin !== null,
          )
          .map((b) => `${model.slug}/${b.sizeCode}`),
      );
    expect(offenders).toEqual([]);
  });

  it("no nasal pillow mask gates on nose height", () => {
    const offenders = [...RUNS.values()]
      .filter((r) => r.model.interfaceType === "nasal_pillow")
      .flatMap(({ model, bands }) =>
        bands
          .filter((b) => b.variant.noseHeightMin !== null)
          .map((b) => `${model.slug}/${b.sizeCode}`),
      );
    expect(offenders).toEqual([]);
  });

  it("every full-face style mask still gates on nose-to-chin", () => {
    // The one dimension the only manufacturer who publishes numbers
    // sizes full face masks on (F&P REF 620198). Dropping it would make
    // the engine blind to what actually separates the sizes.
    const missing = [...RUNS.values()]
      .filter((r) => FACE.includes(r.model.interfaceType))
      .filter(({ bands }) =>
        bands.every((b) => b.variant.noseToChinMin === null),
      )
      .map((r) => r.model.slug);
    expect(missing).toEqual([]);
  });

  it("no migration authors a face-width band", () => {
    // Face width is the one measured dimension that gates NOTHING, and
    // that is a decision rather than an oversight — 0511's per-interface
    // table assigns it to no interface, and every migration that names
    // the column only ever NULLs it.
    //
    // It stays that way until someone has data on the right axis, and
    // this guard exists because the wrong axis is so easy to reach for.
    // `faceWidthAtCheekbones` is the mesh's frontal SILHOUETTE width at
    // landmarks 234/454 — ~153 mm on the canonical face — not the
    // caliper bizygomatic breadth of the anthropometric tables, which
    // runs ~20 mm narrower. Bands copied from those tables would sit
    // below every real reading, and `scoreVariant` averages each
    // non-NULL dimension, so a wrong-axis band does not merely add
    // nothing: it drags every mask's fit score down and pushes patients
    // out of band. That is precisely the silent, one-directional failure
    // 0511 was written to undo, and nothing currently stops it recurring
    // on this column.
    //
    // Authoring one is legitimate — from observed fitter readings, per
    // the convention note in cpap-fitter's face-measurements.ts. Doing
    // so means updating this test deliberately, which is the point.
    // Checked by FILE, not by assignment syntax. An `=` pattern only
    // catches UPDATE-shaped authoring, and this repo seeds bands the
    // other way — `INSERT INTO mask_size_variants (<column list>)
    // SELECT ... FROM (VALUES ...)`, as 0486, 0494 and 0522 all do.
    // Adding the face-width columns to such a list with real values
    // emits no `=` at all and would sail past a syntax check, while
    // authoring exactly the bands this test forbids.
    //
    // So the invariant is on the SET OF FILES: these four are the only
    // migrations allowed to name the column, and each is verified below
    // to do so benignly. Any other migration touching face width fails
    // here — which is the intended cost, because authoring these bands
    // should be a deliberate act that updates this test.
    const ALLOWED = new Map([
      ["0481_mask_intelligence_catalog.sql", "declares the columns"],
      ["0493_non_magnetic_mask_skus.sql", "copies a twin's existing values"],
      ["0511_mask_fit_band_conventions.sql", "clears them to NULL"],
      ["0512_mask_size_run_corrections.sql", "clears them to NULL"],
    ]);
    const COLUMN = /"?face_width_(?:min|max)_mm"?/i;

    const unexpectedFiles: string[] = [];
    const offenders: string[] = [];
    for (const file of readdirSync(MIGRATIONS).filter((f) =>
      f.endsWith(".sql"),
    )) {
      const sql = read(file);
      if (!COLUMN.test(sql)) continue;
      if (!ALLOWED.has(file)) {
        unexpectedFiles.push(file);
        continue;
      }
      for (const [i, line] of sql.split("\n").entries()) {
        // Within an allowed file, still refuse a non-NULL assignment.
        // Quotes optional: Postgres accepts a bare identifier, so a
        // migration written without them is valid SQL that a
        // quotes-required pattern would wave straight through.
        if (/"?face_width_(min|max)_mm"?\s*=\s*(?!NULL)\S/i.test(line)) {
          offenders.push(`${file}:${i + 1}`);
        }
      }
    }
    expect(unexpectedFiles).toEqual([]);
    expect(offenders).toEqual([]);
  });

  it("full-face nose-to-chin bands bracket the canonical adult", () => {
    // The defect in one line: before 0511 the AirFit F20's whole run
    // topped out at 80.5 mm against an 89.4 mm average adult.
    for (const { model, bands } of RUNS.values()) {
      if (!FACE.includes(model.interfaceType)) continue;
      if (model.serviceLine === "pediatric") continue;
      const mins = bands
        .map((b) => b.variant.noseToChinMin)
        .filter((v): v is number => v !== null);
      const maxes = bands
        .map((b) => b.variant.noseToChinMax)
        .filter((v): v is number => v !== null);
      expect(Math.min(...mins), model.slug).toBeLessThan(
        CANONICAL_ADULT.noseToChin,
      );
      expect(Math.max(...maxes), model.slug).toBeGreaterThan(
        CANONICAL_ADULT.noseToChin,
      );
    }
  });
});

describe("size runs match what the manufacturer actually ships", () => {
  // Verified while auditing the seed — 0511's runs against ResMed's own
  // storefront (eshop.resmed.com) and support pages; 0512's against
  // manufacturer-hosted documents or two independent sources with
  // per-size SKUs (docs/mask-size-run-registry-2026-08-21.md holds the
  // per-model citations). Each of these was wrong in the seed: invented
  // sizes (AirFit F20 XS/LW, F30 Wides, F30i Large, DreamWear gel
  // pillows XS), missing sizes (TrueBlue MW, Forma/Wisp/ComfortGel Blue
  // Full/FitLife XL, Wisp Pediatric L, the XS cushions), whole runs
  // shifted (Amara), or codes the manufacturer never prints (N10 and
  // Swift FX Nano ship S/Standard/Wide, Zest ships Petite).
  const EXPECTED: Record<string, string[]> = {
    // key: "slug|component"
    "resmed-airfit-f20|cushion": ["S", "M", "L"],
    "resmed-airfit-f20-non-magnetic|cushion": ["S", "M", "L"],
    "resmed-airfit-n20|cushion": ["S", "M", "L"],
    "resmed-airfit-f30|cushion": ["S", "M"],
    "resmed-airfit-n30|cushion": ["S", "SW", "M"],
    "resmed-airfit-f30i|cushion": ["S", "SW", "M", "W"],
    "resmed-airfit-f30i-non-magnetic|cushion": ["S", "SW", "M", "W"],
    "resmed-airfit-f40|cushion": ["SW", "M", "L"],
    "resmed-airfit-n30i|cushion": ["S", "SW", "M", "W"],
    "resmed-airfit-n10|cushion": ["S", "Standard", "Wide"],
    "resmed-swift-fx-nano|cushion": ["S", "Standard", "Wide"],
    "resmed-swift-fx|pillow": ["XS", "S", "M", "L"],
    "resmed-airfit-f10|cushion": ["XS", "S", "M", "L"],
    "resmed-quattro-air|cushion": ["XS", "S", "M", "L"],
    "philips-amara-full|cushion": ["P", "S", "M", "L"],
    "philips-wisp|cushion": ["P", "S/M", "L", "XL"],
    "philips-wisp-pediatric|cushion": ["S", "M", "L"],
    "philips-trueblue|cushion": ["P", "S", "M", "MW", "L"],
    "philips-comfortgel-blue-full|cushion": ["S", "M", "L", "XL"],
    // 0512 also aligns this run's Medium-Wide CODE with the rest of the
    // catalog ('MW', long form as the label) so the DB and static
    // catalog modes emit the same size code.
    "philips-dreamwear-ff|cushion": ["S", "M", "MW", "L"],
    "philips-fitlife|cushion": ["S", "L", "XL"],
    "philips-dreamwear-np|pillow": ["S", "M", "L"],
    "fisher-paykel-forma|cushion": ["S", "M", "L", "XL"],
    "fisher-paykel-zest|cushion": ["Petite", "Standard", "Plus"],
    "fisher-paykel-brevida|pillow": ["XS-S", "M-L"],
    "fisher-paykel-evora-full|cushion": ["XS", "S-M", "L"],
  };

  it.each(Object.keys(EXPECTED))("%s", (key) => {
    const run = RUNS.get(key);
    expect(run, `${key} has no run`).toBeDefined();
    expect([...run!.bands.map((b) => b.sizeCode)].sort()).toEqual(
      [...EXPECTED[key]!].sort(),
    );
  });
});
