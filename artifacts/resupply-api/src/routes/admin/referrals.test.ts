// Route tests for routes/admin/provider-referrals.ts — the DME's inbound queue.
//
// Three things are worth locking down here, and only three:
//
//   1. ROUTE ORDER. `/admin/provider-referrals/providers` is a literal path that
//      sits under the same prefix as `/admin/provider-referrals/:id`. Express
//      matches in declaration order, so if the literal ever drifts below
//      the parameterised route it binds `:id="providers"` and 400s on the
//      uuid parse. That is a silent break of a working page, and it is
//      exactly the kind of thing a later "tidy the file" commit does.
//   2. DRAFT INVISIBILITY. A referral belongs to the DME when it is
//      SUBMITTED, not while the provider is still writing it. Every read
//      must carry the `submitted_at is not null` filter.
//   3. STATUS TRANSITIONS guard in the WHERE clause rather than after a
//      read, so two staff clicking at once cannot race a referral
//      backwards.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// vi.hoisted() is lifted above these, so the fixture inside it repeats
// the literals rather than referencing them.
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const REFERRAL_ID = "44444444-4444-4444-8444-444444444444";

/** Every query the route builds, so the tests can assert on filters. */
const db = vi.hoisted(() => ({
  queries: [] as Array<{
    table: string;
    op: string;
    filters: string[];
    payload?: unknown;
  }>,
  referral: {
    id: "44444444-4444-4444-8444-444444444444",
    status: "submitted",
    submitted_at: "2026-08-01T00:00:00.000Z",
    patient_id: null,
    patient_first_name: "Test",
    patient_last_name: "Patient",
    provider_unread_count: 0,
    dme_unread_count: 2,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    org_id: "22222222-2222-4222-8222-222222222222",
  } as Record<string, unknown> | null,
  /** Rows the guarded UPDATE ... .select() returns; [] = no transition. */
  updateReturns: [{ id: "44444444-4444-4444-8444-444444444444" }] as unknown[],
}));

vi.mock("@workspace/resupply-db", () => {
  const build = (table: string) => {
    const filters: string[] = [];
    const chain: Record<string, unknown> = {};
    const record = (op: string, payload?: unknown) => {
      db.queries.push({ table, op, filters: [...filters], payload });
    };
    for (const m of ["select", "order", "range", "limit", "in", "eq"]) {
      chain[m] = (a?: unknown, b?: unknown) => {
        if (m === "eq") filters.push(`${String(a)}=${String(b)}`);
        if (m === "in") filters.push(`${String(a)} in ${JSON.stringify(b)}`);
        if (m === "select" && typeof a === "string") record("select");
        return chain;
      };
    }
    chain.not = (col: string, op: string, val: unknown) => {
      filters.push(`not:${col}:${op}:${String(val)}`);
      return chain;
    };
    chain.maybeSingle = async () => {
      record("read");
      if (table === "referrals") return { data: db.referral, error: null };
      if (table === "providers") {
        return {
          data: { id: "p", first_name: "A", last_name: "B" },
          error: null,
        };
      }
      return { data: null, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      record("read");
      return resolve({ data: [], error: null });
    };
    chain.update = (payload: unknown) => {
      const upd: Record<string, unknown> = {};
      upd.eq = (a?: unknown, b?: unknown) => {
        filters.push(`${String(a)}=${String(b)}`);
        return upd;
      };
      upd.in = (a?: unknown, b?: unknown) => {
        filters.push(`${String(a)} in ${JSON.stringify(b)}`);
        return upd;
      };
      upd.not = (c: string, o: string, v: unknown) => {
        filters.push(`not:${c}:${o}:${String(v)}`);
        return upd;
      };
      upd.select = () => {
        record("update", payload);
        return {
          then: (resolve: (v: unknown) => unknown) =>
            resolve({ data: db.updateReturns, error: null }),
        };
      };
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
    chain.upsert = (payload: unknown) => {
      record("upsert", payload);
      return {
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: null, error: null }),
      };
    };
    return chain;
  };
  return {
    getOrgScopedClient: vi.fn(() => ({
      from: (t: string) => build(t),
      raw: () => ({ schema: () => ({ from: (t: string) => build(t) }) }),
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
    req.adminEmail = "csr@example.test";
    next();
  },
  requirePermission: () => (_r: unknown, _s: unknown, next: () => void) =>
    next(),
}));
vi.mock("../../middlewares/admin-rate-limit", () => ({
  adminRateLimit: () => (_r: unknown, _s: unknown, next: () => void) => next(),
}));

import referralsRouter from "./referrals";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(referralsRouter);
  return app;
}

beforeEach(() => {
  db.queries = [];
  db.updateReturns = [{ id: REFERRAL_ID }];
  db.referral = {
    id: REFERRAL_ID,
    status: "submitted",
    submitted_at: "2026-08-01T00:00:00.000Z",
    patient_id: null,
    patient_first_name: "Test",
    patient_last_name: "Patient",
    provider_unread_count: 0,
    dme_unread_count: 2,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    org_id: ORG_ID,
  };
});

describe("route ordering", () => {
  it("serves /admin/provider-referrals/providers as a literal, not as :id", async () => {
    const res = await request(makeApp()).get(
      "/admin/provider-referrals/providers",
    );
    // If `:id` had matched first, the uuid parse would 400 with
    // "invalid_id" instead of returning the link list.
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("links");
  });

  it("still rejects a genuinely malformed referral id", async () => {
    const res = await request(makeApp()).get(
      "/admin/provider-referrals/not-a-uuid",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_id");
  });
});

describe("drafts are invisible to the DME", () => {
  it("filters the queue to submitted referrals only", async () => {
    await request(makeApp()).get("/admin/provider-referrals?open=true");
    const listed = db.queries.find(
      (q) => q.table === "referrals" && q.op === "read",
    );
    expect(listed).toBeDefined();
    expect(listed!.filters).toContain("not:submitted_at:is:null");
  });

  it("filters the detail read the same way", async () => {
    await request(makeApp()).get(`/admin/provider-referrals/${REFERRAL_ID}`);
    const read = db.queries.find(
      (q) => q.table === "referrals" && q.op === "read",
    );
    expect(read!.filters).toContain("not:submitted_at:is:null");
  });
});

describe("accept", () => {
  it("takes a submitted referral and stamps who took it", async () => {
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/accept`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("accepted");
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    expect(update!.payload).toMatchObject({
      status: "accepted",
      accepted_by_email: "csr@example.test",
    });
  });

  it("409s rather than re-accepting one already in progress", async () => {
    db.referral = { ...db.referral!, status: "in_progress" };
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/accept`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_pending");
  });

  it("404s on a draft that was never submitted", async () => {
    db.referral = { ...db.referral!, submitted_at: null };
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/accept`)
      .send({});
    expect(res.status).toBe(404);
  });
});

describe("decline", () => {
  it("requires a reason the provider can actually read", async () => {
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/decline`)
      .send({ reason: "no" });
    expect(res.status).toBe(400);
    expect(db.queries.some((q) => q.op === "update")).toBe(false);
  });

  it("stores the reason AND posts it to the thread", async () => {
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/decline`)
      .send({ reason: "We are out of network for this payer." });
    expect(res.status).toBe(200);
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    expect(update!.payload).toMatchObject({
      status: "declined",
      declined_reason: "We are out of network for this payer.",
    });
    const message = db.queries.find(
      (q) => q.table === "referral_messages" && q.op === "insert",
    );
    expect(message!.payload).toMatchObject({
      author_kind: "staff",
      body: "We are out of network for this payer.",
    });
  });
});

describe("status transitions", () => {
  it("guards the allowed from-states in the WHERE, not after a read", async () => {
    await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/status`)
      .send({ status: "in_progress" });
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    // Two staff clicking at once must not race it backwards, so the
    // permitted prior states are part of the update's own filter — and
    // in_progress may only be reached from accepted.
    expect(update!.filters).toContain('status in ["accepted"]');
  });

  it("409s when the guarded update matched nothing", async () => {
    db.updateReturns = [];
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/status`)
      .send({ status: "dispensed" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("invalid_transition");
  });

  it("stamps dispensed_at only when dispensing", async () => {
    await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/status`)
      .send({ status: "in_progress" });
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    expect(update!.payload).not.toHaveProperty("dispensed_at");
  });
});

describe("messages", () => {
  it("bumps the PROVIDER's badge, never the DME's own", async () => {
    await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/messages`)
      .send({ body: "Received, we'll reach out to the patient today." });
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    expect(update!.payload).toHaveProperty("provider_unread_count");
    expect(update!.payload).not.toHaveProperty("dme_unread_count");
  });

  it("records the event without the message body", async () => {
    await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/messages`)
      .send({ body: "Patient Jane Doe called about her mask." });
    const event = db.queries.find(
      (q) => q.table === "referral_events" && q.op === "insert",
    );
    const detail = (event!.payload as { detail: Record<string, unknown> })
      .detail;
    expect(detail).toEqual({ chars: 39 });
    expect(JSON.stringify(event!.payload)).not.toContain("Jane");
  });
});

// Copilot review on #1263: accept did its status check in a prior READ and
// then updated on `id` alone, so two staff clicking Accept together both
// passed the read and both wrote — two accepted events, last-writer-wins on
// who is recorded as having taken it. Decline and status already guarded in
// the WHERE; accept was the odd one out.
describe("accept is race-safe", () => {
  it("constrains the update to status='submitted'", async () => {
    await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/accept`)
      .send({});
    const update = db.queries.find(
      (q) => q.table === "referrals" && q.op === "update",
    );
    expect(update!.filters).toContain("status=submitted");
  });

  it("409s when the guarded update matched nothing, and writes no events", async () => {
    // The row read as 'submitted' but someone else took it first.
    db.updateReturns = [];
    const res = await request(makeApp())
      .post(`/admin/provider-referrals/${REFERRAL_ID}/accept`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_pending");
    // The loser must not leave an accepted event behind.
    expect(
      db.queries.some(
        (q) => q.table === "referral_events" && q.op === "insert",
      ),
    ).toBe(false);
  });
});
