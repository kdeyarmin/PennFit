// preflight:prod — production environment readiness check.
//
// Read-only validator that runs against the current `process.env` and
// reports whether the environment is safe to launch as production.
// Designed to be run from inside the deploy target (Replit Secrets
// already loaded into the process) or locally against a dotenv file
// via Node's native --env-file flag, e.g.
//
//   node --env-file=.env.production --import=tsx scripts/src/preflight-prod-env.ts
//   pnpm --filter @workspace/scripts preflight:prod
//
// What it covers (and what it does NOT):
//   * Presence + shape of every var the resupply-api refuses to boot
//     without (mirrors artifacts/resupply-api/src/lib/env-check.ts).
//   * Strict base64 (regex + round-trip) for the two HMAC keys —
//     mirrors lib/resupply-audit so preflight can't pass values
//     that boot-time validation would reject.
//   * Production-only sanity for the vendor keys called out in
//     docs/runbooks/production-launch.md — sk_live_ vs sk_test_,
//     https vs http://localhost on every public URL, @example.* on
//     every *_EMAIL variable.
//   * Feature-flag posture (RESUPPLY_FITTER_REENGAGE_ENABLED=1).
//   * Stale secrets that the codebase no longer reads (Task #38's
//     AUTH_PASSWORD_PEPPER, migration 0025's RESUPPLY_MASTER_KEY
//     family). Stale values are silently ignored at runtime; flag
//     them here so the operator can prune the secret store.
//   * Common name-confusion: STRIPE_WEBHOOK_SECRET (the
//     display-only legacy alias) set while STRIPE_WEBHOOK_SIGNING_SECRET
//     (the runtime-consumed canonical name) is unset.
//
// What it does NOT do:
//   * Hit Postgres, Supabase, Stripe, SendGrid, or Twilio. A
//     credential that's correctly shaped but revoked still passes.
//     The /admin/operations dashboard tile + the post-deploy smoke
//     tests in docs/PRODUCTION_READINESS.md catch live-wire failures.
//   * Validate the migration history. The migrator itself enforces
//     ordering; this script only checks DATABASE_URL is set.
//
// Exit codes:
//   0 — every required check passed (warnings allowed).
//   1 — at least one required check failed.
//   2 — internal error (the checker itself crashed).

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

const useColor = process.stdout.isTTY === true && !process.env.NO_COLOR;
const paint = (color: string, text: string): string =>
  useColor ? `${color}${text}${RESET}` : text;

type Severity = "pass" | "warn" | "fail";

interface CheckResult {
  name: string;
  severity: Severity;
  detail: string;
}

const results: CheckResult[] = [];

/**
 * Appends a check result entry to the module-level results list.
 *
 * @param name - Short identifier for the check
 * @param severity - Outcome severity: `"pass"`, `"warn"`, or `"fail"`
 * @param detail - Human-readable message or context to display in the report
 */
function record(name: string, severity: Severity, detail: string): void {
  results.push({ name, severity, detail });
}

/**
 * Reads an environment variable by name and returns its trimmed value or nothing.
 *
 * @param name - The environment variable name to read from `process.env`
 * @returns The trimmed variable value, or `undefined` if the variable is unset or becomes empty after trimming
 */
function getTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Checks that the environment variable named `name` is present and records a pass or fail result.
 *
 * Treats an empty string as unset; records a `"fail"` (detail: `"unset or empty"`) when missing or empty,
 * and records a `"pass"` (detail: `"set"`) when a non-empty value exists.
 *
 * @param name - The name of the environment variable to check
 */

function requirePresent(name: string): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
  } else {
    record(name, "pass", "set");
  }
}

/**
 * Validate that the environment variable named by `name` begins with `prefix` and record the check result.
 *
 * Records a `"fail"` if the variable is unset/empty or if its value does not start with `prefix`; records a `"pass"` with a short detail when it does.
 *
 * @param name - The environment variable name to validate
 * @param prefix - The required starting substring for the variable's value
 */
function requirePrefix(name: string, prefix: string): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
    return;
  }
  if (!value.startsWith(prefix)) {
    // Detail intentionally omits any portion of the actual value:
    // this tool runs in deploy environments where stdout may be
    // captured to logs and the var may carry a partial secret.
    record(name, "fail", `does not start with "${prefix}"`);
    return;
  }
  record(name, "pass", `starts with "${prefix}"`);
}

/**
 * Validates that the environment variable named `name` contains a valid HTTPS URL (and optionally disallows localhost) and records a pass or fail result.
 *
 * @param name - The environment variable name to validate
 * @param forbidLocalhost - If `true`, values with hostnames `localhost` or `127.0.0.1` are treated as failures
 *
 * On success, records a `"pass"` with the URL origin; on failure, records a `"fail"` with a concise reason.
 */
function requireHttpsUrl(name: string, forbidLocalhost: boolean): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    record(name, "fail", `not a valid URL: "${value}"`);
    return;
  }
  if (parsed.protocol !== "https:") {
    record(name, "fail", `must be https:// (got ${parsed.protocol}//)`);
    return;
  }
  if (forbidLocalhost && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")) {
    record(name, "fail", `must not point at localhost (got ${parsed.hostname})`);
    return;
  }
  record(name, "pass", parsed.origin);
}

// Base64-decoded byte length. Used for the two HMAC keys, both of which
// pass through `openssl rand -base64 48` → ~36 characters of base64 →
// 32 raw bytes. The audit module rejects anything shorter than 32 at
// boot; mirror that here.
/**
 * Validates that an environment variable contains valid base64 that decodes to at least a given number of bytes.
 *
 * Records a `"fail"` check if the variable is unset/empty, is not valid base64, or decodes to fewer than `minBytes` bytes; records a `"pass"` with the decoded byte count when the requirement is met.
 *
 * @param name - The environment variable name to check
 * @param minBytes - Minimum required decoded byte length
 */
function requireBase64Bytes(name: string, minBytes: number): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
    return;
  }
  // Mirror lib/resupply-audit/src/sign.ts's two-step validation:
  // (1) strict regex — Buffer.from(value, "base64") silently drops
  //     any char outside the base64 alphabet, so a URL-safe (-/_)
  //     string or a 64-char hex string would decode to >= 32 bytes
  //     without warning. The boot-time audit key check rejects
  //     those, so preflight has to reject them too — otherwise a
  //     preflight-passes-but-boot-fails false-ready gate.
  // (2) round-trip equality — catches values whose length AND alphabet
  //     pass but which contain padding that doesn't decode to a clean
  //     byte boundary.
  if (!/^[A-Za-z0-9+/]+=*$/.test(value)) {
    record(
      name,
      "fail",
      "not strict base64 (only A-Z, a-z, 0-9, +, /, = padding allowed)",
    );
    return;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    record(name, "fail", "did not round-trip through base64 decode/encode");
    return;
  }
  if (decoded.length < minBytes) {
    record(name, "fail", `decodes to ${decoded.length} bytes (need >= ${minBytes})`);
    return;
  }
  record(name, "pass", `${decoded.length} bytes (base64)`);
}

/**
 * Verify that an environment variable equals a specific expected value and record the check result.
 *
 * Records a pass when the variable is present and exactly equals `expected`; otherwise records the provided
 * `severity` with a message indicating the variable is missing/empty or showing the expected vs. actual value.
 *
 * @param name - Environment variable name to validate
 * @param expected - Exact string value required for the variable
 * @param severity - Severity to record when the variable is missing or does not match; defaults to `"fail"`
 */
function expectExactly(name: string, expected: string, severity: Severity = "fail"): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, severity, `unset or empty (expected "${expected}")`);
    return;
  }
  if (value !== expected) {
    record(name, severity, `expected "${expected}" (got "${value}")`);
    return;
  }
  record(name, "pass", `= "${expected}"`);
}

/**
 * Records a warning if the named environment variable is set.
 *
 * When the environment variable contains a non-empty value, a `warn` check result
 * is recorded using the provided reason.
 *
 * @param name - The environment variable name to check
 * @param reason - Explanation to attach to the warning when the variable is set
 */
function warnIfSet(name: string, reason: string): void {
  const value = getTrimmed(name);
  if (value !== undefined) {
    record(name, "warn", reason);
  }
}

/**
 * Validates an environment variable contains a comma-separated list with at least one non-empty entry and records the check result.
 *
 * @param name - The environment variable name expected to hold a comma-separated list; records a `"fail"` if unset/empty or if all entries are empty, otherwise records a `"pass"` with the number of entries.
 */
function requireNonEmptyList(
  name: string,
  options: { absentSeverity?: Severity; absentDetail?: string } = {},
): void {
  const value = getTrimmed(name);
  const absentSeverity = options.absentSeverity ?? "fail";
  const absentDetail = options.absentDetail ?? "must contain at least one entry";
  if (value === undefined) {
    record(name, absentSeverity, absentDetail);
    return;
  }
  const entries = value.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) {
    record(name, absentSeverity, absentDetail);
    return;
  }
  record(name, "pass", `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

// Forbids known placeholder values that ship in .env.example. Matching
// these in production means the operator copied the example file but
/**
 * Detects whether an environment variable contains a known placeholder value and records a failure if so.
 *
 * If the environment variable's trimmed value exactly equals any provided placeholder or contains
 * the substring `"replace_me"`, a `"fail"` check is recorded for `name`.
 *
 * @param name - The environment variable name to inspect
 * @param placeholders - Known placeholder values to compare against
 * @returns `true` if the value matched a placeholder and a `"fail"` check was recorded, `false` otherwise
 */
function refusePlaceholder(name: string, ...placeholders: string[]): boolean {
  const value = getTrimmed(name);
  if (value === undefined) return false;
  for (const placeholder of placeholders) {
    if (value === placeholder || value.includes("replace_me")) {
      // Detail intentionally omits the value: some vars in this
      // family are secrets (service-role JWTs, signing keys) and
      // even the first 40 chars can be enough to identify or
      // partially leak them when this stdout is captured to logs.
      record(name, "fail", "looks like a .env.example placeholder");
      return true;
    }
  }
  return false;
}

/**
 * Performs a suite of environment-variable validations to assess production readiness.
 *
 * Runs a fixed sequence of checks (boot-required vars, admin allowlist, production-specific
 * posture for third-party credentials and public URLs, feature-flag posture, stale-secret
 * warnings, and placeholder-leak detection) and records each outcome as a `CheckResult`
 * appended to the module-level `results` array with severity `pass | warn | fail`.
 *
 * This function does not return a value; callers should inspect `results` (or call
 * `report()`) to determine overall status and exit codes.
 */

function runChecks(): void {
  // 1. Boot-required vars — mirrors env-check.ts in resupply-api.
  requirePresent("PORT");

  if (!refusePlaceholder("DATABASE_URL", "postgres://user:password@localhost:5432/pennpaps")) {
    const url = getTrimmed("DATABASE_URL");
    if (url && !url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
      record("DATABASE_URL", "fail", `must start with postgres:// or postgresql://`);
    } else if (url) {
      record("DATABASE_URL", "pass", "set");
    } else {
      record("DATABASE_URL", "fail", "unset or empty");
    }
  }

  if (!refusePlaceholder("SUPABASE_URL", "https://YOUR-PROJECT.supabase.co")) {
    requireHttpsUrl("SUPABASE_URL", /* forbidLocalhost */ false);
  }
  if (!refusePlaceholder("SUPABASE_SERVICE_ROLE_KEY", "replace_me_with_service_role_key")) {
    requirePresent("SUPABASE_SERVICE_ROLE_KEY");
  }

  if (!refusePlaceholder("RESUPPLY_LINK_HMAC_KEY", "replace_me_with_32_byte_secret")) {
    requireBase64Bytes("RESUPPLY_LINK_HMAC_KEY", 32);
  }
  if (!refusePlaceholder("RESUPPLY_AUDIT_HMAC_KEY", "replace_me_with_32_byte_secret")) {
    requireBase64Bytes("RESUPPLY_AUDIT_HMAC_KEY", 32);
  }

  // 2. Admin allowlist — WARN, not FAIL.
  //    The runtime admin gate (middlewares/requireAdmin.ts:21)
  //    consults `auth.users.role` only — there is no env-var
  //    allowlist anymore. The variable is still read by
  //    routes/admin/system-info.ts to populate the
  //    `adminAllowlistCount` display tile on /admin/operations,
  //    so leaving it empty in production is operator-noticeable
  //    but not auth-breaking. Bootstrap via
  //    `pnpm --filter @workspace/scripts auth:bootstrap-admin`
  //    is what actually creates the first admin row.
  requireNonEmptyList("RESUPPLY_ADMIN_EMAILS", {
    absentSeverity: "warn",
    absentDetail:
      "empty — admin auth comes from DB roles (requireAdmin) now; " +
      "this var is only read by /admin/operations for the allowlist " +
      "count tile. Bootstrap admins via auth:bootstrap-admin instead.",
  });

  // 3. Production posture — only matters when NODE_ENV=production.
  //    All other checks above apply equally to staging.
  const nodeEnv = getTrimmed("NODE_ENV") ?? "development";
  if (nodeEnv !== "production") {
    record(
      "NODE_ENV",
      "warn",
      `is "${nodeEnv}" — production-only checks below are advisory in this run`,
    );
  } else {
    record("NODE_ENV", "pass", `= "production"`);
  }
  const prodMode = nodeEnv === "production";
  const prodSeverity: Severity = prodMode ? "fail" : "warn";

  // Stripe — sk_live_ in prod, never the test or placeholder key.
  if (!refusePlaceholder("STRIPE_SECRET_KEY", "sk_test_replace_me")) {
    const sk = getTrimmed("STRIPE_SECRET_KEY");
    if (sk === undefined) {
      record("STRIPE_SECRET_KEY", prodSeverity, "unset (Stripe checkout will be disabled)");
    } else if (prodMode && !sk.startsWith("sk_live_")) {
      // Distinguish the common-mistake case ("sk_test_ in production")
      // from the unexpected-shape case without leaking the actual key.
      const reason = sk.startsWith("sk_test_")
        ? "must be a live key (sk_live_…), got a test key (sk_test_…)"
        : "must be a live key (sk_live_…)";
      record("STRIPE_SECRET_KEY", "fail", reason);
    } else if (sk.startsWith("sk_live_")) {
      record("STRIPE_SECRET_KEY", "pass", "starts with sk_live_");
    } else if (sk.startsWith("sk_test_")) {
      record("STRIPE_SECRET_KEY", "pass", "starts with sk_test_");
    } else {
      record("STRIPE_SECRET_KEY", prodSeverity, "unexpected key shape");
    }
  }

  if (!refusePlaceholder("STRIPE_WEBHOOK_SIGNING_SECRET", "whsec_replace_me")) {
    const w = getTrimmed("STRIPE_WEBHOOK_SIGNING_SECRET");
    if (w === undefined) {
      record(
        "STRIPE_WEBHOOK_SIGNING_SECRET",
        prodSeverity,
        "unset (Stripe webhook verification will fail closed)",
      );
    } else {
      requirePrefix("STRIPE_WEBHOOK_SIGNING_SECRET", "whsec_");
    }
  }

  // SendGrid — must look like a real SG key, not the example placeholder.
  if (!refusePlaceholder("SENDGRID_API_KEY", "SG.replace_me")) {
    const sg = getTrimmed("SENDGRID_API_KEY");
    if (sg === undefined) {
      record(
        "SENDGRID_API_KEY",
        prodSeverity,
        "unset (no outbound email will be sent)",
      );
    } else if (!sg.startsWith("SG.")) {
      record("SENDGRID_API_KEY", "fail", `does not start with "SG."`);
    } else {
      record("SENDGRID_API_KEY", "pass", "starts with SG.");
    }
  }

  // CLAUDE.md "One From address" invariant: SENDGRID_FROM_EMAIL must
  // be info@pennpaps.com in production.
  if (prodMode) {
    expectExactly("SENDGRID_FROM_EMAIL", "info@pennpaps.com");
  } else {
    const from = getTrimmed("SENDGRID_FROM_EMAIL");
    if (from === undefined) {
      record("SENDGRID_FROM_EMAIL", "warn", "unset (defaults break the One-From invariant)");
    } else {
      record("SENDGRID_FROM_EMAIL", "pass", from);
    }
  }

  // Twilio — auth token must not be the placeholder; account SID
  // must look like one if set.
  if (!refusePlaceholder("TWILIO_AUTH_TOKEN", "replace_me")) {
    const t = getTrimmed("TWILIO_AUTH_TOKEN");
    if (t === undefined) {
      record(
        "TWILIO_AUTH_TOKEN",
        prodSeverity,
        "unset (no outbound SMS or voice will be sent)",
      );
    } else {
      record("TWILIO_AUTH_TOKEN", "pass", "set");
    }
  }
  const tsid = getTrimmed("TWILIO_ACCOUNT_SID");
  if (tsid !== undefined && !tsid.startsWith("AC")) {
    record("TWILIO_ACCOUNT_SID", "fail", `must start with "AC"`);
  } else if (tsid === "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx") {
    record("TWILIO_ACCOUNT_SID", "fail", "is the .env.example placeholder");
  } else if (tsid === undefined && prodMode) {
    record("TWILIO_ACCOUNT_SID", "warn", "unset (no SMS/voice)");
  } else if (tsid !== undefined) {
    record("TWILIO_ACCOUNT_SID", "pass", "set");
  }
  // SMS needs at least one of these two — otherwise the SMS adapter
  // refuses to send.
  const tmsid = getTrimmed("TWILIO_MESSAGING_SERVICE_SID");
  const tnum = getTrimmed("TWILIO_PHONE_NUMBER");
  if (prodMode && tsid !== undefined && tmsid === undefined && tnum === undefined) {
    record(
      "TWILIO_MESSAGING_SERVICE_SID / TWILIO_PHONE_NUMBER",
      "fail",
      "at least one is required when TWILIO_ACCOUNT_SID is set",
    );
  } else if (tmsid !== undefined || tnum !== undefined) {
    record(
      "TWILIO_MESSAGING_SERVICE_SID / TWILIO_PHONE_NUMBER",
      "pass",
      tmsid !== undefined ? "messaging service set" : "phone number set",
    );
  }

  // Public URLs — every customer-facing URL must be HTTPS and not
  // localhost in production.
  const publicUrls = [
    "SHOP_PUBLIC_BASE_URL",
    "REMINDER_PUBLIC_BASE_URL",
    "RESUPPLY_VOICE_PUBLIC_BASE_URL",
    "RESUPPLY_DASHBOARD_PUBLIC_BASE_URL",
    "PENN_ADMIN_PUBLIC_BASE_URL",
  ] as const;
  for (const name of publicUrls) {
    const value = getTrimmed(name);
    if (value === undefined) {
      record(name, prodSeverity, "unset");
      continue;
    }
    if (prodMode) {
      requireHttpsUrl(name, /* forbidLocalhost */ true);
    } else {
      record(name, "pass", value);
    }
  }

  // 4. Feature flag posture.
  const reengage = getTrimmed("RESUPPLY_FITTER_REENGAGE_ENABLED");
  if (reengage === "1") {
    record("RESUPPLY_FITTER_REENGAGE_ENABLED", "pass", "= 1 (worker registered)");
  } else if (prodMode) {
    record(
      "RESUPPLY_FITTER_REENGAGE_ENABLED",
      "warn",
      `is "${reengage ?? "(unset)"}" — abandoned-fitter nudges OFF`,
    );
  } else {
    record(
      "RESUPPLY_FITTER_REENGAGE_ENABLED",
      "pass",
      `= "${reengage ?? "(unset)"}" (intentionally OFF outside production)`,
    );
  }

  // 5. Stale secrets — silently ignored at runtime; flag so the
  //    operator can prune the secret store.
  warnIfSet(
    "AUTH_PASSWORD_PEPPER",
    "Task #38 removed the server-side pepper — value is ignored. Delete from secret store.",
  );
  warnIfSet(
    "RESUPPLY_MASTER_KEY",
    "Migration 0025 stripped pgcrypto encryption — value is ignored. Delete from secret store.",
  );
  warnIfSet(
    "RESUPPLY_DATA_KEY",
    "Migration 0025 stripped pgcrypto encryption — value is ignored. Delete from secret store.",
  );
  warnIfSet(
    "RESUPPLY_PHONE_HMAC_KEY",
    "Migration 0025 dropped phone_lookup — value is ignored. Delete from secret store.",
  );

  // 6. Lingering .env.example placeholders for the optional / lower-
  //    severity vars that aren't covered by the required-at-boot
  //    checks above. Optional vars that are unset don't fail —
  //    those are intentional graceful-degrade paths — but a value
  //    that matches the example placeholder verbatim is a copy-
  //    paste oversight worth flagging.
  refusePlaceholder("OPENAI_API_KEY", "sk-replace_me");
  refusePlaceholder("TWILIO_PHONE_NUMBER", "+15555550123");
  refusePlaceholder("PENN_FULFILLMENT_EMAIL", "fulfillment@example.com");
  refusePlaceholder("VITE_RESUPPLY_CONTACT_EMAIL", "support@example.com");

  // Belt-and-braces: any email-shaped env var landing on @example.com
  // in production is a placeholder leak even if it isn't one of the
  // four named above. Scan every var whose name ends in _EMAIL.
  // Skip names that already have a result so we don't double-flag
  // the cases the explicit `refusePlaceholder` above already caught.
  const alreadyReported = new Set(results.map((r) => r.name));
  for (const name of Object.keys(process.env)) {
    if (!name.endsWith("_EMAIL")) continue;
    if (alreadyReported.has(name)) continue;
    const value = getTrimmed(name);
    if (value === undefined) continue;
    if (/@example\.(com|org|net)$/i.test(value)) {
      record(name, "fail", `points at @example.* (placeholder domain): "${value}"`);
    }
  }

  // 7. Common name-confusion / legacy aliases.
  //
  // STRIPE_WEBHOOK_SECRET vs STRIPE_WEBHOOK_SIGNING_SECRET: an older
  // `admin/system-integrations-status` field reads `STRIPE_WEBHOOK_SECRET`
  // for a display tile, but the actual webhook handler in
  // `artifacts/resupply-api/src/lib/stripe/config.ts:66` reads
  // `STRIPE_WEBHOOK_SIGNING_SECRET`. An operator who mistakes the
  // display name for the production name silently breaks webhook
  // verification on the first event. Flag the mismatch loudly.
  const legacyStripeWebhook = getTrimmed("STRIPE_WEBHOOK_SECRET");
  const realStripeWebhook = getTrimmed("STRIPE_WEBHOOK_SIGNING_SECRET");
  if (legacyStripeWebhook !== undefined && realStripeWebhook === undefined) {
    record(
      "STRIPE_WEBHOOK_SECRET",
      "fail",
      "set but STRIPE_WEBHOOK_SIGNING_SECRET (the canonical name) is unset — " +
        "the webhook handler reads only the latter. Rename the env var.",
    );
  } else if (legacyStripeWebhook !== undefined && realStripeWebhook !== undefined) {
    record(
      "STRIPE_WEBHOOK_SECRET",
      "warn",
      "set alongside STRIPE_WEBHOOK_SIGNING_SECRET — only the latter is " +
        "consulted by the webhook handler. The legacy name can be deleted.",
    );
  }
}

/**
 * Map a severity value to its corresponding colored uppercase label.
 *
 * @param severity - The severity to convert into a label
 * @returns The uppercase label `PASS`, `WARN`, or `FAIL`, wrapped in ANSI color codes when color output is enabled
 */

function symbolFor(severity: Severity): string {
  switch (severity) {
    case "pass":
      return paint(GREEN, "PASS");
    case "warn":
      return paint(YELLOW, "WARN");
    case "fail":
      return paint(RED, "FAIL");
  }
}

/**
 * Prints a formatted preflight report of recorded checks to stdout and indicates launch readiness.
 *
 * Writes each check entry and a summary count of pass/warn/fail to stdout, and emits a final
 * readiness message describing whether launch is safe, allowed with warnings, or blocked.
 *
 * @returns `1` if any recorded check has severity `fail`, `0` otherwise.
 */
function report(): number {
  const failed = results.filter((r) => r.severity === "fail");
  const warned = results.filter((r) => r.severity === "warn");
  const passed = results.filter((r) => r.severity === "pass");

  process.stdout.write(`\npreflight:prod — production env readiness\n`);
  process.stdout.write(`${paint(DIM, "─".repeat(48))}\n`);
  for (const r of results) {
    process.stdout.write(`  ${symbolFor(r.severity)}  ${r.name}\n        ${paint(DIM, r.detail)}\n`);
  }
  process.stdout.write(`${paint(DIM, "─".repeat(48))}\n`);
  process.stdout.write(
    `  ${paint(GREEN, `${passed.length} pass`)}, ${paint(YELLOW, `${warned.length} warn`)}, ${paint(RED, `${failed.length} fail`)}\n\n`,
  );

  if (failed.length > 0) {
    process.stdout.write(
      `${paint(RED, "Not safe to launch.")} Fix the FAIL lines above and re-run.\n`,
    );
    return 1;
  }
  if (warned.length > 0) {
    process.stdout.write(
      `${paint(YELLOW, "Launch-eligible with warnings.")} Review each WARN line and confirm intent.\n`,
    );
  } else {
    process.stdout.write(`${paint(GREEN, "Ready for launch.")}\n`);
  }
  return 0;
}

try {
  runChecks();
  process.exit(report());
} catch (err) {
  process.stderr.write(
    `[preflight:prod] internal error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(2);
}
