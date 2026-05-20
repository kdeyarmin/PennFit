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
//   * Production-only sanity for the vendor keys called out in
//     docs/runbooks/production-launch.md — sk_live_ vs sk_test_,
//     https vs http://localhost, real domains vs example.com.
//   * Feature-flag posture (RESUPPLY_FITTER_REENGAGE_ENABLED=1).
//   * Stale secrets that the codebase no longer reads (Task #38's
//     AUTH_PASSWORD_PEPPER, migration 0025's RESUPPLY_MASTER_KEY
//     family). Stale values are silently ignored at runtime; flag
//     them here so the operator can prune the secret store.
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

function record(name: string, severity: Severity, detail: string): void {
  results.push({ name, severity, detail });
}

function getTrimmed(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

// Helpers ---------------------------------------------------------------

function requirePresent(name: string): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
  } else {
    record(name, "pass", "set");
  }
}

function requirePrefix(name: string, prefix: string): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
    return;
  }
  if (!value.startsWith(prefix)) {
    record(name, "fail", `does not start with "${prefix}" (got "${value.slice(0, prefix.length)}…")`);
    return;
  }
  record(name, "pass", `starts with "${prefix}"`);
}

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
function requireBase64Bytes(name: string, minBytes: number): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "unset or empty");
    return;
  }
  let decodedLen: number;
  try {
    decodedLen = Buffer.from(value, "base64").length;
  } catch {
    record(name, "fail", "not valid base64");
    return;
  }
  if (decodedLen < minBytes) {
    record(name, "fail", `decodes to ${decodedLen} bytes (need >= ${minBytes})`);
    return;
  }
  record(name, "pass", `${decodedLen} bytes (base64)`);
}

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

function warnIfSet(name: string, reason: string): void {
  const value = getTrimmed(name);
  if (value !== undefined) {
    record(name, "warn", reason);
  }
}

function requireNonEmptyList(name: string): void {
  const value = getTrimmed(name);
  if (value === undefined) {
    record(name, "fail", "must contain at least one entry");
    return;
  }
  const entries = value.split(",").map((e) => e.trim()).filter(Boolean);
  if (entries.length === 0) {
    record(name, "fail", "must contain at least one entry");
    return;
  }
  record(name, "pass", `${entries.length} entr${entries.length === 1 ? "y" : "ies"}`);
}

// Forbids known placeholder values that ship in .env.example. Matching
// these in production means the operator copied the example file but
// never filled in the real value.
function refusePlaceholder(name: string, ...placeholders: string[]): boolean {
  const value = getTrimmed(name);
  if (value === undefined) return false;
  for (const placeholder of placeholders) {
    if (value === placeholder || value.includes("replace_me")) {
      record(name, "fail", `looks like a .env.example placeholder ("${value.slice(0, 40)}")`);
      return true;
    }
  }
  return false;
}

// Checks ---------------------------------------------------------------

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

  // 2. Admin allowlist — requireAdmin 503s on empty in production.
  requireNonEmptyList("RESUPPLY_ADMIN_EMAILS");

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
      record(
        "STRIPE_SECRET_KEY",
        "fail",
        `must be a live key (sk_live_…), got prefix "${sk.slice(0, 8)}"`,
      );
    } else if (sk.startsWith("sk_live_") || sk.startsWith("sk_test_")) {
      record("STRIPE_SECRET_KEY", "pass", `prefix "${sk.slice(0, 8)}"`);
    } else {
      record("STRIPE_SECRET_KEY", prodSeverity, `unexpected key shape ("${sk.slice(0, 8)}…")`);
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
      record("SENDGRID_API_KEY", "fail", `does not start with "SG." (got "${sg.slice(0, 4)}…")`);
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
    record("TWILIO_ACCOUNT_SID", "fail", `must start with "AC" (got "${tsid.slice(0, 4)}…")`);
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
}

// Report ---------------------------------------------------------------

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
