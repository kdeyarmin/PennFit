// Tests for the NOT VALID constraint survey.
//
// Two halves. The pure parts (reading the CHECK body back out of
// pg_get_constraintdef, and rendering a repair PLAN that executes
// nothing) run everywhere. The survey itself needs a real database and
// skips honestly without DATABASE_URL — same pattern as migrate.test.ts.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations.
import { buildRepairPlan, extractCheckBody } from "./constraint-preflight.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(HERE, "constraint-preflight.mjs");
const dbUrl = process.env.DATABASE_URL;

describe("extractCheckBody", () => {
  it("reads a simple enum CHECK", () => {
    expect(
      extractCheckBody(
        "CHECK ((status = ANY (ARRAY['a'::text, 'b'::text]))) NOT VALID",
      ),
    ).toBe("((status = ANY (ARRAY['a'::text, 'b'::text])))");
  });

  it("does not stop at a parenthesis inside a string literal", () => {
    // A vocabulary value containing a paren would otherwise truncate the
    // expression and silently produce a predicate that counts nothing.
    expect(
      extractCheckBody("CHECK ((reason = ANY (ARRAY['x(y'::text]))) NOT VALID"),
    ).toBe("((reason = ANY (ARRAY['x(y'::text])))");
  });

  it("handles a doubled quote inside a literal", () => {
    expect(
      extractCheckBody("CHECK ((note = 'it''s (fine)'::text)) NOT VALID"),
    ).toBe("((note = 'it''s (fine)'::text))");
  });

  it("returns null for a non-CHECK constraint rather than guessing", () => {
    expect(
      extractCheckBody("FOREIGN KEY (a) REFERENCES b(c) NOT VALID"),
    ).toBeNull();
  });

  it("returns null for an unbalanced definition", () => {
    expect(extractCheckBody("CHECK ((status = 'a'")).toBeNull();
  });
});

describe("buildRepairPlan", () => {
  const survey = {
    schema: "resupply",
    table_name: "episodes",
    name: "episodes_status_enum",
    violations: 3,
    groups: [
      { values: { status: "pending" }, count: 2 },
      { values: { status: null }, count: 1 },
    ],
  };

  it("emits nothing but commented-out SQL — a plan never runs itself", () => {
    const plan = buildRepairPlan(survey).join("\n");
    const executable = plan
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("--"));
    expect(executable).toEqual([]);
  });

  it("names the row count and the predicate for each offending group", () => {
    const plan = buildRepairPlan(survey).join("\n");
    expect(plan).toContain(`"status" = 'pending'`);
    expect(plan).toContain("2 row(s)");
    expect(plan).toContain(`"status" IS NULL`);
  });

  it("leaves the target value blank so nobody can run it unthinkingly", () => {
    expect(buildRepairPlan(survey).join("\n")).toContain("'<TARGET>'");
  });

  it("returns nothing when there is nothing to repair", () => {
    expect(buildRepairPlan({ ...survey, violations: 0, groups: [] })).toEqual(
      [],
    );
  });
});

describe.skipIf(!dbUrl)("constraint survey against a live database", () => {
  const SCHEMA = "constraint_preflight_spec";
  let pool: Pool;

  beforeAll(async () => {
    pool = new Pool({ connectionString: dbUrl, max: 1 });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(
      `CREATE TABLE ${SCHEMA}.widgets (
         id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
         status text,
         secret_note text
       )`,
    );
    await pool.query(
      `INSERT INTO ${SCHEMA}.widgets (status, secret_note) VALUES
         ('ok', 'patient wrote this'),
         ('ok', 'patient wrote this'),
         ('legacy', 'patient wrote this'),
         (NULL, 'patient wrote this')`,
    );
    await pool.query(
      `ALTER TABLE ${SCHEMA}.widgets
         ADD CONSTRAINT widgets_status_enum
         CHECK (status IN ('ok', 'better')) NOT VALID`,
    );
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  function run(args: string[]) {
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env },
      encoding: "utf8",
      timeout: 120_000,
    });
    return {
      code: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("counts violations exactly, and does not count NULL as a violation", () => {
    // A CHECK passes when it evaluates to NULL. `status IS NULL` is
    // therefore NOT a violation — one legacy row, not two. Getting this
    // backwards is the whole reason the survey uses `(body) IS FALSE`.
    const { code, stdout } = run([`--schema=${SCHEMA}`, "--json"]);
    expect(code).toBe(1);
    const report = JSON.parse(stdout);
    const widget = report.constraints.find(
      (c: { name: string }) => c.name === "widgets_status_enum",
    );
    expect(widget.violations).toBe(1);
    expect(widget.groups).toEqual([{ values: { status: "legacy" }, count: 1 }]);
    expect(widget.sampleIds).toHaveLength(1);
  });

  it("exits 0 when every surveyed constraint is clean", async () => {
    // A second schema, so the dirty fixture above stays dirty. It could
    // not be cleaned and re-dirtied in place anyway: re-introducing the
    // off-vocabulary row is itself rejected by the NOT VALID constraint,
    // which is exactly the hazard this workstream exists to surface.
    const CLEAN = `${SCHEMA}_clean`;
    await pool.query(`DROP SCHEMA IF EXISTS ${CLEAN} CASCADE`);
    await pool.query(`CREATE SCHEMA ${CLEAN}`);
    await pool.query(
      `CREATE TABLE ${CLEAN}.widgets (id serial PRIMARY KEY, status text)`,
    );
    await pool.query(`INSERT INTO ${CLEAN}.widgets (status) VALUES ('ok')`);
    await pool.query(
      `ALTER TABLE ${CLEAN}.widgets
         ADD CONSTRAINT clean_status_enum
         CHECK (status IN ('ok')) NOT VALID`,
    );
    try {
      const { code, stdout } = run([`--schema=${CLEAN}`]);
      expect(code).toBe(0);
      expect(stdout).toContain("CLEAN");
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${CLEAN} CASCADE`);
    }
  });

  it("cannot write, even if asked", async () => {
    // The session is read-only at the database, not merely by
    // inspection of the source.
    const before = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.widgets`,
    );
    run([`--schema=${SCHEMA}`, "--repair-plan"]);
    const after = await pool.query(
      `SELECT count(*)::int AS n FROM ${SCHEMA}.widgets`,
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
    const stillInvalid = await pool.query(
      `SELECT convalidated FROM pg_constraint WHERE conname = 'widgets_status_enum'`,
    );
    expect(stillInvalid.rows[0].convalidated).toBe(false);
  });

  it("withholds values from columns that are not known vocabulary", async () => {
    await pool.query(
      `ALTER TABLE ${SCHEMA}.widgets
         ADD CONSTRAINT widgets_note_enum
         CHECK (secret_note IN ('approved-note')) NOT VALID`,
    );
    const { stdout } = run([`--schema=${SCHEMA}`, "--json"]);
    const report = JSON.parse(stdout);
    const note = report.constraints.find(
      (c: { name: string }) => c.name === "widgets_note_enum",
    );
    expect(note.violations).toBeGreaterThan(0);
    expect(note.groups).toEqual([]);
    expect(stdout).not.toContain("patient wrote this");
    await pool.query(
      `ALTER TABLE ${SCHEMA}.widgets DROP CONSTRAINT widgets_note_enum`,
    );
  });
});
