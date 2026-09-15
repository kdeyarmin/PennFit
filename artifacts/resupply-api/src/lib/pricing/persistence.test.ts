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
    await db.exec(
      "ALTER TABLE resupply.products ADD COLUMN name text NOT NULL DEFAULT 'Fixture product', ADD COLUMN category text",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0552_pricing_portfolio.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // Preserve the actual order/delivery routine definitions while keeping this
    // fixture focused on pricing tables. Their full relation/body validation and
    // behavior run in the dedicated order/delivery tests and full migration replay.
    await db.exec("SET check_function_bodies=off");
    for (const [file, name, signature] of [
      [
        "0549_csr_pricing_order_integrity.sql",
        "create_csr_priced_order",
        "uuid,uuid,integer,uuid,jsonb",
      ],
      [
        "0550_csr_delivery_reviews.sql",
        "save_csr_delivery_review",
        "uuid,uuid,text,jsonb",
      ],
      [
        "0550_csr_delivery_reviews.sql",
        "approve_csr_delivery_review",
        "uuid,uuid,uuid,text,integer,text,boolean",
      ],
    ]) {
      const source = await readFile(
        new URL(
          `../../../../../lib/resupply-db/migrations/${file}`,
          import.meta.url,
        ),
        "utf8",
      );
      const definition = source.match(
        new RegExp(
          `CREATE (?:OR REPLACE )?FUNCTION resupply\\.${name}\\([\\s\\S]*?\\$\\$;`,
        ),
      );
      if (!definition)
        throw new Error(`Missing actual fixture routine ${name}`);
      await db.exec(definition[0]);
      await db.exec(
        `REVOKE ALL ON FUNCTION resupply.${name}(${signature}) FROM PUBLIC,anon,authenticated; GRANT EXECUTE ON FUNCTION resupply.${name}(${signature}) TO service_role`,
      );
    }
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0553_pricing_business_conflicts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    // The deadline trigger uses this actual order key shape; its complete
    // lifecycle is exercised by the dedicated order deadline regression suite.
    await db.exec(
      "CREATE TABLE resupply.csr_order_requests(id uuid PRIMARY KEY, org_id uuid, patient_id uuid, pricing_quote_id uuid, expires_at timestamptz, link_version integer, status text)",
    );
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0554_pricing_delivery_and_schedule_guards.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec("SET check_function_bodies=on");
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
  it("uses nonretrying409 signals for stale offers and reviews, preserving grants and unrelated serialization failures", async () => {
    await expect(
      mutate("offer", { ...offer, expectedVersion: 99 }),
    ).rejects.toMatchObject({ code: "PT409", message: "revision_conflict" });
    const saved = await quote();
    await expect(
      db.query("SELECT resupply.pricing_assert_quote_current($1,$2,99)", [
        org,
        saved.id,
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "revision_conflict" });
    await expect(
      db.query("SELECT resupply.pricing_assert_dependencies($1,$2)", [
        org,
        JSON.stringify([{ offerId, version: 99 }]),
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "stale_dependencies" });
    const grants = await db.query<{
      name: string;
      security: boolean;
      public: boolean;
      service: boolean;
    }>(
      "SELECT p.proname name,p.prosecdef security,has_function_privilege('anon',p.oid,'EXECUTE') public,has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resupply' AND p.proname IN ('pricing_assert_dependencies','pricing_assert_quote_current','pricing_mutate','create_csr_priced_order','save_csr_delivery_review','approve_csr_delivery_review')",
    );
    expect(grants.rows).toHaveLength(6);
    for (const row of grants.rows)
      expect(row).toMatchObject({
        security: false,
        public: false,
        service: true,
      });
    // The migration does not intercept or convert actual PostgreSQL serialization errors.
    await expect(
      db.exec(
        "DO $$ BEGIN RAISE SQLSTATE '40001' USING MESSAGE='unrelated serialization failure'; END $$",
      ),
    ).rejects.toMatchObject({ code: "40001" });
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
  it("reapplies delivery/schedule corrections without broadening function access", async () => {
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0554_pricing_delivery_and_schedule_guards.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const functions = await db.query<{
      name: string;
      invoker: boolean;
      anon: boolean;
      authenticated: boolean;
      service: boolean;
    }>(
      "SELECT p.proname name,NOT p.prosecdef invoker,has_function_privilege('anon',p.oid,'EXECUTE') anon,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('service_role',p.oid,'EXECUTE') service FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='resupply' AND p.proname IN ('pricing_current_offers','pricing_current_revenue_profiles','pricing_assert_quote_current','pricing_alerts','pricing_apply_scheduled','guard_bound_pricing_deadline','guard_csr_pricing_deadline')",
    );
    expect(functions.rows).toHaveLength(7);
    for (const row of functions.rows)
      expect(row).toMatchObject({
        invoker: true,
        anon: false,
        authenticated: false,
        service: true,
      });
    expect(
      (
        await db.query("SELECT * FROM resupply.pricing_current_offers($1)", [
          org,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("alerts on the expired effective offer during a gap before its future replacement", async () => {
    await db.query(
      "UPDATE resupply.pricing_offers SET expires_at='2025-01-01' WHERE org_id=$1 AND id=$2",
      [org, offerId],
    );
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      effectiveFrom: "2090-01-01T00:00:00Z",
      unitCostCents: 6000,
    });
    const alerts = await db.query<{
      result: Array<{ code: string; entityId: string }>;
    }>("SELECT resupply.pricing_alerts($1) result", [org]);
    expect(alerts.rows[0].result).toEqual([
      expect.objectContaining({ code: "offer_expired", entityId: offerId }),
    ]);
    expect(
      (
        await db.query("SELECT * FROM resupply.pricing_current_offers($1)", [
          org,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query<{ result: unknown[] }>(
          "SELECT resupply.pricing_alerts($1) result",
          [otherOrg],
        )
      ).rows[0].result,
    ).toEqual([]);
  });
  it("compares current cost only with the preceding effective version", async () => {
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      effectiveFrom: "2090-01-01T00:00:00Z",
      unitCostCents: 9000,
    });
    expect(
      (
        await db.query<{ result: unknown[] }>(
          "SELECT resupply.pricing_alerts($1) result",
          [org],
        )
      ).rows[0].result,
    ).toEqual([]);
    await mutate("offer", {
      ...offer,
      expectedVersion: 2,
      unitCostCents: 5000,
    });
    const alerts = await db.query<{ result: unknown[] }>(
      "SELECT resupply.pricing_alerts($1) result",
      [org],
    );
    expect(alerts.rows[0].result).toEqual([
      expect.objectContaining({
        code: "supplier_cost_increase",
        amountCents: 1000,
        entityId: offerId,
      }),
    ]);
  });
  it("does not resurrect superseded offers or revenue profiles after the latest effective version expires", async () => {
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      expiresAt: "2025-01-01T00:00:00Z",
    });
    expect(
      (
        await db.query("SELECT * FROM resupply.pricing_current_offers($1)", [
          org,
        ])
      ).rows,
    ).toEqual([]);
    const profile = {
      id: id(60),
      patientId: id(3),
      lines: [{ sku: "MASK", quantity: 1 }],
      source: "Synthetic",
      effectiveFrom: offer.effectiveFrom,
      expiresAt: offer.expiresAt,
      expectedCollectibleCents: 10000,
    };
    await mutate("revenue_profile", profile);
    await mutate("revenue_profile", {
      ...profile,
      expectedVersion: 1,
      expiresAt: "2025-01-01T00:00:00Z",
    });
    expect(
      (
        await db.query(
          "SELECT * FROM resupply.pricing_current_revenue_profiles($1)",
          [org],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT * FROM resupply.pricing_offers WHERE org_id=$1",
          [org],
        )
      ).rows,
    ).toHaveLength(2);
    expect(
      (
        await db.query(
          "SELECT * FROM resupply.pricing_revenue_profiles WHERE org_id=$1",
          [org],
        )
      ).rows,
    ).toHaveLength(2);
  });
  it("rechecks the carrier service when approving an existing saved quote", async () => {
    const saved = await quote();
    await db.query(
      "UPDATE resupply.patients SET address='{}' WHERE org_id=$1 AND id=$2",
      [org, id(3)],
    );
    await db.query(
      "INSERT INTO resupply.pricing_shipping_quotes(id,org_id,cost_cents,expires_at,data) VALUES($1,$2,100,$3,$4)",
      [
        id(61),
        org,
        offer.expiresAt,
        JSON.stringify({ patientAddressSnapshot: {}, service: "Ground" }),
      ],
    );
    await db.query(
      "UPDATE resupply.pricing_quotes SET scenario=$1 WHERE org_id=$2 AND id=$3",
      [
        JSON.stringify({
          shippingQuoteId: id(61),
          delivery: { service: "Express" },
        }),
        org,
        saved.id,
      ],
    );
    await expect(
      db.query("SELECT resupply.pricing_assert_quote_current($1,$2,1)", [
        org,
        saved.id,
      ]),
    ).rejects.toMatchObject({ code: "PT409", message: "stale_dependencies" });
    await db.query(
      "UPDATE resupply.pricing_quotes SET scenario=jsonb_set(scenario,'{delivery,service}','\"Ground\"') WHERE org_id=$1 AND id=$2",
      [org, saved.id],
    );
    await expect(
      db.query("SELECT resupply.pricing_assert_quote_current($1,$2,1)", [
        org,
        saved.id,
      ]),
    ).resolves.toBeDefined();
  });
  it.each(["40001", "40P01", "08006", "42501"])(
    "keeps scheduled changes pending and retryable after database error %s",
    async (code) => {
      const entry = {
        policyId,
        scenario: { validUntil: offer.expiresAt },
        dependencies: [{ offerId, version: 1 }],
        approvalClass: "firm",
      };
      const batch = await mutate("batch", {
        name: "Retryable scheduled",
        entries: [entry],
      });
      await mutate("schedule", {
        id: batch.id,
        expectedStateRevision: 1,
        scheduledAt: new Date(Date.now() + 60000).toISOString(),
      });
      await db.query(
        "UPDATE resupply.pricing_price_lists SET scheduled_at=now()-interval '1 minute' WHERE org_id=$1 AND id=$2",
        [org, batch.id],
      );
      await db.exec(
        `CREATE FUNCTION resupply.fixture_activation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE SQLSTATE '${code}' USING MESSAGE='Synthetic database failure'; END $$; CREATE TRIGGER fixture_activation_failure BEFORE UPDATE ON resupply.pricing_state FOR EACH ROW WHEN (NEW.active_price_list_id IS NOT NULL) EXECUTE FUNCTION resupply.fixture_activation_failure()`,
      );
      try {
        await expect(
          db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]),
        ).rejects.toMatchObject({ code });
        expect(
          (
            await db.query(
              "SELECT schedule_status,schedule_error FROM resupply.pricing_price_lists WHERE org_id=$1 AND id=$2",
              [org, batch.id],
            )
          ).rows[0],
        ).toEqual({ schedule_status: "pending", schedule_error: null });
        expect(
          (
            await db.query(
              "SELECT * FROM resupply.pricing_events WHERE org_id=$1 AND operation='schedule_blocked'",
              [org],
            )
          ).rows,
        ).toEqual([]);
      } finally {
        await db.exec(
          "DROP TRIGGER fixture_activation_failure ON resupply.pricing_state; DROP FUNCTION resupply.fixture_activation_failure()",
        );
      }
      await db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]);
      expect(
        (
          await db.query(
            "SELECT schedule_status FROM resupply.pricing_price_lists WHERE org_id=$1 AND id=$2",
            [org, batch.id],
          )
        ).rows[0],
      ).toEqual({ schedule_status: "applied" });
    },
  );
  it("deduplicates exact proposal and import retries without resetting their review", async () => {
    const proposal = {
      name: "Mask",
      manufacturer: "Example",
      model: "M1",
      size: "M",
      packDescription: "One",
      source: "Supplier quote",
      notes: "Synthetic",
      comparison: {
        currency: "USD",
        quantity: 3,
        destination: "19000",
        service: "Ground",
        suppliers: [
          {
            id: "candidate",
            supplierName: "Candidate",
            source: "Quote",
            expiresAt: "2099-01-01T00:00:00Z",
            packCostCents: 501,
            unitsPerPack: 2,
            minimumPacks: 1,
            fees: [],
          },
        ],
      },
    };
    const first = await mutate("proposal", proposal);
    const repeat = await mutate("proposal", proposal);
    expect(repeat.id).toBe(first.id);
    expect(repeat.data).toEqual(proposal);
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
      comparison: {
        previousPriceListId: id(22),
        previousEntryIndexes: [0],
        previousUnitAmounts: [
          { sku: "MASK", quantity: 1, unitAmountCents: 12000 },
        ],
        previousEvaluation: { contributionCents: 7000 },
      },
    };
    const first = await mutate("batch", { name: "First", entries: [entry] });
    expect((first.entries as (typeof entry)[])[0].comparison).toEqual(
      entry.comparison,
    );
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
          "SELECT schedule_status,schedule_error FROM resupply.pricing_price_lists WHERE id=$1",
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
          "SELECT schedule_status,schedule_error FROM resupply.pricing_price_lists WHERE id=$1",
          [second.id],
        )
      ).rows[0],
    ).toMatchObject({
      schedule_status: "blocked",
      schedule_error: "stale_dependencies",
    });
    expect(
      (
        await db.query(
          "SELECT active_price_list_id FROM resupply.pricing_state WHERE org_id=$1",
          [org],
        )
      ).rows[0],
    ).toMatchObject({ active_price_list_id: batch.id });
  });
  it("protects newly published contexts at preview save, activation and scheduled activation", async () => {
    const entry = (sku: string) => ({
      policyId,
      approvalClass: "firm",
      dependencies: [{ offerId, version: 1 }],
      scenario: {
        validUntil: offer.expiresAt,
        revenue: { mode: "self_pay" },
        lines: [{ sku, quantity: 1, unitAmountCents: 10000 }],
      },
    });
    const first = await mutate("batch", {
      name: "A and B",
      entries: [entry("A"), entry("B")],
    });
    await mutate("activate", { id: first.id, expectedStateRevision: 1 });
    const stale = await db.query<{ result: { id: string } }>(
      "SELECT resupply.pricing_save_portfolio_batch($1,'fixture',$2,$3) result",
      [
        org,
        first.id,
        JSON.stringify({
          name: "Reviewed A and B",
          entries: [entry("A"), entry("B")],
        }),
      ],
    );
    const expanded = await mutate("batch", {
      name: "Added C",
      entries: [entry("A"), entry("B"), entry("C")],
    });
    await mutate("activate", { id: expanded.id, expectedStateRevision: 2 });
    await expect(
      db.query(
        "SELECT resupply.pricing_save_portfolio_batch($1,'fixture',$2,$3)",
        [
          org,
          first.id,
          JSON.stringify({
            name: "Outdated source",
            entries: [entry("A"), entry("B")],
          }),
        ],
      ),
    ).rejects.toThrow("price_list_contexts_changed");
    await expect(
      mutate("activate", {
        id: stale.rows[0].result.id,
        expectedStateRevision: 3,
      }),
    ).rejects.toThrow("price_list_contexts_changed");
    await mutate("schedule", {
      id: stale.rows[0].result.id,
      expectedStateRevision: 3,
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });
    await db.query(
      "UPDATE resupply.pricing_price_lists SET scheduled_at=now()-interval '1 minute' WHERE id=$1",
      [stale.rows[0].result.id],
    );
    await db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]);
    expect(
      (
        await db.query(
          "SELECT active_price_list_id FROM resupply.pricing_state WHERE org_id=$1",
          [org],
        )
      ).rows[0].active_price_list_id,
    ).toBe(expanded.id);
    expect(
      (
        await db.query(
          "SELECT schedule_status,schedule_error FROM resupply.pricing_price_lists WHERE id=$1",
          [stale.rows[0].result.id],
        )
      ).rows[0],
    ).toMatchObject({
      schedule_status: "blocked",
      schedule_error: "price_list_contexts_changed",
    });
    // Explicit policy publication resetting the pointer remains a separate allowed operation.
    await db.query(
      "UPDATE resupply.pricing_state SET active_price_list_id=NULL WHERE org_id=$1",
      [org],
    );
  });
  it("does not restore an unselected retained price after a later manager changes its amount", async () => {
    const entry = (sku: string, amount: number, changeKind = "selected") => ({
      policyId,
      approvalClass: "firm",
      changeKind,
      dependencies: [{ offerId, version: 1 }],
      scenario: {
        validUntil: offer.expiresAt,
        revenue: { mode: "self_pay" },
        lines: [{ sku, quantity: 1, unitAmountCents: amount }],
      },
    });
    const first = await mutate("batch", {
      name: "A and B",
      entries: [entry("A", 10000), entry("B", 20000)],
    });
    await mutate("activate", { id: first.id, expectedStateRevision: 1 });
    const pending = await mutate("batch", {
      name: "Update A only",
      entries: [entry("A", 11000), entry("B", 20000, "retained")],
    });
    await mutate("schedule", {
      id: pending.id,
      expectedStateRevision: 2,
      scheduledAt: new Date(Date.now() + 60000).toISOString(),
    });
    const later = await mutate("batch", {
      name: "Manager updates B",
      entries: [entry("A", 10000), entry("B", 22000)],
    });
    await mutate("activate", { id: later.id, expectedStateRevision: 3 });
    await expect(
      mutate("activate", { id: pending.id, expectedStateRevision: 4 }),
    ).rejects.toMatchObject({
      code: "PT409",
      message: "price_list_contexts_changed",
    });
    await db.query(
      "UPDATE resupply.pricing_price_lists SET scheduled_at=now()-interval '1 minute' WHERE id=$1",
      [pending.id],
    );
    await db.query("SELECT resupply.pricing_apply_scheduled($1)", [org]);
    expect(
      (
        await db.query(
          "SELECT active_price_list_id FROM resupply.pricing_state WHERE org_id=$1",
          [org],
        )
      ).rows[0].active_price_list_id,
    ).toBe(later.id);
    expect(
      (
        await db.query(
          "SELECT schedule_status FROM resupply.pricing_price_lists WHERE id=$1",
          [pending.id],
        )
      ).rows[0].schedule_status,
    ).toBe("blocked");
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
      await expect(
        db.query("SELECT * FROM resupply.pricing_portfolio($1)", [org]),
      ).rejects.toThrow(/permission denied/i);
      await db.exec("RESET ROLE");
    }
  });
  it("filters the full canonical portfolio before pagination and excludes other tenants/inactive products", async () => {
    await db.query(
      "INSERT INTO resupply.products(org_id,sku,name,category,active) VALUES ($1,'AAA','Other category','filter',true),($1,'BBB','Second mask','mask',true),($1,'CCC','Third mask','mask',true),($1,'DDD','Hidden mask','mask',false),($2,'ZZZ','Other tenant mask','mask',true)",
      [org, otherOrg],
    );
    await db.query(
      "UPDATE resupply.products SET category='mask',name='First mask' WHERE org_id=$1 AND sku='MASK'",
      [org],
    );
    const page = await db.query(
      "SELECT sku FROM resupply.pricing_portfolio($1,'mask','mask',NULL,1,1)",
      [org],
    );
    expect(page.rows).toEqual([{ sku: "CCC" }]);
    const all = await db.query(
      "SELECT sku FROM resupply.pricing_portfolio($1,'mask','mask')",
      [org],
    );
    expect(all.rows).toEqual([{ sku: "BBB" }, { sku: "CCC" }, { sku: "MASK" }]);
    const literalWildcard = await db.query(
      "SELECT sku FROM resupply.pricing_portfolio($1,'%')",
      [org],
    );
    expect(literalWildcard.rows).toEqual([]);
  });
  it("uses latest effective supplier identity for filtering and does not leak offers sharing a SKU across tenants", async () => {
    await mutate("offer", {
      ...offer,
      expectedVersion: 1,
      supplierName: "Future supplier",
      effectiveFrom: "2090-01-01T00:00:00Z",
    });
    await db.query(
      "INSERT INTO resupply.products(org_id,sku) VALUES($1,'MASK')",
      [otherOrg],
    );
    await mutate(
      "offer",
      {
        ...offer,
        id: id(40),
        expectedVersion: 0,
        supplierName: "Other tenant supplier",
      },
      otherOrg,
    );
    const result = await db.query<{
      offers: Array<{ org_id: string; version: number }>;
    }>(
      "SELECT offers FROM resupply.pricing_portfolio($1,NULL,NULL,'test supplier')",
      [org],
    );
    expect(result.rows[0].offers).toHaveLength(1);
    expect(result.rows[0].offers[0]).toMatchObject({ org_id: org, version: 1 });
    expect(
      (
        await db.query(
          "SELECT * FROM resupply.pricing_portfolio($1,NULL,NULL,'future supplier')",
          [org],
        )
      ).rows,
    ).toEqual([]);
    expect(
      (
        await db.query(
          "SELECT * FROM resupply.pricing_portfolio($1,NULL,NULL,'other tenant')",
          [org],
        )
      ).rows,
    ).toEqual([]);
  });
  it("bounds offer payloads while disclosing truncation and keeps overflow suppliers searchable", async () => {
    await db.query(
      "INSERT INTO resupply.pricing_offers(id,org_id,version,sku,data,effective_from,expires_at,is_current,created_by) SELECT ('00000000-0000-4000-8000-' || lpad((100+g)::text,12,'0'))::uuid,$1,1,'MASK',jsonb_build_object('supplierName',CASE WHEN g=101 THEN 'Last supplier' ELSE 'Other' END),'2020-01-01','2099-01-01',true,'fixture' FROM generate_series(1,101) g",
      [org],
    );
    const result = await db.query<{
      offers: unknown[];
      has_more_offers: boolean;
      matching_offer_ids: string[];
      active_suppliers: Array<{ offerId: string; supplierName: string }>;
    }>(
      "SELECT offers,has_more_offers,matching_offer_ids,active_suppliers FROM resupply.pricing_portfolio($1,NULL,NULL,'last supplier',0,51,$2)",
      [org, [id(201), offerId]],
    );
    expect(result.rows[0].offers).toHaveLength(100);
    expect(result.rows[0].has_more_offers).toBe(true);
    expect(result.rows[0].matching_offer_ids).toEqual([id(201)]);
    expect(result.rows[0].active_suppliers).toEqual(
      expect.arrayContaining([
        { sku: "MASK", offerId: id(201), supplierName: "Last supplier" },
      ]),
    );
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
