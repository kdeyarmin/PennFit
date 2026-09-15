// check:code-schema-refs — find application code that reads or writes a
// table, column, or function the database does not have.
//
// WHY THIS EXISTS, AND HOW IT DIFFERS FROM check:schema-drift
// ----------------------------------------------------------
// The sibling detector `check-schema-drift.ts` compares MIGRATIONS to the
// LIVE DB and answers "has this database fallen behind the checked-in
// migrations?". It was written after a production sign-in outage caused by
// an unapplied migration.
//
// This one runs the opposite direction: it compares APPLICATION CODE to
// the LIVE DB and answers "does the code ask for something that was never
// in any migration?". A database perfectly in sync with every migration
// still fails these queries, so the existing detector reports OK while the
// feature is broken in production.
//
// That direction is not hypothetical. A single audit pass found seven of
// them, all shipped:
//   * `shop_orders.patient_id` (twice: the re-fit campaign and the
//     mask-fit worklist) — shop_orders has no FK to patients at all.
//   * `office_ally_submissions.created_at` — the column is `submitted_at`,
//     and the claims watchdog threw on it whenever it had work to do.
//   * `patients.communication_preferences` (twice) — it lives on
//     shop_customers. One caller threw, killing a whole org's dunning
//     tick; the other skipped every outreach run.
//   * `shop_customers.patient_id` — that table joins on email/auth id, and
//     dropping the error made a consent check fail toward SENDING.
//   * `fitter_fit_requests.patient_id` — reachable only via fit_session_id.
//
// WHY TESTS DO NOT CATCH THIS CLASS
// ---------------------------------
// The staged Supabase mock in
// `artifacts/resupply-api/src/test-helpers/supabase-mock.ts` returns
// whatever a test staged, keyed by table and verb. It does not validate
// column names, so a test can stage a row carrying a column that does not
// exist and the suite agrees with the bug. Several of the seven had
// passing tests that did exactly that. Only something that consults the
// real schema can see them.
//
// WHAT IT IS / IS NOT
//   * Heuristic. It reads the source textually and tracks each Supabase
//     query CHAIN (from `.from("literal")` to the end of the expression),
//     which is what keeps a table name from one query being attributed to
//     a column from the next. A chain rooted at a non-literal (a helper's
//     `table` parameter) is skipped rather than guessed at.
//   * Read-only against the DB. One connection, information_schema
//     SELECTs, no writes. Safe to point at production.
//   * A monitoring signal, not a compiler. It reports what it can prove is
//     absent, and stays quiet where it cannot tell.
//
// USAGE
//   DATABASE_URL=postgres://… pnpm --filter @workspace/scripts check:code-schema-refs
//   DATABASE_URL=… pnpm --filter @workspace/scripts check:code-schema-refs -- --json
//
// EXIT CODES
//   0 — every resolvable reference exists
//   1 — at least one unknown table, column, or function
//   2 — usage / environment error (no DATABASE_URL, source dirs missing)
//   3 — internal error

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { getDbPool } from "@workspace/resupply-db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

// Where application code that talks to PostgREST lives.
const SOURCE_ROOTS = [
  path.join("artifacts", "resupply-api", "src"),
  path.join("lib"),
  path.join("scripts", "src"),
];

// `public` is included because the storefront-era tables (orders,
// newsletter_subscribers, reminder_subscriptions, usage_events,
// admin_audit_log) still live there rather than under `resupply`.
const SCHEMAS = ["resupply", "resupply_auth", "public"] as const;

// References the code makes on purpose that this checker cannot resolve.
// Each entry needs a reason so the list stays auditable. Keyed as
// `table` or `table.column`.
const INTENTIONAL: Record<string, string> = {
  // Asserted against a hand-rolled fake client that records the column
  // string verbatim; never reaches a database.
  "patients.name": "org-scoped-client.test.ts fixture, fake client only",
};

// Receivers whose `.from()` is not a table reference. Matched on the
// RECEIVER (`Buffer.from("x")`), never on the argument — keying off the
// argument would both invent a table named "x" and suppress a real table
// that happened to share one of these names.
const NOT_A_TABLE_RECEIVER = new Set([
  "Buffer",
  "Array",
  "String",
  "Object",
  "Uint8Array",
  "Int8Array",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "Map",
  "Set",
  "Date",
]);

// Filter verbs whose FIRST argument is a column name.
const COLUMN_FIRST_ARG = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "overlaps",
  "order",
  "not",
]);

export interface Reference {
  file: string;
  line: number;
  table: string;
  /** Absent for a bare table reference. */
  column?: string;
  /** How the reference was made, for the report. */
  via: string;
}

// ─────────────────────────────────────────────────────────────────────
// Pure extraction core (unit-tested without a DB or a filesystem)
// ─────────────────────────────────────────────────────────────────────

/**
 * Strip `//` line comments and block comments.
 *
 * Several files in this repo explain a filter in prose directly above a
 * DIFFERENT query, so leaving comments in makes the prose read as a call
 * site. String literals are preserved: a `//` inside a URL string is not
 * a comment, and clobbering it would corrupt the chain it sits in.
 */
export function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote: string | null = null;
  // Last significant (non-whitespace, non-comment) character emitted, used
  // only to tell a regex literal from a division.
  let prev: string | null = null;

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      i += 1;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 2;
        continue;
      }
      // Keep newlines so line numbers stay accurate.
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      prev = c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 2;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 2;
      continue;
    }
    // A regex literal. This has to be recognised, because THIS file's own
    // patterns contain an odd number of quote characters inside character
    // classes (`[^"'\`]`). Treating those as string delimiters desynchronises
    // the scanner: everything after is read as one long string literal, which
    // both invents references and silently swallows real ones.
    if (c === "/" && startsRegex(prev)) {
      i = skipRegex(source, i);
      prev = "/";
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out;
}

/**
 * Whether a `/` at this position opens a regex rather than being division.
 * Division can only follow a value, so anything that cannot end an
 * expression means a regex starts here.
 */
function startsRegex(prev: string | null): boolean {
  if (prev === null) return true;
  return !/[A-Za-z0-9_$)\]]/.test(prev);
}

/**
 * Index just past a regex literal starting at `start`. A `/` inside a
 * character class does not close it, so classes are tracked.
 */
function skipRegex(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i];
    if (c === "\\") {
      i += 1;
      continue;
    }
    if (c === "\n") return i;
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return i + 1;
  }
  return source.length;
}

/** 1-based line number of a character offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i += 1) {
    if (source[i] === "\n") line += 1;
  }
  return line;
}

/**
 * The extent of the query chain rooted at `.from("x")`.
 *
 * A chain ends at the first `;` or `,` seen at the paren/brace depth it
 * started from, or at the next `.from(` — whichever comes first. Bounding
 * it is the whole point: attributing columns to "the most recent .from
 * anywhere in the file" is what produced false positives when a helper
 * took a table name as a parameter, and it would also silently miss the
 * real reference by pinning it to the wrong table.
 */
function chainEnd(source: string, start: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      // Fell out of the expression that contained the chain.
      if (depth < 0) return i;
    } else if (depth === 0 && (c === ";" || c === "\n")) {
      // A newline only ends the chain when the next non-space character
      // is not a continuation of it.
      if (c === ";") return i;
      let j = i + 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] !== ".") return i;
    }
  }
  return source.length;
}

/**
 * Index of the delimiter closing the one at `openIdx`, or -1 if unbalanced.
 * Quote-aware, so a brace inside a string does not shift the depth.
 */
export function matchingClose(source: string, openIdx: number): number {
  const open = source[openIdx];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === "\\") {
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c === open) depth += 1;
    else if (c === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Top-level keys of an object literal body (the text between its braces).
 *
 * Only the top level: a nested object is a jsonb VALUE, and its inner keys
 * are not columns. A spread or a computed key is skipped rather than
 * guessed at — the explicit keys beside it are still real column names, so
 * dropping the whole object would lose the signal.
 */
export function parseObjectKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let token = "";

  const flush = () => {
    const raw = token.trim();
    token = "";
    if (!raw) return;
    // `...spread` — the key set is not knowable here.
    if (raw.startsWith("...")) return;
    // `[computed]: v` — likewise.
    if (raw.startsWith("[")) return;
    // A ternary in the VALUE also contains a colon; the key is always the
    // part before the first one.
    const head = (raw.includes(":") ? raw.slice(0, raw.indexOf(":")) : raw)
      .trim()
      // A quoted key: `"member-id": x`.
      .replace(/^["'`]|["'`]$/g, "");
    if (/^[A-Za-z_]\w*$/.test(head)) keys.push(head);
  };

  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === "\\") {
        token += c + (body[i + 1] ?? "");
        i += 1;
        continue;
      }
      if (c === quote) quote = null;
      token += c;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      token += c;
      continue;
    }
    if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      flush();
      continue;
    }
    token += c;
  }
  flush();
  return keys;
}

/**
 * Column names written by an `.insert()` / `.update()` / `.upsert()`
 * argument. Handles one object and an array of objects; returns [] for a
 * variable payload, which is unresolvable.
 */
export function parseWritePayload(arg: string): string[] {
  const trimmed = arg.trim();
  if (trimmed.startsWith("{")) {
    const close = matchingClose(trimmed, 0);
    if (close < 0) return [];
    return parseObjectKeys(trimmed.slice(1, close));
  }
  if (trimmed.startsWith("[")) {
    const close = matchingClose(trimmed, 0);
    if (close < 0) return [];
    const inner = trimmed.slice(1, close);
    const keys: string[] = [];
    // Every element that is itself an object literal contributes its keys.
    for (let i = 0; i < inner.length; i += 1) {
      if (inner[i] !== "{") continue;
      const end = matchingClose(inner, i);
      if (end < 0) break;
      keys.push(...parseObjectKeys(inner.slice(i + 1, end)));
      i = end;
    }
    return keys;
  }
  return [];
}

/** Top-level column names in a PostgREST select string, plus embeds. */
export function parseSelect(select: string): {
  columns: string[];
  embeds: string[];
} {
  const columns: string[] = [];
  const embeds: string[] = [];
  let depth = 0;
  let token = "";

  const flush = () => {
    const raw = token.trim();
    token = "";
    if (!raw || raw === "*") return;
    // Cast first: `::` also matches the `alias:column` test below, so reading
    // the alias first turns `created_at::text` into `:text` and drops the
    // column silently instead of checking it.
    const uncast = raw.split("::")[0];
    // `alias:column` — the real column is on the right.
    const aliased = uncast.includes(":")
      ? uncast.slice(uncast.indexOf(":") + 1)
      : uncast;
    // `col->>'x'` json access: only the head is a real column.
    const head = aliased.split("->")[0].trim();
    if (!head) return;
    // An embed: `table(...)`, `table!fk(...)`, `table!inner(...)`.
    if (head.includes("(")) {
      const name = head.slice(0, head.indexOf("(")).split("!")[0].trim();
      if (name) embeds.push(name);
      return;
    }
    if (/^[A-Za-z_]\w*$/.test(head)) columns.push(head);
  };

  for (let i = 0; i < select.length; i += 1) {
    const c = select[i];
    if (c === "(") depth += 1;
    if (c === ")") depth -= 1;
    if (c === "," && depth === 0) {
      flush();
      continue;
    }
    token += c;
  }
  flush();
  return { columns, embeds };
}

/** Columns named inside an `.or()` / `.and()` PostgREST filter string. */
export function parseFilterString(filter: string): string[] {
  const cols: string[] = [];
  // Each clause is `column.operator.value`; nested `or(...)` groups are
  // split on the same commas, which is fine because each inner clause
  // still starts with its column.
  for (const clause of filter.split(",")) {
    const m = /^\s*(?:(?:and|or)\()?\s*([A-Za-z_]\w*)\./.exec(clause);
    if (m && m[1] !== "and" && m[1] !== "or") cols.push(m[1]);
  }
  return cols;
}

/**
 * Extract every resolvable table/column/RPC reference from one source
 * file. Pure: takes text, returns references.
 */
export function extractReferences(
  file: string,
  rawSource: string,
): {
  refs: Reference[];
  rpcs: Array<{ file: string; line: number; fn: string }>;
} {
  const source = stripComments(rawSource);
  const refs: Reference[] = [];
  const rpcs: Array<{ file: string; line: number; fn: string }> = [];

  for (const m of source.matchAll(/\.rpc\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
    rpcs.push({ file, line: lineAt(source, m.index!), fn: m[1] });
  }

  // Only chains rooted at a string literal. `.from(table)` with a
  // variable is unresolvable, and guessing is what misattributes columns.
  // The optional leading group is the receiver: a bare identifier when the
  // call is `db.from(…)`, absent when it is `getClient().from(…)`.
  for (const m of source.matchAll(
    /([A-Za-z_$][\w$]*)?\s*\.from\(\s*["'`]([A-Za-z0-9_]+)["'`]/g,
  )) {
    const receiver = m[1];
    const table = m[2];
    if (receiver && NOT_A_TABLE_RECEIVER.has(receiver)) continue;
    const start = m.index!;
    // Report the `.from` token's line, not the receiver's: in a wrapped
    // chain (`await db\n  .from("t")`) they are different lines.
    const tableLine = lineAt(source, start + m[0].indexOf(".from("));
    refs.push({ file, line: tableLine, table, via: ".from()" });

    const body = source.slice(start + m[0].length, chainEnd(source, start));

    for (const s of body.matchAll(/\.select\(\s*([\s\S]*?)\)/g)) {
      // Only a fully literal argument is safe to parse; a template with
      // `${...}` or a concatenated variable is not.
      const literal = joinStringLiteral(s[1]);
      if (literal === null) continue;
      const { columns } = parseSelect(literal);
      const line = tableLine + countNewlines(body.slice(0, s.index!));
      for (const column of columns) {
        refs.push({ file, line, table, column, via: ".select()" });
      }
    }

    for (const f of body.matchAll(/\.(\w+)\(\s*["'`]([A-Za-z0-9_]+)["'`]/g)) {
      const verb = f[1];
      if (!COLUMN_FIRST_ARG.has(verb)) continue;
      refs.push({
        file,
        line: tableLine + countNewlines(body.slice(0, f.index!)),
        table,
        column: f[2],
        via: `.${verb}()`,
      });
    }

    // Write payloads. A write to a column the table lacks fails the same way
    // a read does, and costs more: the row is not stored.
    for (const w of body.matchAll(/\.(insert|update|upsert)\(/g)) {
      const argStart = w.index! + w[0].length - 1;
      const close = matchingClose(body, argStart);
      if (close < 0) continue;
      const line = tableLine + countNewlines(body.slice(0, w.index!));
      for (const column of parseWritePayload(body.slice(argStart + 1, close))) {
        refs.push({ file, line, table, column, via: `.${w[1]}()` });
      }
    }

    for (const f of body.matchAll(/\.(or|and)\(\s*["'`]([^"'`]+)["'`]/g)) {
      const line = tableLine + countNewlines(body.slice(0, f.index!));
      for (const column of parseFilterString(f[2])) {
        refs.push({ file, line, table, column, via: `.${f[1]}()` });
      }
    }
  }

  return { refs, rpcs };
}

function countNewlines(s: string): number {
  let n = 0;
  for (const c of s) if (c === "\n") n += 1;
  return n;
}

/**
 * Concatenated string literals (`"a, " + "b"`) joined into one string.
 * Returns null when any part is not a literal — a select built from a
 * variable cannot be checked, and pretending otherwise invents columns.
 */
export function joinStringLiteral(expr: string): string | null {
  const trimmed = expr.trim();
  if (!trimmed) return null;
  let out = "";
  let rest = trimmed;
  while (rest.length > 0) {
    const m = /^(["'`])((?:[^\\]|\\.)*?)\1/.exec(rest);
    if (!m) return null;
    // A template literal with an interpolation is not resolvable.
    if (m[1] === "`" && m[2].includes("${")) return null;
    out += m[2];
    rest = rest.slice(m[0].length).trim();
    if (rest.startsWith("+")) {
      rest = rest.slice(1).trim();
      continue;
    }
    if (rest.length > 0) return null;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Filesystem + DB
// ─────────────────────────────────────────────────────────────────────

// This checker's OWN test file is the one place in the repo that names
// tables which deliberately do not exist (`ghost_table`, `t`) — they are
// fixtures for the extractor. Every other test file in the repo stages real
// tables, so tests are otherwise scanned on purpose: a test that stages a
// column the schema lacks is asserting the bug, which is how several of the
// seven survived review.
const SELF_TEST = "check-code-schema-refs.test.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "generated") {
      continue;
    }
    if (entry === SELF_TEST) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
      continue;
    }
    if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

export interface RefReport {
  unknownTables: Reference[];
  unknownColumns: Reference[];
  unknownRpcs: Array<{ file: string; line: number; fn: string }>;
  ignored: string[];
  filesScanned: number;
  referencesChecked: number;
}

async function run(): Promise<RefReport> {
  const roots = SOURCE_ROOTS.map((r) => path.join(REPO_ROOT, r)).filter(
    existsSync,
  );
  if (roots.length === 0) {
    process.stderr.write(
      "[check-code-schema-refs] no source roots found — wrong working directory?\n",
    );
    process.exit(2);
  }

  const files = roots.flatMap((r) => walk(r));
  const allRefs: Reference[] = [];
  const allRpcs: Array<{ file: string; line: number; fn: string }> = [];
  for (const file of files) {
    const { refs, rpcs } = extractReferences(
      path.relative(REPO_ROOT, file),
      readFileSync(file, "utf8"),
    );
    allRefs.push(...refs);
    allRpcs.push(...rpcs);
  }

  const pool = getDbPool();
  const client = await pool.connect();
  try {
    // Tables AND views: PostgREST exposes both and several routes read views.
    const tablesRes = await client.query<{ name: string }>(
      `select table_name as name
         from information_schema.tables
        where table_schema = any($1)`,
      [SCHEMAS as unknown as string[]],
    );
    const liveTables = new Set(tablesRes.rows.map((r) => r.name));

    const colsRes = await client.query<{ table: string; column: string }>(
      `select table_name as "table", column_name as "column"
         from information_schema.columns
        where table_schema = any($1)`,
      [SCHEMAS as unknown as string[]],
    );
    const liveCols = new Map<string, Set<string>>();
    for (const r of colsRes.rows) {
      if (!liveCols.has(r.table)) liveCols.set(r.table, new Set());
      liveCols.get(r.table)!.add(r.column);
    }

    const fnRes = await client.query<{ name: string }>(
      `select p.proname as name
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = any($1)`,
      [SCHEMAS as unknown as string[]],
    );
    const liveFns = new Set(fnRes.rows.map((r) => r.name));

    const ignored: string[] = [];
    const unknownTables: Reference[] = [];
    const unknownColumns: Reference[] = [];

    for (const ref of allRefs) {
      if (!ref.column) {
        if (liveTables.has(ref.table)) continue;
        if (INTENTIONAL[ref.table]) {
          ignored.push(`${ref.table} (${INTENTIONAL[ref.table]})`);
          continue;
        }
        unknownTables.push(ref);
        continue;
      }
      // A column on a table we could not resolve is already covered by the
      // table finding; reporting both double-counts one bug.
      const cols = liveCols.get(ref.table);
      if (!cols) continue;
      if (cols.has(ref.column)) continue;
      const k = `${ref.table}.${ref.column}`;
      if (INTENTIONAL[k]) {
        ignored.push(`${k} (${INTENTIONAL[k]})`);
        continue;
      }
      unknownColumns.push(ref);
    }

    const unknownRpcs = allRpcs.filter((r) => !liveFns.has(r.fn));

    const byLoc = (a: { file: string; line: number }, b: typeof a) =>
      a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1;
    unknownTables.sort(byLoc);
    unknownColumns.sort(byLoc);
    unknownRpcs.sort(byLoc);

    return {
      unknownTables,
      unknownColumns,
      unknownRpcs,
      ignored: [...new Set(ignored)].sort(),
      filesScanned: files.length,
      referencesChecked: allRefs.length + allRpcs.length,
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
      "[check-code-schema-refs] DATABASE_URL is not set — refusing to run.\n",
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
        const DIM = "\x1b[2m";
        const RESET = "\x1b[0m";
        const color = process.stdout.isTTY && !process.env.NO_COLOR;
        const paint = (c: string, s: string) => (color ? c + s + RESET : s);
        const w = (s: string) => process.stdout.write(s);

        w(
          `[check-code-schema-refs] scanned ${report.filesScanned} files, ` +
            `checked ${report.referencesChecked} references\n`,
        );
        if (report.ignored.length) {
          w(
            paint(
              DIM,
              `  (ignored ${report.ignored.length} known-intentional reference(s))\n`,
            ),
          );
        }
        const section = (
          title: string,
          rows: Array<{ file: string; line: number }>,
          fmt: (r: never) => string,
        ) => {
          if (rows.length === 0) return;
          w(paint(RED, `  ${title} (${rows.length}):\n`));
          for (const r of rows) {
            w(`    ${r.file}:${r.line}  ${fmt(r as never)}\n`);
          }
        };
        section(
          "UNKNOWN TABLES",
          report.unknownTables,
          (r: Reference) => r.table,
        );
        section(
          "UNKNOWN COLUMNS",
          report.unknownColumns,
          (r: Reference) => `${r.table}.${r.column}  ${paint(DIM, r.via)}`,
        );
        section(
          "UNKNOWN FUNCTIONS",
          report.unknownRpcs,
          (r: { fn: string }) => r.fn,
        );

        const clean =
          report.unknownTables.length === 0 &&
          report.unknownColumns.length === 0 &&
          report.unknownRpcs.length === 0;
        if (clean) {
          w(paint(GREEN, "  OK — every resolvable reference exists.\n"));
        }
      }
      const bad =
        report.unknownTables.length > 0 ||
        report.unknownColumns.length > 0 ||
        report.unknownRpcs.length > 0;
      process.exit(bad ? 1 : 0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        `[check-code-schema-refs] internal error: ${
          err instanceof Error ? (err.stack ?? err.message) : String(err)
        }\n`,
      );
      process.exit(3);
    });
}

// Importing this module (the unit tests for the pure extractors) must NOT
// trigger the DB-touching run() or the process.exit() calls in main().
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
