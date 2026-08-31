// Tests for GET /admin/approval-gates — the "Needs a person" set.
//
// The route changes no gate, so the only thing it can get wrong is what
// it SAYS, and there is one way to say it wrongly that matters: reporting
// a queue we could not read as though it were empty. A backlog that
// renders as a quiet day is exactly the failure the panel exists to
// prevent, so these pin that a gate with no queue and a gate whose count
// failed stay distinguishable all the way out to the response.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

import {
  makeRequireAdminMock,
  type MockAdminCtx,
} from "../../test-helpers/auth-mocks";

const { mockAdmin, state } = vi.hoisted(() => ({
  mockAdmin: { current: null as MockAdminCtx | null },
  state: {
    /** Tables whose count query should blow up, simulating a partial
     *  outage rather than an empty queue. */
    failingTables: new Set<string>(),
    /** Count returned for every table that does not fail. */
    count: 3,
  },
}));

vi.mock("../../middlewares/requireAdmin", () =>
  makeRequireAdminMock(mockAdmin),
);

vi.mock("../../middlewares/admin-rate-limit", () => {
  const passthrough = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ): void => next();
  return {
    adminReadRateLimiter: passthrough,
    adminWriteRateLimiter: passthrough,
  };
});

vi.mock("@workspace/resupply-db", () => {
  /** Minimal thenable PostgREST builder: every filter returns `this`, and
   *  awaiting it resolves the head-count. */
  function builder(table: string) {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "neq"]) {
      self[m] = () => self;
    }
    self.then = (
      resolve: (v: { count: number | null; error: unknown }) => unknown,
    ) =>
      resolve(
        state.failingTables.has(table)
          ? { count: null, error: { message: "relation unavailable" } }
          : { count: state.count, error: null },
      );
    return self;
  }
  return {
    getOrgScopedClient: () => ({ from: (table: string) => builder(table) }),
  };
});

let app: Express;

beforeEach(async () => {
  vi.resetModules();
  state.failingTables = new Set();
  state.count = 3;
  mockAdmin.current = {
    userId: "u-1",
    email: "csr@example.com",
    role: "admin",
    orgId: "org-1",
  };
  const router = (await import("./approval-gates")).default;
  app = express();
  app.use(express.json());
  app.use(router);
});

afterEach(() => {
  vi.clearAllMocks();
});

type GateRow = {
  key: string;
  countable: boolean;
  waiting: number | null;
  why: string;
};
type Body = {
  gates: GateRow[];
  totals: {
    gateCount: number;
    waiting: number;
    uncountableGates: number;
    failedCounts: number;
  };
};

async function get(): Promise<Body> {
  const res = await request(app).get("/admin/approval-gates");
  expect(res.status).toBe(200);
  return res.body as Body;
}

describe("GET /admin/approval-gates", () => {
  it("counts every gate that has a queue", async () => {
    const body = await get();
    const counted = body.gates.filter((g) => g.countable);
    expect(counted.length).toBeGreaterThan(0);
    for (const gate of counted) {
      expect(gate.waiting, gate.key).toBe(3);
    }
    expect(body.totals.waiting).toBe(counted.length * 3);
    expect(body.totals.failedCounts).toBe(0);
  });

  it("marks a gate with no single queue uncountable, not empty", async () => {
    // Some gates are a judgement rather than a worklist — there is no row
    // to count. That is a permanent property of the gate, and reporting
    // it as zero waiting would be a lie in the other direction.
    const body = await get();
    const uncountable = body.gates.filter((g) => !g.countable);
    expect(uncountable.length).toBeGreaterThan(0);
    for (const gate of uncountable) {
      expect(gate.waiting, gate.key).toBeNull();
    }
    expect(body.totals.uncountableGates).toBe(uncountable.length);
  });

  it("separates a failed count from a gate that never had a queue", async () => {
    // The distinction the SPA's tooltip depends on. Both render a dash;
    // only one of them is a reason to come back later, and folding them
    // into one number hides an outage inside a constant.
    const baseline = await get();
    const target = baseline.gates.find((g) => g.countable);
    expect(target).toBeDefined();

    const { APPROVAL_GATES } =
      await import("../../lib/approval-gates/registry");
    const gate = APPROVAL_GATES.find((g) => g.key === target?.key);
    state.failingTables.add(gate?.queue?.table as string);

    const body = await get();
    const row = body.gates.find((g) => g.key === target?.key);
    // Still countable — the gate HAS a queue; we just could not read it.
    expect(row?.countable).toBe(true);
    expect(row?.waiting).toBeNull();
    expect(body.totals.failedCounts).toBe(1);
    expect(body.totals.uncountableGates).toBe(baseline.totals.uncountableGates);
  });

  it("understates rather than invents when a queue is unreadable", async () => {
    // A failed count must drop OUT of the total, never enter it as a
    // zero: an operator reading the sum should see it fall and the
    // failure counter rise together.
    const baseline = await get();
    const target = baseline.gates.find((g) => g.countable);
    const { APPROVAL_GATES } =
      await import("../../lib/approval-gates/registry");
    state.failingTables.add(
      APPROVAL_GATES.find((g) => g.key === target?.key)?.queue?.table as string,
    );

    const body = await get();
    expect(body.totals.waiting).toBe(baseline.totals.waiting - 3);
  });

  it("reports zero waiting as a real zero", async () => {
    // The other half of the contract: an empty queue we DID read is a
    // number, not a dash.
    state.count = 0;
    const body = await get();
    const counted = body.gates.filter((g) => g.countable);
    for (const gate of counted) {
      expect(gate.waiting, gate.key).toBe(0);
    }
    expect(body.totals.waiting).toBe(0);
    expect(body.totals.failedCounts).toBe(0);
  });

  it("carries the reason a person is required on every gate", async () => {
    // The panel shows `why` verbatim; a blank one would render a demand
    // with no argument behind it.
    const body = await get();
    for (const gate of body.gates) {
      expect(gate.why.trim().length, gate.key).toBeGreaterThan(30);
    }
  });

  it("refuses without a tenant rather than counting across all of them", async () => {
    // `orgId: null` makes the mock attach no `req.orgId` at all — the
    // shape a route actually sees when tenant context is missing.
    mockAdmin.current = {
      userId: "u-1",
      email: "csr@example.com",
      role: "admin",
      orgId: null,
    };
    const res = await request(app).get("/admin/approval-gates");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("tenant_context_missing");
  });
});
