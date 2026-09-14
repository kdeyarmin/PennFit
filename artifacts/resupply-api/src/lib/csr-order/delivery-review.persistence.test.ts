import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1),
  patient = id(2),
  quote = id(3),
  order = id(4),
  policy = id(5),
  offer = id(6),
  lineId = id(7);
const expiry = "2099-01-01T00:00:00Z";
const address = {
  line1: "12 Fixture Street",
  city: "York",
  state: "PA",
  zip: "17401",
};
const line = {
  id: lineId,
  sku: "MASK",
  description: "Mask",
  quantity: 2,
  unitAmountCents: 5000,
  unitCostCents: 1000,
  fulfillmentMethod: "stock",
  offerId: offer,
  offerVersion: 1,
};
const input = {
  revenue: { mode: "insurance", expectedCollectibleCents: 8000 },
};
let db: {
  exec(sql: string): Promise<unknown>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: T[] }>;
  close(): Promise<void>;
};
const payload = () => ({
  quoteRevision: 1,
  scenario: { patientId: patient, lines: [line] },
  input,
  policyId: policy,
  policyVersion: 1,
  dependencies: [{ offerId: offer, version: 1 }],
  approvalClass: "firm",
  addressSnapshot: address,
  validUntil: expiry,
  evaluation: { netRevenueCents: 8000, totalVariableCostCents: 4000 },
});
async function save(value = payload(), tenant = org) {
  return (
    await db.query<{ r: { id: string } }>(
      "SELECT resupply.save_csr_delivery_review($1,$2,'manager',$3) r",
      [tenant, order, JSON.stringify(value)],
    )
  ).rows[0].r.id;
}
async function approve(review: string, allow = false, tenant = org) {
  return (
    await db.query<{
      r: { status: string; fulfillmentIds: string[]; replayed?: boolean };
    }>(
      "SELECT resupply.approve_csr_delivery_review($1,$2,$3,'manager',1,'Verified new delivery', $4) r",
      [tenant, order, review, allow],
    )
  ).rows[0].r;
}
async function dispense() {
  return (
    await db.query<{ r: { status: string; fulfillmentIds: string[] } }>(
      "SELECT resupply.dispense_csr_priced_order($1,$2) r",
      [org, order],
    )
  ).rows[0].r;
}
describe("delivery review preserves the accepted CSR commitment", () => {
  beforeAll(async () => {
    if (process.env.CSR_DELIVERY_TEST_DATABASE_URL) {
      const url = new URL(process.env.CSR_DELIVERY_TEST_DATABASE_URL);
      if (
        url.hostname !== "127.0.0.1" ||
        !/^\/pricing_test_delivery_[a-z0-9_]+$/.test(url.pathname)
      )
        throw new Error(
          "Delivery SQL fixtures require a dedicated loopback pricing_test_delivery_* database.",
        );
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      db = {
        exec: (sql) => client.query(sql),
        query: (sql, values) => client.query(sql, values),
        close: () => client.end(),
      };
      await db.exec("DROP SCHEMA IF EXISTS resupply CASCADE");
    } else db = new PGlite();
    await db.exec(`DO $$ BEGIN
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
      IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role BYPASSRLS; END IF;
      END; $$;
      CREATE SCHEMA resupply; GRANT USAGE ON SCHEMA resupply TO anon,authenticated,service_role;
      CREATE TABLE resupply.organizations(id uuid PRIMARY KEY);
      CREATE TABLE resupply.patients(id uuid PRIMARY KEY,org_id uuid,address jsonb);
      CREATE TABLE resupply.products(org_id uuid,sku text,active boolean DEFAULT true,PRIMARY KEY(org_id,sku));`);
    await db.exec(
      await readFile(
        new URL(
          "../../../../../lib/resupply-db/migrations/0548_pricing_profitability.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    await db.exec(`CREATE TABLE resupply.insurance_claim_line_items(id uuid);
      CREATE TABLE resupply.csr_order_requests(id uuid PRIMARY KEY,org_id uuid,status text,items jsonb,amount_total_cents bigint,
        order_reference text,customer_name text,customer_email text,customer_phone text,documents jsonb,note_to_customer text,
        link_version integer,expires_at timestamptz,sent_at timestamptz,currency text,created_by_email text);
      CREATE TABLE resupply.resupply_order_drafts(id uuid PRIMARY KEY,org_id uuid,patient_id uuid,status text,csr_order_request_id uuid,updated_at timestamptz);
      CREATE TABLE resupply.prescriptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),org_id uuid,patient_id uuid,item_sku text,status text DEFAULT 'active',valid_from date,valid_until date);
      CREATE TABLE resupply.episodes(id uuid PRIMARY KEY,org_id uuid,patient_id uuid,prescription_id uuid REFERENCES resupply.prescriptions(id),status text,due_at timestamptz,metadata jsonb);
      CREATE TABLE resupply.fulfillments(id uuid PRIMARY KEY,org_id uuid,patient_id uuid,episode_id uuid REFERENCES resupply.episodes(id),item_sku text,
        quantity integer,status text,shipment_metadata jsonb DEFAULT '{}',submitted_at timestamptz,shipped_at timestamptz,updated_at timestamptz);
      CREATE TABLE resupply.csr_compliance_alerts(id uuid DEFAULT gen_random_uuid(),org_id uuid,patient_id uuid,alert_type text,status text);
      CREATE TABLE resupply.stock_moves(delta integer);
      CREATE FUNCTION resupply.adjust_product_stock(uuid,text,integer,text,text,text,text) RETURNS integer LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO resupply.stock_moves VALUES($3); RETURN 0; END; $$;`);
    for (const name of [
      "0549_csr_pricing_order_integrity.sql",
      "0550_csr_delivery_reviews.sql",
      "0553_pricing_business_conflicts.sql",
    ])
      await db.exec(
        await readFile(
          new URL(
            `../../../../../lib/resupply-db/migrations/${name}`,
            import.meta.url,
          ),
          "utf8",
        ),
      );
    await db.exec(
      "GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA resupply TO service_role",
    );
  }, 30_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.exec(
      "RESET ROLE; TRUNCATE resupply.organizations,resupply.fulfillments,resupply.episodes,resupply.prescriptions,resupply.csr_order_requests,resupply.patients,resupply.products,resupply.csr_compliance_alerts,resupply.stock_moves CASCADE",
    );
    await db.query("INSERT INTO resupply.organizations VALUES($1)", [org]);
    await db.query("INSERT INTO resupply.patients VALUES($1,$2,$3)", [
      patient,
      org,
      JSON.stringify(address),
    ]);
    await db.query("INSERT INTO resupply.products VALUES($1,'MASK',true)", [
      org,
    ]);
    await db.query(
      "INSERT INTO resupply.pricing_policies(id,org_id,version,data,effective_from,expires_at,created_by) VALUES($1,$2,1,'{}','2020-01-01',$3,'manager')",
      [policy, org, expiry],
    );
    await db.query(
      "INSERT INTO resupply.pricing_state(org_id,enabled,current_policy_id) VALUES($1,true,$2)",
      [org, policy],
    );
    await db.query(
      "INSERT INTO resupply.pricing_offers(id,org_id,version,sku,data,effective_from,expires_at,created_by) VALUES($1,$2,1,'MASK','{}','2020-01-01',$3,'manager')",
      [offer, org, expiry],
    );
    await db.query(
      "INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,status,policy_id,policy_version,scenario,input,evaluation,lines,dependencies,approval_class,valid_until,bound_order_id,created_by) VALUES($1,$2,$3,'bound',$4,1,$5,$6,'{\"netRevenueCents\":8000}', $7,'[]','firm',$8,$9,'manager')",
      [
        quote,
        org,
        patient,
        policy,
        JSON.stringify({
          lines: [line],
          deliveryAddressSnapshot: { ...address, zip: "19000" },
        }),
        JSON.stringify(input),
        JSON.stringify([line]),
        expiry,
        order,
      ],
    );
    await db.query(
      "INSERT INTO resupply.csr_order_requests(id,org_id,status,patient_id,pricing_quote_id,items,amount_total_cents) VALUES($1,$2,'signed',$3,$4,$5,10000)",
      [order, org, patient, quote, JSON.stringify([line])],
    );
    await db.query(
      "INSERT INTO resupply.prescriptions(org_id,patient_id,item_sku,valid_from) VALUES($1,$2,'MASK','2020-01-01')",
      [org, patient],
    );
  });
  it("holds the old address, then atomically approves the separate forecast and creates each original line once", async () => {
    expect((await dispense()).status).toBe("address_hold");
    const before = (
      await db.query(
        "SELECT scenario,input,evaluation,lines FROM resupply.pricing_quotes WHERE id=$1",
        [quote],
      )
    ).rows;
    const review = await save();
    const first = await approve(review);
    expect(first.status).toBe("queued");
    expect(first.fulfillmentIds).toHaveLength(1);
    expect(await approve(review)).toMatchObject({
      replayed: true,
      fulfillmentIds: first.fulfillmentIds,
    });
    expect((await db.query("SELECT * FROM resupply.stock_moves")).rows).toEqual(
      [{ delta: -2 }],
    );
    expect(
      (
        await db.query(
          "SELECT scenario,input,evaluation,lines FROM resupply.pricing_quotes WHERE id=$1",
          [quote],
        )
      ).rows,
    ).toEqual(before);
    expect(
      (
        await db.query<{ amount_total_cents: number }>(
          "SELECT amount_total_cents FROM resupply.csr_order_requests",
        )
      ).rows[0].amount_total_cents,
    ).toSatisfy((value: number | string) => Number(value) === 10000);
  });
  it("keeps held rows held on ordinary retry and releases only the approved order without dispensing twice", async () => {
    const first = await approve(await save());
    await db.exec("UPDATE resupply.fulfillments SET status='on_hold'");
    expect((await dispense()).status).toBe("address_hold");
    const next = await save();
    expect((await approve(next)).fulfillmentIds).toEqual(first.fulfillmentIds);
    expect(
      (await db.query("SELECT status FROM resupply.fulfillments")).rows,
    ).toEqual([{ status: "queued" }]);
    expect(
      (await db.query("SELECT * FROM resupply.stock_moves")).rows,
    ).toHaveLength(1);
    await expect(
      approve(
        (
          await db.query<{ id: string }>(
            "SELECT id FROM resupply.csr_delivery_reviews ORDER BY created_at LIMIT 1",
          )
        ).rows[0].id,
      ),
    ).rejects.toThrow("delivery_review_superseded");
  });
  it("holds only unsubmitted queued priced work on a direct address edit and records its reason", async () => {
    await approve(await save());
    await db.query(
      `INSERT INTO resupply.fulfillments(id,org_id,patient_id,episode_id,item_sku,quantity,status)
      SELECT $1,org_id,patient_id,episode_id,item_sku,quantity,'queued' FROM resupply.fulfillments LIMIT 1`,
      [id(81)],
    );
    await db.query(
      `INSERT INTO resupply.fulfillments(id,org_id,patient_id,episode_id,item_sku,quantity,status,pricing_quote_id,submitted_at)
      SELECT $1,org_id,patient_id,episode_id,item_sku,quantity,'queued',$2,now() FROM resupply.fulfillments LIMIT 1`,
      [id(82), quote],
    );
    await db.query(
      `INSERT INTO resupply.fulfillments(id,org_id,patient_id,episode_id,item_sku,quantity,status,pricing_quote_id,shipped_at)
      SELECT $1,org_id,patient_id,episode_id,item_sku,quantity,'shipped',$2,now() FROM resupply.fulfillments LIMIT 1`,
      [id(83), quote],
    );
    await db.query("UPDATE resupply.patients SET address=$1 WHERE id=$2", [
      JSON.stringify({ ...address, zip: "19000" }),
      patient,
    ]);
    const rows = (
      await db.query<{
        id: string;
        status: string;
        shipment_metadata: Record<string, unknown>;
      }>("SELECT id,status,shipment_metadata FROM resupply.fulfillments")
    ).rows;
    expect(rows.find((r) => r.id === id(81))?.status).toBe("queued");
    expect(rows.find((r) => r.id === id(82))?.status).toBe("queued");
    expect(rows.find((r) => r.id === id(83))?.status).toBe("shipped");
    expect(
      rows.find((r) => ![id(81), id(82), id(83)].includes(r.id)),
    ).toMatchObject({
      status: "on_hold",
      shipment_metadata: {
        deliveryHoldReason: "patient_address_changed",
        deliveryHoldActive: true,
      },
    });
  });
  it("fails closed for unknown or unsigned orders and batches only the selected tenant's held priced episodes", async () => {
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT resupply.csr_order_delivery_allowed($1,$2) allowed",
          [org, id(99)],
        )
      ).rows[0].allowed,
    ).toBe(false);
    await approve(await save());
    const episode = (
      await db.query<{ id: string }>("SELECT id FROM resupply.episodes")
    ).rows[0].id;
    const held = async (tenant = org) =>
      (
        await db.query<{ ids: string[] }>(
          "SELECT resupply.csr_pricing_held_episode_ids($1,$2::uuid[]) ids",
          [tenant, [episode, id(99)]],
        )
      ).rows[0].ids;
    expect(await held()).toEqual([]);
    await db.exec("UPDATE resupply.fulfillments SET submitted_at=now()");
    expect(await held()).toEqual([episode]);
    expect(await held(id(90))).toEqual([]);
    await db.exec("DELETE FROM resupply.fulfillments");
    expect(await held()).toEqual([episode]);
    await db.exec("UPDATE resupply.csr_order_requests SET status='sent'");
    expect(
      (
        await db.query<{ allowed: boolean }>(
          "SELECT resupply.csr_order_delivery_allowed($1,$2) allowed",
          [org, order],
        )
      ).rows[0].allowed,
    ).toBe(false);
    await expect(
      db.query(
        "SELECT resupply.csr_pricing_held_episode_ids($1,array_fill($2::uuid,ARRAY[10001]))",
        [org, episode],
      ),
    ).rejects.toThrow("invalid_episode_batch");
  });
  it("rejects a destination changed after preview", async () => {
    const review = await save();
    await db.query("UPDATE resupply.patients SET address=$1", [
      JSON.stringify({ ...address, zip: "19000" }),
    ]);
    await expect(approve(review)).rejects.toMatchObject({
      message: "delivery_snapshot_changed",
      code: "PT409",
    });
    expect(
      (await db.query("SELECT * FROM resupply.fulfillments")).rows,
    ).toHaveLength(0);
  });
  it("cannot change accepted quantity, amount, patient or collectible revenue in a delivery snapshot", async () => {
    for (const change of [
      {
        ...payload(),
        scenario: { ...payload().scenario, lines: [{ ...line, quantity: 3 }] },
      },
      {
        ...payload(),
        scenario: {
          ...payload().scenario,
          lines: [{ ...line, unitAmountCents: 9000 }],
        },
      },
      {
        ...payload(),
        input: {
          revenue: { mode: "insurance", expectedCollectibleCents: 9000 },
        },
      },
      { ...payload(), scenario: { ...payload().scenario, patientId: id(88) } },
    ])
      await expect(save(change)).rejects.toThrow("delivery_terms_changed");
  });
  it("rejects stale dependencies and expired reviews before releasing work", async () => {
    const review = await save();
    await db.exec("UPDATE resupply.pricing_offers SET expires_at='2021-01-01'");
    await expect(approve(review)).rejects.toMatchObject({
      message: "stale_dependencies",
      code: "PT409",
    });
    await db.exec(
      "UPDATE resupply.csr_delivery_reviews SET valid_until='2021-01-01'",
    );
    await expect(approve(review)).rejects.toThrow("delivery_review_expired");
  });
  it("requires an explicit permitted exception and never overrides a hard block", async () => {
    await expect(
      approve(await save({ ...payload(), approvalClass: "blocked" }), true),
    ).rejects.toThrow("blocked_pricing");
    const exception = await save({ ...payload(), approvalClass: "exception" });
    await expect(approve(exception)).rejects.toThrow("blocked_pricing");
    expect((await approve(exception, true)).status).toBe("queued");
  });
  it("requires the address-change alert to be resolved and retains clinical eligibility", async () => {
    const review = await save();
    await db.query(
      "INSERT INTO resupply.csr_compliance_alerts(org_id,patient_id,alert_type,status) VALUES($1,$2,'address_change_pending','open')",
      [org, patient],
    );
    await expect(approve(review)).rejects.toThrow("address_change_pending");
    await db.exec(
      "UPDATE resupply.csr_compliance_alerts SET status='resolved'; UPDATE resupply.prescriptions SET status='inactive'",
    );
    expect((await approve(review)).status).toBe("needs_prescription");
    expect(
      (await db.query("SELECT status FROM resupply.csr_delivery_reviews")).rows,
    ).toEqual([{ status: "pending" }]);
  });
  it("cannot recall already submitted or shipped fulfillment", async () => {
    await approve(await save());
    const pending = await save();
    await db.exec("UPDATE resupply.fulfillments SET submitted_at=now()");
    await expect(approve(pending)).rejects.toThrow(
      "delivery_already_in_progress",
    );
    await expect(save()).rejects.toThrow("delivery_already_in_progress");
  });
  it("keeps another tenant and public API roles outside the delivery review", async () => {
    const review = await save();
    await db.query("INSERT INTO resupply.organizations VALUES($1)", [id(99)]);
    await expect(approve(review, false, id(99))).rejects.toThrow(
      "signed_priced_order_required",
    );
    await db.exec("SET ROLE anon");
    await expect(approve(review)).rejects.toThrow("permission denied");
    await expect(
      db.query("SELECT * FROM resupply.csr_delivery_reviews"),
    ).rejects.toThrow("permission denied");
  });
  it.skipIf(!process.env.CSR_DELIVERY_TEST_DATABASE_URL)(
    "serializes real concurrent address edits before approval and cannot release a stale preview",
    async () => {
      const review = await save();
      const locker = new pg.Client({
        connectionString: process.env.CSR_DELIVERY_TEST_DATABASE_URL,
      });
      const approver = new pg.Client({
        connectionString: process.env.CSR_DELIVERY_TEST_DATABASE_URL,
      });
      await locker.connect();
      await approver.connect();
      try {
        await locker.query("BEGIN; SET LOCAL ROLE service_role");
        await locker.query(
          "UPDATE resupply.patients SET address=$1 WHERE id=$2",
          [JSON.stringify({ ...address, zip: "19000" }), patient],
        );
        await approver.query("SET ROLE service_role");
        const pid = (await approver.query("SELECT pg_backend_pid() pid"))
          .rows[0].pid;
        const pending = approver
          .query(
            "SELECT resupply.approve_csr_delivery_review($1,$2,$3,'manager',1,'Verified destination',false)",
            [org, order, review],
          )
          .then(
            () => ({ error: null }),
            (error) => ({ error: error as Error }),
          );
        let waiting = false;
        for (let attempt = 0; attempt < 40; attempt++) {
          const activity = await db.query<{ wait_event_type: string }>(
            "SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1",
            [pid],
          );
          if (activity.rows[0]?.wait_event_type === "Lock") {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(waiting).toBe(true);
        await locker.query("COMMIT");
        expect((await pending).error?.message).toContain(
          "delivery_snapshot_changed",
        );
        expect(
          (await db.query("SELECT * FROM resupply.fulfillments")).rows,
        ).toHaveLength(0);
      } finally {
        await locker.query("ROLLBACK").catch(() => undefined);
        await approver.query("ROLLBACK").catch(() => undefined);
        await Promise.all([locker.end(), approver.end()]);
      }
    },
  );
});
