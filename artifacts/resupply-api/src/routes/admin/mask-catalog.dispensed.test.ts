// The "only what you dispense" filter on the sign-off queue.
//
// Why it exists: the catalog ships ~290 estimated size bands across ~86
// models, and the clinical fitter cannot be switched on until a clinician
// signs off the bands. The activation runbook says a tenant "only needs
// the models it actually dispenses" — but the console had no way to say
// that, so every reviewer faced the whole platform catalog. That is the
// difference between an afternoon and a project.
//
// The behaviour that matters most here is the FAIL-OPEN: a tenant with
// neither a formulary nor stock recorded must see the whole catalog, not
// an empty page. "We cannot tell what you dispense" and "you dispense
// nothing" are different answers, and only one of them is true.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";

const db = vi.hoisted(() => ({
  formularyRules: [] as Array<Record<string, unknown>>,
  availability: [] as Array<Record<string, unknown>>,
  models: [] as Array<Record<string, unknown>>,
  variants: [] as Array<Record<string, unknown>>,
  reviews: [] as Array<Record<string, unknown>>,
}));

vi.mock("@workspace/resupply-db", () => {
  const rowsFor = (table: string) => {
    switch (table) {
      case "formulary_rules":
        return db.formularyRules;
      case "mask_availability":
        return db.availability;
      case "mask_models":
        return db.models;
      case "mask_size_variants":
        return db.variants;
      case "mask_variant_reviews":
        return db.reviews;
      default:
        return [];
    }
  };
  const makeBuilder = (table: string) => {
    // `.in()` and `.eq()` are honoured on ANY column, not just id. The
    // route relies on them to exclude denied formulary rules and
    // not-stocked masks, so a mock that ignored them would pass those
    // rows through and report a filter bug that isn't there.
    const inFilters: Array<[string, string[]]> = [];
    const eqFilters: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "or", "limit", "order", "range", "ilike"]) {
      chain[m] = () => chain;
    }
    chain.in = (col: string, vals: string[]) => {
      inFilters.push([col, vals]);
      return chain;
    };
    chain.eq = (col: string, val: unknown) => {
      eqFilters.push([col, val]);
      return chain;
    };
    chain.maybeSingle = async () => ({ data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown) => {
      let rows = rowsFor(table);
      for (const [col, vals] of inFilters) {
        rows = rows.filter((r) => vals.includes(String(r[col])));
      }
      for (const [col, val] of eqFilters) {
        // Fixtures omit columns they don't exercise; an absent column is
        // not a mismatch.
        rows = rows.filter((r) => !(col in r) || r[col] === val);
      }
      return resolve({ data: rows, error: null });
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => makeBuilder(t),
      raw: () => ({ schema: () => ({ from: (t: string) => makeBuilder(t) }) }),
    })),
  };
});

vi.mock("../../middlewares/requireAdmin", () => ({
  requireAdmin: (
    req: Record<string, unknown>,
    _res: unknown,
    next: () => void,
  ) => {
    req.orgId = ORG_ID;
    next();
  },
  requirePermission: () => (_r: unknown, _s: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_r: unknown, _s: unknown, next: () => void) => next(),
  adminWriteRateLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
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

const RESMED = "aaaaaaaa-0000-4000-8000-000000000001";
const FP = "aaaaaaaa-0000-4000-8000-000000000002";
const PHILIPS = "aaaaaaaa-0000-4000-8000-000000000003";

beforeEach(() => {
  db.models = [
    { id: RESMED, manufacturer: "ResMed", model_name: "AirFit N20" },
    { id: FP, manufacturer: "Fisher & Paykel", model_name: "Eson 2" },
    { id: PHILIPS, manufacturer: "Philips Respironics", model_name: "Wisp" },
  ];
  db.formularyRules = [];
  db.availability = [];
  db.variants = [];
  db.reviews = [];
});

const list = (qs: string) =>
  request(makeApp()).get(`/admin/fitter/catalog${qs}`);
const names = (body: { models: Array<{ modelName: string }> }) =>
  body.models.map((m) => m.modelName).sort();

describe("a tenant that has told us nothing about what it dispenses", () => {
  it("sees the whole catalog rather than an empty queue", async () => {
    const res = await list("?dispensedOnly=true");
    expect(res.status).toBe(200);
    expect(names(res.body)).toEqual(["AirFit N20", "Eson 2", "Wisp"]);
  });

  it("says so, so the console can explain the unfiltered list", async () => {
    const res = await list("?dispensedOnly=true");
    // Silently ignoring the toggle would read as the filter being broken.
    expect(res.body.dispensingConfigured).toBe(false);
  });
});

describe("resolving what a tenant dispenses", () => {
  it("narrows to models a formulary rule allows", async () => {
    db.formularyRules = [
      { target_kind: "model", target_mask_model_id: FP, effect: "allow" },
    ];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["Eson 2"]);
    expect(res.body.dispensingConfigured).toBe(true);
  });

  it("counts a manufacturer-level allow as every model from that maker", async () => {
    db.formularyRules = [
      {
        target_kind: "manufacturer",
        target_manufacturer: "ResMed",
        effect: "prefer",
      },
    ];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["AirFit N20"]);
  });

  it("counts stocked masks even with no formulary at all", async () => {
    db.availability = [{ mask_model_id: PHILIPS, availability: "in_stock" }];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["Wisp"]);
  });

  it("unions the two signals rather than requiring both", async () => {
    db.formularyRules = [
      { target_kind: "model", target_mask_model_id: FP, effect: "allow" },
    ];
    db.availability = [{ mask_model_id: PHILIPS, availability: "low" }];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["Eson 2", "Wisp"]);
  });
});

describe("signals that must NOT count as dispensing", () => {
  it("ignores a denied model", async () => {
    // A denied mask is the one a reviewer has least reason to spend time
    // on, so a deny must not pull it into the queue.
    db.formularyRules = [
      { target_kind: "model", target_mask_model_id: FP, effect: "deny" },
    ];
    db.availability = [{ mask_model_id: PHILIPS, availability: "in_stock" }];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["Wisp"]);
  });

  it("ignores masks explicitly not stocked", async () => {
    db.availability = [
      { mask_model_id: FP, availability: "not_stocked" },
      { mask_model_id: PHILIPS, availability: "in_stock" },
    ];
    const res = await list("?dispensedOnly=true");
    expect(names(res.body)).toEqual(["Wisp"]);
  });
});

describe("the filter is opt-in", () => {
  it("leaves the list alone when not requested", async () => {
    db.formularyRules = [
      { target_kind: "model", target_mask_model_id: FP, effect: "allow" },
    ];
    const res = await list("");
    expect(names(res.body)).toEqual(["AirFit N20", "Eson 2", "Wisp"]);
    expect(res.body.dispensingConfigured).toBeUndefined();
  });
});
