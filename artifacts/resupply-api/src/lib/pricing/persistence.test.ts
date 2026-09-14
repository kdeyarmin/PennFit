import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1);
const otherOrg = id(2);
const offerId = id(4);
let db: {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};
let policyId: string;
const offer = {
  id: offerId,
  sku: "MASK",
  supplierName: "Test supplier",
  supplierSku: "M1",
  unitCostCents: 4000,
  currency: "USD",
  unitsPerPack: 1,
  minQuantity: 1,
  maxQuantity: null,
  status: "verified",
  effectiveFrom: "2020-01-01T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
  source: "Synthetic fixture",
  components: [],
};
async function mutate(operation: string, payload: unknown, tenant = org) {
  const result = await db.query<{ result: Record<string, unknown> }>(
    "SELECT resupply.pricing_mutate($1::uuid,'fixture-reviewer',$2,$3::jsonb) result",
    [tenant, operation, JSON.stringify(payload)],
  );
  return result.rows[0].result;
}
async function quote(approvalClass = "firm") {
  return mutate("quote", {
    patientId: id(3),
    policyId,
    policyVersion: 1,
    status: "pending_approval",
    scenario: {},
    input: { revenue: { mode: "insurance" } },
    evaluation: {},
    lines: [{ id: id(6), sku: "MASK", quantity: 1, unitAmountCents: 10000 }],
    dependencies: [{ offerId, version: 1 }],
    approvalClass,
    validUntil: "2098-01-01T00:00:00Z",
  });
}
describe("pricing persistence transactions", () => {
  beforeAll(async () => {
    if (process.env.PRICING_TEST_DATABASE_URL) {
      const target = new URL(process.env.PRICING_TEST_DATABASE_URL);
      if (
        target.hostname !== "127.0.0.1" ||
        !/^\/pricing_test_[a-z0-9_]+$/.test(target.pathname)
      )
        throw new Error(
          "Pricing SQL tests require an explicitly isolated loopback test database.",
        );
      // A dedicated session preserves SET ROLE even after an expected SQL error.
      // Pool.query discards failed connections, which would reset the role to postgres.
      const client = new pg.Client({ connectionString: target.toString() });
      await client.connect();
      db = {
        exec: (sql) => client.query(sql),
        query: (sql, values) => client.query(sql, values),
        close: () => client.end(),
      };
      await db.exec("DROP SCHEMA IF EXISTS resupply CASCADE");
    } else db = new PGlite();
    await db.exec(
      "DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF; END; $$; CREATE SCHEMA resupply; GRANT USAGE ON SCHEMA resupply TO service_role,anon,authenticated; CREATE TABLE resupply.organizations(id uuid PRIMARY KEY); CREATE TABLE resupply.patients(id uuid PRIMARY KEY,org_id uuid REFERENCES resupply.organizations(id),address jsonb); CREATE TABLE resupply.products(org_id uuid REFERENCES resupply.organizations(id),sku text,active boolean default true,PRIMARY KEY(org_id,sku));",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0548_pricing_profitability.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }, 30_000);
  afterAll(async () => {
    await db?.close();
  });
  beforeEach(async () => {
    await db.exec("RESET ROLE; TRUNCATE resupply.organizations CASCADE;");
    await db.query("INSERT INTO resupply.organizations VALUES($1),($2)", [
      org,
      otherOrg,
    ]);
    await db.query("INSERT INTO resupply.patients(id,org_id) VALUES($1,$2)", [
      id(3),
      org,
    ]);
    await db.query(
      "INSERT INTO resupply.products(org_id,sku) VALUES($1,'MASK')",
      [org],
    );
    const policy = await mutate("policy", {
      name: "Explicit policy",
      rules: {
        targetMarginBps: 4000,
        floorMarginBps: 2000,
        basis: "contribution",
      },
      effectiveFrom: offer.effectiveFrom,
      expiresAt: offer.expiresAt,
    });
    policyId = policy.id as string;
    await mutate("publish", {
      id: policyId,
      expectedStateRevision: 0,
      enabled: true,
      enforceQuotes: true,
    });
    const { id: _id, ...newOffer } = offer;
    void _id;
    // A caller-supplied UUID is accepted with expectedVersion0 by trusted SQL; the HTTP contract generates initial IDs.
    await mutate("offer", { ...newOffer, id: offerId, expectedVersion: 0 });
  });
  it("starts every untouched organization without an active policy or fabricated margin", async () => {
    const result = await db.query<{
      enabled: boolean;
      current_policy_id: null;
    }>("SELECT (resupply.pricing_lock_state($1)).*", [otherOrg]);
    expect(result.rows[0]).toMatchObject({
      enabled: false,
      current_policy_id: null,
    });
  });
  it("keeps old supplier versions immutable and rejects lost updates", async () => {
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      unitCostCents: 5000,
    });
    await expect(
      mutate("offer", { ...offer, expectedVersion: 1, unitCostCents: 6000 }),
    ).rejects.toThrow("revision_conflict");
    const rows = await db.query<{
      version: number;
      data: { unitCostCents: number };
      is_current: boolean;
    }>(
      "SELECT version,data,is_current FROM resupply.pricing_offers ORDER BY version",
    );
    expect(
      rows.rows.map((row) => [
        row.version,
        row.data.unitCostCents,
        row.is_current,
      ]),
    ).toEqual([
      [1, 4000, false],
      [2, 5000, true],
    ]);
  });
  it("deduplicates exact proposal and import retries without resetting their review", async () => {
    const proposal = {
      name: "Mask",
      manufacturer: "Example",
      model: "M1",
      size: "M",
      packDescription: "One",
      source: "Supplier quote",
      notes: "Synthetic",
    };
    const first = await mutate("proposal", proposal);
    const repeat = await mutate("proposal", proposal);
    expect(repeat.id).toBe(first.id);
    const { id: _id, ...imported } = offer;
    void _id;
    const importedResult = await mutate("offer", {
      ...imported,
      effectiveFrom: new Date(Date.now() - 1000).toISOString(),
    });
    expect(importedResult.id).toBe(offerId);
    expect(
      (await db.query("SELECT count(*) n FROM resupply.pricing_offers")).rows[0]
        .n,
    ).toBeDefined();
    expect(
      (await db.query("SELECT * FROM resupply.pricing_offers")).rows,
    ).toHaveLength(1);
  });
  it("keeps today's effective offer until a future cost becomes effective", async () => {
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      unitCostCents: 5000,
      effectiveFrom: "2090-01-01T00:00:00Z",
    });
    const current = await db.query<{ version: number }>(
      "SELECT version FROM resupply.pricing_current_offers($1)",
      [org],
    );
    expect(current.rows).toEqual([{ version: 1 }]);
    const saved = await quote();
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "Future cost has not become effective",
        allowException: false,
      }),
    ).resolves.toMatchObject({ status: "approved" });
  });
  it("allows pausing an expired policy without publishing invented replacement targets", async () => {
    await db.query(
      "UPDATE resupply.pricing_policies SET expires_at='2021-01-01' WHERE id=$1",
      [policyId],
    );
    expect(
      await mutate("publish", {
        id: policyId,
        expectedStateRevision: 1,
        enabled: false,
        enforceQuotes: false,
      }),
    ).toMatchObject({ enabled: false, enforce_quotes: false });
  });
  it("rejects approval after a supplier version changes", async () => {
    const saved = await quote();
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      unitCostCents: 5000,
    });
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "Reviewed by the fixture owner",
        allowException: false,
      }),
    ).rejects.toThrow("stale_dependencies");
  });
  it("allows only one decision for the reviewed quote revision", async () => {
    const saved = await quote();
    const approved = await mutate("approve", {
      id: saved.id,
      expectedRevision: 1,
      reason: "Reviewed by the fixture owner",
      allowException: false,
    });
    expect(approved).toMatchObject({ status: "approved", revision: 2 });
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "A competing review must fail",
        allowException: false,
      }),
    ).rejects.toThrow("revision_conflict");
  });
  it("cannot approve blocked financials even when exception approval is requested", async () => {
    const saved = await quote("blocked");
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "A hard policy rule is blocked",
        allowException: true,
      }),
    ).rejects.toThrow("blocked_pricing");
  });
  it("records explicit exception scope and full snapshot in durable history", async () => {
    const saved = await quote("exception");
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "Estimated invoice has been reviewed",
        allowException: false,
      }),
    ).rejects.toThrow("blocked_pricing");
    await mutate("approve", {
      id: saved.id,
      expectedRevision: 1,
      reason: "Estimated invoice has been reviewed",
      allowException: true,
    });
    const result = await db.query<{
      data: { request: { reason: string }; result: { revision: number } };
    }>("SELECT data FROM resupply.pricing_events WHERE operation='approve'");
    expect(result.rows[0].data.request.reason).toContain("Estimated invoice");
    expect(result.rows[0].data.result.revision).toBe(2);
  });
  it("prevents foreign-tenant patient and quote access", async () => {
    const saved = await quote();
    await expect(
      db.query("SELECT resupply.pricing_assert_quote_current($1,$2,1)", [
        otherOrg,
        saved.id,
      ]),
    ).rejects.toThrow("not_found");
    await db.query("INSERT INTO resupply.patients(id,org_id) VALUES($1,$2)", [
      id(7),
      otherOrg,
    ]);
    await expect(
      mutate("quote", {
        patientId: id(7),
        policyId,
        policyVersion: 1,
        status: "draft",
        scenario: {},
        input: {},
        evaluation: {},
        lines: [{}],
        dependencies: [{ offerId, version: 1 }],
        approvalClass: "firm",
        validUntil: offer.expiresAt,
      }),
    ).rejects.toThrow("not_found");
  });
  it("activates and restores complete price snapshots atomically", async () => {
    const entry = {
      policyId,
      scenario: { validUntil: offer.expiresAt },
      dependencies: [{ offerId, version: 1 }],
      approvalClass: "firm",
    };
    const first = await mutate("batch", { name: "First", entries: [entry] });
    const second = await mutate("batch", { name: "Second", entries: [entry] });
    await mutate("activate", { id: first.id, expectedStateRevision: 1 });
    await mutate("activate", { id: second.id, expectedStateRevision: 2 });
    const restored = await mutate("activate", {
      id: first.id,
      expectedStateRevision: 3,
    });
    expect(restored).toMatchObject({
      active_price_list_id: first.id,
      revision: 4,
    });
    const invalid = await mutate("batch", {
      name: "One blocked item",
      entries: [entry, { ...entry, approvalClass: "blocked" }],
    });
    await expect(
      mutate("activate", { id: invalid.id, expectedStateRevision: 4 }),
    ).rejects.toThrow("blocked_pricing");
    const state = await db.query<{
      active_price_list_id: string;
      revision: number;
    }>(
      "SELECT active_price_list_id,revision FROM resupply.pricing_state WHERE org_id=$1",
      [org],
    );
    expect(state.rows[0]).toEqual({
      active_price_list_id: first.id,
      revision: 4,
    });
  });
  it("applies a scheduled batch once and holds a changed-cost batch without partial activation", async () => {
    const entry = {
      policyId,
      scenario: { validUntil: offer.expiresAt },
      dependencies: [{ offerId, version: 1 }],
      approvalClass: "firm",
    };
    const batch = await mutate("batch", {
      name: "Scheduled",
      entries: [entry],
    });
    await mutate("schedule", {
      id: batch.id,
      expectedStateRevision: 1,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await db.query(
      "UPDATE resupply.pricing_price_lists SET scheduled_at=now()-interval '1 minute' WHERE id=$1",
      [batch.id],
    );
    await db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]);
    expect(
      (
        await db.query(
          "SELECT schedule_status FROM resupply.pricing_price_lists WHERE id=$1",
          [batch.id],
        )
      ).rows[0],
    ).toMatchObject({ schedule_status: "applied" });
    const second = await mutate("batch", {
      name: "Stale scheduled",
      entries: [entry],
    });
    await mutate("schedule", {
      id: second.id,
      expectedStateRevision: 3,
      scheduledAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      unitCostCents: 5000,
    });
    await db.query(
      "UPDATE resupply.pricing_price_lists SET scheduled_at=now()-interval '1 minute' WHERE id=$1",
      [second.id],
    );
    await db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]);
    expect(
      (
        await db.query(
          "SELECT schedule_status FROM resupply.pricing_price_lists WHERE id=$1",
          [second.id],
        )
      ).rows[0],
    ).toMatchObject({ schedule_status: "blocked" });
    expect(
      (
        await db.query(
          "SELECT active_price_list_id FROM resupply.pricing_state WHERE org_id=$1",
          [org],
        )
      ).rows[0],
    ).toMatchObject({ active_price_list_id: batch.id });
  });
  it("rejects changed address and verified revenue profile revisions before approval", async () => {
    const profile = await mutate("revenue_profile", {
      name: "Payer evidence",
      patientId: id(3),
      lines: [{ sku: "MASK", quantity: 1 }],
      allowedCents: 10000,
      expectedCollectibleCents: 9000,
      source: "Evidence fixture",
      effectiveFrom: offer.effectiveFrom,
      expiresAt: offer.expiresAt,
    });
    const saved = await quote();
    await db.query(
      "UPDATE resupply.pricing_quotes SET scenario=$2::jsonb WHERE id=$1",
      [
        saved.id,
        JSON.stringify({
          revenueProfileId: profile.id,
          revenueProfileVersion: 1,
          deliveryAddressSnapshot: null,
        }),
      ],
    );
    await mutate("revenue_profile", {
      ...(profile.data as object),
      id: profile.id,
      expectedVersion: 1,
      expectedCollectibleCents: 8000,
    });
    await expect(
      mutate("approve", {
        id: saved.id,
        expectedRevision: 1,
        reason: "Payer source changed before approval",
        allowException: false,
      }),
    ).rejects.toThrow("stale_dependencies");
    const fresh = await quote();
    await db.query(
      "UPDATE resupply.pricing_quotes SET scenario=$2::jsonb WHERE id=$1",
      [fresh.id, JSON.stringify({ deliveryAddressSnapshot: { zip: "19000" } })],
    );
    await expect(
      mutate("approve", {
        id: fresh.id,
        expectedRevision: 1,
        reason: "Destination changed before approval",
        allowException: false,
      }),
    ).rejects.toThrow("stale_dependencies");
  });
  it("reopens actual completeness and deduplicates the same economic event across sources", async () => {
    const saved = await quote();
    await db.query(
      "UPDATE resupply.pricing_quotes SET status='bound',bound_order_id=$2 WHERE id=$1",
      [saved.id, id(8)],
    );
    const event = {
      quoteId: saved.id,
      economicEventId: "claim-collection-1",
      source: "collection",
      sourceRef: "payer-remit-1",
      kind: "revenue",
      amountCents: 5000,
      occurredAt: "2026-09-14T12:00:00Z",
    };
    const first = await mutate("actual", event);
    const retry = await mutate("actual", event);
    expect(retry.id).toBe(first.id);
    await expect(
      mutate("actual", { ...event, sourceRef: "shop-payment-copy" }),
    ).rejects.toThrow("duplicate_economic_event");
    await mutate("close_actuals", {
      id: saved.id,
      expectedRevision: 1,
      costsComplete: true,
      revenueComplete: true,
      reason: "All fixture invoices and collections matched",
    });
    await mutate("actual", {
      ...event,
      economicEventId: "supplier-invoice-1",
      source: "supplier_invoice",
      sourceRef: "supplier-invoice-1",
      kind: "cost",
      amountCents: 4000,
    });
    const result = await db.query(
      "SELECT actuals_revision,costs_complete,revenue_complete FROM resupply.pricing_quotes WHERE id=$1",
      [saved.id],
    );
    expect(result.rows[0]).toMatchObject({
      actuals_revision: 3,
      costs_complete: false,
      revenue_complete: false,
    });
  });
  it("keeps price data and mutation RPCs inaccessible to public Data API roles", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`SET ROLE ${role}`);
      await expect(
        db.query("SELECT * FROM resupply.pricing_offers"),
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db.query("SELECT resupply.pricing_mutate($1,'actor','policy','{}')", [
          org,
        ]),
      ).rejects.toThrow(/permission denied/i);
      await db.exec("RESET ROLE");
    }
  });
  it("returns atomic actual snapshots, stable alert review keys and weighted financial totals", async () => {
    const saved = await quote();
    await db.query(
      "UPDATE resupply.pricing_quotes SET status='bound',bound_order_id=$2,evaluation=$3::jsonb WHERE id=$1",
      [
        saved.id,
        id(8),
        JSON.stringify({
          netRevenueCents: 10000,
          totalVariableCostCents: 4000,
        }),
      ],
    );
    await mutate("actual", {
      quoteId: saved.id,
      economicEventId: "revenue-1",
      source: "collection",
      sourceRef: "remit-1",
      kind: "revenue",
      amountCents: 10000,
    });
    await mutate("actual", {
      quoteId: saved.id,
      economicEventId: "cost-1",
      source: "supplier_invoice",
      sourceRef: "invoice-1",
      kind: "cost",
      amountCents: 5000,
    });
    await mutate("close_actuals", {
      id: saved.id,
      expectedRevision: 2,
      costsComplete: true,
      revenueComplete: true,
      reason: "All fixture sources reconciled",
    });
    const snapshot = await db.query<{
      result: { quote: { actuals_revision: number }; events: unknown[] };
    }>("SELECT resupply.pricing_actuals_snapshot($1,$2) result", [
      org,
      saved.id,
    ]);
    expect(snapshot.rows[0].result.events).toHaveLength(2);
    expect(snapshot.rows[0].result.quote.actuals_revision).toBe(3);
    const alerts = await db.query<{ result: Array<{ key: string }> }>(
      "SELECT resupply.pricing_alerts($1) result",
      [org],
    );
    const key = alerts.rows[0].result[0].key;
    await mutate("alert_review", {
      key,
      expectedRevision: 0,
      status: "resolved",
      owner: "Fixture reviewer",
      reviewAt: null,
      notes: "Freight invoice explained",
    });
    const reviewed = await db.query<{
      result: Array<{ key: string; status: string }>;
    }>("SELECT resupply.pricing_alerts($1) result", [org]);
    expect(reviewed.rows[0].result[0]).toMatchObject({
      key,
      status: "resolved",
    });
    const summary = await db.query<{
      result: { groups: Array<{ marginBps: number; quoteCount: number }> };
    }>("SELECT resupply.pricing_summary($1) result", [org]);
    expect(summary.rows[0].result.groups[0]).toMatchObject({
      marginBps: 5000,
      quoteCount: 1,
    });
  });
});
