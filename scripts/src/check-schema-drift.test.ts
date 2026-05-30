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

  it("counts every input record in filesParsed", () => {
    const r = parseMigrationsFromText([
      { name: "0001.sql", sql: "-- noop" },
      { name: "0002.sql", sql: "-- noop" },
      { name: "0003.sql", sql: "-- noop" },
    ]);
    expect(r.filesParsed).toBe(3);
  });
});
