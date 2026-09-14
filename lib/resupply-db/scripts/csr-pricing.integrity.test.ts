import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

function localTestUrl(value: string) {
  const url = new URL(value);
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    /(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(url.pathname.slice(1))
  );
}
const configured = process.env.PRICING_TEST_DATABASE_URL;
if (configured && !localTestUrl(configured))
  throw new Error("Pricing tests require a loopback test database");
const databaseUrl =
  configured ??
  (process.env.DATABASE_URL && localTestUrl(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : undefined);

describe.skipIf(!databaseUrl)(
  "approved CSR order integrity in PostgreSQL",
  () => {
    let pool: Pool;
    const org = randomUUID(),
      foreignOrg = randomUUID(),
      policy = randomUUID();
    const expiry = "2099-01-01T00:00:00Z";
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 6 });
      await pool.query(`ALTER ROLE service_role BYPASSRLS;
      GRANT USAGE ON SCHEMA resupply TO service_role;
      GRANT SELECT, INSERT, UPDATE ON resupply.csr_order_requests, resupply.fulfillments, resupply.episodes, resupply.prescriptions, resupply.patients, resupply.products, resupply.resupply_order_drafts, resupply.csr_compliance_alerts TO service_role;`);
      await pool.query(
        "INSERT INTO resupply.organizations(id,slug,name) VALUES ($1::uuid,$1::uuid::text,'Pricing fixture'),($2::uuid,$2::uuid::text,'Foreign fixture')",
        [org, foreignOrg],
      );
      await pool.query(
        "INSERT INTO resupply.pricing_policies(id,org_id,version,data,effective_from,expires_at,created_by) VALUES($1,$2,1,'{}','2020-01-01',$3,'fixture')",
        [policy, org, expiry],
      );
      await pool.query(
        "INSERT INTO resupply.pricing_state(org_id,enabled,enforce_quotes,current_policy_id) VALUES($1,true,true,$2)",
        [org, policy],
      );
    });
    afterAll(async () => {
      if (!pool) return;
      for (const table of [
        "fulfillments",
        "episodes",
        "resupply_order_drafts",
        "csr_order_requests",
        "pricing_actual_events",
        "pricing_quotes",
        "pricing_state",
        "pricing_events",
        "pricing_price_lists",
        "pricing_offers",
        "pricing_policies",
        "pricing_shipping_quotes",
        "pricing_proposals",
        "csr_compliance_alerts",
        "prescriptions",
        "product_stock_ledger",
        "products",
        "patients",
        "organizations",
      ]) {
        await pool.query(
          `DELETE FROM resupply.${table} WHERE ${table === "organizations" ? "id" : "org_id"} = ANY($1::uuid[])`,
          [[org, foreignOrg]],
        );
      }
      await pool.end();
    });
    async function rpc(
      name:
        | "create_csr_priced_order"
        | "dispense_csr_priced_order"
        | "dispense_csr_legacy_order",
      args: unknown[],
    ) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE service_role");
        const result = await client.query(
          `SELECT resupply.${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS result`,
          args,
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
    async function fixture(
      options: { missingRx?: boolean; stock?: number } = {},
    ) {
      const patient = randomUUID(),
        quote = randomUUID();
      await pool.query(
        "INSERT INTO resupply.patients(id,org_id,legal_first_name,legal_last_name,date_of_birth) VALUES($1,$2,'Fixture','Patient','2000-01-01')",
        [patient, org],
      );
      const lines = [0, 1].map((n) => ({
        id: randomUUID(),
        sku: `FIX-${randomUUID()}`,
        description: `Fixture item ${n}`,
        quantity: n + 1,
        unitAmountCents: 5000,
        unitCostCents: 1000 + n,
        fulfillmentMethod: n === 0 ? "stock" : "dropship",
        offerId: randomUUID(),
        offerVersion: 1,
      }));
      for (const [index, line] of lines.entries()) {
        await pool.query(
          "INSERT INTO resupply.products(org_id,sku,name,stock_count) VALUES($1,$2,$3,$4)",
          [org, line.sku, line.description, options.stock ?? 10],
        );
        await pool.query(
          "INSERT INTO resupply.pricing_offers(id,org_id,version,sku,data,effective_from,expires_at,created_by) VALUES($1,$2,1,$3,'{}','2020-01-01',$4,'fixture')",
          [line.offerId, org, line.sku, expiry],
        );
        if (!(options.missingRx && index === 1))
          await pool.query(
            "INSERT INTO resupply.prescriptions(org_id,patient_id,item_sku,cadence_days,valid_from) VALUES($1,$2,$3,90,'2020-01-01')",
            [org, patient, line.sku],
          );
      }
      await pool.query(
        `INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,status,policy_id,policy_version,scenario,input,evaluation,lines,dependencies,approval_class,valid_until,created_by)
      VALUES($1,$2,$3,'approved',$4,1,'{"revenue":{"mode":"insurance"}}','{}','{}',$5,$6,'firm',$7,'fixture')`,
        [
          quote,
          org,
          patient,
          policy,
          JSON.stringify(lines),
          JSON.stringify(
            lines.map((l) => ({
              offerId: l.offerId,
              version: 1,
              expiresAt: expiry,
            })),
          ),
          expiry,
        ],
      );
      const request = {
        patient_id: patient,
        order_reference: `TEST-${randomUUID()}`,
        customer_name: "Fixture Patient",
        customer_email: "fixture@example.com",
        customer_phone: null,
        documents: [],
        note_to_customer: null,
        items: lines.map((l) => ({
          lineId: l.id,
          sku: l.sku,
          description: l.description,
          quantity: l.quantity,
          unitAmountCents: l.unitAmountCents,
        })),
        amount_total_cents: 15000,
        expires_at: expiry,
        created_by_email: "fixture@example.com",
      };
      const create = (
        overrides: Record<string, unknown> = {},
        tenant = org,
        draft: string | null = null,
      ) =>
        rpc("create_csr_priced_order", [
          tenant,
          quote,
          1,
          draft,
          { ...request, ...overrides },
        ]);
      return { patient, quote, lines, request, create };
    }
    async function sign(id: string) {
      await pool.query(
        "UPDATE resupply.csr_order_requests SET status='signed' WHERE org_id=$1 AND id=$2",
        [org, id],
      );
    }
    async function count(
      table: "fulfillments" | "episodes" | "csr_order_requests",
      patient: string,
    ) {
      return (
        await pool.query(
          `SELECT count(*)::int AS count FROM resupply.${table} WHERE org_id=$1 AND patient_id=$2`,
          [org, patient],
        )
      ).rows[0].count;
    }

    it("binds once under concurrent retries and rejects changed recipients or line totals", async () => {
      const f = await fixture();
      const results = await Promise.all([f.create(), f.create(), f.create()]);
      expect(new Set(results.map((r) => r.id)).size).toBe(1);
      expect(results.filter((r) => !r.replayed)).toHaveLength(1);
      expect(await count("csr_order_requests", f.patient)).toBe(1);
      await expect(
        f.create({ customer_email: "changed@example.com" }),
      ).rejects.toThrow("quote_already_bound");
      await expect(f.create({ amount_total_cents: 14999 })).rejects.toThrow(
        "quote_items_changed",
      );
    });
    it("rejects foreign patients, foreign quotes, and changed approved order economics", async () => {
      const f = await fixture();
      await expect(f.create({}, foreignOrg)).rejects.toThrow("quote_not_found");
      await expect(f.create({ patient_id: randomUUID() })).rejects.toThrow(
        "insurance_patient_quote_required",
      );
      const order = await f.create();
      await expect(
        pool.query(
          "UPDATE resupply.csr_order_requests SET amount_total_cents=99 WHERE id=$1",
          [order.id],
        ),
      ).rejects.toThrow("approved_order_is_immutable");
      expect(
        (await rpc("dispense_csr_priced_order", [foreignOrg, order.id])).status,
      ).toBe("not_found");
    });
    it("does not replay a canceled commitment as a successful new order", async () => {
      const f = await fixture();
      const order = await f.create();
      await pool.query(
        "UPDATE resupply.csr_order_requests SET status='canceled' WHERE id=$1",
        [order.id],
      );
      await expect(f.create()).rejects.toThrow("quote_already_bound");
      expect(await count("csr_order_requests", f.patient)).toBe(1);
    });
    it("does not bind a quote after its cost dependency changes", async () => {
      const f = await fixture();
      await pool.query(
        "UPDATE resupply.pricing_offers SET expires_at=now()-interval '1 second' WHERE org_id=$1 AND id=$2",
        [org, f.lines[0].offerId],
      );
      await expect(f.create()).rejects.toThrow("stale_dependencies");
      expect(await count("csr_order_requests", f.patient)).toBe(0);
    });
    it("creates every exact fulfillment and moves owned stock once while preserving quoted cost", async () => {
      const f = await fixture();
      const order = await f.create();
      expect(
        (await rpc("dispense_csr_priced_order", [org, order.id])).status,
      ).toBe("not_signed");
      await sign(order.id);
      const results = await Promise.all([
        rpc("dispense_csr_priced_order", [org, order.id]),
        rpc("dispense_csr_priced_order", [org, order.id]),
      ]);
      expect(
        results.every(
          (r) => r.status === "queued" && r.fulfillmentIds.length === 2,
        ),
      ).toBe(true);
      expect(await count("fulfillments", f.patient)).toBe(2);
      expect(await count("episodes", f.patient)).toBe(2);
      const rows = (
        await pool.query(
          "SELECT item_sku, quantity, pricing_unit_cost_cents, fulfillment_method FROM resupply.fulfillments WHERE org_id=$1 AND patient_id=$2",
          [org, f.patient],
        )
      ).rows;
      for (const line of f.lines)
        expect(rows).toContainEqual({
          item_sku: line.sku,
          quantity: line.quantity,
          pricing_unit_cost_cents: line.unitCostCents,
          fulfillment_method: line.fulfillmentMethod,
        });
      const stock = (
        await pool.query(
          "SELECT sku,stock_count FROM resupply.products WHERE org_id=$1 AND sku=ANY($2::text[])",
          [org, f.lines.map((l) => l.sku)],
        )
      ).rows;
      expect(stock.find((r) => r.sku === f.lines[0].sku).stock_count).toBe(9);
      expect(stock.find((r) => r.sku === f.lines[1].sku).stock_count).toBe(10);
    });
    it("holds the whole order for a missing prescription without partial episodes or stock movements", async () => {
      const f = await fixture({ missingRx: true });
      const order = await f.create();
      await sign(order.id);
      expect(
        (await rpc("dispense_csr_priced_order", [org, order.id])).status,
      ).toBe("needs_prescription");
      expect(await count("fulfillments", f.patient)).toBe(0);
      expect(await count("episodes", f.patient)).toBe(0);
      await pool.query(
        "INSERT INTO resupply.prescriptions(org_id,patient_id,item_sku,cadence_days,valid_from) VALUES($1,$2,$3,90,'2020-01-01')",
        [org, f.patient, f.lines[1].sku],
      );
      expect(
        (await rpc("dispense_csr_priced_order", [org, order.id])).status,
      ).toBe("queued");
    });
    it("keeps bound commitments retrievable after source expiry", async () => {
      const f = await fixture();
      const order = await f.create();
      await pool.query(
        "UPDATE resupply.pricing_offers SET expires_at=now()-interval '1 second' WHERE org_id=$1 AND id=$2",
        [org, f.lines[0].offerId],
      );
      expect((await f.create()).id).toBe(order.id);
    });
    it.each([undefined, "dropship"])(
      "creates an exact legacy fulfillment with method %s and moves only owned stock",
      async (fulfillmentMethod) => {
        const f = await fixture();
        const orderId = randomUUID(),
          draftId = randomUUID();
        await pool.query(
          "UPDATE resupply.pricing_state SET enforce_quotes=false WHERE org_id=$1",
          [org],
        );
        try {
          await pool.query(
            "INSERT INTO resupply.csr_order_requests(id,org_id,order_reference,status,customer_name,items,amount_total_cents) VALUES($1,$2,$3,'signed','Fixture',$4,10000)",
            [
              orderId,
              org,
              randomUUID(),
              JSON.stringify([
                {
                  description: "Signed fixture item",
                  quantity: 2,
                  unitAmountCents: 5000,
                  fulfillmentMethod,
                },
              ]),
            ],
          );
        } finally {
          await pool.query(
            "UPDATE resupply.pricing_state SET enforce_quotes=true WHERE org_id=$1",
            [org],
          );
        }
        await pool.query(
          "INSERT INTO resupply.resupply_order_drafts(id,org_id,patient_id,category,suggested_product_id,suggested_quantity,status,csr_order_request_id) VALUES($1,$2,$3,'mask',$4,1,'ordered',$5)",
          [draftId, org, f.patient, f.lines[0].sku, orderId],
        );
        const results = await Promise.all([
          rpc("dispense_csr_legacy_order", [org, orderId]),
          rpc("dispense_csr_legacy_order", [org, orderId]),
        ]);
        expect(results.every((r) => r.status === "queued")).toBe(true);
        const rows = (
          await pool.query(
            "SELECT f.quantity,f.episode_id,e.prescription_id FROM resupply.fulfillments f JOIN resupply.episodes e ON e.id=f.episode_id WHERE f.org_id=$1 AND f.csr_order_request_id=$2",
            [org, orderId],
          )
        ).rows;
        expect(rows).toHaveLength(1);
        expect(rows[0].quantity).toBe(2);
        expect(rows[0].episode_id).not.toBe(draftId);
        expect(rows[0].prescription_id).toBeTruthy();
        const stock = await pool.query(
          "SELECT stock_count FROM resupply.products WHERE org_id=$1 AND sku=$2",
          [org, f.lines[0].sku],
        );
        expect(stock.rows[0].stock_count).toBe(
          fulfillmentMethod === "dropship" ? 10 : 8,
        );
        expect(
          (await rpc("dispense_csr_legacy_order", [foreignOrg, orderId]))
            .status,
        ).toBe("not_found");
      },
    );
    it("enforces approved quotes at the database insertion boundary", async () => {
      await expect(
        pool.query(
          "INSERT INTO resupply.csr_order_requests(org_id,order_reference,customer_name,items,amount_total_cents) VALUES($1,$2,'Fixture','[]',100)",
          [org, randomUUID()],
        ),
      ).rejects.toThrow("approved_quote_required");
    });
    it("does not grant browser roles authority to bind or dispense orders", async () => {
      const rows = (
        await pool.query(
          "SELECT role, has_function_privilege(role,'resupply.create_csr_priced_order(uuid,uuid,integer,uuid,jsonb)','EXECUTE') AS create, has_function_privilege(role,'resupply.dispense_csr_priced_order(uuid,uuid)','EXECUTE') AS dispense FROM unnest(ARRAY['anon','authenticated']) role",
        )
      ).rows;
      expect(rows.every((r) => !r.create && !r.dispense)).toBe(true);
    });
  },
);
