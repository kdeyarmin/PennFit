// Route tests for routes/admin/safety-screens.ts
//
// Two invariants dominate, and both are about damage a bug here could do
// beyond the tenant making the request:
//
//   1. TENANCY. `safety_screen_versions.org_id` is NULLABLE and NULL means
//      the PLATFORM set every tenant is screened against. An unfiltered
//      write would let one DME edit — or delete — the clinical questions
//      shown to every other DME on the platform.
//   2. IMMUTABILITY OF A PUBLISHED SET. Stored answers are stamped with a
//      version label, and the fit report prints it. Editing a live set in
//      place would silently change what those answers mean.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const DRAFT_ID = "44444444-4444-4444-8444-444444444444";
const PLATFORM_ID = "55555555-5555-4555-8555-555555555555";

const db = vi.hoisted(() => ({
  writes: [] as Array<{
    table: string;
    op: string;
    payload: unknown;
    filters: Array<[string, unknown]>;
  }>,
  /**
   * What an ownership lookup resolves to. `null` models the case that
   * matters most: the row exists but belongs to the platform, so the
   * `.eq("org_id", orgId)` filter matches nothing.
   */
  ownedRow: null as Record<string, unknown> | null,
  /** Rows a list/`then` read resolves to. */
  listRows: [] as Array<Record<string, unknown>>,
  questionRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("@workspace/resupply-db", () => {
  const makeBuilder = (table: string) => {
    const filters: Array<[string, unknown]> = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "or", "limit", "order", "in"]) {
      chain[m] = () => chain;
    }
    chain.eq = (col: string, val: unknown) => {
      filters.push([col, val]);
      return chain;
    };
    chain.maybeSingle = async () => ({ data: db.ownedRow, error: null });
    chain.then = (resolve: (v: unknown) => unknown) =>
      resolve({
        data:
          table === "safety_screen_questions" ? db.questionRows : db.listRows,
        error: null,
      });
    const record = (op: string, payload: unknown) => {
      const sub: Record<string, unknown> = {};
      const subFilters: Array<[string, unknown]> = [];
      sub.eq = (col: string, val: unknown) => {
        subFilters.push([col, val]);
        return sub;
      };
      sub.select = () => sub;
      sub.limit = () => sub;
      sub.maybeSingle = async () => ({
        data: op === "insert" ? { id: DRAFT_ID } : null,
        error: null,
      });
      sub.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null });
      db.writes.push({ table, op, payload, filters: subFilters });
      return sub;
    };
    chain.insert = (p: unknown) => record("insert", p);
    chain.update = (p: unknown) => record("update", p);
    chain.delete = () => record("delete", null);
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => makeBuilder(t),
      raw: () => ({
        schema: () => ({ from: (t: string) => makeBuilder(t) }),
      }),
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
    req.adminEmail = "rt@example.test";
    next();
  },
  requirePermission: () => (_r: unknown, _s: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_r: unknown, _s: unknown, next: () => void) => next(),
  // Pre-auth IP buckets, mounted AHEAD of requireAdmin on every route in
  // this file. Pass-through here — the limiting itself is upstream config.
  adminReadRateLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
  adminWriteRateLimiter: (_r: unknown, _s: unknown, next: () => void) => next(),
}));
const invalidate = vi.hoisted(() => vi.fn());
vi.mock("../../lib/fitting/catalog-store", () => ({
  invalidateFittingContext: invalidate,
}));

import safetyScreensRouter from "./safety-screens";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(safetyScreensRouter);
  return app;
}

function draft(over: Record<string, unknown> = {}) {
  return {
    id: DRAFT_ID,
    org_id: ORG_ID,
    slug: "magnetic_implant",
    version: "2026-09.v2",
    scope: "magnetic",
    status: "draft",
    title: "Magnetic component safety check",
    intro_copy: null,
    attestation_copy: "I confirm…",
    effective_from: null,
    ...over,
  };
}

const QUESTION = {
  questionKey: "patient_cardiac_device",
  prompt: "Do you have a pacemaker?",
  subject: "patient",
  sortOrder: 10,
  riskFlag: "magnet_implant_patient",
  disqualifiesAttribute: "has_magnetic_components",
  severity: "exclude",
  unsureBehavesAs: "exclude",
};

beforeEach(() => {
  db.writes = [];
  db.ownedRow = null;
  db.listRows = [];
  db.questionRows = [];
  invalidate.mockClear();
});

describe("a tenant can never write the platform's set", () => {
  // Every one of these resolves ownership through `.eq("org_id", orgId)`,
  // so a platform row (org_id NULL) simply does not match. Each case
  // sends a VALID body for its route, so a 404 proves the ownership
  // check rejected it rather than the schema.
  const CASES: Array<
    [string, "patch" | "put" | "post" | "delete", string, object]
  > = [
    ["patch copy", "patch", "", { title: "Mine" }],
    ["replace questions", "put", "/questions", { questions: [QUESTION] }],
    ["publish", "post", "/publish", {}],
    ["retire", "post", "/retire", {}],
    ["delete", "delete", "", {}],
  ];

  it.each(CASES)(
    "404s on %s and writes nothing",
    async (_label, method, suffix, body) => {
      db.ownedRow = null; // the ownership filter matched no row
      const url = `/admin/fitter/safety-screens/${PLATFORM_ID}${suffix}`;
      const res = await request(makeApp())[method](url).send(body);
      expect(res.status).toBe(404);
      expect(db.writes).toHaveLength(0);
    },
  );

  it("scopes every write it does make to the tenant", async () => {
    db.ownedRow = draft();
    db.questionRows = [{ id: "q1", screen_version_id: DRAFT_ID }];
    await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/publish`)
      .send({});
    const versionWrites = db.writes.filter(
      (w) => w.table === "safety_screen_versions" && w.op === "update",
    );
    expect(versionWrites.length).toBeGreaterThan(0);
    for (const w of versionWrites) {
      expect(w.filters.find(([c]) => c === "org_id")?.[1]).toBe(ORG_ID);
    }
  });
});

describe("a published set is immutable", () => {
  // Stored answers are stamped with the version label and the fit report
  // prints it, so editing a live set would change what those answers mean.
  const CASES: Array<[string, "patch" | "put" | "delete", string, object]> = [
    ["patch copy", "patch", "", { title: "Reworded" }],
    ["replace questions", "put", "/questions", { questions: [QUESTION] }],
    ["delete", "delete", "", {}],
  ];

  it.each(CASES)(
    "refuses to %s an active set",
    async (_label, method, suffix, body) => {
      db.ownedRow = draft({ status: "active" });
      const url = `/admin/fitter/safety-screens/${DRAFT_ID}${suffix}`;
      const res = await request(makeApp())[method](url).send(body);
      expect(res.status).toBe(409);
    },
  );
});

describe("publishing", () => {
  it("retires the previous active set before promoting the draft", async () => {
    db.ownedRow = draft();
    db.questionRows = [{ id: "q1", screen_version_id: DRAFT_ID }];
    const res = await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/publish`)
      .send({});
    expect(res.status).toBe(200);
    const updates = db.writes.filter(
      (w) => w.table === "safety_screen_versions" && w.op === "update",
    );
    // Order matters: 0498's unique index allows only one active row per
    // (org, slug), so promoting first would collide with the incumbent.
    const statuses = updates.map(
      (w) => (w.payload as Record<string, unknown>).status,
    );
    expect(statuses).toEqual(["retired", "active"]);
  });

  it("refuses to publish a set with no questions", async () => {
    db.ownedRow = draft();
    db.questionRows = [];
    const res = await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/publish`)
      .send({});
    // The assessment route would demand this screen and the patient could
    // never complete it — every fitting would stall.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_questions");
  });

  it("invalidates the cached fitting context", async () => {
    db.ownedRow = draft();
    db.questionRows = [{ id: "q1", screen_version_id: DRAFT_ID }];
    await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/publish`)
      .send({});
    // Without this the next patient is still asked the old questions.
    expect(invalidate).toHaveBeenCalledWith(ORG_ID);
  });
});

describe("questions", () => {
  it("rejects a duplicate question key", async () => {
    db.ownedRow = draft();
    const res = await request(makeApp())
      .put(`/admin/fitter/safety-screens/${DRAFT_ID}/questions`)
      .send({ questions: [QUESTION, { ...QUESTION, sortOrder: 20 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("duplicate_question_key");
  });

  it("rejects a question key that is not a stable identifier", async () => {
    db.ownedRow = draft();
    const res = await request(makeApp())
      .put(`/admin/fitter/safety-screens/${DRAFT_ID}/questions`)
      .send({
        // Keys are stamped onto stored answers, so prose here would make
        // historical responses unmatchable.
        questions: [{ ...QUESTION, questionKey: "Do you have a pacemaker?" }],
      });
    expect(res.status).toBe(400);
  });

  it("replaces the set wholesale rather than merging", async () => {
    db.ownedRow = draft();
    const res = await request(makeApp())
      .put(`/admin/fitter/safety-screens/${DRAFT_ID}/questions`)
      .send({ questions: [QUESTION] });
    expect(res.status).toBe(200);
    const ops = db.writes
      .filter((w) => w.table === "safety_screen_questions")
      .map((w) => w.op);
    // A removed question left in place is the less obvious of two wrong
    // answers on a safety screen.
    expect(ops).toEqual(["delete", "insert"]);
  });
});

describe("retiring", () => {
  it("falls back to the platform set rather than to no screening", async () => {
    db.ownedRow = draft({ status: "active" });
    const res = await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/retire`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.revertedToPlatformDefault).toBe(true);
    expect(invalidate).toHaveBeenCalledWith(ORG_ID);
  });

  it("refuses to retire something that is not active", async () => {
    db.ownedRow = draft({ status: "draft" });
    const res = await request(makeApp())
      .post(`/admin/fitter/safety-screens/${DRAFT_ID}/retire`)
      .send({});
    expect(res.status).toBe(409);
  });
});
