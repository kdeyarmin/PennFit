// check:schema-drift — compare the checked-in migration DDL against the
// columns/tables that actually exist in a live database.
//
// WHY THIS EXISTS
// ----------------
// On 2026-05-30, admin/customer sign-in 500'd in production because
// `resupply_auth.password_credentials.set_by_admin_at` (migration 0142) had
// never been applied to the live database. Root cause: the production project
// has no `drizzle.resupply_migrations` ledger and had drifted materially
// behind the checked-in migrations, with no automated signal. See
// docs/incident-signin-500-schema-drift-2026-05-30.md.
//
// This is the durable detector. It parses every
// lib/resupply-db/drizzle/*.sql migration for additive DDL targeting the
// `resupply` / `resupply_auth` schemas, accounts for later DROP/RENAME, then
// asks the live DB (via DATABASE_URL) which expected tables/columns are
// absent. Exit non-zero when drift is found so it can gate a scheduled job or
// a pre-deploy step.
//
// WHAT IT IS / IS NOT
//   * Heuristic textual DDL parsing — handles ADD COLUMN [IF NOT EXISTS],
//     DROP COLUMN, RENAME COLUMN, CREATE TABLE (name only), DROP TABLE,
//     ALTER TABLE ... RENAME TO. It does NOT extract columns declared inside
//     CREATE TABLE bodies (those tables, when present, already carry their
//     base columns; the historical drift risk is the later ALTERs). It is a
//     monitoring signal, not a migration planner.
//   * Read-only. Opens one connection, runs information_schema SELECTs, and
//     never writes. Safe to point at production.
//   * Honors an allowlist of KNOWN-INTENTIONAL absences (e.g. audit-log
//     tamper columns retired by migration 0156) so the signal stays
//     actionable instead of perpetually red.
//
// USAGE
//   DATABASE_URL=postgres://… pnpm --filter @workspace/scripts check:schema-drift
//   # JSON for machines:
//   DATABASE_URL=… pnpm --filter @workspace/scripts check:schema-drift -- --json
//
// EXIT CODES
//   0 — no drift (every expected object present; allowlisted absences ignored)
//   1 — drift found (missing tables and/or columns)
//   2 — usage / environment error (no DATABASE_URL, migrations dir missing)
//   3 — internal error

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getDbPool } from "@workspace/resupply-db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/src -> repo root -> lib/resupply-db/drizzle
const MIGRATIONS_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "lib",
  "resupply-db",
  "drizzle",
);
const SCHEMAS = ["resupply", "resupply_auth"] as const;

// Columns/tables the migrations textually "expect" but which are absent ON
// PURPOSE. Each entry needs a reason so this list stays auditable. Keyed as
// `schema.table` (whole-table intentional absence) or `schema.table.column`.
const INTENTIONAL_ABSENCES: Record<string, string> = {
  // Audit-log tamper-evidence retired by migration 0156 (see CLAUDE.md, "No
  // HIPAA/DMEPOS/ACHC compliance machinery"). Current code has zero refs.
  "resupply.audit_log.signature": "retired by 0156 (audit tamper-evidence)",
  "resupply.audit_log.chain_seq": "retired by 0156 (audit tamper-evidence)",
  "resupply.audit_log.prev_signature":
    "retired by 0156 (audit tamper-evidence)",
  "resupply.audit_log.archived_at": "retired by 0156 (audit tamper-evidence)",
};

interface Loc {
  schema: string;
  table: string;
}

function stripComments(sql: string): string {
  // Drop line comments so DDL mentioned in prose headers isn't parsed as real.
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

function normTable(raw: string): Loc | null {
  const m = /^\s*"?([a-zA-Z_]\w*)"?\s*\.\s*"?([a-zA-Z_]\w*)"?\s*$/.exec(raw);
  if (!m) return null;
  const schema = m[1];
  const table = m[2];
  if (!SCHEMAS.includes(schema as (typeof SCHEMAS)[number])) return null;
  return { schema, table };
}

function key(schema: string, table: string, column?: string): string {
  return column ? `${schema}.${table}.${column}` : `${schema}.${table}`;
}

interface ParseResult {
  // schema.table -> set of expected column names (from ADD COLUMN)
  expectedColumns: Map<string, Set<string>>;
  // schema.table for every CREATE TABLE not later dropped
  expectedTables: Set<string>;
  filesParsed: number;
}

function parseMigrations(dir: string): ParseResult {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const expectedColumns = new Map<string, Set<string>>();
  const expectedTables = new Set<string>();
  const droppedTables = new Set<string>();

  const reAlter =
    /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?\w+"?\s*\.\s*"?\w+"?)(.*?);/gis;
  const reCreate =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?\w+"?\s*\.\s*"?\w+"?)/gi;
  const reDropTable =
    /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?("?\w+"?\s*\.\s*"?\w+"?)/gi;
  const reAddCol =
    /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_]\w*)"?/gi;
  const reDropCol = /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?"?([a-zA-Z_]\w*)"?/gi;
  const reRenameCol =
    /RENAME\s+COLUMN\s+"?([a-zA-Z_]\w*)"?\s+TO\s+"?([a-zA-Z_]\w*)"?/gi;
  const reRenameTbl = /RENAME\s+TO\s+"?([a-zA-Z_]\w*)"?/i;

  for (const file of files) {
    const sql = stripComments(readFileSync(path.join(dir, file), "utf8"));

    for (const m of sql.matchAll(reCreate)) {
      const loc = normTable(m[1]);
      if (!loc) continue;
      const k = key(loc.schema, loc.table);
      expectedTables.add(k);
      droppedTables.delete(k);
      if (!expectedColumns.has(k)) expectedColumns.set(k, new Set());
    }

    for (const m of sql.matchAll(reDropTable)) {
      const loc = normTable(m[1]);
      if (!loc) continue;
      const k = key(loc.schema, loc.table);
      droppedTables.add(k);
      expectedTables.delete(k);
      expectedColumns.delete(k);
    }

    for (const m of sql.matchAll(reAlter)) {
      const loc = normTable(m[1]);
      if (!loc) continue;
      const k = key(loc.schema, loc.table);
      const body = m[2];
      const set = expectedColumns.get(k) ?? new Set<string>();
      expectedColumns.set(k, set);

      for (const rc of body.matchAll(reRenameCol)) {
        set.delete(rc[1]);
        set.add(rc[2]);
      }
      for (const dc of body.matchAll(reDropCol)) {
        set.delete(dc[1]);
      }
      for (const ac of body.matchAll(reAddCol)) {
        set.add(ac[1]);
      }
      const rt = reRenameTbl.exec(body);
      if (rt && !droppedTables.has(k)) {
        const newKey = key(loc.schema, rt[1]);
        const merged = expectedColumns.get(newKey) ?? new Set<string>();
        for (const c of set) merged.add(c);
        expectedColumns.set(newKey, merged);
        expectedColumns.delete(k);
        if (expectedTables.delete(k)) expectedTables.add(newKey);
      }
    }
  }

  for (const k of droppedTables) {
    expectedColumns.delete(k);
    expectedTables.delete(k);
  }

  return { expectedColumns, expectedTables, filesParsed: files.length };
}

interface DriftReport {
  missingTables: string[];
  missingColumns: string[];
  ignoredAbsences: string[];
  filesParsed: number;
  hasLedger: boolean;
}

async function run(): Promise<DriftReport> {
  if (!existsSync(MIGRATIONS_DIR)) {
    process.stderr.write(
      `[check-schema-drift] migrations dir not found: ${MIGRATIONS_DIR}\n`,
    );
    process.exit(2);
  }
  const parsed = parseMigrations(MIGRATIONS_DIR);

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    // Live tables in our schemas.
    const liveTablesRes = await client.query<{ schema: string; table: string }>(
      `select table_schema as schema, table_name as "table"
         from information_schema.tables
        where table_schema = any($1)`,
      [SCHEMAS as unknown as string[]],
    );
    const liveTables = new Set(
      liveTablesRes.rows.map((r) => `${r.schema}.${r.table}`),
    );

    // Live columns in our schemas.
    const liveColsRes = await client.query<{
      schema: string;
      table: string;
      column: string;
    }>(
      `select table_schema as schema, table_name as "table", column_name as "column"
         from information_schema.columns
        where table_schema = any($1)`,
      [SCHEMAS as unknown as string[]],
    );
    const liveCols = new Set(
      liveColsRes.rows.map((r) => `${r.schema}.${r.table}.${r.column}`),
    );

    // Does the migration ledger exist? Its absence is itself a finding.
    const ledgerRes = await client.query<{ present: boolean }>(
      `select to_regclass('drizzle.resupply_migrations') is not null as present`,
    );
    const hasLedger = ledgerRes.rows[0]?.present === true;

    const ignoredAbsences: string[] = [];
    const missingTables: string[] = [];
    for (const t of parsed.expectedTables) {
      if (liveTables.has(t)) continue;
      if (INTENTIONAL_ABSENCES[t]) {
        ignoredAbsences.push(`${t} (${INTENTIONAL_ABSENCES[t]})`);
        continue;
      }
      missingTables.push(t);
    }

    const missingColumns: string[] = [];
    for (const [tKey, cols] of parsed.expectedColumns) {
      // Only flag columns on tables that DO exist live — a column on an
      // absent table is already covered by the missing-table finding, and
      // emitting both would double-count.
      if (!liveTables.has(tKey)) continue;
      for (const c of cols) {
        const ck = `${tKey}.${c}`;
        if (liveCols.has(ck)) continue;
        if (INTENTIONAL_ABSENCES[ck]) {
          ignoredAbsences.push(`${ck} (${INTENTIONAL_ABSENCES[ck]})`);
          continue;
        }
        missingColumns.push(ck);
      }
    }

    missingTables.sort();
    missingColumns.sort();
    ignoredAbsences.sort();
    return {
      missingTables,
      missingColumns,
      ignoredAbsences,
      filesParsed: parsed.filesParsed,
      hasLedger,
    };
  } finally {
    client.release();
    await pool.end();
  }
}

function main(): void {
  const json = process.argv.includes("--json");
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[check-schema-drift] DATABASE_URL is not set — refusing to run.\n",
    );
    process.exit(2);
  }
  run()
    .then((report) => {
      if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        const RED = "\x1b[31m";
        const GREEN = "\x1b[32m";
        const YELLOW = "\x1b[33m";
        const DIM = "\x1b[2m";
        const RESET = "\x1b[0m";
        const color = process.stdout.isTTY && !process.env.NO_COLOR;
        const paint = (c: string, s: string) => (color ? c + s + RESET : s);

        process.stdout.write(
          `[check-schema-drift] parsed ${report.filesParsed} migration files\n`,
        );
        if (!report.hasLedger) {
          process.stdout.write(
            paint(
              YELLOW,
              "  ! drizzle.resupply_migrations ledger ABSENT — applied state is untracked on this DB\n",
            ),
          );
        }
        if (report.ignoredAbsences.length) {
          process.stdout.write(
            paint(
              DIM,
              `  (ignored ${report.ignoredAbsences.length} known-intentional absence(s))\n`,
            ),
          );
        }
        if (report.missingTables.length) {
          process.stdout.write(
            paint(RED, `  MISSING TABLES (${report.missingTables.length}):\n`),
          );
          for (const t of report.missingTables) {
            process.stdout.write(`    - ${t}\n`);
          }
        }
        if (report.missingColumns.length) {
          process.stdout.write(
            paint(
              RED,
              `  MISSING COLUMNS on existing tables (${report.missingColumns.length}):\n`,
            ),
          );
          for (const c of report.missingColumns) {
            process.stdout.write(`    - ${c}\n`);
          }
        }
        if (!report.missingTables.length && !report.missingColumns.length) {
          process.stdout.write(
            paint(GREEN, "  OK — no schema drift detected.\n"),
          );
        }
      }
      const drift =
        report.missingTables.length > 0 || report.missingColumns.length > 0;
      process.exit(drift ? 1 : 0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[check-schema-drift] internal error: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`,
      );
      process.exit(3);
    });
}

main();
