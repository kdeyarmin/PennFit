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
    /** Tables whose OLDEST-ITEM read should fail. Distinct from a failed
     *  count: the count still stands and only the age is unknown. */
    failingAgeTables: new Set<string>(),
    /** ISO timestamp returned as the oldest waiting item, or null. */
    oldestAt: null as string | null,
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
  /** Minimal thenable PostgREST builder: every filter returns `this`,
   *  awaiting it resolves the head-count, and `.order().limit()
   *  .maybeSingle()` resolves the oldest-item read the age check makes. */
  function builder(table: string) {
    const self: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "not", "neq", "order"]) {
      self[m] = () => self;
    }
    self.limit = () => ({
      maybeSingle: async () =>
        state.failingAgeTables.has(table)
          ? { data: null, error: { message: "age read failed" } }
          : {
              data:
                state.oldestAt === null ? null : { created_at: state.oldestAt },
              error: null,
            },
    });
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
  state.failingAgeTables = new Set();
  state.count = 3;
  state.oldestAt = null;
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
  countFailed: boolean;
  waiting: number | null;
  why: string;
  href: string;
  priority: number;
  disposition: string;
  slaHours: number | null;
  uncountableReason: string | null;
  oldestAt: string | null;
  oldestAgeHours: number | null;
  ageStatus: string;
};
type Body = {
  gates: GateRow[];
  refreshedAt: string;
  escalationMultiplier: number;
  totals: {
    gateCount: number;
    waiting: number;
    uncountableGates: number;
    failedCounts: number;
    breachedGates: number;
    escalatedGates: number;
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

  it("explains every gate it cannot count", async () => {
    // A permanent dash with no explanation is indistinguishable from an
    // outage, and an operator looking at one has no way to tell.
    const body = await get();
    for (const gate of body.gates.filter((g) => !g.countable)) {
      expect(gate.uncountableReason, gate.key).toBeTruthy();
    }
    for (const gate of body.gates.filter((g) => g.countable)) {
      expect(gate.uncountableReason, gate.key).toBeNull();
    }
  });

  it("distinguishes a failed count from an uncountable gate in the ROW, not only the totals", async () => {
    const baseline = await get();
    const target = baseline.gates.find((g) => g.countable);
    const { APPROVAL_GATES } =
      await import("../../lib/approval-gates/registry");
    state.failingTables.add(
      APPROVAL_GATES.find((g) => g.key === target?.key)?.queue?.table as string,
    );
    const body = await get();
    const failed = body.gates.find((g) => g.key === target?.key);
    expect(failed?.countFailed).toBe(true);
    expect(failed?.countable).toBe(true);
    for (const gate of body.gates.filter((g) => !g.countable)) {
      // An uncountable gate has not FAILED. Reporting it as an outage
      // would make a permanent property look like a transient one.
      expect(gate.countFailed, gate.key).toBe(false);
    }
  });

  it("carries an owner, a deep link, a priority and a disposition on every gate", async () => {
    const body = await get();
    for (const gate of body.gates) {
      expect(gate.href, gate.key).toMatch(/^\/admin\//);
      expect([1, 2, 3], gate.key).toContain(gate.priority);
      expect(gate.disposition.length, gate.key).toBeGreaterThan(20);
    }
  });

  it("stamps when the reading was taken", async () => {
    // A dashboard left open overnight shows yesterday's depths as though
    // they were now, and the counts look identical either way.
    const body = await get();
    expect(Date.parse(body.refreshedAt)).toBeGreaterThan(0);
  });
});

describe("aging", () => {
  /** An ISO timestamp `hours` in the past. */
  function hoursAgo(hours: number): string {
    return new Date(Date.now() - hours * 3600_000).toISOString();
  }

  it("reports a fresh queue as ok", async () => {
    state.oldestAt = hoursAgo(1);
    const body = await get();
    const gate = body.gates.find((g) => g.key === "address_change_confirm");
    expect(gate?.oldestAgeHours).toBeGreaterThanOrEqual(1);
    expect(gate?.ageStatus).toBe("ok");
  });

  it("warns before the expectation is missed, not after", async () => {
    // 24h SLA; 20h is inside it but past three quarters.
    state.oldestAt = hoursAgo(20);
    const body = await get();
    expect(
      body.gates.find((g) => g.key === "address_change_confirm")?.ageStatus,
    ).toBe("due_soon");
  });

  it("marks a breach when the oldest item is past the expectation", async () => {
    state.oldestAt = hoursAgo(30);
    const body = await get();
    const gate = body.gates.find((g) => g.key === "address_change_confirm");
    expect(gate?.ageStatus).toBe("breached");
    expect(body.totals.breachedGates).toBeGreaterThan(0);
  });

  it("escalates when a queue has stopped being worked entirely", async () => {
    // Past the SLA is late. Past the multiplier is nobody is working
    // this, and those want different responses.
    state.oldestAt = hoursAgo(24 * 30);
    const body = await get();
    expect(
      body.gates.find((g) => g.key === "address_change_confirm")?.ageStatus,
    ).toBe("escalate");
    expect(body.totals.escalatedGates).toBeGreaterThan(0);
  });

  it("honours a configured escalation multiplier", async () => {
    const previous = process.env.APPROVAL_GATE_ESCALATION_MULTIPLIER;
    process.env.APPROVAL_GATE_ESCALATION_MULTIPLIER = "50";
    try {
      state.oldestAt = hoursAgo(24 * 30);
      const body = await get();
      expect(body.escalationMultiplier).toBe(50);
      // 720h against a 24h SLA is 30x — a breach, but no longer an
      // escalation at 50x.
      expect(
        body.gates.find((g) => g.key === "address_change_confirm")?.ageStatus,
      ).toBe("breached");
    } finally {
      if (previous === undefined) {
        delete process.env.APPROVAL_GATE_ESCALATION_MULTIPLIER;
      } else {
        process.env.APPROVAL_GATE_ESCALATION_MULTIPLIER = previous;
      }
    }
  });

  it("never manufactures an alarm for a standing task", async () => {
    // Catalog sign-off has no due date. Giving it one would invent a
    // breach out of a task nobody is late on.
    state.oldestAt = hoursAgo(24 * 365);
    const body = await get();
    const gate = body.gates.find((g) => g.key === "mask_catalog_signoff");
    expect(gate?.slaHours).toBeNull();
    expect(gate?.ageStatus).toBe("no_sla");
  });

  it("does not report an age for an empty queue", async () => {
    state.count = 0;
    state.oldestAt = hoursAgo(500);
    const body = await get();
    for (const gate of body.gates.filter((g) => g.countable)) {
      expect(gate.oldestAt, gate.key).toBeNull();
      expect(gate.ageStatus, gate.key).not.toBe("breached");
    }
  });

  it("keeps the COUNT when only the age read fails", async () => {
    // A failed age read is not a failed count. Dropping the whole gate to
    // null over an unknown age would hide a real backlog.
    const { APPROVAL_GATES } =
      await import("../../lib/approval-gates/registry");
    const table = APPROVAL_GATES.find((g) => g.key === "address_change_confirm")
      ?.queue?.table as string;
    state.failingAgeTables.add(table);
    state.oldestAt = hoursAgo(5);
    const body = await get();
    const gate = body.gates.find((g) => g.key === "address_change_confirm");
    expect(gate?.waiting).toBe(3);
    expect(gate?.countFailed).toBe(false);
    expect(gate?.oldestAt).toBeNull();
  });
});

describe("tenant scope", () => {
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
