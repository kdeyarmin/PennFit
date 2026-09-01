// POST /shop/orders/nps — the public NPS capture endpoint.
//
// This file was committed EMPTY (9c4e30457) and has been failing the run
// as "no test suite found" ever since — a red signal everybody learned to
// ignore, on an endpoint that genuinely needed one.
//
// It is worth covering because it is one of the few PUBLIC, unauthenticated
// write endpoints in the platform. Nothing populates `req.orgId`, so the
// HMAC token IS the authorization and the tenant is derived from the
// order's own record. Two properties follow from that and both are pinned
// here:
//
//   * an unsigned, tampered or expired token writes NOTHING;
//   * the rating lands in the tenant that owns the ORDER, regardless of
//     which host the patient clicked from — a signed link minted for
//     tenant B must not deposit a rating in tenant A.
//
// PHI: the detractor ping carries a score, an order reference and a
// "has a comment" flag. It must never carry the comment itself, which is
// free text a patient wrote — asserted below, because Slack is external.

import { beforeEach, describe, expect, it, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const ORDER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const { state } = vi.hoisted(() => ({
  state: {
    /** order id -> owning tenant, as `resolveOrgIdForSignedRecord` answers. */
    orgByOrder: {} as Record<string, string | null>,
    /** Rows returned from `shop_orders`, keyed by the org the client was
     *  scoped to — so a cross-tenant read genuinely finds nothing. */
    ordersByOrg: {} as Record<string, Array<Record<string, unknown>>>,
    inserts: [] as Array<{ org: string; table: string; row: unknown }>,
    detractorPings: [] as Array<Record<string, unknown>>,
    insertFails: false,
  },
}));

vi.mock("@workspace/resupply-db", () => ({
  getOrgScopedClient: (orgId: string) => ({
    from: (table: string) => {
      let rows = [...(state.ordersByOrg[orgId] ?? [])];
      const self: Record<string, unknown> = {
        select: () => self,
        eq: (c: string, v: unknown) => {
          rows = rows.filter((r) => r[c] === v);
          return self;
        },
        limit: () => self,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        insert: async (row: unknown) => {
          state.inserts.push({ org: orgId, table, row });
          return state.insertFails
            ? { error: { message: "insert blew up" } }
            : { error: null };
        },
      };
      return self;
    },
  }),
}));

vi.mock("../../lib/storefront/signed-link-org", () => ({
  resolveOrgIdForSignedRecord: async (_table: string, id: string) =>
    state.orgByOrder[id] ?? null,
}));

vi.mock("../../lib/slack/notify", () => ({
  notifyNpsDetractor: async (input: Record<string, unknown>) => {
    state.detractorPings.push(input);
  },
}));

const { signNpsToken } = await import("../../lib/nps-token");

let app: Express;

beforeEach(async () => {
  vi.resetModules();
  process.env.RESUPPLY_LINK_HMAC_KEY =
    "dGVzdC1obWFjLWtleS1mb3ItbnBzLXRva2Vucy0zMi1ieXRlcy1sb25n";
  state.orgByOrder = { [ORDER_A]: ORG_A };
  state.ordersByOrg = {
    [ORG_A]: [{ id: ORDER_A, status: "delivered", delivered_at: "2026-06-01" }],
    [ORG_B]: [],
  };
  state.inserts = [];
  state.detractorPings = [];
  state.insertFails = false;
  const router = (await import("./nps-response")).default;
  app = express();
  app.use(express.json());
  app.use(router);
});

const post = (body: unknown) =>
  request(app)
    .post("/shop/orders/nps")
    .send(body as object);

describe("the token is the authorization", () => {
  it("accepts a correctly signed token and records the score", async () => {
    const res = await post({ token: signNpsToken(ORDER_A, 9) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(state.inserts).toHaveLength(1);
    expect(state.inserts[0].row).toMatchObject({
      order_id: ORDER_A,
      score: 9,
      comment: null,
    });
  });

  it("writes NOTHING for a tampered signature", async () => {
    // The single most important property here: this endpoint is public.
    const token = signNpsToken(ORDER_A, 9);
    const tampered = token.slice(0, -4) + "AAAA";
    const res = await post({ token: tampered });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_token" });
    expect(state.inserts).toHaveLength(0);
  });

  it("writes NOTHING for a token whose payload was edited", async () => {
    // Swapping the score in the payload invalidates the HMAC, so a
    // patient cannot promote their own rating — nor anyone else's.
    const token = signNpsToken(ORDER_A, 2);
    const [payload, sig] = token.split(".");
    const decoded = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as { o: string; s: number; e: number };
    decoded.s = 10;
    const forged =
      Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url") +
      "." +
      sig;
    const res = await post({ token: forged });
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("writes NOTHING for an expired token", async () => {
    const res = await post({ token: signNpsToken(ORDER_A, 9, -60) });
    expect(res.status).toBe(400);
    expect(state.inserts).toHaveLength(0);
  });

  it("rejects a body that is not the expected shape", async () => {
    for (const body of [
      {},
      { token: "" },
      { token: signNpsToken(ORDER_A, 9), extra: "no" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(400);
    }
    expect(state.inserts).toHaveLength(0);
  });
});

describe("tenant attribution", () => {
  it("scopes the write to the tenant that owns the ORDER", async () => {
    // Not the host the patient clicked from, and not a default. Nothing
    // populates req.orgId on a public endpoint, so the order's own
    // record is the only trustworthy source.
    await post({ token: signNpsToken(ORDER_A, 8) });
    expect(state.inserts[0].org).toBe(ORG_A);
  });

  it("fails CLOSED when the order's tenant cannot be resolved", async () => {
    // Never falls back to a seed org: that would deposit one practice's
    // patient feedback in another's analytics.
    state.orgByOrder = {};
    const res = await post({ token: signNpsToken(ORDER_A, 8) });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: "tenant_unavailable" });
    expect(state.inserts).toHaveLength(0);
  });

  it("404s when the order does not exist in its own tenant", async () => {
    state.ordersByOrg[ORG_A] = [];
    const res = await post({ token: signNpsToken(ORDER_A, 8) });
    expect(res.status).toBe(404);
    expect(state.inserts).toHaveLength(0);
  });

  it("does not find a tenant-A order through a tenant-B client", async () => {
    // The org-scoped client filters; this asserts the fake does too, so
    // the attribution assertions above mean something.
    state.orgByOrder = { [ORDER_A]: ORG_B };
    const res = await post({ token: signNpsToken(ORDER_A, 8) });
    expect(res.status).toBe(404);
  });
});

describe("detractor escalation", () => {
  it.each([0, 3, 6])("pings on a detractor score of %i", async (score) => {
    await post({ token: signNpsToken(ORDER_A, score), comment: "not great" });
    expect(state.detractorPings).toHaveLength(1);
    expect(state.detractorPings[0]).toMatchObject({
      orgId: ORG_A,
      orderId: ORDER_A,
      score,
      hasComment: true,
    });
  });

  it.each([7, 9, 10])(
    "stays quiet on a passive or promoter %i",
    async (score) => {
      await post({ token: signNpsToken(ORDER_A, score) });
      expect(state.detractorPings).toHaveLength(0);
    },
  );

  it("NEVER sends the patient's comment to Slack", async () => {
    // Slack is an external service and the comment is free text a
    // patient wrote. Only the flag travels.
    await post({
      token: signNpsToken(ORDER_A, 1),
      comment: "my CPAP mask leaks and my doctor Jane Roe said to call",
    });
    const ping = JSON.stringify(state.detractorPings[0]);
    expect(ping).not.toContain("Jane Roe");
    expect(ping).not.toContain("leaks");
    expect(state.detractorPings[0].hasComment).toBe(true);
  });
});

describe("failure posture", () => {
  it("reports a failed insert rather than claiming success", async () => {
    state.insertFails = true;
    const res = await post({ token: signNpsToken(ORDER_A, 9) });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "insert_failed" });
  });

  it("records a rating on an order that has since been cancelled", async () => {
    // Deliberate: the patient's feedback is valid regardless of what
    // happened to the order afterwards.
    state.ordersByOrg[ORG_A] = [
      { id: ORDER_A, status: "cancelled", delivered_at: "2026-06-01" },
    ];
    const res = await post({ token: signNpsToken(ORDER_A, 4) });
    expect(res.status).toBe(200);
    expect(state.inserts).toHaveLength(1);
  });
});
