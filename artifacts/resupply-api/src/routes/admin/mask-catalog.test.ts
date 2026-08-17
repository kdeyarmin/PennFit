// Route tests for routes/admin/mask-catalog.ts
//
// One concern dominates this file: `mask_models` and `mask_size_variants`
// are SHARED platform reference data. Every tenant reads the same rows.
// So the tests here are about what a tenant is allowed to WRITE:
//
//   * clinical sign-off must land in the tenant-scoped
//     `mask_variant_reviews` table, never on the shared variant's
//     `needs_clinical_review` flag — one DME's respiratory therapist must
//     not lift the engine's confidence cap for every other DME;
//   * catalog edits must be refused on rows the tenant does not own;
//   * a band edit must be validated against the row's STORED endpoints,
//     not just the fields in the request, or a partial edit can author a
//     min-above-max band that matches no patient.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ORG_ID = "33333333-3333-4333-8333-333333333333";
const VARIANT_ID = "44444444-4444-4444-8444-444444444444";
const MODEL_ID = "55555555-5555-4555-8555-555555555555";

/**
 * Records every write the route attempts, so a test can assert not just
 * that the right table was written but that the WRONG one wasn't.
 */
const db = vi.hoisted(() => ({
  writes: [] as Array<{ table: string; op: string; payload: unknown }>,
  /** org_id of the model behind VARIANT_ID — null means a platform row. */
  variantOwnerOrgId: null as string | null,
  /** What the stored variant row looks like, for band-merge validation. */
  variantRow: {} as Record<string, unknown>,
  modelOwnerOrgId: null as string | null,
  modelCatalogVersion: 3,
}));

vi.mock("@workspace/resupply-db", () => {
  const makeBuilder = (table: string, scoped: boolean) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of [
      "select",
      "eq",
      "or",
      "limit",
      "order",
      "ilike",
      "neq",
      "in",
      "range",
    ]) {
      chain[m] = () => self();
    }
    chain.maybeSingle = async () => {
      if (table === "mask_size_variants") {
        return {
          data: {
            id: VARIANT_ID,
            mask_model_id: MODEL_ID,
            ...db.variantRow,
            mask_models: { org_id: db.variantOwnerOrgId },
          },
          error: null,
        };
      }
      if (table === "mask_models") {
        return {
          data: {
            id: MODEL_ID,
            org_id: db.modelOwnerOrgId,
            catalog_version: db.modelCatalogVersion,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({ data: [], error: null });
    chain.update = (payload: unknown) => {
      db.writes.push({ table, op: "update", payload });
      const upd: Record<string, unknown> = {};
      for (const m of ["eq", "or"]) upd[m] = () => upd;
      upd.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null });
      return upd;
    };
    chain.upsert = (payload: unknown) => {
      db.writes.push({
        table,
        op: scoped ? "upsert(org-scoped)" : "upsert",
        payload,
      });
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: null }),
      };
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => makeBuilder(t, true),
      raw: () => ({
        schema: () => ({ from: (t: string) => makeBuilder(t, false) }),
      }),
    })),
  };
});

// Auth + rate limiting are exercised elsewhere; here they just let the
// handler run with a known tenant and admin identity.
vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdmin: (
    req: Record<string, unknown>,
    _res: unknown,
    next: () => void,
  ) => {
    req.orgId = ORG_ID;
    req.adminEmail = "rt@example.test";
    next();
  },
  requirePermission: () => (_r: unknown, _s: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_r: unknown, _s: unknown, next: () => void) => next(),
}));
vi.mock("../../lib/fitting/catalog-store", () => ({
  invalidateFittingContext: vi.fn(),
}));

import maskCatalogRouter from "./mask-catalog";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(maskCatalogRouter);
  return app;
}

beforeEach(() => {
  db.writes = [];
  db.variantOwnerOrgId = null;
  db.modelOwnerOrgId = null;
  db.modelCatalogVersion = 3;
  db.variantRow = {
    nose_width_min_mm: 30,
    nose_width_max_mm: 40,
    nose_to_chin_min_mm: null,
    nose_to_chin_max_mm: null,
    nose_height_min_mm: null,
    nose_height_max_mm: null,
    mouth_width_min_mm: null,
    mouth_width_max_mm: null,
    face_width_min_mm: null,
    face_width_max_mm: null,
  };
});

describe("POST /admin/fitter/catalog/variants/:id/review — tenant isolation", () => {
  it("records sign-off in the tenant-scoped table, not on the shared row", async () => {
    const res = await request(makeApp())
      .post(`/admin/fitter/catalog/variants/${VARIANT_ID}/review`)
      .send({ approved: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, approved: true });

    // THE assertion: nothing touched the shared variant row. Clearing
    // `mask_size_variants.needs_clinical_review` here would lift the
    // engine's confidence cap for every other tenant on the platform.
    expect(
      db.writes.filter((w) => w.table === "mask_size_variants"),
    ).toHaveLength(0);

    const reviews = db.writes.filter((w) => w.table === "mask_variant_reviews");
    expect(reviews).toHaveLength(1);
    expect(reviews[0].op).toBe("upsert(org-scoped)");
    expect(reviews[0].payload).toMatchObject({
      size_variant_id: VARIANT_ID,
      approved: true,
      reviewed_by_email: "rt@example.test",
    });
  });

  it("records a withdrawal the same way, still without touching the shared row", async () => {
    const res = await request(makeApp())
      .post(`/admin/fitter/catalog/variants/${VARIANT_ID}/review`)
      .send({ approved: false, note: "bands look wrong for our stock" });

    expect(res.status).toBe(200);
    expect(
      db.writes.filter((w) => w.table === "mask_size_variants"),
    ).toHaveLength(0);
    expect(db.writes[0].payload).toMatchObject({ approved: false });
  });

  it("404s on a size belonging to another tenant's private mask", async () => {
    db.variantOwnerOrgId = OTHER_ORG_ID;
    const res = await request(makeApp())
      .post(`/admin/fitter/catalog/variants/${VARIANT_ID}/review`)
      .send({ approved: true });
    expect(res.status).toBe(404);
    expect(db.writes).toHaveLength(0);
  });
});

describe("PATCH /admin/fitter/catalog/variants/:id — shared-row protection", () => {
  it("refuses to edit the millimetre bands on a shared platform row", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/variants/${VARIANT_ID}`)
      .send({ noseWidthMinMm: 31 });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("platform_row_read_only");
    expect(db.writes).toHaveLength(0);
  });

  it("allows the edit on the tenant's own private mask", async () => {
    db.variantOwnerOrgId = ORG_ID;
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/variants/${VARIANT_ID}`)
      .send({ noseWidthMinMm: 31 });
    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].payload).toMatchObject({ nose_width_min_mm: 31 });
  });

  it("rejects a partial edit that inverts the band against the STORED maximum", async () => {
    db.variantOwnerOrgId = ORG_ID;
    // Stored band is 30–40. Raising only the minimum to 45 leaves a band
    // no patient can match, and validating only the submitted fields
    // would wave it straight through.
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/variants/${VARIANT_ID}`)
      .send({ noseWidthMinMm: 45 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_band");
    expect(db.writes).toHaveLength(0);
  });

  it("rejects a partial edit that lowers the maximum below the stored minimum", async () => {
    db.variantOwnerOrgId = ORG_ID;
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/variants/${VARIANT_ID}`)
      .send({ noseWidthMaxMm: 25 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_band");
  });

  it("accepts a coherent two-sided edit", async () => {
    db.variantOwnerOrgId = ORG_ID;
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/variants/${VARIANT_ID}`)
      .send({ noseWidthMinMm: 45, noseWidthMaxMm: 55 });
    expect(res.status).toBe(200);
  });
});

describe("PATCH /admin/fitter/catalog/:id — ownership and versioning", () => {
  it("refuses to edit a shared platform mask", async () => {
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/${MODEL_ID}`)
      .send({ status: "discontinued" });
    expect(res.status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  it("bumps catalog_version on a clinically-material edit", async () => {
    db.modelOwnerOrgId = ORG_ID;
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/${MODEL_ID}`)
      .send({ hasMagneticComponents: true });
    expect(res.status).toBe(200);
    expect(res.body.catalogVersion).toBe(4);
    expect(db.writes[0].payload).toMatchObject({ catalog_version: 4 });
  });

  it("leaves catalog_version alone for a notes-only edit", async () => {
    db.modelOwnerOrgId = ORG_ID;
    const res = await request(makeApp())
      .patch(`/admin/fitter/catalog/${MODEL_ID}`)
      .send({ notes: "we stock this in medium only" });
    expect(res.status).toBe(200);
    expect(res.body.catalogVersion).toBe(3);
    expect(db.writes[0].payload).not.toHaveProperty("catalog_version");
  });
});
