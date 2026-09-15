import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { ownerBusinessAnalyticsSchema } from "../../resupply-domain/src/owner-analytics";

function localTestUrl(value: string): boolean {
  const url = new URL(value);
  return (
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    /(?:^|_)(?:ci|test|e2e|review)(?:_|$)/.test(url.pathname.slice(1))
  );
}
const configured = process.env.OWNER_ANALYTICS_TEST_DATABASE_URL;
if (configured && !localTestUrl(configured))
  throw new Error("Owner analytics tests require a loopback test database");
const databaseUrl =
  configured ??
  (process.env.DATABASE_URL && localTestUrl(process.env.DATABASE_URL)
    ? process.env.DATABASE_URL
    : undefined);
const from = "2026-08-01T00:00:00Z";
const to = "2026-08-03T00:00:00Z";
const asOf = "2026-08-10T00:00:00Z";
const during = "2026-08-02T12:00:00Z";
const old = "2026-01-01T00:00:00Z";
const signature =
  "resupply.owner_business_analytics(uuid,timestamptz,timestamptz,timestamptz)";

describe.skipIf(!databaseUrl)("owner business analytics in PostgreSQL", () => {
  let pool: Pool;
  let db: PoolClient;
  let org: string;
  let foreign: string;
  beforeAll(async () => {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000,
    });
    db = await pool.connect();
    // All DDL and synthetic fixtures roll back. Never modify a hosted database,
    // persistent role settings, existing organization, or another test's data.
    await db.query("BEGIN");
    for (const migration of [
      "0557_owner_business_analytics.sql",
      "0558_owner_analytics_stock_threshold.sql",
      "0558_owner_analytics_stock_threshold.sql",
    ]) {
      await db.query(
        readFileSync(
          new URL(`../migrations/${migration}`, import.meta.url),
          "utf8",
        ),
      );
    }
  }, 30000);
  afterAll(async () => {
    if (db) {
      await db.query("ROLLBACK");
      db.release();
    }
    await pool?.end();
  });
  beforeEach(async () => {
    await db.query("SAVEPOINT analytics_case");
    org = randomUUID();
    foreign = randomUUID();
    await db.query(
      "INSERT INTO resupply.organizations(id,slug,name) VALUES($1::uuid,$1::uuid::text,'Synthetic analytics'),($2::uuid,$2::uuid::text,'Foreign analytics')",
      [org, foreign],
    );
  });
  afterEach(async () => {
    await db.query("ROLLBACK TO SAVEPOINT analytics_case");
    await db.query("RELEASE SAVEPOINT analytics_case");
  });

  async function insert(
    table: string,
    values: Record<string, unknown>,
  ): Promise<string> {
    const entries = Object.entries({
      id: randomUUID(),
      org_id: org,
      ...values,
    });
    const result = await db.query<{ id: string }>(
      `INSERT INTO resupply.${table} (${entries.map(([key]) => key).join(",")}) VALUES (${entries.map((_, n) => `$${n + 1}`).join(",")}) RETURNING id`,
      entries.map(([, value]) => value),
    );
    return result.rows[0].id;
  }
  const patient = (values: Record<string, unknown> = {}) =>
    insert("patients", {
      legal_first_name: "Synthetic",
      legal_last_name: "Patient",
      date_of_birth: "2000-01-01",
      created_at: old,
      ...values,
    });
  async function episode(
    patientId: string,
    values: Record<string, unknown> = {},
  ) {
    const rx = await insert("prescriptions", {
      patient_id: patientId,
      item_sku: randomUUID(),
      cadence_days: 90,
      valid_from: "2020-01-01",
      created_at: old,
      ...(values.org_id ? { org_id: values.org_id } : {}),
    });
    return insert("episodes", {
      patient_id: patientId,
      prescription_id: rx,
      due_at: during,
      created_at: old,
      ...values,
    });
  }
  const fulfillment = (
    patientId: string,
    episodeId: string,
    values: Record<string, unknown> = {},
  ) =>
    insert("fulfillments", {
      patient_id: patientId,
      episode_id: episodeId,
      item_sku: "MASK",
      quantity: 1,
      created_at: during,
      ...values,
    });
  const claim = (patientId: string, values: Record<string, unknown> = {}) =>
    insert("insurance_claims", {
      patient_id: patientId,
      payer_name: "Synthetic payer",
      date_of_service: "2026-08-02",
      created_at: during,
      ...values,
    });
  const order = (values: Record<string, unknown> = {}) =>
    insert("csr_order_requests", {
      order_reference: randomUUID(),
      customer_name: "Synthetic order",
      items: "[]",
      amount_total_cents: 12345,
      created_at: during,
      ...values,
    });
  async function report(target = org, start = from, end = to, now = asOf) {
    const result = await db.query<{ report: unknown }>(
      "SELECT resupply.owner_business_analytics($1,$2,$3,$4) AS report",
      [target, start, end, now],
    );
    return ownerBusinessAnalyticsSchema.parse(result.rows[0].report);
  }
  async function failure(values: unknown[]) {
    await db.query("SAVEPOINT invalid_call");
    try {
      await db.query(
        "SELECT resupply.owner_business_analytics($1,$2,$3,$4)",
        values,
      );
      throw new Error("Expected invalid analytics request to fail");
    } catch (error) {
      await db.query("ROLLBACK TO SAVEPOINT invalid_call");
      return error;
    } finally {
      await db.query("RELEASE SAVEPOINT invalid_call");
    }
  }

  it("returns complete zero-valued contracts and UTC days without inventing money", async () => {
    const result = await report();
    expect(Object.values(result.current)).toEqual(Array(21).fill(0));
    expect(Object.values(result.previous)).toEqual(Array(21).fill(0));
    expect(Object.values(result.snapshot).every((value) => value === 0)).toBe(
      true,
    );
    expect(result.daily.map((row) => row.date)).toEqual([
      "2026-08-01",
      "2026-08-02",
    ]);
    expect(result.claimAging.map((row) => row.count)).toEqual([0, 0, 0, 0]);
    expect(result.topProducts).toEqual([]);
  });

  it("enforces UTC half-open current/previous boundaries independent of session zone", async () => {
    await db.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    for (const created_at of [
      "2026-07-29T23:59:59.999Z",
      "2026-07-30T00:00:00Z",
      "2026-07-31T23:59:59.999Z",
      from,
      "2026-08-02T23:59:59.999Z",
      to,
    ]) {
      await patient({ created_at });
    }
    const result = await report();
    expect(result.current.patientsAdded).toBe(2);
    expect(result.previous.patientsAdded).toBe(2);
    expect(result.daily.map((row) => row.patientsAdded)).toEqual([1, 1]);
  });

  it("keeps equal elapsed comparison windows across New York daylight saving changes", async () => {
    await db.query("SET LOCAL TIME ZONE 'America/New_York'");
    await patient({ created_at: "2026-10-31T23:30:00Z" });
    await patient({ created_at: "2026-11-01T00:00:00Z" });
    await patient({ created_at: "2026-11-08T00:00:00Z" });
    const result = await report(
      org,
      "2026-11-08T00:00:00Z",
      "2026-11-15T00:00:00Z",
      "2026-11-16T00:00:00Z",
    );
    expect(result.current.patientsAdded).toBe(1);
    expect(result.previous.patientsAdded).toBe(1);
    expect(result.daily).toHaveLength(7);
    expect(result.daily[0]).toMatchObject({
      date: "2026-11-08",
      patientsAdded: 1,
    });
  });

  it("rejects invalid/null/future/nonfinite windows and unknown organizations", async () => {
    for (const values of [
      [null, from, to, asOf],
      [org, null, to, asOf],
      [org, from, null, asOf],
      [org, from, to, null],
      [org, to, from, asOf],
      [org, from, from, asOf],
      [org, "2024-01-01", to, asOf],
      [org, from, to, from],
      [org, "-infinity", to, asOf],
      [org, from, "infinity", asOf],
      [randomUUID(), from, to, asOf],
    ]) {
      expect(await failure(values)).toMatchObject({ code: "22023" });
    }
  });

  it("is read-only invoker code and denies browser-role execution", async () => {
    const result = await db.query(
      "SELECT p.provolatile,p.prosecdef,has_function_privilege('anon',$1,'EXECUTE') anon,has_function_privilege('authenticated',$1,'EXECUTE') authenticated,has_function_privilege('service_role',$1,'EXECUTE') service FROM pg_proc p WHERE p.oid=$1::regprocedure",
      [signature],
    );
    expect(result.rows[0]).toMatchObject({
      provolatile: "s",
      prosecdef: false,
      anon: false,
      authenticated: false,
      service: true,
    });
    await report();
  });

  it("isolates organizations across every table and product-name join", async () => {
    const a = await patient({ created_at: during });
    const b = await patient({ org_id: foreign, created_at: during });
    const ea = await episode(a);
    const eb = await episode(b, { org_id: foreign });
    await fulfillment(a, ea, { shipped_at: during, quantity: 2 });
    await fulfillment(b, eb, {
      org_id: foreign,
      shipped_at: during,
      quantity: 9000,
    });
    await claim(a, { total_billed_cents: 100, total_paid_cents: 20 });
    await claim(b, {
      org_id: foreign,
      total_billed_cents: 99999,
      total_paid_cents: 88888,
    });
    await order();
    await order({ org_id: foreign });
    await db.query(
      "INSERT INTO resupply.products(org_id,sku,name,stock_count,low_stock_threshold,created_at) VALUES($1,'MASK','Own item',2,3,$3),($2,'MASK','Foreign secret item',0,100,$3)",
      [org, foreign, old],
    );
    const result = await report();
    expect(result.current).toMatchObject({
      patientsAdded: 1,
      orderRequestsCreated: 1,
      shipmentLinesRecorded: 1,
      claimBilledCents: 100,
      claimPaidToDateCents: 20,
    });
    expect(result.topProducts).toEqual([
      { sku: "MASK", name: "Own item", units: 2, fulfillmentLines: 1 },
    ]);
    expect(JSON.stringify(result)).not.toContain("Foreign secret");
    expect(result.lowStock).toHaveLength(1);
  });

  it("counts more than 1000 fulfillment lines and deduplicates patients and orders", async () => {
    const p = await patient();
    const e = await episode(p);
    const o = await order({ signed_at: during, status: "signed" });
    await db.query(
      "INSERT INTO resupply.fulfillments(org_id,patient_id,episode_id,item_sku,quantity,csr_order_request_id,created_at,shipped_at) SELECT $1,$2,$3,'MASK',2,$4,$5,$5 FROM generate_series(1,1005)",
      [org, p, e, o, during],
    );
    const result = await report();
    expect(result.current).toMatchObject({
      orderRequestsCreated: 1,
      orderRequestsSigned: 1,
      fulfillmentLinesQueued: 1005,
      unitsQueued: 2010,
      shipmentLinesRecorded: 1005,
      patientsServed: 1,
      returningPatientsServed: 0,
    });
    expect(result.snapshot.unbilledShipmentLines).toBe(1005);
    expect(result.topProducts[0]).toMatchObject({
      units: 2010,
      fulfillmentLines: 1005,
    });
  });

  it("distinguishes created fulfillment lines, actual shipments and assumed episodes", async () => {
    const p = await patient();
    const assumed = await episode(p, {
      created_at: during,
      status: "fulfilled",
      closed_reason: "assumed_shipped",
    });
    const verified = await episode(p, {
      created_at: during,
      status: "fulfilled",
      closed_reason: "assumed_shipped",
    });
    await fulfillment(p, assumed, { status: "queued", quantity: 3 });
    await fulfillment(p, verified, {
      created_at: old,
      delivered_at: during,
      quantity: 2,
    });
    await fulfillment(p, assumed, { status: "canceled", quantity: 100 });
    await fulfillment(p, assumed, { status: "cancelled", quantity: 100 });
    await fulfillment(p, assumed, { status: "shipped", quantity: 4 });
    const result = await report();
    expect(result.current).toMatchObject({
      episodesOpened: 2,
      episodesConfirmed: 2,
      episodesFulfilled: 1,
      episodesAssumedShipped: 1,
      fulfillmentLinesQueued: 2,
      unitsQueued: 7,
      shipmentLinesRecorded: 1,
    });
    expect(result.snapshot.unbilledShipmentLines).toBe(1);
  });

  it("marks returning patients only with earlier real shipment evidence", async () => {
    const p = await patient();
    const q = await patient();
    const e = await episode(p);
    const f = await episode(q);
    await fulfillment(p, e, {
      created_at: old,
      shipped_at: "2026-07-31T23:59:59Z",
    });
    await fulfillment(p, e, { shipped_at: during });
    await fulfillment(p, e, { shipped_at: during });
    await fulfillment(q, f, { created_at: old, status: "shipped" });
    await fulfillment(q, f, { shipped_at: during });
    const result = await report();
    expect(result.current).toMatchObject({
      patientsServed: 2,
      returningPatientsServed: 1,
    });
  });

  it("keeps claim cohort dollars separate from the current aging backlog", async () => {
    const p = await patient();
    await claim(p, {
      status: "partially_paid",
      total_billed_cents: 10000,
      total_paid_cents: 4000,
      submitted_at: "2026-07-01",
    });
    await claim(p, {
      status: "paid",
      total_billed_cents: 6000,
      total_paid_cents: 5500,
      paid_at: "2026-08-09",
    });
    await claim(p, {
      created_at: old,
      status: "denied",
      total_billed_cents: 8000,
      submitted_at: old,
    });
    await claim(p, {
      created_at: old,
      status: "submitted",
      total_billed_cents: 9000,
      submitted_at: "2026-08-01",
    });
    const result = await report();
    expect(result.current).toMatchObject({
      claimsCreated: 2,
      claimBilledCents: 16000,
      claimPaidToDateCents: 9500,
    });
    expect(result.snapshot).toMatchObject({
      openClaims: 3,
      deniedClaims: 1,
      unacknowledgedClaims: 1,
      openClaimBilledCents: 27000,
      openClaimPaidCents: 4000,
    });
    expect(result.claimAging.map((row) => row.count)).toEqual([1, 1, 0, 1]);
    expect(result.payers[0]).toMatchObject({
      claims: 2,
      billedCents: 16000,
      paidCents: 9500,
    });
  });

  it("requires same-tenant claims to remove shipments from the unbilled backlog", async () => {
    const p = await patient();
    const e = await episode(p);
    const f = await fulfillment(p, e, { shipped_at: during });
    await claim(p, { fulfillment_id: f });
    await claim(p, { fulfillment_id: f, status: "denied" });
    const result = await report();
    expect(result.current.shipmentLinesRecorded).toBe(1);
    expect(result.snapshot.unbilledShipmentLines).toBe(0);
  });

  it("deduplicates scheduled patients and excludes inactive or expired supply cycles", async () => {
    const p = await patient();
    const paused = await patient({ status: "paused" });
    await episode(p, { due_at: asOf });
    await episode(p, { due_at: "2026-08-11" });
    await episode(p, { due_at: "2026-08-12" });
    await episode(paused, { due_at: asOf });
    const expired = await patient();
    await episode(expired, { due_at: asOf, expires_at: asOf });
    const invalidRx = await patient();
    const ended = await episode(invalidRx, { due_at: asOf });
    await db.query(
      "UPDATE resupply.prescriptions SET valid_until='2026-08-09' WHERE id=(SELECT prescription_id FROM resupply.episodes WHERE id=$1)",
      [ended],
    );
    const hold = await episode(p, { status: "address_hold", due_at: asOf });
    expect(hold).toBeTruthy();
    const result = await report();
    expect(result.snapshot).toMatchObject({
      dueResupplyPatients: 1,
      dueSoonResupplyPatients: 1,
      addressHoldEpisodes: 1,
      pausedPatients: 1,
    });
  });

  it("separates tracked stock, unknown stock and bounded low-stock previews", async () => {
    await db.query(
      "INSERT INTO resupply.products(org_id,sku,name,stock_count,low_stock_threshold,created_at) SELECT $1,'LOW-'||n,'Synthetic stock',0,3,$2 FROM generate_series(1,12) n",
      [org, old],
    );
    await db.query(
      "INSERT INTO resupply.products(org_id,sku,name,stock_count,low_stock_threshold,active,created_at) VALUES($1,'UNKNOWN','Unknown',NULL,3,true,$2),($1,'NO-THRESHOLD','No threshold',0,NULL,true,$2),($1,'INACTIVE','Inactive',0,3,false,$2)",
      [org, old],
    );
    const result = await report();
    expect(result.snapshot).toMatchObject({
      activeProducts: 14,
      trackedProducts: 13,
      untrackedProducts: 1,
      lowStockProducts: 13,
      outOfStockProducts: 13,
    });
    expect(result.lowStock).toHaveLength(10);
    expect(result.lowStock.some((row) => row.sku === "UNKNOWN")).toBe(false);
  });

  it("matches the catalog default threshold while preserving explicit zero and untracked stock", async () => {
    await db.query(
      "INSERT INTO resupply.products(org_id,sku,name,stock_count,low_stock_threshold,active,created_at) VALUES($1,'DEFAULT-0','Default at zero',0,NULL,true,$3),($1,'DEFAULT-5','Default boundary',5,NULL,true,$3),($1,'DEFAULT-6','Above default',6,NULL,true,$3),($1,'EXPLICIT-0','Explicit zero',0,0,true,$3),($1,'EXPLICIT-1','Above explicit zero',1,0,true,$3),($1,'UNTRACKED','Unknown stock',NULL,NULL,true,$3),($1,'INACTIVE','Inactive',0,NULL,false,$3),($2,'FOREIGN','Foreign stock',0,NULL,true,$3)",
      [org, foreign, old],
    );
    const result = await report();
    expect(result.snapshot).toMatchObject({
      activeProducts: 6,
      trackedProducts: 5,
      untrackedProducts: 1,
      lowStockProducts: 3,
      outOfStockProducts: 2,
    });
    expect(result.lowStock).toEqual([
      {
        sku: "DEFAULT-0",
        name: "Default at zero",
        stockCount: 0,
        threshold: 5,
      },
      { sku: "EXPLICIT-0", name: "Explicit zero", stockCount: 0, threshold: 0 },
      {
        sku: "DEFAULT-5",
        name: "Default boundary",
        stockCount: 5,
        threshold: 5,
      },
    ]);
  });

  it("uses receipt evidence instead of provider acceptance for message delivery", async () => {
    const p = await patient();
    const c = await insert("conversations", {
      patient_id: p,
      episode_id: await episode(p),
      channel: "sms",
      status: "awaiting_admin",
      created_at: old,
      sla_due_at: "2026-08-09",
    });
    for (const values of [
      { direction: "outbound", delivery_status: "sent" },
      { direction: "outbound", delivery_status: "delivered" },
      { direction: "outbound", delivery_status: "read" },
      { direction: "outbound", delivery_status: "sent", delivered_at: during },
      { direction: "outbound", delivery_status: "failed" },
      { direction: "inbound", delivery_status: "delivered" },
      {
        direction: "outbound",
        delivery_status: "delivered",
        delivered_at: "2026-08-20",
      },
    ])
      await insert("messages", {
        conversation_id: c,
        sender_role: "system",
        body: "Synthetic",
        created_at: during,
        ...values,
      });
    const result = await report();
    expect(result.current).toMatchObject({
      outboundMessages: 6,
      inboundMessages: 1,
      deliveredMessages: 3,
      failedMessages: 1,
    });
    expect(result.snapshot).toMatchObject({
      openConversations: 1,
      awaitingStaffConversations: 1,
      unassignedConversations: 1,
      overdueSlaConversations: 1,
    });
    expect(result.outreachChannels).toEqual([
      { channel: "sms", outbound: 6, inbound: 1, delivered: 3, failed: 1 },
    ]);
  });

  it("counts signature and fitting completion events independently from creation", async () => {
    await order({ created_at: old, signed_at: during, status: "signed" });
    await order({ expires_at: asOf });
    await order({ expires_at: "2026-08-11" });
    await order({ status: "canceled" });
    await insert("fitter_fit_requests", {
      full_name: "Synthetic",
      email: "fixture@example.invalid",
      created_at: old,
      closed_at: during,
      status: "closed",
      closed_outcome: "fulfilled",
    });
    await insert("fitter_fit_requests", {
      full_name: "Synthetic",
      email: "fixture2@example.invalid",
      created_at: during,
    });
    const result = await report();
    expect(result.current).toMatchObject({
      orderRequestsCreated: 3,
      orderRequestsSigned: 1,
      fitRequestsCreated: 1,
      fitRequestsFulfilled: 1,
    });
    expect(result.snapshot).toMatchObject({
      pendingSignatures: 1,
      expiredSignatures: 1,
      openFitRequests: 1,
    });
  });
});
