import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

interface Database {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
}
const require = createRequire(
  new URL("../../../artifacts/resupply-api/package.json", import.meta.url),
);
const { PGlite } = require("@electric-sql/pglite") as {
  PGlite: new () => Database;
};
function safeTestUrl(value: string) {
  const url = new URL(value);
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    /(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(url.pathname.slice(1))
  );
}
const explicitUrl =
  process.env.OWNER_PRICING_TEST_DATABASE_URL ??
  process.env.PRICING_TEST_DATABASE_URL;
if (explicitUrl && !safeTestUrl(explicitUrl))
  throw new Error(
    "Owner pricing analytics tests require a loopback test database",
  );
const databaseUrl =
  explicitUrl ??
  (process.env.DATABASE_URL && safeTestUrl(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : undefined);
type Totals = {
  revenueCents: number;
  costCents: number;
  eventCount: number;
  revenueEventCount: number;
  costEventCount: number;
  quoteCount: number;
};
type Analytics = {
  current: Totals;
  previous: Totals;
  settled: {
    boundOrders: number;
    settledOrders: number;
    incompleteOrders: number;
    costsIncompleteOrders: number;
    revenueIncompleteOrders: number;
    uncertainOrders: number;
    netRevenueCents: number;
    netCostCents: number;
    contributionCents: number;
  };
  quality: { undatedEvents: number; futureDatedEvents: number };
  pricing: {
    pendingApprovals: number;
    openProposals: number;
    enabled: boolean;
    enforceQuotes: boolean;
    policyConfigured: boolean;
    activePriceListConfigured: boolean;
  };
  daily: Array<{
    date: string;
    revenueCents: number;
    costCents: number;
    eventCount: number;
  }>;
  costSources: Array<{ source: string; costCents: number; eventCount: number }>;
};
const from = "2026-09-01T00:00:00Z",
  to = "2026-09-15T00:00:00Z",
  asOf = to;
const emptyTotals: Totals = {
  revenueCents: 0,
  costCents: 0,
  eventCount: 0,
  revenueEventCount: 0,
  costEventCount: 0,
  quoteCount: 0,
};

describe("owner pricing analytics SQL", () => {
  let db: Database, pool: Pool | undefined, org: string, policy: string;
  const organizations: string[] = [];
  beforeAll(async () => {
    if (databaseUrl) {
      pool = new Pool({ connectionString: databaseUrl, max: 3 });
      db = {
        exec: (sql) => pool!.query(sql),
        query: (sql, values) => pool!.query(sql, values),
        close: () => pool!.end(),
      };
    } else {
      db = new PGlite();
      await db.exec(
        "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA resupply; CREATE TABLE resupply.organizations(id uuid PRIMARY KEY,slug text,name text); CREATE TABLE resupply.patients(id uuid PRIMARY KEY,org_id uuid); CREATE TABLE resupply.products(org_id uuid,sku text,active boolean);",
      );
      await db.exec(
        await readFile(
          new URL(
            "../migrations/0548_pricing_profitability.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      await db.exec(
        "GRANT USAGE ON SCHEMA resupply TO service_role,anon,authenticated; GRANT SELECT ON resupply.pricing_actual_events,resupply.pricing_quotes,resupply.pricing_state,resupply.pricing_proposals TO service_role;",
      );
    }
    // Local fixture privileges match the platform role; migration permissions
    // remain unchanged and public function execution is asserted separately.
    const migration = await readFile(
      new URL(
        "../migrations/0556_owner_pricing_analytics.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await db.exec(migration);
    await db.exec(migration);
  });
  beforeEach(async () => {
    org = randomUUID();
    policy = randomUUID();
    organizations.push(org);
    await db.query(
      "INSERT INTO resupply.organizations(id,slug,name) VALUES($1::uuid,$1::uuid::text,'Owner analytics fixture')",
      [org],
    );
    await db.query(
      "INSERT INTO resupply.pricing_policies(id,org_id,version,data,effective_from,expires_at,created_by) VALUES($1,$2,1,'{}','2020-01-01','2099-01-01','fixture')",
      [policy, org],
    );
    await db.query(
      "INSERT INTO resupply.pricing_state(org_id,revision,enabled,enforce_quotes,current_policy_id) VALUES($1,7,true,true,$2)",
      [org, policy],
    );
  });
  afterAll(async () => {
    if (!db) return;
    try {
      for (const table of [
        "pricing_actual_events",
        "pricing_events",
        "pricing_quotes",
        "pricing_proposals",
        "pricing_state",
        "pricing_policies",
        "organizations",
      ])
        await db.query(
          `DELETE FROM resupply.${table} WHERE ${table === "organizations" ? "id" : "org_id"}=ANY($1::uuid[])`,
          [organizations],
        );
    } finally {
      await db.close();
    }
  });
  async function quote(
    options: {
      costsComplete?: boolean;
      revenueComplete?: boolean;
      status?: string;
      createdAt?: string;
    } = {},
  ) {
    const id = randomUUID();
    await db.query(
      `INSERT INTO resupply.pricing_quotes(id,org_id,status,policy_id,policy_version,scenario,input,evaluation,lines,dependencies,approval_class,valid_until,costs_complete,revenue_complete,created_by,created_at)
      VALUES($1,$2,$3,$4,1,'{}','{}','{}',$5,'[]','firm','2099-01-01',$6,$7,'fixture',$8)`,
      [
        id,
        org,
        options.status ?? "bound",
        policy,
        JSON.stringify([
          { id: randomUUID(), quantity: 1 },
          { id: randomUUID(), quantity: 2 },
        ]),
        options.costsComplete ?? true,
        options.revenueComplete ?? true,
        options.createdAt ?? "2020-01-01T00:00:00Z",
      ],
    );
    return id;
  }
  async function event(
    quoteId: string,
    kind: string,
    amount: number,
    occurredAt: unknown,
    options: { source?: string; createdAt?: string } = {},
  ) {
    const key = randomUUID();
    await db.query(
      `INSERT INTO resupply.pricing_actual_events(org_id,quote_id,economic_event_id,source,source_ref,kind,amount_cents,data,created_by,created_at)
      VALUES($1,$2,$3,$4,$3,$5,$6,$7,'fixture',$8)`,
      [
        org,
        quoteId,
        key,
        options.source ??
          (kind === "cost" || kind === "cost_credit"
            ? "supplier_invoice"
            : "collection"),
        kind,
        amount,
        JSON.stringify(occurredAt === undefined ? {} : { occurredAt }),
        options.createdAt ?? "2026-09-14T12:00:00Z",
      ],
    );
  }
  async function analytics(
    tenant = org,
    dates = [from, to, asOf],
    timeZone = "UTC",
  ): Promise<Analytics> {
    if (pool) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SELECT set_config('TimeZone',$1,true)", [timeZone]);
        const result = await client.query<{ result: Analytics }>(
          "SELECT resupply.owner_pricing_analytics($1,$2,$3,$4) result",
          [tenant, ...dates],
        );
        await client.query("COMMIT");
        return result.rows[0].result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
    await db.exec("SET ROLE service_role");
    await db.query("SELECT set_config('TimeZone',$1,false)", [timeZone]);
    try {
      return (
        await db.query<{ result: Analytics }>(
          "SELECT resupply.owner_pricing_analytics($1,$2,$3,$4) result",
          [tenant, ...dates],
        )
      ).rows[0].result;
    } finally {
      await db.exec("RESET ROLE; RESET TIME ZONE");
    }
  }
  it("returns empty activity distinctly from configured pricing and does not mutate state", async () => {
    const before = await db.query(
      "SELECT * FROM resupply.pricing_state WHERE org_id=$1",
      [org],
    );
    const result = await analytics();
    expect(result.current).toEqual(emptyTotals);
    expect(result.previous).toEqual(emptyTotals);
    expect(result.settled).toEqual({
      boundOrders: 0,
      settledOrders: 0,
      incompleteOrders: 0,
      costsIncompleteOrders: 0,
      revenueIncompleteOrders: 0,
      uncertainOrders: 0,
      netRevenueCents: 0,
      netCostCents: 0,
      contributionCents: 0,
    });
    expect(result.pricing).toEqual({
      pendingApprovals: 0,
      openProposals: 0,
      enabled: true,
      enforceQuotes: true,
      policyConfigured: true,
      activePriceListConfigured: false,
    });
    expect(result.daily).toEqual([]);
    expect(result.costSources).toEqual([]);
    expect(
      await db.query("SELECT * FROM resupply.pricing_state WHERE org_id=$1", [
        org,
      ]),
    ).toEqual(before);
  });
  it("keeps settled economics separate from incomplete costs and counts multi-line orders once", async () => {
    const complete = await quote(),
      incomplete = await quote({ costsComplete: false });
    await event(complete, "revenue", 10000, from);
    await event(complete, "cost", 6000, from);
    await event(incomplete, "revenue", 90000, from);
    const result = await analytics();
    expect(result.current).toEqual({
      revenueCents: 100000,
      costCents: 6000,
      eventCount: 3,
      revenueEventCount: 2,
      costEventCount: 1,
      quoteCount: 2,
    });
    expect(result.settled).toEqual({
      boundOrders: 2,
      settledOrders: 1,
      incompleteOrders: 1,
      costsIncompleteOrders: 1,
      revenueIncompleteOrders: 0,
      uncertainOrders: 0,
      netRevenueCents: 10000,
      netCostCents: 6000,
      contributionCents: 4000,
    });
  });
  it("nets refunds and credits exactly and derives weighted economics from totals", async () => {
    const one = await quote(),
      two = await quote();
    await event(one, "revenue", 11000, from);
    await event(one, "refund", 1000, from);
    await event(one, "cost", 2000, from);
    await event(one, "cost_credit", 1000, from);
    await event(two, "revenue", 90000, from);
    await event(two, "cost", 81000, from);
    const result = await analytics();
    expect(result.settled).toMatchObject({
      netRevenueCents: 100000,
      netCostCents: 82000,
      contributionCents: 18000,
    });
    expect(result.current).toMatchObject({
      eventCount: 6,
      revenueEventCount: 3,
      costEventCount: 3,
      quoteCount: 2,
    });
    expect(result.costSources).toEqual([
      { source: "supplier_invoice", costCents: 82000, eventCount: 3 },
    ]);
  });
  it("uses occurrence dates, equal previous duration, exclusive boundaries and UTC days", async () => {
    const id = await quote();
    await event(id, "revenue", 11, "2026-08-18T00:00:00Z");
    await event(id, "revenue", 99, "2026-08-17T23:59:59Z");
    await event(id, "revenue", 22, "2026-08-31T23:59:59Z");
    await event(id, "revenue", 33, from, { createdAt: "2026-09-20T00:00:00Z" });
    await event(id, "cost", 44, "2026-09-01T00:30:00+01:00");
    await event(id, "revenue", 55, to);
    const result = await analytics();
    expect(result.previous).toMatchObject({
      revenueCents: 33,
      costCents: 44,
      eventCount: 3,
    });
    expect(result.current).toMatchObject({
      revenueCents: 33,
      costCents: 0,
      eventCount: 1,
    });
    expect(result.daily).toEqual([
      { date: "2026-09-01", revenueCents: 33, costCents: 0, eventCount: 1 },
    ]);
  });
  it("keeps previous elapsed duration exact across daylight saving in a non-UTC session", async () => {
    const id = await quote();
    await event(id, "revenue", 99, "2026-10-31T23:30:00Z");
    await event(id, "revenue", 11, "2026-11-01T00:00:00Z");
    const result = await analytics(
      org,
      ["2026-11-08T00:00:00Z", "2026-11-15T00:00:00Z", "2026-11-15T00:00:00Z"],
      "America/New_York",
    );
    expect(result.previous).toMatchObject({ revenueCents: 11, eventCount: 1 });
  });
  it("excludes unusable and future dates from settled economics and discloses affected orders", async () => {
    const valid = await quote(),
      invalid = await quote(),
      future = await quote();
    await event(valid, "revenue", 100, from);
    await event(valid, "cost", 40, from);
    await event(invalid, "revenue", 1000, from);
    await event(invalid, "cost", 900, "2026-02-31T00:00:00Z");
    await event(future, "revenue", 2000, from);
    await event(future, "cost", 1800, "2026-09-16T00:00:00Z");
    const result = await analytics();
    expect(result.quality).toEqual({ undatedEvents: 1, futureDatedEvents: 1 });
    expect(result.settled).toMatchObject({
      boundOrders: 3,
      settledOrders: 1,
      incompleteOrders: 2,
      uncertainOrders: 2,
      netRevenueCents: 100,
      netCostCents: 40,
      contributionCents: 60,
    });
    expect(result.current).toMatchObject({
      revenueCents: 3100,
      costCents: 40,
      eventCount: 4,
    });
  });
  it.each([
    undefined,
    null,
    "not a date",
    "2026-09-01",
    "infinity",
    "2026-09-01T25:00:00Z",
    42,
  ])("does not guess an occurrence date from %j", async (value) => {
    const id = await quote();
    await event(id, "cost", 25, value);
    const result = await analytics();
    expect(result.quality.undatedEvents).toBe(1);
    expect(result.current).toEqual(emptyTotals);
    expect(result.settled.uncertainOrders).toBe(1);
  });
  it("preserves known zero and negative outcomes instead of manufacturing a margin", async () => {
    await quote();
    const loss = await quote();
    await event(loss, "refund", 50, from);
    await event(loss, "cost", 25, from);
    const result = await analytics();
    expect(result.settled).toMatchObject({
      settledOrders: 2,
      netRevenueCents: -50,
      netCostCents: 25,
      contributionCents: -75,
    });
  });
  it("moves reopened orders out of settled totals without losing their activity", async () => {
    const id = await quote();
    await event(id, "revenue", 100, from);
    expect((await analytics()).settled.settledOrders).toBe(1);
    await db.query(
      "UPDATE resupply.pricing_quotes SET costs_complete=false,revenue_complete=false,actuals_revision=actuals_revision+1 WHERE org_id=$1 AND id=$2",
      [org, id],
    );
    await event(id, "cost", 40, from);
    const result = await analytics();
    expect(result.settled).toMatchObject({
      settledOrders: 0,
      incompleteOrders: 1,
      costsIncompleteOrders: 1,
      revenueIncompleteOrders: 1,
      contributionCents: 0,
    });
    expect(result.current).toMatchObject({ revenueCents: 100, costCents: 40 });
  });
  it("counts actionable proposal/approval snapshots without including closed work", async () => {
    await quote({ status: "pending_approval" });
    await quote({ status: "draft" });
    for (const status of ["open", "reviewing", "resolved", "rejected"])
      await db.query(
        "INSERT INTO resupply.pricing_proposals(org_id,status,data,created_by) VALUES($1,$2,'{}','fixture')",
        [org, status],
      );
    expect((await analytics()).pricing).toMatchObject({
      pendingApprovals: 1,
      openProposals: 2,
    });
  });
  it("isolates tenant data and represents absent configuration without writing defaults", async () => {
    const id = await quote();
    await event(id, "revenue", 1234, from);
    await event(id, "cost", 20, null);
    const foreign = randomUUID();
    organizations.push(foreign);
    await db.query(
      "INSERT INTO resupply.organizations(id,slug,name) VALUES($1::uuid,$1::uuid::text,'Other owner fixture')",
      [foreign],
    );
    const result = await analytics(foreign);
    expect(result.current).toEqual(emptyTotals);
    expect(result.quality).toEqual({ undatedEvents: 0, futureDatedEvents: 0 });
    expect(result.settled.boundOrders).toBe(0);
    expect(result.pricing).toMatchObject({
      enabled: false,
      enforceQuotes: false,
      policyConfigured: false,
      activePriceListConfigured: false,
    });
    expect(
      (
        await db.query(
          "SELECT count(*)::int n FROM resupply.pricing_state WHERE org_id=$1",
          [foreign],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it.each([
    [to, from, asOf],
    [from, from, asOf],
    [from, "2027-10-01T00:00:00Z", "2027-10-01T00:00:00Z"],
    [from, to, from],
    [null, to, asOf],
  ])("rejects invalid or future windows %j", async (start, end, clock) => {
    await expect(
      analytics(org, [start, end, clock] as string[]),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("is stable, invoker-only and not executable by browser roles", async () => {
    const rows = await db.query<{ rolname: string; allowed: boolean }>(
      "SELECT r.rolname,has_function_privilege(r.oid,'resupply.owner_pricing_analytics(uuid,timestamptz,timestamptz,timestamptz)','EXECUTE') allowed FROM pg_roles r WHERE r.rolname IN ('anon','authenticated','service_role') ORDER BY r.rolname",
    );
    expect(rows.rows).toEqual([
      { rolname: "anon", allowed: false },
      { rolname: "authenticated", allowed: false },
      { rolname: "service_role", allowed: true },
    ]);
    expect(
      (
        await db.query(
          "SELECT provolatile,prosecdef FROM pg_proc WHERE oid='resupply.owner_pricing_analytics(uuid,timestamptz,timestamptz,timestamptz)'::regprocedure",
        )
      ).rows,
    ).toEqual([{ provolatile: "s", prosecdef: false }]);
  });
});
