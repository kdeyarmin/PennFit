#!/usr/bin/env node
// constraint-preflight.mjs — "can these NOT VALID constraints be
// formally validated yet?", answered without touching a row.
//
// WHY THIS EXISTS
// ---------------
// Migration 0538 added two CHECK constraints to `resupply.episodes` as
// **NOT VALID**, because 500k+ rows were written before that vocabulary
// was pinned and a validating ADD CONSTRAINT would have failed the
// deploy.
//
// NOT VALID is widely misread as "applies only to new rows". It is not.
// It skips the one-time back-scan, but Postgres still enforces the
// constraint on every subsequent INSERT **and UPDATE** — including an
// UPDATE that does not touch the constrained column at all. So a single
// legacy row carrying an off-vocabulary status turns the next patient
// confirm that touches that row into a 500, on a patient-facing path.
//
// Which means the useful question is not "should we validate?" but
// "how many landmines are already armed?". This answers that, read-only,
// before anyone runs a VALIDATE.
//
// HOW IT COUNTS
// -------------
// Database-native, not paginated-in-application. Each constraint's own
// expression is read back from `pg_get_constraintdef` and evaluated as
// an aggregate:
//
//     SELECT count(*) FROM <table> WHERE (<check body>) IS FALSE
//
// `IS FALSE` rather than `NOT (...)` is deliberate and is the whole
// correctness of this file: a CHECK **passes** when it evaluates to
// NULL, so `NOT (body)` would both miss nothing and count nothing extra
// only by accident, while `NOT (body)` under a NULL body yields NULL and
// silently drops the row from the count. `(body) IS FALSE` is exactly
// Postgres's own violation predicate.
//
// Because it is an aggregate over the real table there is no row cap to
// paginate around and no window that can truncate — the count is
// complete by construction.
//
// PHI
// ---
// Prints counts, constraint names, and internal UUIDs. Column VALUES are
// printed only for low-cardinality vocabulary columns (status, reason,
// kind, …) which are not patient data and are the only thing that makes
// the report actionable. `--include-values` widens that at the
// operator's explicit request; nothing widens it silently.
//
// Exit codes:
//   0 — every NOT VALID constraint surveyed is clean; safe to validate.
//   1 — at least one constraint has violating rows.
//   2 — DATABASE_URL unset, or the survey itself failed.

import pg from "pg";

const { Pool } = pg;

/**
 * Column names whose values are vocabulary, not patient data, and are
 * therefore safe to print in a report attached to a ticket.
 */
const SAFE_VALUE_COLUMNS = new Set([
  "status",
  "closed_reason",
  "reason",
  "kind",
  "type",
  "state",
  "category",
  "source",
  "channel",
  "outcome",
  "review_status",
]);

/** How many offending ids to sample per constraint. */
const ID_SAMPLE_LIMIT = 20;
/** How many distinct offending value-groups to report. */
const GROUP_LIMIT = 50;

/**
 * Parse the CHECK body out of `pg_get_constraintdef`, which returns e.g.
 *   CHECK ((status = ANY (ARRAY['a'::text, 'b'::text]))) NOT VALID
 *
 * Returns the balanced parenthesised expression that follows `CHECK`,
 * with the trailing ` NOT VALID` removed. Returns null for a constraint
 * shape we will not guess at (a foreign key, say) — the caller then
 * reports it as un-surveyable rather than inventing a predicate.
 *
 * @param {string} def
 * @returns {string | null}
 */
export function extractCheckBody(def) {
  const match = /^\s*CHECK\s*\(/i.exec(def);
  if (!match) return null;
  let depth = 0;
  const start = match[0].length - 1;
  for (let i = start; i < def.length; i++) {
    const ch = def[i];
    // The definitions Postgres emits are already normalized, but a
    // string literal can legitimately contain a parenthesis, so track
    // quoting rather than counting blindly.
    if (ch === "'") {
      i += 1;
      while (i < def.length) {
        if (def[i] === "'" && def[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (def[i] === "'") break;
        i += 1;
      }
      continue;
    }
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return def.slice(start, i + 1);
    }
  }
  return null;
}

/** Quote an identifier for interpolation into DDL-free SQL. */
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

/**
 * Every NOT VALID constraint in the given schemas, with the metadata
 * needed to survey it.
 *
 * @param {import("pg").PoolClient} client
 * @param {readonly string[]} schemas
 */
async function listUnvalidatedConstraints(client, schemas) {
  const { rows } = await client.query(
    `SELECT c.conname                              AS name,
            n.nspname                              AS schema,
            rel.relname                            AS table_name,
            c.contype                              AS type,
            pg_get_constraintdef(c.oid)            AS definition,
            -- Cast to text[]: node-postgres has no parser for the
            -- name[] array type and would hand back the raw literal
            -- {status} as a string, silently degrading every grouped
            -- report to "values withheld".
            COALESCE(
              (SELECT array_agg(a.attname::text ORDER BY a.attnum)
                 FROM unnest(c.conkey) AS k(attnum)
                 JOIN pg_attribute a
                   ON a.attrelid = c.conrelid AND a.attnum = k.attnum),
              ARRAY[]::text[]
            )                                      AS columns
       FROM pg_constraint c
       JOIN pg_class rel ON rel.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = rel.relnamespace
      WHERE c.convalidated = false
        AND n.nspname = ANY($1::text[])
      ORDER BY n.nspname, rel.relname, c.conname`,
    [schemas],
  );
  return rows;
}

/**
 * Survey one constraint. Read-only.
 *
 * @param {import("pg").PoolClient} client
 * @param {Record<string, any>} constraint
 * @param {{ includeValues: boolean }} options
 */
async function surveyConstraint(client, constraint, options) {
  const qualified = `${quoteIdent(constraint.schema)}.${quoteIdent(constraint.table_name)}`;

  if (constraint.type !== "c") {
    return {
      ...constraint,
      surveyable: false,
      note:
        `constraint type "${constraint.type}" is not a CHECK; this tool only ` +
        "surveys CHECK constraints. Validate it by hand after reviewing the definition.",
      violations: null,
    };
  }

  const body = extractCheckBody(constraint.definition);
  if (!body) {
    return {
      ...constraint,
      surveyable: false,
      note: "could not parse the CHECK expression; refusing to guess at a predicate.",
      violations: null,
    };
  }

  // `(body) IS FALSE` — Postgres's own violation predicate. See header.
  const violationPredicate = `(${body}) IS FALSE`;

  const { rows: countRows } = await client.query(
    `SELECT count(*)::bigint AS n FROM ${qualified} WHERE ${violationPredicate}`,
  );
  const violations = Number(countRows[0]?.n ?? 0);

  if (violations === 0) {
    return { ...constraint, surveyable: true, violations, groups: [], ids: [] };
  }

  // A capped sample of internal ids so an operator can go look. Only
  // fetched when the table actually has an `id` column.
  let ids = [];
  const { rows: hasId } = await client.query(
    `SELECT 1 FROM pg_attribute
      WHERE attrelid = $1::regclass AND attname = 'id' AND attnum > 0 AND NOT attisdropped`,
    [`${constraint.schema}.${constraint.table_name}`],
  );
  if (hasId.length > 0) {
    const { rows } = await client.query(
      `SELECT id::text AS id FROM ${qualified}
        WHERE ${violationPredicate}
        ORDER BY id
        LIMIT ${ID_SAMPLE_LIMIT}`,
    );
    ids = rows.map((r) => r.id);
  }

  // Which values are offending, and how many of each — the only thing
  // that makes the number actionable.
  const groupColumns = (constraint.columns ?? []).filter(
    (col) => options.includeValues || SAFE_VALUE_COLUMNS.has(col),
  );
  let groups = [];
  if (groupColumns.length > 0) {
    const selectList = groupColumns.map(quoteIdent).join(", ");
    const { rows } = await client.query(
      `SELECT ${selectList}, count(*)::bigint AS n
         FROM ${qualified}
        WHERE ${violationPredicate}
        GROUP BY ${selectList}
        ORDER BY n DESC
        LIMIT ${GROUP_LIMIT}`,
    );
    groups = rows.map((row) => ({
      values: Object.fromEntries(
        groupColumns.map((col) => [col, row[col] ?? null]),
      ),
      count: Number(row.n),
    }));
  }

  return {
    ...constraint,
    surveyable: true,
    violations,
    groups,
    ids,
    valuesWithheld:
      groupColumns.length === 0 && (constraint.columns ?? []).length > 0,
  };
}

/**
 * Render a repair PLAN — SQL an operator reviews and runs by hand.
 * Nothing here executes. Every statement carries a REVIEW marker and
 * names the row count it would touch, because rewriting a historical
 * lifecycle status is a decision about what happened to a patient, not
 * a data-hygiene chore.
 *
 * @param {ReturnType<typeof surveyConstraint> extends Promise<infer T> ? T : never} survey
 * @returns {string[]}
 */
export function buildRepairPlan(survey) {
  if (!survey.violations || survey.groups.length === 0) return [];
  const qualified = `"${survey.schema}"."${survey.table_name}"`;
  const lines = [
    `-- Repair plan for ${survey.schema}.${survey.table_name} / ${survey.name}`,
    `-- ${survey.violations} row(s) currently violate this constraint.`,
    "--",
    "-- NOTHING BELOW HAS BEEN RUN. Each statement rewrites what the system",
    "-- recorded as having happened to a patient's resupply cycle. Decide the",
    "-- target value per row-group, replace <TARGET>, and run inside a",
    "-- transaction you are prepared to roll back.",
    "--",
  ];
  for (const group of survey.groups) {
    const predicate = Object.entries(group.values)
      .map(([col, value]) =>
        value === null
          ? `"${col}" IS NULL`
          : `"${col}" = ${literal(String(value))}`,
      )
      .join(" AND ");
    const cols = Object.keys(group.values);
    lines.push(
      `-- REVIEW: ${group.count} row(s) where ${predicate}`,
      `-- UPDATE ${qualified} SET ${cols
        .map((c) => `"${c}" = '<TARGET>'`)
        .join(", ")} WHERE ${predicate};`,
      "",
    );
  }
  return lines;
}

/** Single-quote a SQL string literal. */
function literal(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    includeValues: argv.includes("--include-values"),
    repairPlan: argv.includes("--repair-plan"),
    schemas: (() => {
      const flag = argv.find((a) => a.startsWith("--schema="));
      return flag
        ? flag
            .slice("--schema=".length)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : ["resupply", "public", "resupply_auth"];
    })(),
  };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    process.stderr.write(
      "[constraint-preflight] DATABASE_URL is not set — refusing to run.\n",
    );
    process.exit(2);
  }
  const args = parseArgs(process.argv.slice(2));

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  try {
    // Read-only for the whole session. A survey must not be able to
    // write even by accident, and this makes that true at the database
    // rather than by inspection of the code above.
    await client.query("SET default_transaction_read_only = on");
    await client.query("SET statement_timeout = '10min'");

    const constraints = await listUnvalidatedConstraints(client, args.schemas);
    const surveys = [];
    for (const constraint of constraints) {
      surveys.push(await surveyConstraint(client, constraint, args));
    }

    const dirty = surveys.filter((s) => (s.violations ?? 0) > 0);
    const unsurveyable = surveys.filter((s) => !s.surveyable);

    if (args.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            event: "constraint.preflight",
            schemas: args.schemas,
            total: surveys.length,
            clean: surveys.length - dirty.length - unsurveyable.length,
            dirty: dirty.length,
            unsurveyable: unsurveyable.length,
            constraints: surveys.map((s) => ({
              schema: s.schema,
              table: s.table_name,
              name: s.name,
              surveyable: s.surveyable,
              violations: s.violations,
              groups: s.groups ?? [],
              sampleIds: s.ids ?? [],
              note: s.note ?? null,
            })),
          },
          null,
          2,
        )}\n`,
      );
    } else {
      process.stdout.write(
        `[constraint-preflight] ${surveys.length} NOT VALID constraint(s) in ` +
          `${args.schemas.join(", ")}\n\n`,
      );
      if (surveys.length === 0) {
        process.stdout.write(
          "  Nothing to survey — every constraint in these schemas is already validated.\n",
        );
      }
      for (const s of surveys) {
        const where = `${s.schema}.${s.table_name} / ${s.name}`;
        if (!s.surveyable) {
          process.stdout.write(`  ?  ${where}\n     ${s.note}\n\n`);
          continue;
        }
        if (s.violations === 0) {
          process.stdout.write(
            `  OK ${where}\n     0 violating rows — safe to VALIDATE.\n\n`,
          );
          continue;
        }
        process.stdout.write(
          `  !! ${where}\n     ${s.violations} violating row(s). ` +
            "VALIDATE would fail, and every UPDATE that touches one of these " +
            "rows already errors.\n",
        );
        for (const g of s.groups) {
          const rendered = Object.entries(g.values)
            .map(([col, value]) => `${col}=${value === null ? "NULL" : value}`)
            .join(" ");
          process.stdout.write(
            `       ${String(g.count).padStart(8)}  ${rendered}\n`,
          );
        }
        if (s.valuesWithheld) {
          process.stdout.write(
            "       (column values withheld — not a known vocabulary column. " +
              "Re-run with --include-values if they are safe to print.)\n",
          );
        }
        if (s.ids.length > 0) {
          process.stdout.write(
            `       sample ids: ${s.ids.slice(0, 5).join(", ")}` +
              (s.violations > 5 ? ` … (+${s.violations - 5} more)` : "") +
              "\n",
          );
        }
        process.stdout.write("\n");
      }

      if (args.repairPlan) {
        for (const s of dirty) {
          process.stdout.write(`${buildRepairPlan(s).join("\n")}\n`);
        }
      }

      process.stdout.write(
        dirty.length === 0
          ? "[constraint-preflight] CLEAN — every surveyed constraint can be validated.\n"
          : `[constraint-preflight] ${dirty.length} constraint(s) have violating rows. ` +
              "Resolve them before validating; re-run with --repair-plan for reviewable SQL.\n",
      );
    }

    process.exit(dirty.length === 0 ? 0 : 1);
  } finally {
    client.release();
    await pool.end();
  }
}

const isDirectRun =
  Boolean(process.argv[1]) &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(
      `[constraint-preflight] failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    process.exit(2);
  });
}
