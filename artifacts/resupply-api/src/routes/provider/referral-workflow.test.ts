// Route tests for the clinical half of the provider referral portal.
//
// The submit gate is the one that matters. A referral order names a
// specific mask and size and is what the receiving DME dispenses and
// bills against, so it must not reach them unsigned or incomplete — and
// the UI sequencing is not the gate, because the API is reachable
// directly. Everything below exercises that boundary.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ORG = "33333333-3333-4333-8333-333333333333";
const REFERRAL_ID = "44444444-4444-4444-8444-444444444444";

/** A referral that satisfies every submit precondition. */
function completeReferral(): Record<string, unknown> {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    org_id: "33333333-3333-4333-8333-333333333333",
    provider_id: "11111111-1111-4111-8111-111111111111",
    status: "signed",
    patient_first_name: "Test",
    patient_last_name: "Patient",
    patient_dob: "1970-01-01",
    insurance_payer_name: "Aetna",
    approved_mask_model_id: "55555555-5555-4555-8555-555555555555",
    signed_at: "2026-08-17T00:00:00.000Z",
    submitted_at: null,
    provider_unread_count: 0,
    dme_unread_count: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const db = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; op: string; payload?: unknown }>,
  referral: null as Record<string, unknown> | null,
  /** Rows the `referral_documents` read returns. */
  documents: [{ doc_type: "prescription" }] as Record<string, unknown>[],
}));

vi.mock("@workspace/resupply-db", () => {
  const build = (table: string) => {
    const chain: Record<string, unknown> = {};
    const record = (op: string, payload?: unknown) => {
      db.queries.push({ table, op, payload });
    };
    for (const m of ["select", "eq", "or", "limit", "order"]) {
      chain[m] = () => chain;
    }
    chain.maybeSingle = async () =>
      table === "referrals"
        ? { data: db.referral, error: null }
        : { data: null, error: null };
    chain.then = (resolve: (v: unknown) => unknown) => {
      record("read");
      return resolve({
        data: table === "referral_documents" ? db.documents : [],
        error: null,
      });
    };
    chain.update = (payload: unknown) => {
      const upd: Record<string, unknown> = {};
      upd.eq = () => upd;
      upd.then = (resolve: (v: unknown) => unknown) => {
        record("update", payload);
        return resolve({ data: null, error: null });
      };
      return upd;
    };
    chain.insert = (payload: unknown) => {
      record("insert", payload);
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: null }),
      };
    };
    return chain;
  };
  return {
    resolveSeedOrgId: vi.fn(async () => "seed-org"),
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => build(t),
      raw: () => ({ schema: () => ({ from: (t: string) => build(t) }) }),
    })),
  };
});

vi.mock("../../middlewares/requireProvider", () => ({
  requireProvider: [
    (req: Record<string, unknown>, _res: unknown, next: () => void) => {
      req.providerAccount = {
        id: ACCOUNT_ID,
        providerId: PROVIDER_ID,
        emailLower: "dr@example.test",
        status: "active",
        mfaEnrolledAt: "2026-01-01T00:00:00.000Z",
      };
      next();
    },
  ],
  requireProviderMfaEnrolled: (
    _req: unknown,
    _res: unknown,
    next: () => void,
  ) => next(),
}));
vi.mock("./shared", () => ({
  providerPortalRateLimiter: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
  attachProviderOrgId: (_req: unknown, _res: unknown, next: () => void) =>
    next(),
}));
// The loader is covered by referrals.test.ts; here it just resolves.
vi.mock("./referral-shared.js", async () => {
  const actual =
    await vi.importActual<typeof import("./referral-shared")>(
      "./referral-shared",
    );
  return {
    ...actual,
    loadReferralForProvider: vi.fn(async () =>
      db.referral ? { orgId: TARGET_ORG, row: db.referral } : null,
    ),
    recordReferralEvent: vi.fn(async () => {
      db.queries.push({ table: "referral_events", op: "insert" });
    }),
  };
});

import workflowRouter from "./referral-workflow";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(workflowRouter);
  return app;
}

beforeEach(() => {
  db.queries = [];
  db.referral = completeReferral();
  db.documents = [{ doc_type: "prescription" }];
});

function submit() {
  return request(makeApp())
    .post(`/api/provider/referrals/${REFERRAL_ID}/submit`)
    .send({});
}

describe("submit — the gate on what reaches the DME", () => {
  it("accepts a referral that is complete and signed", async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("submitted");
  });

  it("refuses an UNSIGNED order, however complete it otherwise is", async () => {
    // This is the one the UI sequencing hid: the SPA only offers "Send to
    // the DME" after signing, but the endpoint is reachable directly, and
    // an unsigned order is one the DME cannot dispense or bill against.
    db.referral = { ...completeReferral(), signed_at: null, status: "draft" };
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("incomplete");
    expect(res.body.missing).toContain("your signature on the order");
    expect(
      db.queries.some((q) => q.table === "referrals" && q.op === "update"),
    ).toBe(false);
  });

  it("refuses without an approved mask", async () => {
    db.referral = { ...completeReferral(), approved_mask_model_id: null };
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.missing).toContain("an approved mask");
  });

  it("refuses without a prescription on file", async () => {
    db.documents = [{ doc_type: "sleep_study" }];
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.missing).toContain("a prescription");
  });

  it("lists every missing item at once rather than one per attempt", async () => {
    db.referral = {
      ...completeReferral(),
      patient_dob: null,
      insurance_payer_name: null,
      approved_mask_model_id: null,
      signed_at: null,
    };
    db.documents = [];
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.missing).toHaveLength(5);
    // The message reads as a sentence, not a token dump.
    expect(res.body.message).toMatch(/still needs .+ and .+\.$/);
  });

  it("refuses a second submission", async () => {
    db.referral = {
      ...completeReferral(),
      submitted_at: "2026-08-17T00:00:00.000Z",
      status: "submitted",
    };
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_submitted");
  });

  it("refuses once the referral is closed", async () => {
    db.referral = { ...completeReferral(), status: "cancelled" };
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_active");
  });
});

describe("signature request", () => {
  it("refuses to raise an order that names no mask", async () => {
    // Unsigned, so the already-signed guard doesn't short-circuit first.
    db.referral = {
      ...completeReferral(),
      signed_at: null,
      approved_mask_model_id: null,
    };
    const res = await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/signature`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("no_approved_mask");
  });

  it("refuses to re-sign an already-signed order", async () => {
    const res = await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/signature`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_signed");
  });
});
