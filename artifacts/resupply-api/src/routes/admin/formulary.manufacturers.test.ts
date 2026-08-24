// Route tests for the manufacturer show/hide switch on
// routes/admin/formulary.ts (migration 0516).
//
// The switch is a VIEW over `formulary_rules` — hiding a brand writes one
// org-wide `exclude` rule — so the cases worth pinning are the ones where
// "just write the rule" would be wrong:
//
//   * hiding a brand that leaves a patient profile with nothing must be
//     REFUSED, not saved, because rules go live the instant they are
//     written and a starved formulary reads to a patient as a clinical
//     exclusion rather than a stocking decision;
//   * the rule must carry the CATALOG's spelling of the manufacturer, not
//     the operator's — a rule targeting "resmed" against a catalog that
//     says "ResMed" saves cleanly and then hides nothing at all;
//   * un-hiding must not delete a scoped rule somebody authored by hand.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
  MOCK_ORG_ID,
} from "../../test-helpers/auth-mocks";
import type { CatalogMask, FormularyRule } from "../../lib/fitting/types";

const FORMULARY_ID = "66666666-6666-4666-8666-666666666666";

const { mockAdmin, db } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  db: {
    writes: [] as Array<{ table: string; op: string; payload: unknown }>,
    deletes: [] as string[],
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit:
    () =>
    (
      _req: import("express").Request,
      _res: import("express").Response,
      next: import("express").NextFunction,
    ) =>
      next(),
  adminWriteRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
  adminReadRateLimiter: (
    _req: import("express").Request,
    _res: import("express").Response,
    next: import("express").NextFunction,
  ) => next(),
}));

vi.mock("@workspace/resupply-db", () => {
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const m of ["select", "eq", "limit", "order"]) chain[m] = () => self();
    chain.maybeSingle = async () =>
      table === "formularies"
        ? { data: { id: FORMULARY_ID, version: 1 }, error: null }
        : { data: null, error: null };
    chain.insert = async (payload: unknown) => {
      db.writes.push({ table, op: "insert", payload });
      return { data: { id: "new-rule" }, error: null };
    };
    chain.delete = () => ({
      eq: async (_col: string, id: string) => {
        db.deletes.push(id);
        return { error: null };
      },
    });
    return chain;
  };
  return {
    getOrgScopedClient: () => ({ from: (table: string) => builder(table) }),
  };
});

// The catalog + live formulary the route resolves against. Rebuilt per
// test so a hide/unhide case can start from whichever rules it needs.
const catalog: { current: CatalogMask[] } = { current: [] };
const rules: { current: FormularyRule[] } = { current: [] };

vi.mock("../../lib/fitting/catalog-store", () => ({
  invalidateFittingContext: () => {},
  loadFittingContext: async () => ({
    catalog: catalog.current,
    formulary: {
      id: FORMULARY_ID,
      name: "Test",
      version: 1,
      defaultPosture: "open" as const,
      rules: rules.current,
    },
    availability: {},
    safetyScreen: null,
    degraded: false,
  }),
}));

function mask(over: Partial<CatalogMask> = {}): CatalogMask {
  return {
    id: over.slug ?? "m1",
    slug: over.slug ?? "m1",
    manufacturer: "ResMed",
    modelName: "Test Mask",
    productLine: null,
    interfaceType: "full_face",
    serviceLine: "adult",
    therapyModes: ["pap"],
    vented: "vented",
    hasMagneticComponents: false,
    magnetFreeVariantSlug: null,
    pressureMin: 4,
    pressureMax: 25,
    supportsSupplementalOxygen: null,
    minimalContact: false,
    avoidsNasalBridge: false,
    hosePosition: "front",
    facialHairTolerance: "fair",
    sideSleepingTolerance: "fair",
    claustrophobiaTolerance: "fair",
    glassesCompatible: false,
    cushionMaterial: "Silicone",
    headgearStyle: "Fabric",
    weightGrams: 120,
    description: null,
    imageUrl: null,
    status: "current",
    fitDataSource: "manufacturer",
    needsClinicalReview: false,
    catalogVersion: 1,
    variants: [],
    contraindications: [],
    ...over,
  };
}

function rule(over: Partial<FormularyRule> = {}): FormularyRule {
  return {
    id: "r1",
    locationId: null,
    payerProfileId: null,
    contractRef: null,
    serviceLine: null,
    therapyMode: null,
    targetKind: "manufacturer",
    targetManufacturer: "ResMed",
    targetInterfaceType: null,
    targetMaskModelId: null,
    targetSizeVariantId: null,
    effect: "exclude",
    preferenceRank: null,
    reasonCode: "not_carried",
    reasonNote: null,
    effectiveFrom: null,
    effectiveTo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

// Two brands, so hiding one always leaves something dispensable. Both are
// adult + PAP + pediatric-safe enough for the synthetic panel to score.
const TWO_BRANDS = [
  mask({ slug: "resmed-a", manufacturer: "ResMed", serviceLine: "both" }),
  mask({
    slug: "philips-a",
    manufacturer: "Philips Respironics",
    serviceLine: "both",
    therapyModes: ["pap", "niv"],
  }),
  mask({
    slug: "resmed-b",
    manufacturer: "ResMed",
    serviceLine: "both",
    therapyModes: ["pap", "niv"],
  }),
];

let app: Express;

beforeEach(async () => {
  vi.resetModules();
  db.writes.length = 0;
  db.deletes.length = 0;
  catalog.current = TWO_BRANDS;
  rules.current = [];
  mockAdmin.current = {
    userId: "u1",
    email: "ops@example.com",
    role: "admin",
    orgId: MOCK_ORG_ID,
  };
  const router = (await import("./formulary")).default;
  app = express();
  app.use(express.json());
  app.use("/resupply-api", router);
});

const put = (name: string, hidden: boolean) =>
  request(app)
    .put(
      `/resupply-api/admin/fitter/formulary/manufacturers/${encodeURIComponent(name)}`,
    )
    .send({ hidden });

describe("GET /admin/fitter/formulary/manufacturers", () => {
  it("lists every brand in the catalog with its model count", async () => {
    const res = await request(app).get(
      "/resupply-api/admin/fitter/formulary/manufacturers",
    );
    expect(res.status).toBe(200);
    expect(res.body.manufacturers).toEqual([
      expect.objectContaining({
        manufacturer: "Philips Respironics",
        modelCount: 1,
        hidden: false,
      }),
      expect.objectContaining({
        manufacturer: "ResMed",
        modelCount: 2,
        hidden: false,
      }),
    ]);
  });

  it("reports a brand hidden by the switch as removable", async () => {
    rules.current = [rule()];
    const res = await request(app).get(
      "/resupply-api/admin/fitter/formulary/manufacturers",
    );
    const resmed = res.body.manufacturers.find(
      (m: { manufacturer: string }) => m.manufacturer === "ResMed",
    );
    expect(resmed).toMatchObject({
      hidden: true,
      hiddenByToggle: true,
      ruleId: "r1",
      hiddenModelCount: 2,
    });
  });

  it("marks a brand hidden by a hand-written scoped rule as not the switch's", async () => {
    // A location-scoped rule cannot fire in the context-free resolution
    // this list uses, so the brand is NOT hidden and the switch says so.
    rules.current = [rule({ locationId: "loc-1" })];
    const res = await request(app).get(
      "/resupply-api/admin/fitter/formulary/manufacturers",
    );
    const resmed = res.body.manufacturers.find(
      (m: { manufacturer: string }) => m.manufacturer === "ResMed",
    );
    expect(resmed).toMatchObject({ hidden: false, hiddenByToggle: false });
  });

  it("separates the switch's position from its net effect", async () => {
    // Switched off, but a narrower allow keeps one model dispensable. The
    // two booleans must disagree here — collapsing them would either hide
    // a mask the tenant still sells or show a switch as untouched.
    rules.current = [
      rule({ id: "toggle-rule" }),
      rule({
        id: "keep-one",
        targetKind: "mask_model",
        targetManufacturer: null,
        targetMaskModelId: "resmed-a",
        effect: "allow",
      }),
    ];
    const res = await request(app).get(
      "/resupply-api/admin/fitter/formulary/manufacturers",
    );
    const resmed = res.body.manufacturers.find(
      (m: { manufacturer: string }) => m.manufacturer === "ResMed",
    );
    expect(resmed).toMatchObject({
      hidden: false,
      hiddenByToggle: true,
      modelCount: 2,
      hiddenModelCount: 1,
    });
  });
});

describe("PUT /admin/fitter/formulary/manufacturers/:name", () => {
  it("writes one org-wide exclude rule using the CATALOG's spelling", async () => {
    // The operator typed "resmed"; the catalog says "ResMed". A rule
    // carrying the operator's spelling would save and hide nothing.
    const res = await put("resmed", true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hidden: true, manufacturer: "ResMed" });
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0]).toMatchObject({
      table: "formulary_rules",
      op: "insert",
      payload: {
        formulary_id: FORMULARY_ID,
        target_kind: "manufacturer",
        target_manufacturer: "ResMed",
        effect: "exclude",
        location_id: null,
        payer_profile_id: null,
        contract_ref: null,
        service_line: null,
        therapy_mode: null,
      },
    });
  });

  it("refuses to hide the last brand standing", async () => {
    catalog.current = [
      mask({ slug: "resmed-a", manufacturer: "ResMed", serviceLine: "both" }),
    ];
    const res = await put("ResMed", true);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("formulary_would_exclude_all");
    expect(res.body.starvedProfiles.length).toBeGreaterThan(0);
    // Refused means NOT written. A 409 that still saved would be worse
    // than no guard at all.
    expect(db.writes).toHaveLength(0);
  });

  it("is idempotent when the brand is already hidden", async () => {
    rules.current = [rule()];
    const res = await put("ResMed", true);
    expect(res.status).toBe(200);
    expect(db.writes).toHaveLength(0);
  });

  it("404s on a manufacturer no mask in the catalog is made by", async () => {
    const res = await put("Acme Masks", true);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("unknown_manufacturer");
    expect(db.writes).toHaveLength(0);
  });

  it("removes the switch's own rule when showing a brand again", async () => {
    rules.current = [rule({ id: "toggle-rule" })];
    const res = await put("ResMed", false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hidden: false, manufacturer: "ResMed" });
    expect(db.deletes).toEqual(["toggle-rule"]);
  });

  it("leaves a scoped exclusion alone rather than silently deleting it", async () => {
    // Somebody deliberately hid this brand at one location. Un-hiding
    // org-wide must not throw that away.
    rules.current = [rule({ id: "scoped", locationId: "loc-1" })];
    const res = await put("ResMed", false);
    expect(res.status).toBe(200);
    expect(db.deletes).toEqual([]);
  });

  it("rejects a body that isn't a visibility flag", async () => {
    const res = await request(app)
      .put("/resupply-api/admin/fitter/formulary/manufacturers/ResMed")
      .send({ hidden: "yes" });
    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });
});
