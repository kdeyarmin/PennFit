// Real-Postgres integration test for the 0225 patient-merge function.
//
// The unit/route tests (merge.test.ts) mock the RPC, so they prove the
// HTTP contract but NOT that the dynamic cross-table SQL actually works.
// This test boots PGlite (Postgres compiled to WASM, in-process) and runs
// the migration file VERBATIM against a miniature schema, then exercises:
//   1. happy path — every FK repoints, duplicate is closed + lineage set;
//   2. atomic rollback — a unique-constraint conflict (a one-row-per-
//      patient child existing for both records) aborts the WHOLE merge,
//      leaving nothing changed;
//   3. the guard rails (same patient / not found / already merged) raise
//      the SQLSTATEs the route maps.
//
// No external DB, no cost, no network — it runs in CI like any other spec.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeEach } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  __dirname,
  "../../../../../lib/resupply-db/drizzle/0225_merge_patient_records.sql",
);

const PRIMARY = "11111111-1111-4111-8111-111111111111";
const DUPLICATE = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";

/** Minimal schema the merge fn touches: patients + a few FK children,
 *  including a one-row-per-patient table (unique) to force a conflict. */
const SETUP_SQL = `
  CREATE SCHEMA IF NOT EXISTS resupply;
  CREATE TABLE resupply.patients (
    id uuid PRIMARY KEY,
    status text NOT NULL DEFAULT 'active',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- multi-row children
  CREATE TABLE resupply.orders (
    id uuid PRIMARY KEY,
    patient_id uuid NOT NULL REFERENCES resupply.patients(id)
  );
  CREATE TABLE resupply.conversations (
    id uuid PRIMARY KEY,
    patient_id uuid NOT NULL REFERENCES resupply.patients(id)
  );
  -- one-row-per-patient child: the source of merge conflicts
  CREATE TABLE resupply.patient_coverage (
    patient_id uuid PRIMARY KEY REFERENCES resupply.patients(id),
    payer text NOT NULL
  );
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SETUP_SQL);
  // Run the migration file verbatim (strip the migrator's breakpoints).
  const migration = readFileSync(MIGRATION_PATH, "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  await db.exec(migration);
  return db;
}

async function seedPair(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO resupply.patients (id, status) VALUES
      ('${PRIMARY}', 'active'),
      ('${DUPLICATE}', 'active');
    INSERT INTO resupply.orders (id, patient_id) VALUES
      ('${OTHER}', '${DUPLICATE}'),
      ('44444444-4444-4444-8444-444444444444', '${DUPLICATE}');
    INSERT INTO resupply.conversations (id, patient_id) VALUES
      ('55555555-5555-4555-8555-555555555555', '${DUPLICATE}');
  `);
}

async function callMerge(
  db: PGlite,
  primary: string,
  duplicate: string,
): Promise<{ tablesRepointed: number; rowsRepointed: number }> {
  const res = await db.query<{ result: unknown }>(
    "SELECT resupply.merge_patient_records($1, $2) AS result",
    [primary, duplicate],
  );
  return res.rows[0]!.result as {
    tablesRepointed: number;
    rowsRepointed: number;
  };
}

async function countWhere(
  db: PGlite,
  table: string,
  patientId: string,
): Promise<number> {
  const r = await db.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM resupply.${table} WHERE patient_id = $1`,
    [patientId],
  );
  return r.rows[0]!.n;
}

let db: PGlite;
beforeEach(async () => {
  db = await freshDb();
});

describe("merge_patient_records (real Postgres)", () => {
  it("repoints every FK and closes the duplicate", async () => {
    await seedPair(db);
    await db.exec(
      `INSERT INTO resupply.patient_coverage (patient_id, payer)
       VALUES ('${DUPLICATE}', 'Aetna')`,
    );

    const summary = await callMerge(db, PRIMARY, DUPLICATE);

    // 3 tables had rows moved: orders, conversations, patient_coverage.
    expect(summary.tablesRepointed).toBe(3);
    expect(summary.rowsRepointed).toBe(4); // 2 orders + 1 convo + 1 coverage

    expect(await countWhere(db, "orders", PRIMARY)).toBe(2);
    expect(await countWhere(db, "orders", DUPLICATE)).toBe(0);
    expect(await countWhere(db, "conversations", PRIMARY)).toBe(1);
    expect(await countWhere(db, "patient_coverage", PRIMARY)).toBe(1);

    const dup = await db.query<{
      status: string;
      merged_into_patient_id: string | null;
      merged_at: string | null;
    }>(
      `SELECT status, merged_into_patient_id, merged_at
       FROM resupply.patients WHERE id = $1`,
      [DUPLICATE],
    );
    expect(dup.rows[0]!.status).toBe("closed");
    expect(dup.rows[0]!.merged_into_patient_id).toBe(PRIMARY);
    expect(dup.rows[0]!.merged_at).not.toBeNull();
  });

  it("rolls back the ENTIRE merge when a unique child conflicts", async () => {
    await seedPair(db);
    // Both records already have a coverage row → repointing collides on
    // the patient_coverage PK.
    await db.exec(`
      INSERT INTO resupply.patient_coverage (patient_id, payer) VALUES
        ('${PRIMARY}', 'BCBS'),
        ('${DUPLICATE}', 'Aetna');
    `);

    let code: string | undefined;
    try {
      await callMerge(db, PRIMARY, DUPLICATE);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("23505"); // unique_violation → route maps to 409

    // Nothing moved: orders still on the duplicate, duplicate still open,
    // both coverage rows intact. Proves the call is all-or-nothing.
    expect(await countWhere(db, "orders", DUPLICATE)).toBe(2);
    expect(await countWhere(db, "orders", PRIMARY)).toBe(0);
    expect(await countWhere(db, "patient_coverage", PRIMARY)).toBe(1);
    expect(await countWhere(db, "patient_coverage", DUPLICATE)).toBe(1);
    const dup = await db.query<{ status: string }>(
      `SELECT status FROM resupply.patients WHERE id = $1`,
      [DUPLICATE],
    );
    expect(dup.rows[0]!.status).toBe("active");
  });

  it("refuses to merge a patient into itself (P0001)", async () => {
    await seedPair(db);
    await expect(callMerge(db, PRIMARY, PRIMARY)).rejects.toMatchObject({
      code: "P0001",
    });
  });

  it("raises P0002 when a patient does not exist", async () => {
    await seedPair(db);
    await expect(
      callMerge(db, PRIMARY, "99999999-9999-4999-8999-999999999999"),
    ).rejects.toMatchObject({ code: "P0002" });
  });

  it("refuses to re-merge an already-merged duplicate (P0003)", async () => {
    await seedPair(db);
    await callMerge(db, PRIMARY, DUPLICATE);
    await expect(callMerge(db, PRIMARY, DUPLICATE)).rejects.toMatchObject({
      code: "P0003",
    });
  });
});
