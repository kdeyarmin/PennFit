import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OrgScopedClient } from "@workspace/resupply-db";
import { getReconciliation } from "./service";

const org = "00000000-0000-4000-8000-000000000001";
const foreign = "00000000-0000-4000-8000-000000000002";
const quote = "00000000-0000-4000-8000-000000000003";
const policy = "00000000-0000-4000-8000-000000000004";
let db: PGlite;
const scoped = (orgId = org) =>
  ({
    orgId,
    raw: () => ({
      schema: () => ({
        rpc: async (
          name: string,
          args: {
            p_org_id: string;
            p_quote_id: string;
            p_offset: number;
            p_limit: number;
          },
        ) => {
          if (name !== "pricing_actuals_page")
            return {
              data: null,
              error: { message: "Forecast evidence unavailable" },
            };
          try {
            const result = await db.query<{ result: unknown }>(
              "SELECT resupply.pricing_actuals_page($1,$2,$3,$4) result",
              [args.p_org_id, args.p_quote_id, args.p_offset, args.p_limit],
            );
            return { data: result.rows[0].result, error: null };
          } catch (error) {
            return { data: null, error };
          }
        },
      }),
    }),
  }) as unknown as OrgScopedClient;

describe("complete reconciliation with bounded event pages", () => {
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA resupply; GRANT USAGE ON SCHEMA resupply TO service_role,anon,authenticated;
      CREATE TABLE resupply.organizations(id uuid PRIMARY KEY);
      CREATE TABLE resupply.patients(id uuid PRIMARY KEY,org_id uuid,address jsonb);
      CREATE TABLE resupply.products(org_id uuid,sku text,active boolean,PRIMARY KEY(org_id,sku));`);
    for (const file of [
      "0548_pricing_profitability.sql",
      "0555_pricing_actuals_pagination.sql",
    ])
      await db.exec(
        await readFile(
          new URL(
            `../../../../../lib/resupply-db/migrations/${file}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await db.query("INSERT INTO resupply.organizations VALUES($1),($2)", [
      org,
      foreign,
    ]);
    await db.query(
      "INSERT INTO resupply.pricing_policies(id,org_id,version,data,effective_from,expires_at,created_by) VALUES($1,$2,1,'{}','2020-01-01','2099-01-01','fixture')",
      [policy, org],
    );
    await db.query(
      `INSERT INTO resupply.pricing_quotes(id,org_id,status,policy_id,policy_version,scenario,input,evaluation,lines,dependencies,approval_class,valid_until,bound_order_id,created_by,costs_complete,revenue_complete)
      VALUES($1,$2,'bound',$3,1,'{"lines":[]}','{}','{"netRevenueCents":25000,"totalVariableCostCents":6000}','[{"sku":"MASK","quantity":1}]','[]','firm','2099-01-01',$1,'fixture',true,true)`,
      [quote, org, policy],
    );
    await db.query(
      `INSERT INTO resupply.pricing_actual_events(org_id,quote_id,economic_event_id,source,source_ref,kind,amount_cents,data,created_by,created_at)
      SELECT $1,$2,'fixture-'||i,'supplier_invoice','fixture-'||i,kind,amount,
        jsonb_build_object('economicEventId','fixture-'||i,'source','supplier_invoice','sourceRef','fixture-'||i,'kind',kind,'amountCents',amount),
        'fixture','2026-01-01'::timestamptz+i*interval '1 second'
      FROM (SELECT i,CASE i%4 WHEN 0 THEN 'revenue' WHEN 1 THEN 'refund' WHEN 2 THEN 'cost' ELSE 'cost_credit' END kind,
        CASE i%4 WHEN 0 THEN 100 WHEN 1 THEN 10 WHEN 2 THEN 30 ELSE 5 END amount FROM generate_series(1,1002) i) source`,
      [org, quote],
    );
  }, 30000);
  afterAll(async () => db?.close());

  it("keeps all-event totals and settled state beyond 1000 entries while returning distinct pages", async () => {
    const first = await getReconciliation(scoped(), quote);
    const last = await getReconciliation(scoped(), quote, 1000);
    expect(first.eventPage).toEqual({
      offset: 0,
      limit: 100,
      total: 1002,
      hasMore: true,
    });
    expect(first.events).toHaveLength(100);
    expect(last.eventPage).toEqual({
      offset: 1000,
      limit: 100,
      total: 1002,
      hasMore: false,
    });
    expect(last.events).toHaveLength(2);
    expect(
      first.events.some((event) =>
        last.events.some((tail) => tail.id === event.id),
      ),
    ).toBe(false);
    for (const result of [first, last])
      expect(result).toMatchObject({
        actualRevenueCents: 22490,
        actualCostCents: 6280,
        actualContributionCents: 16210,
        settled: true,
      });
  });
  it("can record and read another event after the former limit without losing completeness changes", async () => {
    await db.query("SELECT resupply.pricing_mutate($1,'fixture','actual',$2)", [
      org,
      JSON.stringify({
        quoteId: quote,
        economicEventId: "new-invoice",
        source: "supplier_invoice",
        sourceRef: "new-invoice",
        kind: "cost",
        amountCents: 50,
      }),
    ]);
    const result = await getReconciliation(scoped(), quote, 1000);
    expect(result.eventPage.total).toBe(1003);
    expect(result.events).toHaveLength(3);
    expect(result).toMatchObject({
      actualRevenueCents: 22490,
      actualCostCents: 6330,
      costsComplete: false,
      revenueComplete: false,
      revision: 1,
    });
  });
  it("rejects another tenant and direct browser role access", async () => {
    await expect(
      getReconciliation(scoped(foreign), quote),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await db.exec("SET ROLE authenticated");
    try {
      await expect(
        db.query("SELECT resupply.pricing_actuals_page($1,$2)", [org, quote]),
      ).rejects.toThrow(/permission denied/);
    } finally {
      await db.exec("RESET ROLE");
    }
  });
  it("rejects invalid pages instead of querying arbitrary offsets", async () => {
    for (const offset of [-1, 1.5, 2_147_483_648])
      await expect(
        getReconciliation(scoped(), quote, offset),
      ).rejects.toMatchObject({ code: "invalid_body", status: 400 });
  });
});
