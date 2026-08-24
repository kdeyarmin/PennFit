// Idempotency for POST /shop/fitter-requests.
//
// The bug: /fit-request is reachable by back-navigation and its submit
// button is clickable twice, so one patient asking for one thing filed
// two queue rows and sent staff two notification emails. Staff then work
// a phantom.
//
// The guard is a partial unique index the DATABASE enforces, not a
// read-then-write check in the route — two racing double-clicks both pass
// a read-then-write. These tests pin the behaviour that hangs off it:
// what counts as the same ask, what a conflict resolves to, and what a
// duplicate must NOT cause.

import { describe, it, expect, vi, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  /** Payloads passed to .insert(), oldest first. */
  inserts: [] as Array<Record<string, unknown>>,
  /** Payloads passed to .update(), oldest first. */
  updates: [] as Array<Record<string, unknown>>,
  /** Queue of results the next insert()s resolve to. */
  insertResults: [] as Array<{
    data: { id: string } | null;
    error: { code?: string; message: string } | null;
  }>,
  /** What the post-conflict lookup for an open request returns. */
  existingOpen: null as { id: string } | null,
  /** What findFitterLead's lookup returns. */
  lead: null as { id: string } | null,
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "order", "limit", "is"]) {
        chain[m] = () => chain;
      }
      chain.maybeSingle = async () => {
        if (table === "fitter_leads") return { data: db.lead, error: null };
        return { data: db.existingOpen, error: null };
      };
      chain.insert = (payload: Record<string, unknown>) => {
        db.inserts.push(payload);
        const result = db.insertResults.shift() ?? {
          data: { id: "inserted-row" },
          error: null,
        };
        const after: Record<string, unknown> = {
          maybeSingle: async () => result,
        };
        for (const m of ["select", "eq", "limit"]) after[m] = () => after;
        return after;
      };
      chain.update = (payload: Record<string, unknown>) => {
        db.updates.push(payload);
        const after: Record<string, unknown> = {
          maybeSingle: async () => ({ data: { id: "x" }, error: null }),
          then: undefined,
        };
        for (const m of ["select", "eq", "limit", "is"]) after[m] = () => after;
        // Supabase update() is awaited directly in some call sites.
        return Object.assign(
          Promise.resolve({ data: null, error: null }),
          after,
        );
      };
      return chain;
    },
  }),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  computeFitRequestDedupeHash,
  recordFitRequest,
  type RecordFitRequestInput,
} from "./fit-request-record";

const BASE: RecordFitRequestInput = {
  orgId: "00000000-0000-4000-8000-000000000000",
  requestType: "callback",
  fullName: "Dana Ruiz",
  email: "dana@example.com",
  phone: "215-555-0134",
  preferredContactMethod: "phone",
  population: "adult",
  submitterIp: null,
  userAgent: null,
};

const UNIQUE_VIOLATION = { code: "23505", message: "duplicate key" };

beforeEach(() => {
  db.inserts = [];
  db.updates = [];
  db.insertResults = [];
  db.existingOpen = null;
  db.lead = null;
});

describe("computeFitRequestDedupeHash — what counts as the same ask", () => {
  const hash = (
    over: Partial<Parameters<typeof computeFitRequestDedupeHash>[0]>,
  ) =>
    computeFitRequestDedupeHash({
      requestType: BASE.requestType,
      fullName: BASE.fullName,
      email: BASE.email,
      phone: BASE.phone,
      ...over,
    });

  it("ignores the trivia a patient would never call a difference", () => {
    // Capitalisation, padding, a doubled space, and the way a phone
    // number is punctuated. The same person typed the same thing twice.
    expect(hash({ fullName: "  DANA   RUIZ " })).toBe(hash({}));
    expect(hash({ email: "Dana@Example.com" })).toBe(hash({}));
    expect(hash({ phone: "(215) 555 0134" })).toBe(hash({}));
  });

  it("separates two people, and one person asking for two things", () => {
    expect(hash({ email: "sam@example.com" })).not.toBe(hash({}));
    expect(hash({ fullName: "Dana Ruiz-Bell" })).not.toBe(hash({}));
    // Sending details and ALSO asking for a call are two asks.
    expect(hash({ requestType: "full_details" })).not.toBe(hash({}));
  });

  it("cannot be collided by shifting a character across fields", () => {
    // The joiner has to be something no normalized part can contain, or
    // ("ab","c") and ("a","bc") would hash alike and merge two patients.
    expect(hash({ fullName: "ab", email: "c@x.com" })).not.toBe(
      hash({ fullName: "abc", email: "@x.com" }),
    );
  });

  it("treats a missing phone as its own value, not as a wildcard", () => {
    expect(hash({ phone: null })).not.toBe(hash({}));
    expect(hash({ phone: null })).toBe(hash({ phone: "" }));
  });
});

describe("recordFitRequest — a re-submit does not queue a second request", () => {
  it("files normally when nothing conflicts", async () => {
    const res = await recordFitRequest(BASE);
    expect(res).toEqual({ id: "inserted-row" });
    expect(res.duplicate).toBeUndefined();
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]!.dedupe_hash).toEqual(expect.any(String));
  });

  it("returns the EXISTING request on a unique violation, without re-inserting", async () => {
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };

    const res = await recordFitRequest(BASE);

    expect(res.id).toBe("already-open");
    expect(res.duplicate).toBe(true);
    // One attempt only — the conflict resolved, so no retry.
    expect(db.inserts).toHaveLength(1);
  });

  it("reports a duplicate rather than an error, so the patient is not told to retry", async () => {
    // The whole point: the patient's ask IS in the queue. Surfacing the
    // unique violation as a failure would tell them to submit again,
    // which is the loop this exists to break.
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };
    const res = await recordFitRequest(BASE);
    expect(res.error).toBeUndefined();
    expect(res.id).toBeTruthy();
  });

  it("folds newly supplied detail into the request that already exists", async () => {
    // A patient who re-submits having found their insurance card. The
    // second submission carries more than the first; staff should work
    // the fuller version rather than two conflicting rows.
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };

    await recordFitRequest({
      ...BASE,
      insuranceCarrier: "Aetna",
      memberId: "W123456789",
    });

    const enrich = db.updates.at(-1)!;
    expect(enrich).toHaveProperty("insurance_carrier", "Aetna");
    expect(enrich).toHaveProperty("member_id", "W123456789");
  });

  it("never blanks a field the first submission supplied", async () => {
    // A sparser re-submit must not erase detail already in the queue.
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };

    await recordFitRequest({ ...BASE, insuranceCarrier: null, notes: "   " });

    const enrich = db.updates.at(-1) ?? {};
    expect(enrich).not.toHaveProperty("insurance_carrier");
    expect(enrich).not.toHaveProperty("notes");
  });

  it("never lets a re-submit touch the columns the CSR owns", async () => {
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };

    await recordFitRequest({ ...BASE, notes: "please call after 5" });

    for (const u of db.updates) {
      for (const owned of [
        "status",
        "csr_note",
        "contacted_at",
        "contacted_by",
        "closed_at",
        "closed_outcome",
      ]) {
        expect(u).not.toHaveProperty(owned);
      }
    }
  });

  it("inserts for real when the conflicting request was closed in the meantime", async () => {
    // The narrow race: a CSR closes the matching request between our
    // INSERT failing and the lookup running. The queue no longer holds
    // this ask, so a new row is correct — not a duplicate.
    db.insertResults = [
      { data: null, error: UNIQUE_VIOLATION },
      { data: { id: "second-attempt" }, error: null },
    ];
    db.existingOpen = null;

    const res = await recordFitRequest(BASE);

    expect(db.inserts).toHaveLength(2);
    expect(res.id).toBe("second-attempt");
    expect(res.duplicate).toBeUndefined();
  });

  it("gives up rather than looping when every attempt conflicts and vanishes", async () => {
    db.insertResults = [
      { data: null, error: UNIQUE_VIOLATION },
      { data: null, error: UNIQUE_VIOLATION },
    ];
    db.existingOpen = null;

    const res = await recordFitRequest(BASE);

    expect(db.inserts).toHaveLength(2);
    expect(res.id).toBeNull();
    expect(res.error).toBeTruthy();
  });

  it("still fails loudly on a non-conflict database error", async () => {
    // Only 23505 means "already queued". Anything else is a genuine
    // write failure and the patient must be told to try again.
    db.insertResults = [
      { data: null, error: { code: "42501", message: "permission denied" } },
    ];
    const res = await recordFitRequest(BASE);
    expect(res.id).toBeNull();
    expect(res.error).toContain("permission denied");
  });

  it("does not re-stamp the prospect when the request was already filed", async () => {
    // `contact_requested_at` records that this person raised their hand.
    // The first submission set it; a re-submit has nothing to add and
    // must not move the timestamp.
    db.lead = { id: "lead-1" };
    db.insertResults = [{ data: null, error: UNIQUE_VIOLATION }];
    db.existingOpen = { id: "already-open" };

    await recordFitRequest(BASE);

    for (const u of db.updates) {
      expect(u).not.toHaveProperty("contact_requested_at");
    }
  });
});
