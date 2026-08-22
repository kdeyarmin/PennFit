/**
 * The legacy storefront catalog, held to the same axis as the fitter.
 *
 * `maskCatalog` still drives the live /api/recommend path (the
 * invite-gated virtual fitter) and /api/masks. Its original hand-authored
 * `fitRanges` carried the same defect migration 0511 fixed in the DB
 * catalog: nose-to-chin authored on a subnasale→menton scale (~65 mm)
 * while the browser pipeline reports nose TIP → menton (~89 mm on the
 * canonical face). Under `recommendationEngine`'s semantics that had two
 * live consequences for a perfectly average adult:
 *
 *   - `scoreFitMatch` zeroed the noseToChin term (weight 0.35) for every
 *     full-face mask, systematically de-ranking the whole interface; and
 *   - `recommendSize` — which sizes full-face/hybrid masks by linearly
 *     partitioning [noseToChinMin, noseToChinMax] — clamped every
 *     average adult to the LARGEST size with a spurious "you may be a
 *     marginal fit" warning.
 *
 * The catalog now carries one uniform envelope per dimension — ±18%
 * (±3 SD) around the canonical face on the pipeline's own axes — so
 * geometry stops pretending to distinguish masks, sizing partitions the
 * same envelope the DB catalog's bands are derived from, and only a
 * genuine ±3 SD outlier sees the clamp warning. This file pins all of
 * that, plus the size runs verified against manufacturer sources
 * (docs/mask-size-run-registry-2026-08-21.md).
 */

import { describe, expect, it } from "vitest";

import { MAGNETIC_MASK_IDS, maskCatalog } from "./maskCatalog.js";
import { resolveSizeRunBuckets } from "../lib/size-run.js";
import {
  maskHasMagneticHardware,
  recommendSize,
  type FacialMeasurements,
} from "../lib/storefront/recommendationEngine.js";

/** Frontal spans of MediaPipe's canonical face through the production
 * landmark pairs — same anchor as lib/fitting's plausibility windows. */
const CANONICAL_ADULT: FacialMeasurements = {
  noseWidth: 35.72,
  noseHeight: 29.36,
  noseToChin: 89.4,
  mouthWidth: 49.12,
  faceWidthAtCheekbones: 153.28,
  calibrationMethod: "iris",
};

/** ±18% of the canonical face, one decimal — what every entry carries. */
const ENVELOPE = {
  noseWidthMin: 29.3,
  noseWidthMax: 42.1,
  noseToChinMin: 73.3,
  noseToChinMax: 105.5,
  mouthWidthMin: 40.3,
  mouthWidthMax: 58.0,
} as const;

describe("legacy catalog fit ranges", () => {
  it("every mask carries the canonical-face envelope, unchanged", () => {
    for (const mask of maskCatalog) {
      expect(mask.fitRanges, mask.id).toEqual(ENVELOPE);
    }
  });

  it("the envelope brackets the canonical adult on every dimension", () => {
    expect(ENVELOPE.noseWidthMin).toBeLessThan(CANONICAL_ADULT.noseWidth);
    expect(ENVELOPE.noseWidthMax).toBeGreaterThan(CANONICAL_ADULT.noseWidth);
    expect(ENVELOPE.noseToChinMin).toBeLessThan(CANONICAL_ADULT.noseToChin);
    expect(ENVELOPE.noseToChinMax).toBeGreaterThan(CANONICAL_ADULT.noseToChin);
    expect(ENVELOPE.mouthWidthMin).toBeLessThan(CANONICAL_ADULT.mouthWidth);
    expect(ENVELOPE.mouthWidthMax).toBeGreaterThan(CANONICAL_ADULT.mouthWidth);
  });

  it("an average adult is never told they are a marginal fit", () => {
    // The pre-fix catalog produced the "above this mask's range … you may
    // be a marginal fit" clamp for an 89.4 mm nose-to-chin on essentially
    // every full-face mask. Inside the envelope the rationale must be the
    // ordinary estimated-size one.
    for (const mask of maskCatalog) {
      const { size, rationale } = recommendSize(mask, CANONICAL_ADULT);
      if (mask.sizesAvailable.length === 0) continue;
      expect(size, mask.id).not.toBeNull();
      expect(rationale, mask.id).not.toMatch(/marginal fit/i);
    }
  });

  it("an average adult lands mid-run, not clamped to an end size", () => {
    // For every mask whose run spans 3+ PARTITION BUCKETS, the canonical
    // face must NOT resolve into the last bucket — that is the clamp the
    // broken axis produced. Buckets, not array positions: recommendSize
    // follows 0511's wide-code convention, so a run like the N30's
    // [S, SW, M] is a TWO-bucket ladder (SW shares M's width bucket) and
    // its plain Medium — the semantically right size for an average
    // face — sits last in the array without being an end size. (The
    // first bucket is legitimate for 2-bucket runs whose split straddles
    // the average.)
    for (const mask of maskCatalog) {
      const sizes = mask.sizesAvailable;
      if (sizes.length < 3) continue;
      const run = resolveSizeRunBuckets(
        sizes,
        mask.type === "fullFace" || mask.type === "hybrid"
          ? "height"
          : "width",
      );
      if (run.bucketCount < 3) continue;
      const { size } = recommendSize(mask, CANONICAL_ADULT);
      const chosenBucket = run.bucketOf[sizes.indexOf(size!)];
      expect(chosenBucket, mask.id).not.toBe(run.bucketCount - 1);
    }
  });
});

describe("legacy catalog size runs", () => {
  it("the fabricated DreamWear Full Face Gel is gone", () => {
    // No such Philips product exists; migration 0512 retires the same
    // model in the DB catalog.
    expect(
      maskCatalog.find((m) => m.id === "philips-dreamwear-ff-gel"),
    ).toBeUndefined();
  });

  // Runs verified against manufacturer sources — the same table the DB
  // catalog is pinned to in lib/fitting/catalog-bands.test.ts.
  const VERIFIED_RUNS: Record<string, string[]> = {
    "resmed-airfit-f20": ["S", "M", "L"],
    "resmed-airfit-f30": ["S", "M"],
    "resmed-airfit-f40": ["SW", "M", "L"],
    "resmed-airfit-n20": ["S", "M", "L"],
    "resmed-airfit-n30": ["S", "SW", "M"],
    "resmed-airfit-f30i": ["S", "SW", "M", "W"],
    "resmed-airfit-n30i": ["S", "SW", "M", "W"],
    "resmed-airfit-p10": ["XS", "S", "M", "L"],
    "resmed-mirage-fx": ["Standard", "Wide"],
    "philips-dreamwear-ff": ["S", "M", "MW", "L"],
    "philips-dreamwear-nasal": ["S", "M", "MW", "L"],
    "philips-dreamwear-np": ["S", "M", "L"],
    "philips-dreamwear-silicone-pillows": ["S", "M", "MW", "L"],
    "philips-dreamwisp": ["P", "S", "M", "L", "XL"],
    "philips-amara-view": ["S", "M", "L"],
    "philips-pico": ["S/M", "L", "XL"],
    "fisher-paykel-vitera": ["S", "M", "L"],
    "fisher-paykel-eson2": ["S", "M", "L"],
    "fisher-paykel-brevida": ["XS-S", "M-L"],
    "fisher-paykel-evora-full": ["XS", "S-M", "L"],
    "fisher-paykel-zest": ["Petite", "Standard", "Plus"],
  };

  it.each(Object.keys(VERIFIED_RUNS))("%s", (id) => {
    const mask = maskCatalog.find((m) => m.id === id);
    // The legacy catalog is a subset of the DB catalog; a verified model
    // absent here is fine, but one that IS here must carry the real run.
    if (!mask) return;
    expect(mask.sizesAvailable).toEqual(VERIFIED_RUNS[id]!);
  });
});

describe("magnet safety on the legacy catalog", () => {
  const byId = new Map(maskCatalog.map((m) => [m.id, m]));

  it("every audited magnetic mask exists and warns about implanted devices", () => {
    // The legacy path cannot run the clinical magnet screen (its
    // questionnaire has no implant question), so the manufacturer-flagged
    // warning in `contraindications` is the one surface every consumer
    // of this catalog shows. Before this, the FDA-recalled masks carried
    // no magnet mention in their contraindications at all.
    expect(MAGNETIC_MASK_IDS.size).toBeGreaterThan(0);
    for (const id of MAGNETIC_MASK_IDS) {
      const mask = byId.get(id);
      expect(mask, `${id} missing from the catalog`).toBeDefined();
      expect(
        mask!.contraindications.some((c) => /magnet/i.test(c)),
        `${id} has no magnet warning`,
      ).toBe(true);
      expect(maskHasMagneticHardware(mask!), id).toBe(true);
    }
  });

  it("the Fisher & Paykel range is magnet-free and no longer false-positives the text checks", () => {
    // F&P state publicly that their entire range is magnet-free; the
    // Evora Full's old "magnetic-style clips" copy false-positived every
    // text-based magnet check, excluding the safest option for implant
    // patients (the miscue 0492 corrected in the DB catalog).
    const fp = maskCatalog.filter((m) => m.id.startsWith("fisher-paykel-"));
    expect(fp.length).toBeGreaterThan(0);
    for (const mask of fp) {
      expect(MAGNETIC_MASK_IDS.has(mask.id), mask.id).toBe(false);
      expect(maskHasMagneticHardware(mask), mask.id).toBe(false);
    }
  });
});
