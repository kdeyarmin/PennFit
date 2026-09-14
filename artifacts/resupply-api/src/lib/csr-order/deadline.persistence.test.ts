import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const org = id(1),
  patient = id(2),
  quote = id(3),
  order = id(4);
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`SET TIME ZONE 'UTC'; CREATE SCHEMA resupply;
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE resupply.pricing_quotes(id uuid PRIMARY KEY, org_id uuid, patient_id uuid,
      bound_order_id uuid, status text, valid_until timestamptz, actuals_revision integer DEFAULT 0);
    CREATE TABLE resupply.csr_order_requests(id uuid PRIMARY KEY, org_id uuid, patient_id uuid,
      pricing_quote_id uuid, status text, expires_at timestamptz, link_version integer,
      signed_at timestamptz, updated_at timestamptz);
    GRANT USAGE ON SCHEMA resupply TO service_role;
    GRANT SELECT,INSERT,UPDATE ON ALL TABLES IN SCHEMA resupply TO service_role;`);
  const migration = await readFile(
    new URL(
      "../../../../../lib/resupply-db/migrations/0554_pricing_delivery_and_schedule_guards.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const start = migration.indexOf("-- BEGIN CSR pricing deadline guards");
  const end = migration.indexOf("-- END CSR pricing deadline guards");
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  // Execute the actual complete trigger section, with its grants, against only
  // the two tables it uses. The remaining migration functions have other owners.
  await db.exec(migration.slice(start, end));
  // Corrective migrations must also leave one working guard per table on retry.
  await db.exec(migration.slice(start, end));
}, 30_000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.exec(
    "RESET ROLE; TRUNCATE resupply.csr_order_requests,resupply.pricing_quotes;",
  );
  await db.query(
    "INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,bound_order_id,status,valid_until) VALUES($1,$2,$3,$4,'bound','2099-01-02')",
    [quote, org, patient, order],
  );
  await db.query(
    "INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,pricing_quote_id,status,expires_at,link_version) VALUES($1,$2,$3,$4,'sent','2099-01-01',2)",
    [order, org, patient, quote],
  );
  await db.exec("SET ROLE service_role");
});
async function expiredFixture() {
  // Seed an already-expired bound quote; never bypass the deadline guard to
  // alter an existing commitment.
  await db.exec(
    "RESET ROLE; TRUNCATE resupply.csr_order_requests,resupply.pricing_quotes;",
  );
  await db.query(
    "INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,bound_order_id,status,valid_until) VALUES($1,$2,$3,$4,'bound','2020-01-01')",
    [quote, org, patient, order],
  );
  await db.query(
    "INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,pricing_quote_id,status,expires_at,link_version) VALUES($1,$2,$3,$4,'sent','2099-01-01',2)",
    [order, org, patient, quote],
  );
  await db.exec("SET ROLE service_role");
}
describe("priced CSR link and signature deadline guards", () => {
  it("caps a resend at the accepted quote deadline", async () => {
    const result = await db.query(
      "UPDATE resupply.csr_order_requests SET link_version=3,expires_at='2099-02-01' WHERE id=$1 RETURNING expires_at::text,link_version",
      [order],
    );
    expect(result.rows[0]).toEqual({
      expires_at: "2099-01-02 00:00:00+00",
      link_version: 3,
    });
  });
  it.each([
    "link_version=3,expires_at='2099-02-01'",
    "status='signed',signed_at=clock_timestamp()",
  ])(
    "rejects an expired bound quote at the atomic update: %s",
    async (assignment) => {
      await expiredFixture();
      await expect(
        db.query(
          `UPDATE resupply.csr_order_requests SET ${assignment} WHERE id=$1`,
          [order],
        ),
      ).rejects.toMatchObject({ code: "PT409", message: "quote_expired" });
      expect(
        (
          await db.query(
            "SELECT status,link_version,signed_at FROM resupply.csr_order_requests WHERE id=$1",
            [order],
          )
        ).rows[0],
      ).toEqual({ status: "sent", link_version: 2, signed_at: null });
    },
  );
  it("does not extend a shorter expired order deadline when signing", async () => {
    await db.exec("RESET ROLE; TRUNCATE resupply.csr_order_requests");
    await db.query(
      "INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,pricing_quote_id,status,expires_at,link_version) VALUES($1,$2,$3,$4,'sent','2020-01-01',2)",
      [order, org, patient, quote],
    );
    await db.exec("SET ROLE service_role");
    await expect(
      db.query(
        "UPDATE resupply.csr_order_requests SET status='signed' WHERE id=$1",
        [order],
      ),
    ).rejects.toMatchObject({ code: "PT409", message: "quote_expired" });
  });
  it("allows a valid signature while repairing a previously overextended link deadline", async () => {
    const result = await db.query(
      "UPDATE resupply.csr_order_requests SET status='signed',signed_at=clock_timestamp(),expires_at='2099-02-01' WHERE id=$1 RETURNING status,expires_at::text",
      [order],
    );
    expect(result.rows[0]).toEqual({
      status: "signed",
      expires_at: "2099-01-02 00:00:00+00",
    });
  });
  it.each([
    ["missing quote", "id", id(30)],
    ["foreign tenant", "org_id", id(31)],
    ["different patient", "patient_id", id(32)],
    ["different bound order", "bound_order_id", id(33)],
  ])(
    "rejects %s before a new link or signature is committed",
    async (_label, column, value) => {
      await db.exec("RESET ROLE; TRUNCATE resupply.pricing_quotes");
      const values: Record<string, string> = {
        id: quote,
        org_id: org,
        patient_id: patient,
        bound_order_id: order,
      };
      values[column] = value;
      await db.query(
        "INSERT INTO resupply.pricing_quotes(id,org_id,patient_id,bound_order_id,status,valid_until) VALUES($1,$2,$3,$4,'bound','2099-01-02')",
        [values.id, values.org_id, values.patient_id, values.bound_order_id],
      );
      await db.exec("SET ROLE service_role");
      await expect(
        db.query(
          "UPDATE resupply.csr_order_requests SET link_version=3 WHERE id=$1",
          [order],
        ),
      ).rejects.toMatchObject({ code: "PT409", message: "quote_not_found" });
    },
  );
  it("allows cancellation to revoke an expired link", async () => {
    await expiredFixture();
    const result = await db.query(
      "UPDATE resupply.csr_order_requests SET status='canceled',link_version=3 WHERE id=$1 RETURNING status,link_version",
      [order],
    );
    expect(result.rows[0]).toEqual({ status: "canceled", link_version: 3 });
  });
  it("preserves bookkeeping for an already signed order after the quote deadline", async () => {
    await expiredFixture();
    await db.exec("RESET ROLE; TRUNCATE resupply.csr_order_requests");
    await db.query(
      "INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,pricing_quote_id,status,expires_at,link_version,signed_at) VALUES($1,$2,$3,$4,'signed','2020-01-01',2,'2019-12-31')",
      [order, org, patient, quote],
    );
    await db.exec("SET ROLE service_role");
    await db.query(
      "UPDATE resupply.csr_order_requests SET status='signed',updated_at=clock_timestamp() WHERE id=$1",
      [order],
    );
    await db.query(
      "UPDATE resupply.pricing_quotes SET actuals_revision=actuals_revision+1 WHERE id=$1",
      [quote],
    );
    expect(
      (
        await db.query<{ actuals_revision: number }>(
          "SELECT actuals_revision FROM resupply.pricing_quotes WHERE id=$1",
          [quote],
        )
      ).rows[0].actuals_revision,
    ).toBe(1);
  });
  it.each([
    "valid_until='2099-02-01'",
    "status='approved'",
    `bound_order_id='${id(35)}'`,
  ])(
    "keeps the bound deadline immutable without locking the quote from the order trigger: %s",
    async (assignment) => {
      await expect(
        db.query(
          `UPDATE resupply.pricing_quotes SET ${assignment} WHERE id=$1`,
          [quote],
        ),
      ).rejects.toMatchObject({
        code: "PT409",
        message: "quote_already_bound",
      });
    },
  );
  it("does not impose a financial deadline on legacy unpriced orders", async () => {
    await db.query(
      "INSERT INTO resupply.csr_order_requests(id,org_id,patient_id,status,expires_at,link_version) VALUES($1,$2,$3,'sent','2020-01-01',1)",
      [id(40), org, patient],
    );
    const result = await db.query<{ expires_at: string }>(
      "UPDATE resupply.csr_order_requests SET link_version=2,expires_at='2099-02-01' WHERE id=$1 RETURNING expires_at::text",
      [id(40)],
    );
    expect(result.rows[0].expires_at).toBe("2099-02-01 00:00:00+00");
  });
});
