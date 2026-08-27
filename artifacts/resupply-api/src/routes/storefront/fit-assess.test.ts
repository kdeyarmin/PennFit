// Route tests for routes/storefront/fit-assess.ts
//
// Four concerns, in the order they matter:
//  1. The invitation gate is unchanged and still runs FIRST — adding an
//     org lookup after an HMAC-only gate is exactly how a 403-or-200
//     route turns into a 500-or-hang.
//  2. The "no images in the backend" hard rule survives a hostile body.
//  3. A database outage degrades rather than failing the patient: the
//     assessment still comes back, marked `degraded`.
//  4. The tenant flag actually gates the path.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORG_ID = "22222222-2222-2222-2222-222222222222";

// Resolve every request to one tenant without a database.
vi.mock("../../lib/storefront/signed-link-org.js", () => ({
  resolveOrgIdForSignedRecord: vi.fn(async () => ORG_ID),
}));

const featureFlags = vi.hoisted(() => ({
  enabled: new Set<string>([
    "fitter.clinical_assessment",
    "fitter.confidence_gating",
  ]),
}));
vi.mock("../../lib/feature-flags.js", () => ({
  isFeatureEnabled: vi.fn(async (key: string) => featureFlags.enabled.has(key)),
  getFeatureFlagState: vi.fn(async (key: string) => ({
    enabled: featureFlags.enabled.has(key),
    degraded: false,
  })),
}));

// The org-scoped client backs two things here: the STATEFUL invite check
// (which must see a live invite) and session persistence (which is
// deliberately allowed to fail, so the default exercises the "session
// write failed but the patient still gets their answer" path).
//
// `db.invite` is what the fitter_invites read returns — set it to a
// revoked or expired row to exercise those branches.
const db = vi.hoisted(() => ({
  invite: {
    patient_id: null as string | null,
    status: "sent",
    expires_at: null as string | null,
  } as Record<string, unknown> | null,
  /** Make the fitter_invites read FAIL (vs. return no row). */
  inviteReadFails: false,
  /** Per-table maybeSingle rows for reads beyond fitter_invites (patients,
   *  insurance_coverages, payer_profiles) — unset tables resolve null. */
  rows: {} as Record<string, Record<string, unknown> | null>,
  /** Every chained filter/modifier call, so a test can assert a query was
   *  actually scoped (the tenant boundary on reference tables IS a chain
   *  call — nothing else observable distinguishes scoped from unscoped). */
  calls: [] as Array<{ table: string; method: string; args: unknown[] }>,
  /** Every insert the route attempts, so a test can assert the payload. */
  inserts: [] as Array<{ table: string; payload: unknown }>,
  /** Every update the route attempts. The invite completion is an UPDATE,
   *  so without this the one write that puts a fitting in front of staff
   *  was the only one the mock couldn't see. */
  updates: [] as Array<{ table: string; payload: unknown }>,
  /** Make the update on this table THROW, to prove a failed worklist
   *  write can't take the clinical record down with it. */
  updateThrowsFor: null as string | null,
  /**
   * Whether the fit_sessions write SUCCEEDS. Default false, which keeps
   * the existing "persistence failed but the patient still got their
   * answer" tests exercising that path unchanged.
   */
  persistOk: false,
}));

vi.mock("@workspace/resupply-db", () => {
  // A minimal chainable PostgREST stand-in. Reads on `fitter_invites`
  // resolve to `db.invite`; every other table resolves empty, and every
  // write rejects — which is exactly the persistence-failure path.
  const builder = (table: string) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    for (const method of [
      "select",
      "eq",
      "limit",
      "order",
      "ilike",
      "neq",
      "or",
    ]) {
      chain[method] = (...args: unknown[]) => {
        db.calls.push({ table, method, args });
        return self();
      };
    }
    chain.maybeSingle = async () =>
      table === "fitter_invites"
        ? db.inviteReadFails
          ? { data: null, error: { message: "db unreachable" } }
          : { data: db.invite, error: null }
        : { data: db.rows[table] ?? null, error: null };
    chain.single = async () => {
      throw new Error("no database in tests");
    };
    chain.insert = (payload: unknown) => {
      db.inserts.push({ table, payload });
      const ok = db.persistOk;
      const row = { id: "11111111-1111-4111-8111-111111111111" };
      return {
        select: () => ({
          single: async () => {
            if (!ok) throw new Error("no database in tests");
            return { data: row, error: null };
          },
          limit: () => ({
            maybeSingle: async () =>
              ok
                ? { data: row, error: null }
                : { data: null, error: { message: "no database in tests" } },
          }),
        }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve(
            ok
              ? { data: row, error: null }
              : { data: null, error: { message: "no database in tests" } },
          ),
      };
    };
    chain.update = (payload: unknown) => {
      if (db.updateThrowsFor === table) {
        throw new Error(`update on ${table} exploded`);
      }
      db.updates.push({ table, payload });
      // Mirrors the two shapes the completion helper uses: the
      // conditional claim (`.eq().not().select()`) and the data-only
      // fallback (`await .eq()`). Tied to `persistOk` so the existing
      // "the database is down" tests keep exercising the failure path.
      const result = db.persistOk
        ? {
            data: [{ id: "22222222-2222-4222-8222-222222222222" }],
            error: null,
          }
        : { data: null, error: { message: "no db" } };
      const node: Record<string, unknown> = {
        not: () => ({ select: async () => result }),
        then: (resolve: (v: unknown) => unknown) => resolve(result),
      };
      return { eq: () => node };
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (table: string) => builder(table),
      raw: () => ({ schema: () => ({ from: (t: string) => builder(t) }) }),
    })),
  };
});

const catalogStore = vi.hoisted(() => ({
  degraded: false,
  safetyScreen: null as unknown,
}));
vi.mock("../../lib/fitting/catalog-store.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../lib/fitting/catalog-store")
  >("../../lib/fitting/catalog-store");
  const { OPEN_FORMULARY } = await vi.importActual<
    typeof import("../../lib/fitting/formulary")
  >("../../lib/fitting/formulary");
  return {
    ...actual,
    loadFittingContext: vi.fn(async () => ({
      catalog: actual.staticCatalogAsMasks(),
      formulary: OPEN_FORMULARY,
      availability: {},
      safetyScreen: catalogStore.safetyScreen ?? null,
      degraded: catalogStore.degraded,
    })),
  };
});

import fitAssessRouter from "./fit-assess";
import { signFitterInviteToken } from "../../lib/fitter-invite-token";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(fitAssessRouter);
  return app;
}

let savedLinkHmacKey: string | undefined;
beforeAll(() => {
  savedLinkHmacKey = process.env.RESUPPLY_LINK_HMAC_KEY;
  process.env.RESUPPLY_LINK_HMAC_KEY = "test-link-hmac-key-value-1234567890";
});
afterAll(() => {
  if (savedLinkHmacKey === undefined) delete process.env.RESUPPLY_LINK_HMAC_KEY;
  else process.env.RESUPPLY_LINK_HMAC_KEY = savedLinkHmacKey;
});
afterEach(() => {
  catalogStore.degraded = false;
  catalogStore.safetyScreen = null;
  featureFlags.enabled = new Set([
    "fitter.clinical_assessment",
    "fitter.confidence_gating",
  ]);
  db.invite = { patient_id: null, status: "sent", expires_at: null };
  db.inviteReadFails = false;
  db.rows = {};
  db.calls = [];
  db.inserts = [];
  db.updates = [];
  db.updateThrowsFor = null;
  db.persistOk = false;
});

const INVITE_ID = "11111111-1111-1111-1111-111111111111";
const VALID_MEASUREMENTS = {
  noseWidth: 34,
  noseHeight: 45,
  noseToChin: 66,
  mouthWidth: 50,
  faceWidthAtCheekbones: 142,
};
const VALID_PROFILE = {
  population: "adult" as const,
  therapyMode: "pap" as const,
  mouthBreather: false,
  sleepPositions: ["back" as const],
  claustrophobia: "none" as const,
  facialHair: "none" as const,
  skinIrritation: "none" as const,
  handDexterity: "normal" as const,
  pressureCmH2O: 10,
  minimalContactPreference: "no_preference" as const,
};

function post(
  body: Record<string, unknown>,
  token = signFitterInviteToken(INVITE_ID),
) {
  // Most fixtures exercise the happy path on the adult service line. Tests
  // that deliberately omit population pass `population: undefined` so the
  // helper does not inject a default.
  const payload =
    "population" in body ? body : { population: "adult", ...body };
  return request(makeApp())
    .post("/fit/assess")
    .set("x-fitter-invite-token", token)
    .send(payload);
}

describe("POST /fit/assess — invitation gate", () => {
  it("403s with no token", async () => {
    const res = await request(makeApp())
      .post("/fit/assess")
      .send({ measurements: VALID_MEASUREMENTS });
    expect(res.status).toBe(403);
  });

  it("403s with a mis-signed token", async () => {
    const good = signFitterInviteToken(INVITE_ID);
    const tampered = `${good.slice(0, -4)}AAAA`;
    const res = await post({ measurements: VALID_MEASUREMENTS }, tampered);
    expect(res.status).toBe(403);
  });

  it("403s before touching the tenant lookup or the flags", async () => {
    // The gate has to be first. If a bad token reached the org resolver we
    // would be doing database work on unauthenticated input.
    const { resolveOrgIdForSignedRecord } =
      await import("../../lib/storefront/signed-link-org.js");
    vi.mocked(resolveOrgIdForSignedRecord).mockClear();
    await post({ measurements: VALID_MEASUREMENTS }, "garbage");
    expect(resolveOrgIdForSignedRecord).not.toHaveBeenCalled();
  });
});

describe("POST /fit/assess — input hardening", () => {
  it("rejects an unknown field", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      somethingElse: true,
    });
    expect(res.status).toBe(400);
  });

  it("rejects a data-URL smuggled into the body", async () => {
    const res = await post({
      measurements: {
        ...VALID_MEASUREMENTS,
        calibrationMethod: "iris",
      },
      profile: {
        ...VALID_PROFILE,
        priorMaskModelSlug: "data:image/png;base64,AAAA",
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/binary or encoded data|Invalid input/);
  });

  it("rejects a very long base64-looking string", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: { ...VALID_PROFILE, priorMaskSize: "A".repeat(1200) },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a grossly impossible measurement", async () => {
    const res = await post({
      measurements: { ...VALID_MEASUREMENTS, noseWidth: 900 },
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(400);
  });

  it("accepts a measurement outside the sizing window and says so in the outcome", async () => {
    // Out of range is an ANSWER ("we won't guess"), not a 400. A patient
    // whose face is unusual should get an explanation, not a form error.
    const res = await post({
      measurements: { ...VALID_MEASUREMENTS, noseWidth: 15 },
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("outside_validated_range");
    expect(res.body.primary).toBeNull();
  });
});

describe("POST /fit/assess — tenant gating", () => {
  it("404s when the tenant has not enabled the clinical assessment", async () => {
    featureFlags.enabled = new Set();
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /fit/assess — happy path and degradation", () => {
  it("returns a recommendation with full provenance", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.provenance.rulesEngineVersion).toMatch(/^fit-rules@/);
    expect(res.body.provenance.formularyName).toBeTruthy();
    expect(res.body.disclaimer).toBeTruthy();
    expect(Array.isArray(res.body.alternatives)).toBe(true);
  });

  it("still answers, marked degraded, when the catalog could not be loaded", async () => {
    catalogStore.degraded = true;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.provenance.degraded).toBe(true);
    expect(res.body.outcome).toBeTruthy();
  });

  it("returns the assessment even though the session write failed", async () => {
    // The DB mock throws on every call, so persistence cannot succeed.
    // The patient must still get their fitting.
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.fitSessionId).toBeNull();
    expect(res.body.outcome).toBeTruthy();
  });

  it("accepts the legacy 11-answer shape with no v2 profile", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      answers: {
        mouthBreather: true,
        claustrophobic: false,
        sideOrStomachSleeper: true,
        heavyFacialHair: false,
        wearsGlasses: false,
        frequentCongestion: false,
        priorMaskExperience: "none",
        mobilityLimitations: false,
        sensitiveSkin: false,
        siliconeSensitivity: false,
        cpapPressureSetting: "medium",
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBeTruthy();
  });

  it("accepts the exact shape the v2 questionnaire's toProfilePayload emits", async () => {
    // Pins the wire contract between the SPA's fit-profile module and the
    // .strict() profile schema here — an unknown key on either side 400s
    // the whole assessment, so drift must fail THIS test, not a patient.
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: {
        version: "fit_profile_v2",
        population: "adult",
        therapyMode: "pap",
        therapyDevice: "cpap",
        pressureCmH2O: 12,
        supplementalOxygen: null,
        mouthBreather: true,
        nasalObstruction: "none",
        frequentCongestion: false,
        dryMouth: null,
        sleepPositions: ["side"],
        claustrophobia: "none",
        minimalContactPreference: "minimal",
        facialHair: "none",
        dentures: false,
        skinIrritation: "none",
        sensitiveSkin: false,
        wearsGlasses: null,
        priorMaskExperience: "nasal",
        priorMaskSize: "M",
        priorLeakLocations: ["bridge_of_nose"],
        priorMaskSatisfaction: 2,
        headgearDifficulty: null,
        handDexterity: "normal",
        visionOrCognitiveLimitation: null,
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBeTruthy();
  });

  it("keeps internal ranking and formulary terms out of the browser payload", async () => {
    // The STORED record keeps them; the response must not. `rankScore`
    // bakes in formulary preference and inventory margin rank, and
    // `clinicianReason` / `formularyRulesMatched` are staff-facing.
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k);
          walk(val);
        }
      }
    };
    walk(res.body);
    for (const forbidden of [
      "rankScore",
      "facialFitScore",
      "patientFactorScore",
      "clinicianReason",
      "formularyRulesMatched",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
    // The patient-facing terms survive the projection.
    expect(keys.has("confidence")).toBe(true);
    expect(keys.has("guidance")).toBe(true);
  });

  it("fails closed on magnetic masks when screening is on but no screen loaded", async () => {
    // The tenant screens for magnets, but the screen itself could not be
    // loaded (the mock's context carries safetyScreen: null). The old
    // behaviour silently resolved that to "no risk"; now every magnetic
    // mask is excluded with an explicit record, and the fitting proceeds
    // on the magnet-free catalog.
    featureFlags.enabled = new Set([
      "fitter.clinical_assessment",
      "fitter.magnet_screening",
    ]);
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBeTruthy();
    const excluded = res.body.excluded as Array<{ code: string }>;
    expect(excluded.some((e) => e.code === "magnet_screen_unavailable")).toBe(
      true,
    );
  });
});

describe("GET /fit/catalog", () => {
  it("403s without an invite token", async () => {
    const res = await request(makeApp()).get("/fit/catalog");
    expect(res.status).toBe(403);
  });

  it("returns product facts and carries no patient-identifying fields", async () => {
    const res = await request(makeApp())
      .get("/fit/catalog")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID));
    expect(res.status).toBe(200);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.masks[0]).toHaveProperty("manufacturer");

    // Assert on KEYS, not on prose: mask descriptions legitimately talk
    // about patients ("great for patients who feel claustrophobic"), so a
    // substring match on the whole payload only tests the copywriting.
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) return v.forEach(walk);
      if (v && typeof v === "object") {
        for (const [k, val] of Object.entries(v)) {
          keys.add(k);
          walk(val);
        }
      }
    };
    walk(res.body);
    for (const forbidden of [
      "patientId",
      "patient_id",
      "email",
      "phone",
      "recipientEmail",
      "measurements",
      "profileAnswers",
      "reasonNote",
    ]) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });
});

// The HMAC gate only proves an invite was ONCE issued. Unlike
// /api/recommend — which is stateless and writes nothing — this endpoint
// persists a PHI-bearing session, so it must also confirm the invite
// still stands. A tab left open when staff revoked the invite is the
// realistic path to "we kept recording patient data after being told to
// stop".
describe("POST /fit/assess — stateful invite checks", () => {
  it("declines a revoked invite even with a validly-signed token", async () => {
    db.invite = { patient_id: null, status: "revoked", expires_at: null };
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: "revoked" });
    expect(res.body.primary).toBeUndefined();
  });

  it("declines an expired invite", async () => {
    db.invite = {
      patient_id: null,
      status: "sent",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    };
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: "expired" });
  });

  it("declines when the invite row no longer exists", async () => {
    db.invite = null;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ valid: false, reason: "invite_not_found" });
  });

  it("a FAILED invite lookup is retryable, never 'invite not found'", async () => {
    // A DB blip must not tell the patient their invite is dead ("ask
    // your DME company to resend it") — that reads as permanent and ends
    // fittings that a retry would have finished.
    db.inviteReadFails = true;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      valid: false,
      reason: "invite_lookup_unavailable",
    });
  });

  it("accepts an invite that is live and not yet expired", async () => {
    db.invite = {
      patient_id: null,
      status: "sent",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBeTruthy();
  });
});

// The payer axis resolves by name against `payer_profiles` — a reference
// table with NULLABLE org_id (NULL = platform row) reached via .raw(), so
// the org-scoped client does NOT inject the tenant filter. Unscoped, a
// display name matching another tenant's private payer would mis-scope
// the formulary and persist a foreign payer id as clinical provenance.
describe("POST /fit/assess — payer lookup tenant boundary", () => {
  it("scopes the payer_profiles read to platform + this tenant, tenant row first", async () => {
    db.invite = {
      patient_id: "33333333-3333-3333-3333-333333333333",
      status: "sent",
      expires_at: null,
    };
    db.rows.patients = { location_id: null, date_of_birth: null };
    db.rows.insurance_coverages = { payer_name: "Acme Health" };
    db.rows.payer_profiles = { id: "44444444-4444-4444-4444-444444444444" };

    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);

    const payerCalls = db.calls.filter((c) => c.table === "payer_profiles");
    expect(payerCalls.length).toBeGreaterThan(0);
    const orCall = payerCalls.find((c) => c.method === "or");
    expect(orCall?.args[0]).toBe(`org_id.is.null,org_id.eq.${ORG_ID}`);
    // On a display-name collision the tenant's own row must outrank the
    // platform row — descending org_id with NULLs last.
    const orderCall = payerCalls.find((c) => c.method === "order");
    expect(orderCall?.args).toEqual([
      "org_id",
      { ascending: false, nullsFirst: false },
    ]);
  });
});

// ── Structured recommendation fields (0483 columns, dual-written) ──────
//
// The recommendation also lives in `primary_recommendation` as jsonb, but
// a blob can't be joined or FK-checked. `classifyDecision` in the outcome
// report bails on a null `primary_mask_model_id` BEFORE it looks at the
// clinician's decision, so leaving these unset made every fitting read as
// "undecided" and pinned the acceptance rate at null forever.

describe("POST /api/fit/assess — structured recommendation columns", () => {
  it("writes the mask model and size variant ids, not just the JSON blob", async () => {
    db.persistOk = true;
    // Confidence gating turns a marginal scan into "no recommendation",
    // which is a different (also-tested) path. Off here so the engine
    // actually produces a primary to record.
    featureFlags.enabled = new Set(["fitter.clinical_assessment"]);

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: {},
        population: "adult",
      });

    expect(res.status).toBe(200);
    const session = db.inserts.find((i) => i.table === "fit_sessions");
    expect(session).toBeDefined();
    const row = session!.payload as Record<string, unknown>;

    // The engine produced a primary, so the structured column must carry
    // the same catalog id the blob does.
    const primary = row.primary_recommendation as { maskId?: string } | null;
    expect(primary?.maskId).toBeTruthy();
    expect(row.primary_mask_model_id).toBe(primary?.maskId);

    // At least one of cushion/frame is chosen for a real recommendation;
    // both keys must be present so the column is explicitly null rather
    // than missing when a mask has no separate frame.
    expect(row).toHaveProperty("primary_cushion_variant_id");
    expect(row).toHaveProperty("primary_frame_variant_id");
  });

  it("leaves the ids null when there is deliberately no primary", async () => {
    // A contraindicated / out-of-range outcome has no recommendation to
    // record, and must not invent one.
    db.persistOk = true;

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: {},
        population: "adult",
        safety: {
          screenVersion: "magnetic_implant@v1",
          attestedAt: new Date().toISOString(),
          responses: [],
        },
      });

    expect(res.status).toBe(200);
    const row = db.inserts.find((i) => i.table === "fit_sessions")!
      .payload as Record<string, unknown>;
    const primary = row.primary_recommendation as { maskId?: string } | null;
    if (primary == null) {
      expect(row.primary_mask_model_id).toBeNull();
      expect(row.primary_cushion_variant_id).toBeNull();
      expect(row.primary_frame_variant_id).toBeNull();
    } else {
      // Engine still produced one — the invariant we care about is that
      // the column tracks the blob either way.
      expect(row.primary_mask_model_id).toBe(primary.maskId);
    }
  });

  it("leaves the uuid FK columns null on the degraded path", async () => {
    // The static fallback catalog's ids are slugs, not uuids. Writing them
    // into the uuid FK columns made Postgres reject the entire insert with
    // 22P02, silently losing the clinical record of every degraded
    // fitting. The blob still carries the ids.
    db.persistOk = true;
    catalogStore.degraded = true;
    featureFlags.enabled = new Set(["fitter.clinical_assessment"]);

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: {},
        population: "adult",
      });

    expect(res.status).toBe(200);
    const row = db.inserts.find((i) => i.table === "fit_sessions")!
      .payload as Record<string, unknown>;
    expect(row.degraded).toBe(true);
    expect(row.primary_mask_model_id).toBeNull();
    expect(row.primary_cushion_variant_id).toBeNull();
    expect(row.primary_frame_variant_id).toBeNull();
    const primary = row.primary_recommendation as { maskId?: string } | null;
    expect(primary?.maskId).toBeTruthy();
  });

  it("a degraded-catalog fitting never skips human review, even at high confidence", async () => {
    // The static fallback catalog ships ZERO mask contraindications
    // (catalog-store.ts staticCatalogAsMasks), so Tier-1 factor
    // exclusions were not applied to a degraded recommendation. A
    // high-confidence outcome normally sets review_status
    // "not_required" — on the degraded path it must stay
    // "pending_review" so a clinician sees the fitting before anyone
    // acts on it.
    db.persistOk = true;
    catalogStore.degraded = true;

    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      // A strong multi-frame scan, so the scan floor cannot be what
      // keeps the outcome below high confidence.
      scan: {
        frameCount: 3,
        quality: { lighting: 0.95, distance: 0.95, pose: 0.95 },
        agreement: { noseWidth: 0.97, noseToChin: 0.97 },
        measurementConfidence: 0.95,
        band: "high",
      },
    });

    expect(res.status).toBe(200);
    expect(res.body.provenance.degraded).toBe(true);
    const row = db.inserts.find((i) => i.table === "fit_sessions")!
      .payload as Record<string, unknown>;
    // Regardless of the outcome the engine reached, degraded ⇒ review.
    expect(row.review_status).toBe("pending_review");
  });

  it("routes a withheld-but-not-rescannable outcome to awaiting_review", async () => {
    // `rescan_required` is for outcomes a better photo can fix. An
    // outside-range or contraindicated fitting needs a clinician, and
    // used to land in the rescan bucket of the worklist instead.
    db.persistOk = true;
    const res = await post({
      measurements: { ...VALID_MEASUREMENTS, noseWidth: 15 },
      profile: VALID_PROFILE,
    });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("outside_validated_range");
    const row = db.inserts.find((i) => i.table === "fit_sessions")!
      .payload as Record<string, unknown>;
    expect(row.status).toBe("awaiting_review");
    expect(row.review_status).toBe("pending_review");
  });
});

// The regression this whole change exists for. The invite row is what the
// staff worklist reads, and it used to be written from ONE place — the
// patient's browser — which only transmitted when /results had a mask to
// name. Every fitting the engine declined to name one for left its invite
// stranded at "opened": no measurements, no completion time, absent from
// the holding area and the Completed filter, while the fit_sessions row
// written a few lines above held the whole story. To staff that reads as
// "the invite I sent never registered".
describe("POST /api/fit/assess — the invite records the fitting", () => {
  function inviteUpdate(): Record<string, unknown> | undefined {
    const write = db.updates.find((u) => u.table === "fitter_invites");
    return write?.payload as Record<string, unknown> | undefined;
  }

  it("completes the invite, whether or not a mask was named", async () => {
    db.persistOk = true;

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: VALID_PROFILE,
        population: "adult",
        safety: {
          screenVersion: "magnetic_implant@v1",
          attestedAt: new Date().toISOString(),
          responses: [],
        },
      });

    expect(res.status).toBe(200);
    const upd = inviteUpdate();
    expect(upd).toBeDefined();
    // The fitting is on the invite the moment the engine answers — no
    // dependency on the browser making a second, best-effort call.
    expect(upd!.status).toBe("completed");
    expect(upd!.completed_at).toEqual(expect.any(String));
    expect(upd!.measurements).toEqual(VALID_MEASUREMENTS);
    // …and the worklist can reach the clinical record behind it.
    expect(upd!.fit_session_id).toBe("11111111-1111-4111-8111-111111111111");

    // Whatever the engine decided, the invite must agree with the session
    // rather than inventing a mask to fill its columns.
    const row = db.inserts.find((i) => i.table === "fit_sessions")!
      .payload as Record<string, unknown>;
    const primary = row.primary_recommendation as { name?: string } | null;
    expect(upd!.recommended_mask_name).toBe(primary?.name ?? null);
  });

  it("an everything-excluded re-fitting clears the invite's stale ranked list", async () => {
    // A patient with a still-valid link can rescan after a completed
    // fitting. When the re-run excludes every mask (here: a prescribed
    // pressure above every catalog rating), the assess path must write
    // its (empty) ranked list so the staff worklist doesn't keep showing
    // the PREVIOUS fitting's recommendations against the new
    // contraindicated session.
    db.persistOk = true;
    db.invite = { patient_id: null, status: "completed", expires_at: null };

    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: { ...VALID_PROFILE, pressureCmH2O: 40 },
    });

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("contraindicated");
    const upd = inviteUpdate();
    expect(upd).toBeDefined();
    expect(upd!.recommendations).toEqual([]);
    expect(upd!.recommended_mask_id).toBeNull();
  });

  it("stores the subject the safety screen declares, not a key-prefix guess", async () => {
    // Tenant-authored screens may use any question key; a household
    // question without the `household_` prefix used to be persisted —
    // and printed on the signed fit report — as the PATIENT's own
    // implant answer.
    db.persistOk = true;
    catalogStore.safetyScreen = {
      slug: "magnetic_implant",
      version: "magnetic_implant@v2",
      title: "Implanted device check",
      introCopy: null,
      attestationCopy: "I confirm these answers are accurate.",
      questions: [
        {
          questionKey: "bed_partner_pacemaker",
          prompt: "Does anyone who shares your bed have a pacemaker?",
          helpText: null,
          subject: "household",
          sortOrder: 0,
          riskFlag: "magnet_implant_household",
          disqualifiesAttribute: "has_magnetic_components",
          severity: "exclude",
          unsureBehavesAs: "exclude",
        },
      ],
    };

    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      safety: {
        screenVersion: "magnetic_implant@v2",
        attestedAt: new Date().toISOString(),
        responses: [{ questionKey: "bed_partner_pacemaker", answer: "no" }],
      },
    });

    expect(res.status).toBe(200);
    const ins = db.inserts.find(
      (i) => i.table === "fit_session_safety_responses",
    );
    expect(ins).toBeDefined();
    const rows = ins!.payload as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.question_key).toBe("bed_partner_pacemaker");
    expect(rows[0]!.subject).toBe("household");
  });

  it("never costs the session write its id when the invite update fails", async () => {
    // The completion runs INSIDE the fit-session write. A throw there
    // would abort that write's own try block and return no session id —
    // losing the clinical record over a failure to update a worklist row.
    // The helper swallows everything for exactly this reason.
    db.persistOk = true;
    db.updateThrowsFor = "fitter_invites";

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: VALID_PROFILE,
        population: "adult",
        safety: {
          screenVersion: "magnetic_implant@v1",
          attestedAt: new Date().toISOString(),
          responses: [],
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.fitSessionId).toBe("11111111-1111-4111-8111-111111111111");
  });
});

// ---------------------------------------------------------------------------
// Adult or child — the SESSION field, on both question sets
// ---------------------------------------------------------------------------

describe("POST /fit/assess — population", () => {
  it("applies the top-level population over the legacy-answers mapping", async () => {
    // The legacy questionnaire sends no `profile` block, so `buildProfile`
    // resolves it from `emptyProfile()` — which defaults to "adult" for
    // back-compat. Without this field every legacy-questionnaire fitting
    // would be assessed as an adult, which is how a child gets shown
    // adult-only masks.
    db.persistOk = true;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      answers: {
        mouthBreather: false,
        claustrophobic: false,
        sideOrStomachSleeper: false,
        heavyFacialHair: false,
        wearsGlasses: false,
        frequentCongestion: false,
        priorMaskExperience: "none",
        mobilityLimitations: false,
        sensitiveSkin: false,
        siliconeSensitivity: false,
        cpapPressureSetting: "medium",
      },
      population: "pediatric",
    });
    expect(res.status).toBe(200);
    const session = db.inserts.find((i) => i.table === "fit_sessions");
    expect(session).toBeDefined();
    expect((session!.payload as Record<string, unknown>).population).toBe(
      "pediatric",
    );
  });

  it("does NOT stamp the fitting as a v2 profile just to carry population", async () => {
    // Why the field is top-level rather than a one-key `profile` block:
    // `buildProfile` marks anything with a profile as a v2 profile, which
    // decides the question set the fit report cites. Carrying population
    // that way would make every legacy fitting claim it answered ~20
    // questions it was never asked.
    db.persistOk = true;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      answers: {
        mouthBreather: false,
        claustrophobic: false,
        sideOrStomachSleeper: false,
        heavyFacialHair: false,
        wearsGlasses: false,
        frequentCongestion: false,
        priorMaskExperience: "none",
        mobilityLimitations: false,
        sensitiveSkin: false,
        siliconeSensitivity: false,
        cpapPressureSetting: "medium",
      },
      population: "pediatric",
    });
    expect(res.status).toBe(200);
    const session = db.inserts.find((i) => i.table === "fit_sessions");
    expect(
      (session!.payload as Record<string, unknown>).profile_version,
    ).not.toBe("fit_profile_v2");
  });

  it("rejects when population is omitted and the chart cannot supply it", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      population: undefined,
    });
    expect(res.status).toBe(400);
    expect(res.body.details).toEqual(
      expect.arrayContaining([expect.stringMatching(/population: required/i)]),
    );
  });

  it("accepts a chart-linked invite without body population when DOB supplies it", async () => {
    db.persistOk = true;
    db.rows.patients = {
      location_id: null,
      date_of_birth: new Date(Date.now() - 30 * 365 * 86_400_000)
        .toISOString()
        .slice(0, 10),
    };
    db.invite = {
      patient_id: "66666666-6666-4666-8666-666666666666",
      status: "opened",
      expires_at: null,
    };

    const res = await request(makeApp())
      .post("/fit/assess")
      .set("x-fitter-invite-token", signFitterInviteToken(INVITE_ID))
      .send({
        measurements: VALID_MEASUREMENTS,
        profile: VALID_PROFILE,
      });
    expect(res.status).toBe(200);
    expect(res.body.population).toBe("adult");
  });

  it("rejects a population that is not a known service line", async () => {
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      population: "teenager",
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /fit/assess — the response states the EFFECTIVE service line", () => {
  it("echoes the population the engine actually filtered on", async () => {
    db.persistOk = true;
    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      population: "pediatric",
    });
    expect(res.status).toBe(200);
    expect(res.body.population).toBe("pediatric");
  });

  it("returns the CHART's population when it overrides the browser's", async () => {
    // The chart outranks the client: a date of birth under 18 makes the
    // fitting pediatric no matter what the browser sent, and the SPA has
    // to be told — otherwise the fit request it files afterwards labels a
    // pediatric fitting as adult in the queue and the team email.
    db.persistOk = true;
    db.rows.patients = {
      location_id: null,
      date_of_birth: new Date(Date.now() - 10 * 365 * 86_400_000)
        .toISOString()
        .slice(0, 10),
    };
    db.invite = {
      patient_id: "66666666-6666-4666-8666-666666666666",
      status: "opened",
      expires_at: null,
    };

    const res = await post({
      measurements: VALID_MEASUREMENTS,
      profile: VALID_PROFILE,
      population: "adult",
    });
    expect(res.status).toBe(200);
    expect(res.body.population).toBe("pediatric");
    // And the stored session agrees — the response is not a separate
    // opinion, it is what the engine used.
    const session = db.inserts.find((i) => i.table === "fit_sessions");
    expect((session!.payload as Record<string, unknown>).population).toBe(
      "pediatric",
    );
  });
});
