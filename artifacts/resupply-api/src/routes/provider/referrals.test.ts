// Route tests for the provider side of the referral portal.
//
// One concern dominates: this tree cannot take its tenant from the
// request. A referring physician is a cross-org identity, so a referral's
// tenant is a property of the ROW, and the authorization is the
// provider's own `provider_id`. If that ever slips — if a handler trusts
// an org from the body, or drops the provider_id filter — a global
// provider directory becomes a way to read and write another DME's PHI.
//
// So the tests below assert on the FILTERS the handlers build, not just
// on the status codes, because a handler that returns the right shape
// while querying too broadly is exactly the failure that looks fine.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const PROVIDER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_PROVIDER_ID = "99999999-9999-4999-8999-999999999999";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const TARGET_ORG = "33333333-3333-4333-8333-333333333333";
const OTHER_ORG = "55555555-5555-4555-8555-555555555555";
const REFERRAL_ID = "44444444-4444-4444-8444-444444444444";
const LINK_ID = "66666666-6666-4666-8666-666666666666";

const db = vi.hoisted(() => ({
  queries: [] as Array<{
    table: string;
    op: string;
    filters: string[];
    payload?: unknown;
    /** Which org the client was scoped to when this ran. */
    scopedTo: string | null;
  }>,
  /** The provider_dme_links row the destination lookup resolves to. */
  link: {
    id: "66666666-6666-4666-8666-666666666666",
    org_id: "33333333-3333-4333-8333-333333333333",
    default_location_id: null,
    status: "active",
  } as Record<string, unknown> | null,
  /** The referral row `loadReferralForProvider` resolves to. */
  referral: {
    id: "44444444-4444-4444-8444-444444444444",
    org_id: "33333333-3333-4333-8333-333333333333",
    provider_id: "11111111-1111-4111-8111-111111111111",
    status: "draft",
    patient_first_name: "Test",
    patient_last_name: "Patient",
    provider_unread_count: 0,
    dme_unread_count: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  } as Record<string, unknown> | null,
  insertedId: "44444444-4444-4444-8444-444444444444",
}));

vi.mock("@workspace/resupply-db", () => {
  const build = (table: string, orgId: string | null) => {
    const filters: string[] = [];
    const chain: Record<string, unknown> = {};
    const record = (op: string, payload?: unknown) => {
      db.queries.push({
        table,
        op,
        filters: [...filters],
        payload,
        scopedTo: orgId,
      });
    };
    // Record column AND value: a filter on the right column with the
    // wrong value is exactly the bug these tests exist to catch.
    for (const m of ["select", "order", "limit", "range", "eq", "in", "or"]) {
      chain[m] = (a?: unknown, b?: unknown) => {
        if (m === "eq" || m === "in") filters.push(`${String(a)}=${String(b)}`);
        if (m === "or") filters.push(`or:${String(a)}`);
        return chain;
      };
    }
    chain.not = (c: string, o: string, v: unknown) => {
      filters.push(`not:${c}:${o}:${String(v)}`);
      return chain;
    };
    chain.maybeSingle = async () => {
      record("read");
      if (table === "provider_dme_links") return { data: db.link, error: null };
      if (table === "referrals") return { data: db.referral, error: null };
      return { data: null, error: null };
    };
    chain.single = async () => {
      record("read");
      return { data: { id: db.insertedId }, error: null };
    };
    chain.then = (resolve: (v: unknown) => unknown) => {
      record("read");
      return resolve({ data: [], error: null });
    };
    chain.insert = (payload: unknown) => {
      record("insert", payload);
      const ins: Record<string, unknown> = {};
      ins.select = () => ({
        single: async () => ({ data: { id: db.insertedId }, error: null }),
        limit: () => ({
          maybeSingle: async () => ({
            data: { id: db.insertedId },
            error: null,
          }),
        }),
      });
      ins.then = (resolve: (v: unknown) => unknown) =>
        resolve({ data: null, error: null });
      return ins;
    };
    chain.update = (payload: unknown) => {
      const upd: Record<string, unknown> = {};
      for (const m of ["eq", "in"]) {
        upd[m] = (a?: unknown, b?: unknown) => {
          filters.push(`${String(a)}=${String(b)}`);
          return upd;
        };
      }
      upd.then = (resolve: (v: unknown) => unknown) => {
        record("update", payload);
        return resolve({ data: null, error: null });
      };
      return upd;
    };
    chain.delete = () => {
      const del: Record<string, unknown> = {};
      del.eq = (a?: unknown, b?: unknown) => {
        filters.push(`${String(a)}=${String(b)}`);
        return del;
      };
      del.then = (resolve: (v: unknown) => unknown) => {
        record("delete");
        return resolve({ data: null, error: null });
      };
      return del;
    };
    return chain;
  };
  return {
    resolveSeedOrgId: vi.fn(async () => "seed-org"),
    getOrgScopedClient: vi.fn((orgId: string) => ({
      orgId,
      from: (t: string) => build(t, orgId),
      raw: () => ({
        schema: () => ({ from: (t: string) => build(t, null) }),
      }),
    })),
  };
});

// The auth chain is exercised in requireProvider's own tests; here it just
// establishes a known provider identity.
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

import referralsRouter from "./referrals";

function makeApp(): Express {
  const app = express();
  app.use(express.json());
  app.use(referralsRouter);
  return app;
}

beforeEach(() => {
  db.queries = [];
  db.link = {
    id: LINK_ID,
    org_id: TARGET_ORG,
    default_location_id: null,
    status: "active",
  };
  db.referral = {
    id: REFERRAL_ID,
    org_id: TARGET_ORG,
    provider_id: PROVIDER_ID,
    status: "draft",
    patient_first_name: "Test",
    patient_last_name: "Patient",
    provider_unread_count: 0,
    dme_unread_count: 0,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
});

describe("the isolation primitive", () => {
  it("scopes the list by the SESSION's provider id, not anything from the request", async () => {
    await request(makeApp())
      .get("/api/provider/referrals")
      .query({ providerId: OTHER_PROVIDER_ID });
    const q = db.queries.find((x) => x.table === "referrals");
    expect(q!.filters).toContain(`provider_id=${PROVIDER_ID}`);
    expect(q!.filters).not.toContain(`provider_id=${OTHER_PROVIDER_ID}`);
  });

  it("resolves one referral by (id, provider_id) together", async () => {
    await request(makeApp()).get(`/api/provider/referrals/${REFERRAL_ID}`);
    const lookup = db.queries.find(
      (x) => x.table === "referrals" && x.op === "read",
    );
    expect(lookup!.filters).toContain(`id=${REFERRAL_ID}`);
    expect(lookup!.filters).toContain(`provider_id=${PROVIDER_ID}`);
  });

  it("404s another provider's referral without revealing it exists", async () => {
    db.referral = null; // the (id, provider_id) pair simply does not match
    const res = await request(makeApp()).get(
      `/api/provider/referrals/${REFERRAL_ID}`,
    );
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not_found" });
  });

  it("uses the ROW's org for the tenant client, not the seed org", async () => {
    await request(makeApp()).get(`/api/provider/referrals/${REFERRAL_ID}`);
    // The related reads (events / messages / documents) must run against
    // the referral's own tenant.
    const related = db.queries.filter((x) => x.table === "referral_events");
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].scopedTo).toBe(TARGET_ORG);
  });
});

describe("create", () => {
  it("takes the destination org from an ACTIVE link owned by this provider", async () => {
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({
        dmeLinkId: LINK_ID,
        patient: { firstName: "Jane", lastName: "Doe" },
      });
    expect(res.status).toBe(201);
    expect(res.body.orgId).toBe(TARGET_ORG);

    const linkLookup = db.queries.find((x) => x.table === "provider_dme_links");
    // The link must be constrained to this provider AND to active — a
    // revoked link is a DME that has withdrawn permission.
    expect(linkLookup!.filters).toContain(`provider_id=${PROVIDER_ID}`);
    expect(linkLookup!.filters).toContain("status=active");

    // And the write lands on the tenant the link named.
    const insert = db.queries.find(
      (x) => x.table === "referrals" && x.op === "insert",
    );
    expect(insert!.scopedTo).toBe(TARGET_ORG);
  });

  it("403s when there is no active link, rather than writing anywhere", async () => {
    db.link = null;
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({
        dmeLinkId: LINK_ID,
        patient: { firstName: "Jane", lastName: "Doe" },
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("destination_not_authorized");
    expect(db.queries.some((x) => x.op === "insert")).toBe(false);
  });

  it("ignores an org supplied in the body — the body has no say in tenancy", async () => {
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({
        dmeLinkId: LINK_ID,
        orgId: OTHER_ORG,
        patient: { firstName: "Jane", lastName: "Doe" },
      });
    // `.strict()` rejects the unknown key outright, which is the
    // strongest possible answer: there is no path where a caller-supplied
    // org reaches a query.
    expect(res.status).toBe(400);
    expect(db.queries.some((x) => x.scopedTo === OTHER_ORG)).toBe(false);
  });

  it("rejects a patient with no name", async () => {
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({ dmeLinkId: LINK_ID, patient: { firstName: "", lastName: "" } });
    expect(res.status).toBe(400);
  });
});

describe("editing", () => {
  it("refuses to edit once the DME has it", async () => {
    db.referral = { ...db.referral!, status: "accepted" };
    const res = await request(makeApp())
      .patch(`/api/provider/referrals/${REFERRAL_ID}`)
      .send({ patient: { firstName: "Changed" } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_editable");
    expect(db.queries.some((x) => x.op === "update")).toBe(false);
  });

  it("allows an edit while still a draft", async () => {
    const res = await request(makeApp())
      .patch(`/api/provider/referrals/${REFERRAL_ID}`)
      .send({ patient: { firstName: "Changed" } });
    expect(res.status).toBe(200);
    const update = db.queries.find((x) => x.op === "update");
    expect(update!.payload).toMatchObject({ patient_first_name: "Changed" });
    expect(update!.scopedTo).toBe(TARGET_ORG);
  });
});

describe("messages", () => {
  it("bumps the DME's badge, never the provider's own", async () => {
    await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/messages`)
      .send({ body: "Please call the patient — she works nights." });
    const update = db.queries.find(
      (x) => x.table === "referrals" && x.op === "update",
    );
    expect(update!.payload).toHaveProperty("dme_unread_count");
    expect(update!.payload).not.toHaveProperty("provider_unread_count");
  });

  it("records a character count, never the body", async () => {
    await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/messages`)
      .send({ body: "Jane Doe has a healed nasal fracture." });
    const event = db.queries.find(
      (x) => x.table === "referral_events" && x.op === "insert",
    );
    expect(JSON.stringify(event!.payload)).not.toContain("Jane");
    expect((event!.payload as { detail: { chars: number } }).detail.chars).toBe(
      37,
    );
  });
});

describe("documents", () => {
  it("records the type and size, never the file name", async () => {
    // "Smith, John Rx.pdf" is a routine file name and is PHI.
    await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/documents`)
      .send({
        docType: "prescription",
        fileName: "Doe, Jane Rx.pdf",
        storageObjectPath: "referrals/x/rx.pdf",
        contentType: "application/pdf",
        sizeBytes: 20_000,
      });
    const event = db.queries.find(
      (x) => x.table === "referral_events" && x.op === "insert",
    );
    expect(JSON.stringify(event!.payload)).not.toContain("Jane");
    expect(
      (event!.payload as { detail: Record<string, unknown> }).detail,
    ).toEqual({ docType: "prescription", sizeBytes: 20_000 });
  });

  it("caps attachments at 25 MB", async () => {
    const res = await request(makeApp())
      .post(`/api/provider/referrals/${REFERRAL_ID}/documents`)
      .send({
        docType: "sleep_study",
        fileName: "study.pdf",
        storageObjectPath: "referrals/x/study.pdf",
        contentType: "application/pdf",
        sizeBytes: 40_000_000,
      });
    expect(res.status).toBe(400);
  });

  it("lets a provider remove only their OWN attachment", async () => {
    const docId = "77777777-7777-4777-8777-777777777777";
    await request(makeApp()).delete(
      `/api/provider/referrals/${REFERRAL_ID}/documents/${docId}`,
    );
    const del = db.queries.find(
      (x) => x.table === "referral_documents" && x.op === "delete",
    );
    // A DME's upload is the DME's record, not the provider's to delete.
    expect(del!.filters).toContain("uploaded_by_kind=provider");
  });
});

// Copilot review on #1263: `String(link.org_id)` yields the string "null"
// when org_id is missing, and getOrgScopedClient accepts it — every query
// then scopes to a tenant that cannot exist and returns EMPTY rather than
// erroring. The column is NOT NULL so this is unreachable today, but it is
// the line that decides which tenant a referral is written to, so it fails
// loudly instead.
describe("tenant id is never fabricated from a bad row", () => {
  it('500s rather than scoping to the string "null"', async () => {
    db.link = {
      id: LINK_ID,
      org_id: null,
      default_location_id: null,
      status: "active",
    };
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({
        dmeLinkId: LINK_ID,
        patient: { firstName: "Jane", lastName: "Doe" },
      });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
    // Nothing may be written anywhere.
    expect(db.queries.some((x) => x.op === "insert")).toBe(false);
    expect(db.queries.some((x) => x.scopedTo === "null")).toBe(false);
  });

  it("rejects a non-uuid org_id just as firmly", async () => {
    db.link = {
      id: LINK_ID,
      org_id: "not-a-uuid",
      default_location_id: null,
      status: "active",
    };
    const res = await request(makeApp())
      .post("/api/provider/referrals")
      .send({
        dmeLinkId: LINK_ID,
        patient: { firstName: "Jane", lastName: "Doe" },
      });
    expect(res.status).toBe(500);
    expect(db.queries.some((x) => x.scopedTo === "not-a-uuid")).toBe(false);
  });

  it("treats a referral row with an unusable org_id as not found", async () => {
    db.referral = { ...db.referral!, org_id: null };
    const res = await request(makeApp()).get(
      `/api/provider/referrals/${REFERRAL_ID}`,
    );
    expect(res.status).toBe(404);
  });
});
