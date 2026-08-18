// Geometry sign-off on the fit report (migration 0491).
//
// The catalog UI tells a reviewer their cited source is "printed on the
// fit report". These tests are what makes that true — and, just as
// importantly, cover the two ways it could quietly lie: a rejected review
// rendering as evidence FOR a band, and an unreviewed band rendering as
// nothing at all when "this ran on estimates" is the fact a reader needs.

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION_ID = "55555555-5555-4555-8555-555555555555";
const CUSHION = "66666666-6666-4666-8666-666666666666";
const MODEL = "77777777-7777-4777-8777-777777777777";

const db = vi.hoisted(() => ({
  session: {} as Record<string, unknown>,
  reviews: [] as Array<Record<string, unknown>>,
  variants: [] as Array<Record<string, unknown>>,
}));

vi.mock("@workspace/resupply-db", () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "or", "in", "limit", "order"]) {
      chain[m] = () => self();
    }
    chain.maybeSingle = async () =>
      table === "fit_sessions"
        ? { data: db.session, error: null }
        : { data: null, error: null };
    chain.then = (resolve: (v: unknown) => unknown) => {
      if (table === "mask_variant_reviews") {
        return resolve({ data: db.reviews, error: null });
      }
      if (table === "mask_size_variants") {
        return resolve({ data: db.variants, error: null });
      }
      return resolve({ data: [], error: null });
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => builder(t),
      raw: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
    })),
  };
});

vi.mock("../company-info", () => ({
  getCompanyInfo: vi.fn(async () => null),
}));

import { buildFitReport } from "./build-report";

beforeEach(() => {
  db.session = {
    id: SESSION_ID,
    created_at: "2026-08-01T00:00:00Z",
    rules_engine_version: "v1",
    outcome: "high_confidence",
    review_status: "not_required",
    primary_cushion_variant_id: CUSHION,
    primary_frame_variant_id: null,
    override_variant_id: null,
    primary_mask_model_id: MODEL,
    safety_flags: [],
  };
  db.reviews = [];
  db.variants = [{ id: CUSHION, component: "cushion", size_label: "Medium" }];
});

describe("fit report — geometry sign-off", () => {
  it("carries the cited source through to the report", async () => {
    db.reviews = [
      {
        size_variant_id: CUSHION,
        approved: true,
        reviewed_by_email: "rt@dme.test",
        reviewed_at: "2026-08-02T00:00:00Z",
        source_kind: "manufacturer_fit_guide",
        source_ref: "AirFit N20 fitting template rev C",
      },
    ];

    const report = await buildFitReport("org-1", SESSION_ID);

    expect(report).not.toBeNull();
    const signOff = report!.provenance.geometrySignOff;
    expect(signOff).toHaveLength(1);
    expect(signOff[0]).toMatchObject({
      component: "cushion",
      sizeLabel: "Medium",
      reviewedByEmail: "rt@dme.test",
      sourceKind: "manufacturer_fit_guide",
      sourceRef: "AirFit N20 fitting template rev C",
    });
  });

  it("omits a REJECTED review rather than printing it as evidence", async () => {
    // approved:false means the reviewer judged the band wrong. Rendering
    // it in a section headed "sign-off" would say the opposite.
    db.reviews = [
      {
        size_variant_id: CUSHION,
        approved: false,
        reviewed_by_email: "rt@dme.test",
        reviewed_at: "2026-08-02T00:00:00Z",
        source_kind: "manufacturer_fit_guide",
        source_ref: "rev C",
      },
    ];

    const report = await buildFitReport("org-1", SESSION_ID);
    expect(report!.provenance.geometrySignOff).toEqual([]);
  });

  it("reports nothing signed off when the tenant has no review", async () => {
    // Empty is meaningful: the seeded bands are estimates, so the report
    // renders an explicit "not signed off" line from this.
    const report = await buildFitReport("org-1", SESSION_ID);
    expect(report!.provenance.geometrySignOff).toEqual([]);
  });

  it("keeps a sign-off that predates provenance capture, with null source", async () => {
    // Pre-0491 rows are legitimately sourceless; dropping them would hide
    // a real approval.
    db.reviews = [
      {
        size_variant_id: CUSHION,
        approved: true,
        reviewed_by_email: "rt@dme.test",
        reviewed_at: "2026-07-01T00:00:00Z",
        source_kind: null,
        source_ref: null,
      },
    ];

    const report = await buildFitReport("org-1", SESSION_ID);
    const signOff = report!.provenance.geometrySignOff;
    expect(signOff).toHaveLength(1);
    expect(signOff[0]?.sourceKind).toBeNull();
    expect(signOff[0]?.reviewedByEmail).toBe("rt@dme.test");
  });
});
