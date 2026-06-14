// Real-Postgres integration test for the 0344 org-scoped patient dedup
// RPCs (multi-tenant Phase 0).
//
// merge.integration.test.ts proves the FK-repoint MECHANICS against the
// original 0225 function. This test proves the 0344 TENANT-ISOLATION
// overlay: that the org-aware signatures actually constrain every
// patients read/write to the caller's org. It boots PGlite, builds a
// miniature two-org schema, runs 0344 verbatim, and exercises:
//   1. patient_duplicate_groups only returns the caller-org's collisions;
//   2. merge_patient_records refuses a cross-org id pair (P0002);
//   3. an in-org merge still repoints + closes the duplicate.
//
// No external DB, no network — runs in CI like any other spec.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { describe, it, expect, beforeEach } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_PATH = resolve(
  __dirname,
  "../../../../../lib/resupply-db/drizzle/0344_patient_dedup_rpcs_org_scoped.sql",
);

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";

// Two patients in org A that collide on (last name + DOB), plus one in
// org B that shares the SAME blocking key — it must never appear in org
// A's duplicate scan.
const A_PRIMARY = "11111111-1111-4111-8111-111111111111";
const A_DUPLICATE = "22222222-2222-4222-8222-222222222222";
const B_PATIENT = "33333333-3333-4333-8333-333333333333";

// Minimal schema the dedup fns touch: organizations + patients (with
// org_id + the dedup columns) + a child FK to exercise the merge repoint.
const SETUP_SQL = `
  CREATE SCHEMA IF NOT EXISTS resupply;
  CREATE TABLE resupply.organizations (
    id uuid PRIMARY KEY,
    slug text NOT NULL UNIQUE
  );
  CREATE TABLE resupply.patients (
    id uuid PRIMARY KEY,
    org_id uuid NOT NULL REFERENCES resupply.organizations(id),
    legal_first_name text,
    legal_last_name text,
    date_of_birth text,
    pacware_id text,
    phone_e164 text,
    email text,
    status text NOT NULL DEFAULT 'active',
    merged_into_patient_id uuid REFERENCES resupply.patients(id),
    merged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE resupply.orders (
    id uuid PRIMARY KEY,
    patient_id uuid NOT NULL REFERENCES resupply.patients(id)
  );
  INSERT INTO resupply.organizations (id, slug) VALUES
    ('${ORG_A}', 'org-a'),
    ('${ORG_B}', 'org-b');
`;

async function freshDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SETUP_SQL);
  const migration = readFileSync(MIGRATION_PATH, "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  await db.exec(migration);
  return db;
}

async function seed(db: PGlite): Promise<void> {
  await db.exec(`
    INSERT INTO resupply.patients
      (id, org_id, legal_first_name, legal_last_name, date_of_birth) VALUES
      ('${A_PRIMARY}',   '${ORG_A}', 'Jane',  'Smith', '1965-04-12'),
      ('${A_DUPLICATE}', '${ORG_A}', 'Jayne', 'Smith', '1965-04-12'),
      ('${B_PATIENT}',   '${ORG_B}', 'Janet', 'Smith', '1965-04-12');
    INSERT INTO resupply.orders (id, patient_id) VALUES
      ('44444444-4444-4444-8444-444444444444', '${A_DUPLICATE}');
  `);
}

let db: PGlite;
beforeEach(async () => {
  db = await freshDb();
});

describe("patient dedup RPCs (org-scoped, real Postgres)", () => {
  it("duplicate scan only returns the caller-org's collisions", async () => {
    await seed(db);
    const a = await db.query<{ patient_id: string }>(
      "SELECT patient_id FROM resupply.patient_duplicate_groups($1, $2)",
      [ORG_A, 100],
    );
    const ids = a.rows.map((r) => r.patient_id).sort();
    expect(ids).toEqual([A_PRIMARY, A_DUPLICATE].sort());

    // Org B has a single patient on that blocking key → no collision.
    const b = await db.query(
      "SELECT patient_id FROM resupply.patient_duplicate_groups($1, $2)",
      [ORG_B, 100],
    );
    expect(b.rows).toHaveLength(0);
  });

  it("refuses a cross-org merge (P0002)", async () => {
    await seed(db);
    // Caller is org B but the ids belong to org A → not found, no merge.
    let code: string | undefined;
    try {
      await db.query("SELECT resupply.merge_patient_records($1, $2, $3)", [
        ORG_B,
        A_PRIMARY,
        A_DUPLICATE,
      ]);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe("P0002");

    // Nothing changed: duplicate still active, order still on it.
    const dup = await db.query<{ status: string }>(
      "SELECT status FROM resupply.patients WHERE id = $1",
      [A_DUPLICATE],
    );
    expect(dup.rows[0]!.status).toBe("active");
  });

  it("merges within the org and closes the duplicate", async () => {
    await seed(db);
    const res = await db.query<{ result: { rowsRepointed: number } }>(
      "SELECT resupply.merge_patient_records($1, $2, $3) AS result",
      [ORG_A, A_PRIMARY, A_DUPLICATE],
    );
    expect(res.rows[0]!.result.rowsRepointed).toBe(1); // the one order

    const moved = await db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM resupply.orders WHERE patient_id = $1",
      [A_PRIMARY],
    );
    expect(moved.rows[0]!.n).toBe(1);

    const dup = await db.query<{
      status: string;
      merged_into_patient_id: string | null;
    }>(
      "SELECT status, merged_into_patient_id FROM resupply.patients WHERE id = $1",
      [A_DUPLICATE],
    );
    expect(dup.rows[0]!.status).toBe("closed");
    expect(dup.rows[0]!.merged_into_patient_id).toBe(A_PRIMARY);
  });
});
