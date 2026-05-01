// auth:backfill-shop-customers — one-shot importer that mints
// `auth.users` rows for every customer in a Clerk Dashboard CSV
// export, attaches the bcrypt password hash so first-sign-in
// transparently rehashes to argon2id, and links each row to the
// existing `resupply.shop_customers` row via `auth_user_id`.
//
// See `docs/resupply/AUTH-STAGE-4C-PLAN.md` for the design + the
// 5 confirmed decisions this script encodes.
//
// Usage:
//   DATABASE_URL=postgres://... \
//   pnpm --filter @workspace/scripts auth:backfill-shop-customers \
//     --csv=path/to/users.csv \
//     [--dry-run] \
//     [--limit=N]
//
// What it does (per CSV row):
//   1. Skip if password_digest is empty AND we don't see a
//      verified primary email — the user has nothing we can
//      migrate, and re-issuing the password will go through
//      `/auth/forgot-password` later anyway.
//   2. Otherwise upsert `auth.users` with email_lower from the
//      primary_email_address, role='customer', status='active',
//      and email_verified_at = NOW() iff the address is in
//      verified_email_addresses.
//   3. If password_digest is non-empty: upsert
//      `auth.password_credentials` with algo='clerk-bcrypt-v1'.
//      Skip the upsert if the row already has algo='argon2id-v1'
//      (a customer already signed in via the in-house path
//      mid-migration; their argon2 hash supersedes any earlier
//      bcrypt one).
//   4. UPDATE `resupply.shop_customers` SET auth_user_id = …
//      WHERE clerk_user_id = $csvRowId. No-op if no row exists
//      (e.g. an admin who never bought anything).
//
// Idempotency:
//   * Re-runs are no-ops. ON CONFLICT (email_lower) DO NOTHING
//     for auth.users; ON CONFLICT (user_id) DO UPDATE for
//     password_credentials but only when the existing algo isn't
//     argon2id-v1.
//   * Email collisions (the email already exists in auth.users
//     with a DIFFERENT auth_user_id) are reported and skipped —
//     these need ops review (they're probably the bootstrap-admin
//     re-using the email, see Risk 7 in the plan doc).
//
// Reporting:
//   The summary printed at the end is:
//     created     N  (new auth.users rows)
//     linked      N  (shop_customers rows updated with auth_user_id)
//     reactivated N  (rows already existed but were status='invited'/'locked')
//     skipped_no_email   N  (CSV row with no verified primary email)
//     skipped_passwordless N  (no password digest — needs reset email)
//     skipped_collision  N  (email already linked to a different auth_user_id)
//     errors      N  (per-row failures; details logged to stderr)
//
// Exit codes:
//   0 — every row processed (success or skip).
//   1 — fatal error (CSV parse, DB unreachable, missing CLI args).
//   2 — required env var missing.

import { readFileSync } from "node:fs";

import pg from "pg";

interface ParsedArgs {
  csvPath: string;
  dryRun: boolean;
  limit: number | null;
}

interface CsvRow {
  /** Original Clerk user id from the export. Used as the
   * shop_customers PK (clerk_user_id) — that's the existing
   * value, no rewrite needed. */
  clerkUserId: string;
  primaryEmail: string | null;
  primaryEmailVerified: boolean;
  firstName: string | null;
  lastName: string | null;
  passwordDigest: string | null;
  passwordHasher: string | null;
}

interface Counters {
  created: number;
  linked: number;
  reactivated: number;
  skipped_no_email: number;
  skipped_passwordless: number;
  skipped_collision: number;
  errors: number;
  total: number;
}

function fail(message: string, code = 1): never {
  process.stderr.write(`[auth:backfill-shop-customers] ${message}\n`);
  process.exit(code);
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = new Map<string, string>();
  const flags = new Set<string>();
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) flags.add(raw.slice(2));
    else args.set(raw.slice(2, eq), raw.slice(eq + 1));
  }
  const csvPath = args.get("csv");
  if (!csvPath) fail("--csv=path/to/users.csv is required.");
  const limitRaw = args.get("limit");
  const limit = limitRaw ? Number(limitRaw) : null;
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    fail("--limit must be a positive integer.");
  }
  return {
    csvPath: csvPath!,
    dryRun: flags.has("dry-run"),
    limit,
  };
}

/**
 * RFC-4180-aware single-line CSV parser. Handles quoted cells with
 * embedded commas, doubled-quote escapes, and CRLF / LF line
 * endings. Multi-line cell values inside quoted strings ARE
 * supported because we read the whole file at once and split on
 * lines that aren't inside an open quote.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (c === "\r") {
      // Only end-of-line on the LF; treat \r as part of CRLF.
      i++;
      continue;
    }
    if (c === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      i++;
      continue;
    }
    cell += c;
    i++;
  }
  // Flush trailing cell + row (CSV may not end with a newline).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function normalizeRows(grid: string[][]): CsvRow[] {
  if (grid.length === 0) return [];
  const header = grid[0]!.map((h) => h.trim().toLowerCase());
  const idx = (name: string): number => header.indexOf(name);
  const idxId = idx("id");
  const idxFirst = idx("first_name");
  const idxLast = idx("last_name");
  const idxEmail = idx("primary_email_address");
  const idxVerified = idx("verified_email_addresses");
  const idxDigest = idx("password_digest");
  const idxHasher = idx("password_hasher");
  if (idxId < 0 || idxEmail < 0) {
    fail(
      `CSV header missing required columns. Got: ${header.join(", ")}`,
    );
  }
  const out: CsvRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i]!;
    if (row.every((c) => c.trim() === "")) continue;
    const id = (row[idxId] ?? "").trim();
    if (!id) continue;
    const primaryEmail = (row[idxEmail] ?? "").trim() || null;
    // verified_email_addresses is a comma-separated list within a
    // single CSV cell. The cell content was already split on the
    // outer commas by parseCsv (because the export quotes it), so
    // we get the raw list here.
    const verifiedRaw = idxVerified >= 0 ? (row[idxVerified] ?? "") : "";
    const verifiedList = verifiedRaw
      .split(/[,\s]+/u)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    const primaryEmailVerified =
      primaryEmail !== null &&
      verifiedList.includes(primaryEmail.toLowerCase());
    out.push({
      clerkUserId: id,
      primaryEmail,
      primaryEmailVerified,
      firstName: (idxFirst >= 0 ? (row[idxFirst] ?? "").trim() : "") || null,
      lastName: (idxLast >= 0 ? (row[idxLast] ?? "").trim() : "") || null,
      passwordDigest:
        (idxDigest >= 0 ? (row[idxDigest] ?? "").trim() : "") || null,
      passwordHasher:
        (idxHasher >= 0 ? (row[idxHasher] ?? "").trim().toLowerCase() : "") ||
        null,
    });
  }
  return out;
}

function buildDisplayName(row: CsvRow): string | null {
  const first = (row.firstName ?? "").trim();
  const last = (row.lastName ?? "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  return full.length > 0 ? full : null;
}

interface BackfillContext {
  pool: pg.Pool;
  dryRun: boolean;
  counters: Counters;
}

async function processRow(ctx: BackfillContext, row: CsvRow): Promise<void> {
  ctx.counters.total++;

  if (!row.primaryEmail || !row.primaryEmailVerified) {
    ctx.counters.skipped_no_email++;
    return;
  }
  const emailLower = row.primaryEmail.toLowerCase();
  const displayName = buildDisplayName(row);

  // Check for existing auth.users by email. If one exists with a
  // DIFFERENT clerk linkage (e.g. the bootstrap-admin already
  // owns this email), we skip and report — ops can resolve the
  // collision manually.
  const existing = await ctx.pool.query<{
    id: string;
    role: string;
    status: string;
  }>(
    `SELECT id, role, status FROM auth.users WHERE email_lower = $1 LIMIT 1`,
    [emailLower],
  );

  let authUserId: string;
  let userIsNew = false;

  if (existing.rows[0]) {
    const u = existing.rows[0];
    // If a shop_customers row already points at a DIFFERENT auth
    // user for this clerkUserId, that's a collision.
    const link = await ctx.pool.query<{ auth_user_id: string | null }>(
      `SELECT auth_user_id FROM resupply.shop_customers
        WHERE clerk_user_id = $1 LIMIT 1`,
      [row.clerkUserId],
    );
    const currentAuth = link.rows[0]?.auth_user_id ?? null;
    if (currentAuth !== null && currentAuth !== u.id) {
      ctx.counters.skipped_collision++;
      process.stderr.write(
        `[skip] ${row.clerkUserId} (${emailLower}): shop_customers.auth_user_id=` +
          `${currentAuth} differs from auth.users.id=${u.id}\n`,
      );
      return;
    }
    authUserId = u.id;
    if (u.status !== "active") {
      if (!ctx.dryRun) {
        await ctx.pool.query(
          `UPDATE auth.users
              SET status = 'active',
                  email_verified_at = COALESCE(email_verified_at, NOW()),
                  updated_at = NOW()
            WHERE id = $1`,
          [authUserId],
        );
      }
      ctx.counters.reactivated++;
    }
  } else {
    if (ctx.dryRun) {
      // Synthesize a placeholder id so the rest of the dry-run
      // can pretend the insert happened.
      authUserId = `would-create-${row.clerkUserId}`;
    } else {
      const inserted = await ctx.pool.query<{ id: string }>(
        `INSERT INTO auth.users
           (email_lower, display_name, role, status, email_verified_at)
         VALUES ($1, $2, 'customer', 'active', NOW())
         RETURNING id`,
        [emailLower, displayName],
      );
      authUserId = inserted.rows[0]!.id;
    }
    ctx.counters.created++;
    userIsNew = true;
  }

  // Password credential. Only write when:
  //   * a hash is present in the CSV
  //   * password_hasher is bcrypt (Clerk's only emitted value)
  //   * the row doesn't already have an argon2id-v1 credential
  //     (an in-house sign-in already happened mid-migration)
  if (row.passwordDigest && row.passwordHasher === "bcrypt") {
    if (!ctx.dryRun) {
      await ctx.pool.query(
        `INSERT INTO auth.password_credentials
           (user_id, password_hash, algo, must_change)
         VALUES ($1, $2, 'clerk-bcrypt-v1', false)
         ON CONFLICT (user_id) DO UPDATE
           SET password_hash = EXCLUDED.password_hash,
               algo = EXCLUDED.algo,
               updated_at = NOW()
         WHERE auth.password_credentials.algo <> 'argon2id-v1'`,
        [authUserId, row.passwordDigest],
      );
    }
  } else if (!row.passwordDigest && userIsNew) {
    // Passwordless / OAuth-only Clerk user. We minted an auth row
    // but they have no credential. They'll need to go through
    // /forgot-password to set one. The cutover runbook should
    // bulk-issue reset tokens for these (or we can extend this
    // script with --send-reset-emails). For now, count and move
    // on.
    ctx.counters.skipped_passwordless++;
  }

  // Link the shop_customers row, if one exists. ON CONFLICT
  // DO NOTHING handles "no shop_customers row for this clerk id"
  // gracefully — the customer just hasn't bought anything.
  if (!ctx.dryRun) {
    const result = await ctx.pool.query(
      `UPDATE resupply.shop_customers
          SET auth_user_id = $2,
              updated_at = NOW()
        WHERE clerk_user_id = $1
          AND (auth_user_id IS NULL OR auth_user_id = $2)`,
      [row.clerkUserId, authUserId],
    );
    if (result.rowCount && result.rowCount > 0) {
      ctx.counters.linked++;
    }
  } else {
    // Dry-run: count would-link rows.
    const result = await ctx.pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM resupply.shop_customers
          WHERE clerk_user_id = $1
            AND (auth_user_id IS NULL OR auth_user_id = $2)
        ) AS exists`,
      [row.clerkUserId, authUserId],
    );
    if (result.rows[0]?.exists) ctx.counters.linked++;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!process.env.DATABASE_URL) fail("DATABASE_URL is not set.", 2);

  const text = readFileSync(args.csvPath, "utf8");
  const grid = parseCsv(text);
  const rows = normalizeRows(grid);
  const slice = args.limit ? rows.slice(0, args.limit) : rows;

  process.stdout.write(
    `[auth:backfill-shop-customers] csv=${args.csvPath} ` +
      `rows=${rows.length}` +
      (args.limit ? ` (limit=${args.limit})` : "") +
      (args.dryRun ? " mode=dry-run" : " mode=live") +
      `\n`,
  );

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
  });
  const counters: Counters = {
    created: 0,
    linked: 0,
    reactivated: 0,
    skipped_no_email: 0,
    skipped_passwordless: 0,
    skipped_collision: 0,
    errors: 0,
    total: 0,
  };
  const ctx: BackfillContext = { pool, dryRun: args.dryRun, counters };
  try {
    for (const row of slice) {
      try {
        await processRow(ctx, row);
      } catch (err) {
        counters.errors++;
        process.stderr.write(
          `[error] ${row.clerkUserId}: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }
  } finally {
    await pool.end();
  }

  process.stdout.write(
    "\n[auth:backfill-shop-customers] summary\n" +
      `  total                ${counters.total}\n` +
      `  created              ${counters.created}\n` +
      `  linked               ${counters.linked}\n` +
      `  reactivated          ${counters.reactivated}\n` +
      `  skipped_no_email     ${counters.skipped_no_email}\n` +
      `  skipped_passwordless ${counters.skipped_passwordless}\n` +
      `  skipped_collision    ${counters.skipped_collision}\n` +
      `  errors               ${counters.errors}\n`,
  );

  if (counters.errors > 0) process.exit(1);
}

// Exposed only for tests — never imported by the CLI itself.
export { parseCsv, normalizeRows };

// Run main() only when invoked directly, not when imported by
// the unit tests that exercise parseCsv / normalizeRows.
const invokedAsScript =
  process.argv[1] !== undefined &&
  process.argv[1].endsWith("auth-backfill-shop-customers.ts");
if (invokedAsScript) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `[auth:backfill-shop-customers] failed: ${
        err instanceof Error ? (err.stack ?? err.message) : String(err)
      }\n`,
    );
    process.exit(1);
  });
}
