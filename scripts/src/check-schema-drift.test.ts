// Unit tests for the schema-drift parser (the pure function).
//
// Only `parseMigrationsFromText` is exercised here: it holds the real
// parsing logic and is the part most likely to regress. The DB-touching
// `run()` path is covered by the live `.github/workflows/schema-drift.yml`
// workflow, not by unit tests (it needs a real DATABASE_URL).

import { describe, expect, it } from "vitest";

import { parseMigrationsFromText } from "./check-schema-drift.js";

describe("parseMigrationsFromText", () => {
  it("tracks CREATE TABLE in the resupply schema", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_x.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."widgets" ("id" uuid PRIMARY KEY);`,
      },
    ]);
    expect(r.expectedTables.has("resupply.widgets")).toBe(true);
    expect(r.filesParsed).toBe(1);
  });

  it("tracks ADD COLUMN on a resupply table", () => {
    const r = parseMigrationsFromText([
      {
        name: "0002_x.sql",
        sql: `ALTER TABLE "resupply"."widgets" ADD COLUMN IF NOT EXISTS "color" text;`,
      },
    ]);
    expect(r.expectedColumns.get("resupply.widgets")?.has("color")).toBe(true);
  });

  it("forgets a column removed by a later DROP COLUMN", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_x.sql",
        sql: `ALTER TABLE "resupply"."widgets" ADD COLUMN IF NOT EXISTS "color" text;`,
      },
      {
        name: "0002_x.sql",
        sql: `ALTER TABLE "resupply"."widgets" DROP COLUMN IF EXISTS "color";`,
      },
    ]);
    expect(
      r.expectedColumns.get("resupply.widgets")?.has("color") ?? false,
    ).toBe(false);
  });

  it("forgets a table removed by a later DROP TABLE", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_x.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."temp_t" ("id" uuid PRIMARY KEY);`,
      },
      { name: "0002_x.sql", sql: `DROP TABLE IF EXISTS "resupply"."temp_t";` },
    ]);
    expect(r.expectedTables.has("resupply.temp_t")).toBe(false);
  });

  it("tracks the resupply_auth schema too", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_x.sql",
        sql: `ALTER TABLE "resupply_auth"."password_credentials" ADD COLUMN IF NOT EXISTS "set_by_admin_at" timestamptz;`,
      },
    ]);
    expect(
      r.expectedColumns
        .get("resupply_auth.password_credentials")
        ?.has("set_by_admin_at"),
    ).toBe(true);
  });

  it("ignores tables outside the resupply/resupply_auth schemas", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_x.sql",
        sql: `CREATE TABLE IF NOT EXISTS "public"."orders" ("id" uuid PRIMARY KEY);
              ALTER TABLE "auth"."users" ADD COLUMN IF NOT EXISTS "x" text;`,
      },
    ]);
    expect(r.expectedTables.has("public.orders")).toBe(false);
    expect(r.expectedColumns.has("auth.users")).toBe(false);
  });

  it("does not let a defensive re-create resurrect a dropped column", () => {
    // 0090 re-declares admin_users defensively (IF NOT EXISTS, so the FK it
    // adds resolves on a from-scratch replay) by copying 0020's definition —
    // including the two Clerk columns 0023 had dropped. On any real database
    // the statement is a no-op, so its column list is not authoritative.
    // Merging it anyway made the DAILY drift job report two phantom missing
    // columns against a correct production DB, and a detector that is always
    // red hides the genuine drift it exists to catch.
    const r = parseMigrationsFromText([
      {
        name: "0020_admin_users.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."admin_users" ("id" text PRIMARY KEY, "clerk_user_id" text UNIQUE);`,
      },
      {
        name: "0023_drop.sql",
        sql: `ALTER TABLE "resupply"."admin_users" DROP COLUMN IF EXISTS "clerk_user_id";`,
      },
      {
        name: "0090_defensive.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."admin_users" ("id" text PRIMARY KEY, "clerk_user_id" text UNIQUE);`,
      },
    ]);
    expect(r.expectedTables.has("resupply.admin_users")).toBe(true);
    expect(
      r.expectedColumns.get("resupply.admin_users")?.has("clerk_user_id") ??
        false,
    ).toBe(false);
    // The column the table really does still have is untouched.
    expect(r.expectedColumns.get("resupply.admin_users")?.has("id")).toBe(true);
  });

  it("honors a re-create that fires because the table was dropped", () => {
    // Here the IF NOT EXISTS is NOT a no-op: nothing holds the table when it
    // runs, so its columns are authoritative again.
    const r = parseMigrationsFromText([
      {
        name: "0001_a.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."t" ("id" uuid PRIMARY KEY);`,
      },
      { name: "0002_b.sql", sql: `DROP TABLE IF EXISTS "resupply"."t";` },
      {
        name: "0003_c.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."t" ("id" uuid PRIMARY KEY, "revived" text);`,
      },
    ]);
    expect(r.expectedTables.has("resupply.t")).toBe(true);
    expect(r.expectedColumns.get("resupply.t")?.has("revived")).toBe(true);
  });

  it("still trusts an unguarded CREATE TABLE that re-declares a table", () => {
    // Without IF NOT EXISTS the statement cannot be a silent no-op — it would
    // error on a live table — so the declaration is taken at face value.
    const r = parseMigrationsFromText([
      {
        name: "0001_a.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."t" ("id" uuid PRIMARY KEY);`,
      },
      {
        name: "0002_b.sql",
        sql: `CREATE TABLE "resupply"."t" ("id" uuid PRIMARY KEY, "added" text);`,
      },
    ]);
    expect(r.expectedColumns.get("resupply.t")?.has("added")).toBe(true);
  });

  it("keeps a column a later ADD COLUMN really does add after a re-create", () => {
    const r = parseMigrationsFromText([
      {
        name: "0001_a.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."t" ("id" uuid PRIMARY KEY);`,
      },
      {
        name: "0002_b.sql",
        sql: `CREATE TABLE IF NOT EXISTS "resupply"."t" ("id" uuid PRIMARY KEY, "stale" text);`,
      },
      {
        name: "0003_c.sql",
        sql: `ALTER TABLE "resupply"."t" ADD COLUMN IF NOT EXISTS "real" text;`,
      },
    ]);
    const cols = r.expectedColumns.get("resupply.t");
    // The no-op's invention is ignored; the genuine ADD COLUMN is not.
    expect(cols?.has("stale") ?? false).toBe(false);
    expect(cols?.has("real")).toBe(true);
  });

  it("counts every input record in filesParsed", () => {
    const r = parseMigrationsFromText([
      { name: "0001.sql", sql: "-- noop" },
      { name: "0002.sql", sql: "-- noop" },
      { name: "0003.sql", sql: "-- noop" },
    ]);
    expect(r.filesParsed).toBe(3);
  });
});
