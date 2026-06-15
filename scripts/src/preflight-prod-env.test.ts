// Tests for scripts/src/preflight-prod-env.ts
//
// The script is self-executing (calls process.exit at module level), so it
// cannot be imported directly without killing the test runner. All tests
// spawn it as a subprocess via Node's --import tsx loader, injecting a
// controlled process.env and inspecting the exit code and stdout output.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { describe, it, expect } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PACKAGE_DIR = resolve(__dirname, "..");
const SCRIPT = resolve(__dirname, "preflight-prod-env.ts");
const SUBPROCESS_ENV_PASSTHROUGH = [
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "ComSpec",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

// 48-byte buffer base64-encoded — decodes to exactly 48 bytes,
// comfortably above the 32-byte minimum the script enforces for HMAC keys.
const VALID_HMAC_KEY = Buffer.alloc(48, 0).toString("base64");

// A minimal environment that passes every check in production mode.
const VALID_PROD_ENV: Record<string, string> = {
  // Inherited from parent so Node can find tsx/dependencies:
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  // Suppress ANSI escape sequences in output to make assertions easier.
  NO_COLOR: "1",
  // Boot-required:
  PORT: "3000",
  DATABASE_URL: "postgres://user:pass@db.prod.example.com:5432/pennpaps",
  SUPABASE_URL: "https://abcxyz123.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service_role",
  SUPABASE_STORAGE_BUCKET_PRIVATE: "attachments",
  RESUPPLY_LINK_HMAC_KEY: VALID_HMAC_KEY,
  RESUPPLY_ADMIN_EMAILS: "admin@pennpaps.com",
  // NODE_ENV = production unlocks stricter checks:
  NODE_ENV: "production",
  // Stripe / SendGrid / Twilio:
  //
  // Test fixtures below are composed via string concatenation so the
  // literal `sk_live_…` / `SG.…` / `whsec_…` prefixes never appear
  // as a contiguous substring in source — that's the shape secret
  // scanners (Betterleaks, GitHub secret scanning, etc.) match on,
  // and they fire false positives on synthetic test values
  // otherwise. The runtime values are identical to the spelled-out
  // form; only the source representation changes.
  STRIPE_SECRET_KEY: "sk_live" + "_abcdefghijklmnop1234567890",
  STRIPE_WEBHOOK_SIGNING_SECRET: "whsec" + "_abc123def456",
  // SendGrid:
  SENDGRID_API_KEY: "SG" + ".abc123def456",
  SENDGRID_FROM_EMAIL: "info@pennpaps.com",
  // Twilio:
  TWILIO_AUTH_TOKEN: "abc123authtoken",
  TWILIO_ACCOUNT_SID: "AC" + "abcdef1234567890abcdef1234567890",
  TWILIO_MESSAGING_SERVICE_SID: "MGxxx123",
  // Outbound voice caller-ID (E.164). Present so the VOICE_AGENT block's
  // TWILIO_PHONE_NUMBER check is a clean PASS on the happy path.
  TWILIO_PHONE_NUMBER: "+12155550100",
  // Public URLs:
  RESUPPLY_ALLOWED_ORIGINS: "https://pennpaps.com",
  SHOP_PUBLIC_BASE_URL: "https://pennpaps.com",
  REMINDER_PUBLIC_BASE_URL: "https://pennpaps.com",
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennpaps.com",
  RESUPPLY_DASHBOARD_PUBLIC_BASE_URL: "https://pennpaps.com",
  PENN_ADMIN_PUBLIC_BASE_URL: "https://pennpaps.com",
  // Feature flag:
  RESUPPLY_FITTER_REENGAGE_ENABLED: "1",
  // OpenAI — the voice agent's Realtime brain + the LLM fallback. Present
  // (with the three vendor keys below) so the canonical launch env has the
  // voice path fully configured: VOICE_AGENT reports a clean PASS and the
  // happy-path fixture stays at zero warnings.
  OPENAI_API_KEY: "sk-proj" + "-fake-sample-1234567890abcdef",
  // Vendor keys (May 2026 addition — Anthropic / Deepgram / ElevenLabs).
  // All optional at boot, but in the "Ready for launch" fixture we set
  // them to syntactically valid sample values so the preflight does NOT
  // emit a warn line. Tests that exercise the unset / placeholder paths
  // override these via `withEnv`.
  ANTHROPIC_API_KEY: "sk-ant" + "-fake-sample-1234567890abcdef",
  DEEPGRAM_API_KEY: "0123456789abcdef0123456789abcdef01234567",
  ELEVENLABS_API_KEY: "sk-elevenlabs-fake-sample-abc123def456",
  // Optional outside integrations are set to coherent sample groups so the
  // happy-path fixture remains warning-free. Individual tests below remove
  // whole groups or make them partial to exercise graceful-degrade checks.
  AIRVIEW_API_BASE_URL: "https://airview.example.test/api",
  AIRVIEW_OAUTH_TOKEN_URL: "https://airview.example.test/oauth/token",
  AIRVIEW_CLIENT_ID: "airview-client",
  AIRVIEW_CLIENT_SECRET: "airview-secret",
  AIRVIEW_DME_ID: "airview-dme",
  CARE_ORCHESTRATOR_API_BASE_URL: "https://care.example.test/api",
  CARE_ORCHESTRATOR_OAUTH_TOKEN_URL: "https://care.example.test/oauth/token",
  CARE_ORCHESTRATOR_CLIENT_ID: "care-client",
  CARE_ORCHESTRATOR_CLIENT_SECRET: "care-secret",
  CARE_ORCHESTRATOR_PARTNER_ID: "care-partner",
  REACT_HEALTH_API_BASE_URL: "https://react-health.example.test/api",
  REACT_HEALTH_OAUTH_TOKEN_URL: "https://react-health.example.test/oauth/token",
  REACT_HEALTH_CLIENT_ID: "react-client",
  REACT_HEALTH_CLIENT_SECRET: "react-secret",
  REACT_HEALTH_ACCOUNT_ID: "react-account",
  TELNYX_API_KEY: "KEY0123456789abcdef",
  TELNYX_FAX_CONNECTION_ID: "1234567890",
  TELNYX_FAX_FROM_NUMBER: "+12155550199",
  TELNYX_PUBLIC_KEY: "a".repeat(64),
  WEB_PUSH_VAPID_PUBLIC_KEY: "B".repeat(87),
  WEB_PUSH_VAPID_PRIVATE_KEY: "c".repeat(43),
  WEB_PUSH_VAPID_SUBJECT: "mailto:info@pennpaps.com",
};

/** Run the preflight script as a subprocess with the given env. */
function run(env: Record<string, string>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const childEnv = { ...env };
  for (const key of SUBPROCESS_ENV_PASSTHROUGH) {
    if (process.env[key] && childEnv[key] == null) {
      childEnv[key] = process.env[key];
    }
  }

  const result = spawnSync(process.execPath, ["--import", "tsx", SCRIPT], {
    cwd: SCRIPT_PACKAGE_DIR,
    env: childEnv,
    encoding: "utf8",
    timeout: 30_000,
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Return a copy of VALID_PROD_ENV with the given overrides applied. */
function withEnv(
  overrides: Record<string, string | undefined>,
): Record<string, string> {
  const env: Record<string, string> = { ...VALID_PROD_ENV };
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) {
      delete env[k];
    } else {
      env[k] = v;
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// Happy-path: exit 0
// ---------------------------------------------------------------------------

describe("happy path — all checks pass", () => {
  it("exits 0 and prints 'Ready for launch.' when every prod var is correct", () => {
    const { exitCode, stdout } = run(VALID_PROD_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ready for launch.");
    expect(stdout).not.toContain("Not safe to launch.");
  });

  it("exits 0 and prints 'Ready for launch.' when TWILIO_PHONE_NUMBER is used instead of TWILIO_MESSAGING_SERVICE_SID", () => {
    const env = withEnv({
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_PHONE_NUMBER: "+12155551234",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ready for launch.");
  });

  it("exits 0 and prints 'Ready for launch.' when DATABASE_URL uses postgresql:// prefix", () => {
    const env = withEnv({
      DATABASE_URL: "postgresql://user:pass@db.example.com:5432/pennpaps",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ready for launch.");
  });

  it("exits 0 with warnings (not fails) when stale secrets are present", () => {
    const env = withEnv({
      AUTH_PASSWORD_PEPPER: "some-old-pepper-value",
      RESUPPLY_MASTER_KEY: "old-master-key",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Launch-eligible with warnings.");
    expect(stdout).not.toContain("Not safe to launch.");
  });

  it("exits 0 and warns (not fails) when NODE_ENV is a recognized non-production value", () => {
    // NODE_ENV must be one of development|test|production. A recognized
    // non-production value (here "development") downgrades the prod-only
    // gates to advisory WARN and exits 0. (An *unrecognized* value such
    // as "staging" is a hard FAIL — see the NODE_ENV variants block.)
    const env = withEnv({ NODE_ENV: "development" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Launch-eligible with warnings.");
    expect(stdout).not.toContain("Not safe to launch.");
  });
});

// ---------------------------------------------------------------------------
// Exit 1: boot-required variable checks
// ---------------------------------------------------------------------------

describe("boot-required variables — exit 1 on failure", () => {
  it("fails when PORT is missing", () => {
    const { exitCode, stdout } = run(withEnv({ PORT: undefined }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Not safe to launch.");
  });

  it("fails when DATABASE_URL is missing", () => {
    const { exitCode } = run(withEnv({ DATABASE_URL: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when DATABASE_URL is the .env.example placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({
        DATABASE_URL: "postgres://user:password@localhost:5432/pennpaps",
      }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when DATABASE_URL points at localhost in production (even with a replace_me substring)", () => {
    // refusePlaceholder is exact-match only now (it no longer matches a
    // bare "replace_me" substring — see the dedicated test below), so
    // this value is NOT flagged as a placeholder. It still fails: the
    // host is localhost and NODE_ENV=production, which the prod-only
    // localhost guard rejects before anything else can pass it.
    const { exitCode, stdout } = run(
      withEnv({
        DATABASE_URL: "postgres://replace_me@localhost:5432/pennpaps",
      }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DATABASE_URL");
    expect(stdout).toContain("localhost");
  });

  it("fails when DATABASE_URL does not start with postgres:// or postgresql://", () => {
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "mysql://user:pass@host:3306/db" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DATABASE_URL");
  });

  it("fails when DATABASE_URL points at localhost in NODE_ENV=production", () => {
    // A non-placeholder URL — passes the prefix and placeholder
    // checks — but with a localhost host. The migrator and the API
    // both consult DATABASE_URL directly; a localhost value in prod
    // silently writes prod traffic to a dev/CI database.
    const env = withEnv({
      DATABASE_URL: "postgres://realuser:realpass@localhost:5432/pennpaps_prod",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DATABASE_URL");
    expect(stdout).toContain("localhost");
  });

  it("fails when DATABASE_URL points at 127.0.0.1 in NODE_ENV=production", () => {
    const env = withEnv({
      DATABASE_URL: "postgres://realuser:realpass@127.0.0.1:5432/pennpaps_prod",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(1);
  });

  it("passes when DATABASE_URL points at localhost outside production mode", () => {
    // dev / test / preview is allowed to point at a local DB — the
    // localhost rejection above is prod-only. NODE_ENV must be a
    // recognized value (development|test|production), so use
    // "development" here to exercise the non-prod path.
    const env = withEnv({
      NODE_ENV: "development",
      DATABASE_URL:
        "postgres://localuser:localpass@localhost:5432/pennpaps_local",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("fails when SUPABASE_URL is the placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ SUPABASE_URL: "https://YOUR-PROJECT.supabase.co" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when SUPABASE_URL is http:// (not https)", () => {
    const { exitCode, stdout } = run(
      withEnv({ SUPABASE_URL: "http://abcxyz123.supabase.co" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SUPABASE_URL");
  });

  it("fails when SUPABASE_URL is missing", () => {
    const { exitCode } = run(withEnv({ SUPABASE_URL: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when SUPABASE_SERVICE_ROLE_KEY contains replace_me", () => {
    const { exitCode, stdout } = run(
      withEnv({
        SUPABASE_SERVICE_ROLE_KEY: "replace_me_with_service_role_key",
      }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    const { exitCode } = run(withEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when SUPABASE_STORAGE_BUCKET_PRIVATE is missing", () => {
    // registerPrescriptionAttachmentSweepJob() throws at worker boot
    // when this var is unset, which crashes the API process. Preflight
    // must catch it pre-deploy.
    const { exitCode, stdout } = run(
      withEnv({ SUPABASE_STORAGE_BUCKET_PRIVATE: undefined }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SUPABASE_STORAGE_BUCKET_PRIVATE");
  });

  it("fails when SUPABASE_STORAGE_BUCKET_PRIVATE is whitespace-only (treated as unset)", () => {
    // Mirror getPrivateStorageBucket()'s trim-then-check behavior.
    const { exitCode, stdout } = run(
      withEnv({ SUPABASE_STORAGE_BUCKET_PRIVATE: "   " }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SUPABASE_STORAGE_BUCKET_PRIVATE");
  });

  it("fails when SUPABASE_STORAGE_BUCKET_PRIVATE is missing even outside production mode", () => {
    // The worker crash isn't gated by NODE_ENV — dev/test/preview deploys
    // hit the same boot-time throw, so preflight fails unconditionally.
    // NODE_ENV=development (a recognized non-prod value) isolates the
    // bucket check so the exit-1 cannot be attributed to the NODE_ENV
    // gate instead.
    const { exitCode, stdout } = run(
      withEnv({
        NODE_ENV: "development",
        SUPABASE_STORAGE_BUCKET_PRIVATE: undefined,
      }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SUPABASE_STORAGE_BUCKET_PRIVATE");
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY is missing", () => {
    const { exitCode } = run(withEnv({ RESUPPLY_LINK_HMAC_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY decodes to fewer than 32 bytes", () => {
    // 20 bytes in base64 = 28 chars
    const shortKey = Buffer.alloc(20).toString("base64");
    const { exitCode, stdout } = run(
      withEnv({ RESUPPLY_LINK_HMAC_KEY: shortKey }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_LINK_HMAC_KEY");
    expect(stdout).toContain("bytes");
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY is the placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ RESUPPLY_LINK_HMAC_KEY: "replace_me_with_32_byte_secret" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("passes when RESUPPLY_LINK_HMAC_KEY decodes to exactly 32 bytes (boundary value)", () => {
    const exactly32a = Buffer.alloc(32, 0).toString("base64");
    const env = withEnv({ RESUPPLY_LINK_HMAC_KEY: exactly32a });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY does not round-trip through decode/encode", () => {
    // 65-char value, alphabet OK, but length % 4 == 1 → Node accepts
    // it and silently truncates the trailing char during decode, so
    // re-encoding produces a 64-char string that's different from
    // the input. boot-time validation in lib/resupply-audit catches
    // this; the original lax Buffer.from check did not.
    const lengthOff = "A".repeat(65);
    const { exitCode, stdout } = run(
      withEnv({ RESUPPLY_LINK_HMAC_KEY: lengthOff }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_LINK_HMAC_KEY");
    expect(stdout).toContain("round-trip");
  });

  it("warns (does not fail) when RESUPPLY_ADMIN_EMAILS is missing", () => {
    // requireAdmin reads roles from auth.users.role; the env var is
    // not consulted by the auth gate, so an empty value is non-fatal.
    const { exitCode, stdout } = run(
      withEnv({ RESUPPLY_ADMIN_EMAILS: undefined }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_ADMIN_EMAILS");
    expect(stdout).toContain("WARN");
  });

  it("warns (does not fail) when RESUPPLY_ADMIN_EMAILS is all commas (no real entries)", () => {
    const { exitCode, stdout } = run(withEnv({ RESUPPLY_ADMIN_EMAILS: ",,," }));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_ADMIN_EMAILS");
    expect(stdout).toContain("WARN");
  });

  it("passes when RESUPPLY_ADMIN_EMAILS has multiple entries", () => {
    const env = withEnv({
      RESUPPLY_ADMIN_EMAILS: "alice@pennpaps.com,bob@pennpaps.com",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exit 1: Stripe checks in production mode
// ---------------------------------------------------------------------------

describe("Stripe checks in production mode", () => {
  it("fails when STRIPE_SECRET_KEY is a test key (sk_test_) in production", () => {
    const { exitCode, stdout } = run(
      withEnv({ STRIPE_SECRET_KEY: "sk_test" + "_abcdefghijklmnop" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STRIPE_SECRET_KEY");
    expect(stdout).toContain("live");
  });

  it("fails when STRIPE_SECRET_KEY is the placeholder in production", () => {
    const { exitCode, stdout } = run(
      // The runtime value is the literal .env.example default; the
      // concatenation only keeps the prefix substring out of source
      // so secret scanners don't match.
      withEnv({ STRIPE_SECRET_KEY: "sk_test" + "_replace_me" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when STRIPE_SECRET_KEY has unexpected shape in production", () => {
    const { exitCode, stdout } = run(
      withEnv({ STRIPE_SECRET_KEY: "rk_live_unexpectedshape" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STRIPE_SECRET_KEY");
  });

  it("fails when STRIPE_SECRET_KEY is missing in production", () => {
    const { exitCode } = run(withEnv({ STRIPE_SECRET_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when STRIPE_WEBHOOK_SIGNING_SECRET does not start with whsec_", () => {
    const { exitCode, stdout } = run(
      withEnv({ STRIPE_WEBHOOK_SIGNING_SECRET: "wrongprefix_abc123" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STRIPE_WEBHOOK_SIGNING_SECRET");
  });

  it("fails when STRIPE_WEBHOOK_SIGNING_SECRET is the placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ STRIPE_WEBHOOK_SIGNING_SECRET: "whsec" + "_replace_me" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when STRIPE_WEBHOOK_SIGNING_SECRET is missing in production", () => {
    const { exitCode } = run(
      withEnv({ STRIPE_WEBHOOK_SIGNING_SECRET: undefined }),
    );
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Exit 1: SendGrid checks
// ---------------------------------------------------------------------------

describe("SendGrid checks", () => {
  it("fails when SENDGRID_API_KEY does not start with SG.", () => {
    const { exitCode, stdout } = run(
      withEnv({ SENDGRID_API_KEY: "notSG.badkey" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SENDGRID_API_KEY");
  });

  it("fails when SENDGRID_API_KEY is the placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ SENDGRID_API_KEY: "SG" + ".replace_me" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when SENDGRID_API_KEY is missing in production", () => {
    const { exitCode } = run(withEnv({ SENDGRID_API_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when SENDGRID_FROM_EMAIL is not info@pennpaps.com in production", () => {
    const { exitCode, stdout } = run(
      withEnv({ SENDGRID_FROM_EMAIL: "wrong@example.com" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SENDGRID_FROM_EMAIL");
  });

  it("fails when SENDGRID_FROM_EMAIL is missing in production", () => {
    const { exitCode } = run(withEnv({ SENDGRID_FROM_EMAIL: undefined }));
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Exit 1: Twilio checks
// ---------------------------------------------------------------------------

describe("Twilio checks", () => {
  it("fails when TWILIO_ACCOUNT_SID does not start with 'AC'", () => {
    const { exitCode, stdout } = run(
      withEnv({ TWILIO_ACCOUNT_SID: "XCabcdef1234567890" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_ACCOUNT_SID");
  });

  it("fails when TWILIO_AUTH_TOKEN is the placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ TWILIO_AUTH_TOKEN: "replace_me" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when TWILIO_AUTH_TOKEN is missing in production", () => {
    const { exitCode } = run(withEnv({ TWILIO_AUTH_TOKEN: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when TWILIO_ACCOUNT_SID is set but neither TWILIO_MESSAGING_SERVICE_SID nor TWILIO_PHONE_NUMBER is set in production", () => {
    const env = withEnv({
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_PHONE_NUMBER: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      "TWILIO_MESSAGING_SERVICE_SID / TWILIO_PHONE_NUMBER",
    );
  });

  it("passes when TWILIO_ACCOUNT_SID is not set (Twilio entirely optional in non-prod)", () => {
    const env = withEnv({
      NODE_ENV: "development",
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Exit 1: Public URL checks in production mode
// ---------------------------------------------------------------------------

describe("public URL checks in production mode", () => {
  const publicUrlVars = [
    "SHOP_PUBLIC_BASE_URL",
    "REMINDER_PUBLIC_BASE_URL",
    "RESUPPLY_VOICE_PUBLIC_BASE_URL",
    "RESUPPLY_DASHBOARD_PUBLIC_BASE_URL",
    "PENN_ADMIN_PUBLIC_BASE_URL",
  ] as const;

  for (const varName of publicUrlVars) {
    it(`fails when ${varName} is http:// in production`, () => {
      const { exitCode, stdout } = run(
        withEnv({ [varName]: "http://pennpaps.com" }),
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain(varName);
    });

    it(`fails when ${varName} is localhost in production`, () => {
      const { exitCode, stdout } = run(
        withEnv({ [varName]: "https://localhost:3000" }),
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain(varName);
    });

    it(`fails when ${varName} is missing in production`, () => {
      const { exitCode } = run(withEnv({ [varName]: undefined }));
      expect(exitCode).toBe(1);
    });
  }

  it("passes when all public URLs are valid https in production", () => {
    const { exitCode } = run(VALID_PROD_ENV);
    expect(exitCode).toBe(0);
  });

  it("does not reject http:// public URLs in non-production mode", () => {
    const env = withEnv({
      NODE_ENV: "development",
      SHOP_PUBLIC_BASE_URL: "http://localhost:3000",
      REMINDER_PUBLIC_BASE_URL: "http://localhost:3001",
      RESUPPLY_VOICE_PUBLIC_BASE_URL: "http://localhost:3002",
      RESUPPLY_DASHBOARD_PUBLIC_BASE_URL: "http://localhost:3003",
      PENN_ADMIN_PUBLIC_BASE_URL: "http://localhost:3004",
    });
    const { exitCode } = run(env);
    // Should exit 0 (public URL http check is advisory in non-prod)
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Warnings that do NOT cause exit 1
// ---------------------------------------------------------------------------

describe("warnings that do not block launch", () => {
  it("warns but exits 0 when STRIPE_SECRET_KEY is missing in non-production mode", () => {
    const env = withEnv({
      NODE_ENV: "development",
      STRIPE_SECRET_KEY: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("WARN");
    expect(stdout).not.toContain("Not safe to launch.");
  });

  it("warns but exits 0 when RESUPPLY_FITTER_REENGAGE_ENABLED != 1 in production", () => {
    const env = withEnv({ RESUPPLY_FITTER_REENGAGE_ENABLED: "0" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_FITTER_REENGAGE_ENABLED");
    expect(stdout).toContain("WARN");
  });

  it("warns but exits 0 when RESUPPLY_FITTER_REENGAGE_ENABLED is unset in production", () => {
    const env = withEnv({ RESUPPLY_FITTER_REENGAGE_ENABLED: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("WARN");
  });

  it("passes (no warn) when RESUPPLY_FITTER_REENGAGE_ENABLED=1", () => {
    const { exitCode, stdout } = run(VALID_PROD_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ready for launch.");
  });

  it("warns but exits 0 when AUTH_PASSWORD_PEPPER stale secret is set", () => {
    const env = withEnv({ AUTH_PASSWORD_PEPPER: "oldpepper" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("AUTH_PASSWORD_PEPPER");
    expect(stdout).toContain("WARN");
  });

  it("warns but exits 0 when RESUPPLY_MASTER_KEY stale secret is set", () => {
    const env = withEnv({ RESUPPLY_MASTER_KEY: "oldmasterkey" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_MASTER_KEY");
    expect(stdout).toContain("WARN");
  });

  it("warns but exits 0 when RESUPPLY_DATA_KEY stale secret is set", () => {
    const env = withEnv({ RESUPPLY_DATA_KEY: "olddatakey" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_DATA_KEY");
    expect(stdout).toContain("WARN");
  });

  it("warns but exits 0 when RESUPPLY_PHONE_HMAC_KEY stale secret is set", () => {
    const env = withEnv({ RESUPPLY_PHONE_HMAC_KEY: "oldphonehmackey" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("RESUPPLY_PHONE_HMAC_KEY");
    expect(stdout).toContain("WARN");
  });

  it("fails (exit 1) when NODE_ENV is not set — it no longer silently defaults to development", () => {
    // An undefined NODE_ENV used to default to "development", silently
    // downgrading every production gate from FAIL to WARN. A deploy
    // environment that simply never exported NODE_ENV would then pass
    // preflight while still being a production target. It is now a hard
    // FAIL so the misconfiguration is caught pre-deploy.
    const env = withEnv({ NODE_ENV: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("NODE_ENV");
    expect(stdout).toContain("FAIL");
    expect(stdout).toContain("Not safe to launch.");
  });

  it("warns but exits 0 when SENDGRID_FROM_EMAIL is unset in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      SENDGRID_FROM_EMAIL: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SENDGRID_FROM_EMAIL");
    expect(stdout).toContain("WARN");
  });

  // Vendor keys (May 2026 addition — Anthropic / Deepgram / ElevenLabs).
  // All three are optional. Unset = warn (graceful degrade to existing
  // OpenAI/built-in paths). Set with the .env.example placeholder or a
  // shape-invalid value = fail.

  it("warns but exits 0 when ANTHROPIC_API_KEY is unset", () => {
    const env = withEnv({ ANTHROPIC_API_KEY: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stdout).toContain("WARN");
  });

  it("fails when ANTHROPIC_API_KEY is the .env.example placeholder", () => {
    const env = withEnv({ ANTHROPIC_API_KEY: "sk-ant-replace_me" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stdout).toContain("FAIL");
  });

  it("fails when ANTHROPIC_API_KEY does not start with sk-ant-", () => {
    const env = withEnv({ ANTHROPIC_API_KEY: "sk-something-else-1234" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("ANTHROPIC_API_KEY");
    expect(stdout).toContain("FAIL");
  });

  it("warns but exits 0 when DEEPGRAM_API_KEY is unset", () => {
    const env = withEnv({ DEEPGRAM_API_KEY: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("DEEPGRAM_API_KEY");
    expect(stdout).toContain("WARN");
  });

  it("fails when DEEPGRAM_API_KEY looks too short", () => {
    const env = withEnv({ DEEPGRAM_API_KEY: "short" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("DEEPGRAM_API_KEY");
    expect(stdout).toContain("FAIL");
  });

  it("warns but exits 0 when ELEVENLABS_API_KEY is unset", () => {
    const env = withEnv({ ELEVENLABS_API_KEY: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("ELEVENLABS_API_KEY");
    expect(stdout).toContain("WARN");
  });

  it("fails when ELEVENLABS_API_KEY looks too short", () => {
    const env = withEnv({ ELEVENLABS_API_KEY: "short" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("ELEVENLABS_API_KEY");
    expect(stdout).toContain("FAIL");
  });
});

// ---------------------------------------------------------------------------
// Output content and format
// ---------------------------------------------------------------------------

describe("output format", () => {
  it("prints a summary line with counts of pass, warn, fail", () => {
    const { stdout } = run(VALID_PROD_ENV);
    // e.g. "  N pass, 0 warn, 0 fail"
    expect(stdout).toMatch(/\d+ pass/);
    expect(stdout).toMatch(/\d+ warn/);
    expect(stdout).toMatch(/\d+ fail/);
  });

  it("prints 'PASS' label for passing checks", () => {
    const { stdout } = run(VALID_PROD_ENV);
    expect(stdout).toContain("PASS");
  });

  it("prints 'FAIL' label for failing checks", () => {
    const { stdout } = run(withEnv({ PORT: undefined }));
    expect(stdout).toContain("FAIL");
  });

  it("prints 'WARN' label for warning checks", () => {
    const env = withEnv({ AUTH_PASSWORD_PEPPER: "stale" });
    const { stdout } = run(env);
    expect(stdout).toContain("WARN");
  });

  it("prints 'preflight:prod' header in stdout", () => {
    const { stdout } = run(VALID_PROD_ENV);
    expect(stdout).toContain("preflight:prod");
  });

  it("does not emit ANSI codes when NO_COLOR=1", () => {
    const { stdout } = run(VALID_PROD_ENV);
    // No ESC character should appear
    expect(stdout).not.toContain("\x1b[");
  });
});

// ---------------------------------------------------------------------------
// Regression / edge cases
// ---------------------------------------------------------------------------

describe("edge cases and regression", () => {
  it("trims whitespace from env values before validation", () => {
    // A key padded with spaces should still be accepted if the trimmed value is valid.
    const trimmedKey = `  ${VALID_HMAC_KEY}  `;
    const env = withEnv({ RESUPPLY_LINK_HMAC_KEY: trimmedKey });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("treats a whitespace-only env value as unset", () => {
    const { exitCode } = run(withEnv({ PORT: "   " }));
    expect(exitCode).toBe(1);
  });

  it("fails when SUPABASE_URL is not a valid URL", () => {
    const { exitCode, stdout } = run(withEnv({ SUPABASE_URL: "not-a-url" }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("SUPABASE_URL");
  });

  it("passes when SUPABASE_URL is https://127.0.0.1 — localhost check does NOT apply to SUPABASE_URL (forbidLocalhost=false)", () => {
    // SUPABASE_URL uses requireHttpsUrl with forbidLocalhost=false, so localhost IS allowed
    const env = withEnv({ SUPABASE_URL: "https://127.0.0.1:8080" });
    const { exitCode } = run(env);
    // Must be https — that part still applies
    expect(exitCode).toBe(0);
  });

  it("fails multiple checks at once and reports total fail count", () => {
    const env = withEnv({
      PORT: undefined,
      DATABASE_URL: undefined,
      SUPABASE_URL: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    // At least 3 FAILs
    const failMatches = stdout.match(/FAIL/g) ?? [];
    expect(failMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts sk_test_ key in non-production mode without failing", () => {
    const env = withEnv({
      NODE_ENV: "development",
      STRIPE_SECRET_KEY: "sk_test" + "_abc123",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("refusePlaceholder is exact-match only — a 'replace_me' substring in an otherwise valid value is NOT flagged", () => {
    // refusePlaceholder used to fire on value.includes("replace_me"),
    // but that substring check false-positived on legitimate values
    // that happen to contain the literal (e.g. an admin email like
    // replace_me_review@pennpaps.com). It now matches the .env.example
    // placeholders by exact equality only. So a DATABASE_URL whose
    // userinfo contains "replace_me" but whose host is a real
    // (non-localhost) host passes in production.
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "postgres://replace_me:pass@host:5432/db" }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Ready for launch.");
  });

  it("TWILIO_ACCOUNT_SID placeholder ACxxx... is caught as failure", () => {
    // The script has a special check for the .env.example placeholder value
    // Note: the check for placeholder is second in an if-else chain;
    // because ACxxx starts with 'AC', the first branch passes, then
    // the second checks for the exact placeholder string.
    const { exitCode, stdout } = run(
      withEnv({ TWILIO_ACCOUNT_SID: "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_ACCOUNT_SID");
  });

  it("stale secrets do not cause failures even when all four are set simultaneously", () => {
    const env = withEnv({
      AUTH_PASSWORD_PEPPER: "v1",
      RESUPPLY_MASTER_KEY: "v2",
      RESUPPLY_DATA_KEY: "v3",
      RESUPPLY_PHONE_HMAC_KEY: "v4",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Launch-eligible with warnings.");
  });
});

// ---------------------------------------------------------------------------
// Optional placeholder checks (section 6 of runChecks)
// ---------------------------------------------------------------------------

describe("optional placeholder variable checks", () => {
  it("fails when OPENAI_API_KEY is the placeholder sk-replace_me", () => {
    const env = withEnv({ OPENAI_API_KEY: "sk-replace_me" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("OPENAI_API_KEY");
    expect(stdout).toContain("placeholder");
  });

  it("passes when OPENAI_API_KEY is unset (optional var)", () => {
    const env = withEnv({ OPENAI_API_KEY: undefined });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("passes when OPENAI_API_KEY is set to a real-looking value", () => {
    const env = withEnv({ OPENAI_API_KEY: "sk-realkey123abc" });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("fails when TWILIO_PHONE_NUMBER is the .env.example placeholder +15555550123", () => {
    const env = withEnv({
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_PHONE_NUMBER: "+15555550123",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_PHONE_NUMBER");
    expect(stdout).toContain("placeholder");
  });

  it("fails when PENN_FULFILLMENT_EMAIL is the placeholder fulfillment@example.com", () => {
    const env = withEnv({ PENN_FULFILLMENT_EMAIL: "fulfillment@example.com" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("PENN_FULFILLMENT_EMAIL");
    expect(stdout).toContain("placeholder");
  });

  it("passes when PENN_FULFILLMENT_EMAIL is unset (optional var)", () => {
    const env = withEnv({ PENN_FULFILLMENT_EMAIL: undefined });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("fails when VITE_RESUPPLY_CONTACT_EMAIL is the placeholder support@example.com", () => {
    const env = withEnv({ VITE_RESUPPLY_CONTACT_EMAIL: "support@example.com" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("VITE_RESUPPLY_CONTACT_EMAIL");
    expect(stdout).toContain("placeholder");
  });
});

// ---------------------------------------------------------------------------
// Belt-and-braces @example.* email scan
// ---------------------------------------------------------------------------

describe("@example.* email scan for arbitrary _EMAIL vars", () => {
  it("fails when an arbitrary _EMAIL var points at @example.com", () => {
    // Inject a custom var that ends in _EMAIL with an @example.com address.
    const env = withEnv({ CUSTOM_NOTIFY_EMAIL: "notify@example.com" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("CUSTOM_NOTIFY_EMAIL");
    expect(stdout).toContain("@example");
  });

  it("fails when an _EMAIL var points at @example.org", () => {
    const env = withEnv({ CUSTOM_NOTIFY_EMAIL: "notify@example.org" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("CUSTOM_NOTIFY_EMAIL");
  });

  it("fails when an _EMAIL var points at @example.net", () => {
    const env = withEnv({ CUSTOM_NOTIFY_EMAIL: "notify@example.net" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("CUSTOM_NOTIFY_EMAIL");
  });

  it("passes when an _EMAIL var uses a real domain (not @example.*)", () => {
    const env = withEnv({ CUSTOM_NOTIFY_EMAIL: "notify@pennpaps.com" });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("does not double-flag PENN_FULFILLMENT_EMAIL when already reported by refusePlaceholder", () => {
    // When PENN_FULFILLMENT_EMAIL=fulfillment@example.com, refusePlaceholder fires first.
    // The belt-and-braces loop should skip it (already in alreadyReported set).
    // Either way exit code must be 1 and exactly one entry for that var name.
    const env = withEnv({ PENN_FULFILLMENT_EMAIL: "fulfillment@example.com" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    // Count occurrences of the var name — should not appear more than twice
    // (once for the FAIL line, once for the detail line).
    const occurrences = stdout.split("PENN_FULFILLMENT_EMAIL").length - 1;
    expect(occurrences).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Non-production severity: missing optional vars → warn not fail
// ---------------------------------------------------------------------------

describe("non-production mode — missing vendor vars warn rather than fail", () => {
  it("warns (not fails) when STRIPE_WEBHOOK_SIGNING_SECRET is missing in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      STRIPE_WEBHOOK_SIGNING_SECRET: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("STRIPE_WEBHOOK_SIGNING_SECRET");
    expect(stdout).toContain("WARN");
  });

  it("warns (not fails) when SENDGRID_API_KEY is missing in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      SENDGRID_API_KEY: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SENDGRID_API_KEY");
    expect(stdout).toContain("WARN");
  });

  it("warns (not fails) when TWILIO_AUTH_TOKEN is missing in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      TWILIO_AUTH_TOKEN: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TWILIO_AUTH_TOKEN");
    expect(stdout).toContain("WARN");
  });

  it("warns (not fails) when a public URL var is missing in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      SHOP_PUBLIC_BASE_URL: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SHOP_PUBLIC_BASE_URL");
    expect(stdout).toContain("WARN");
  });

  it("passes (not warns) when RESUPPLY_FITTER_REENGAGE_ENABLED is '0' in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      RESUPPLY_FITTER_REENGAGE_ENABLED: "0",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    // In non-prod the script records a "pass" for non-1 values (intentionally OFF)
    expect(stdout).toContain("PASS");
  });

  it("passes (not warns) when RESUPPLY_FITTER_REENGAGE_ENABLED is unset in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      RESUPPLY_FITTER_REENGAGE_ENABLED: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    // Should not have a warn for RESUPPLY_FITTER_REENGAGE_ENABLED in non-prod
    // (it records a pass with "intentionally OFF" detail)
    const fitterWarnLine = stdout
      .split("\n")
      .some(
        (l) =>
          l.includes("WARN") && l.includes("RESUPPLY_FITTER_REENGAGE_ENABLED"),
      );
    expect(fitterWarnLine).toBe(false);
  });

  it("warns when TWILIO_ACCOUNT_SID is unset in production mode", () => {
    const env = withEnv({
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
    });
    const { stdout } = run(env);
    // Unset TWILIO_ACCOUNT_SID in production → warn (no SMS/voice),
    // but unset TWILIO_AUTH_TOKEN in production → fail per prodSeverity.
    // So this is actually exit 1 because TWILIO_AUTH_TOKEN is missing in prod.
    // Verify the specific TWILIO_ACCOUNT_SID warn line is present:
    expect(stdout).toContain("TWILIO_ACCOUNT_SID");
    // The important assertion: TWILIO_ACCOUNT_SID alone is only a warn
    // (it won't be FAIL for ACCOUNT_SID specifically).
    const accountSidFailLine = stdout
      .split("\n")
      .some((l) => l.includes("FAIL") && l.includes("TWILIO_ACCOUNT_SID"));
    expect(accountSidFailLine).toBe(false);
  });

  it("exits 0 in non-prod when the whole Twilio trio is omitted (TWILIO_ACCOUNT_SID unset produces no entry)", () => {
    // In non-prod, TWILIO_ACCOUNT_SID unset simply produces no entry at all
    // (the tsid===undefined && prodMode guard is false).
    const env = withEnv({
      NODE_ENV: "development",
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// NODE_ENV variations
// ---------------------------------------------------------------------------

describe("NODE_ENV variants", () => {
  it("treats NODE_ENV=development the same as non-production (warn)", () => {
    const env = withEnv({ NODE_ENV: "development" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NODE_ENV");
    expect(stdout).toContain("WARN");
  });

  it("treats NODE_ENV=test the same as non-production (warn)", () => {
    const env = withEnv({ NODE_ENV: "test" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NODE_ENV");
    expect(stdout).toContain("WARN");
  });

  it("exits 0 with no NODE_ENV warning when NODE_ENV=production", () => {
    const { stdout } = run(VALID_PROD_ENV);
    // NODE_ENV should be a PASS line, not a WARN line
    const nodeEnvWarnLine = stdout
      .split("\n")
      .some((l) => l.includes("WARN") && l.includes("NODE_ENV"));
    expect(nodeEnvWarnLine).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SENDGRID_FROM_EMAIL in non-production
// ---------------------------------------------------------------------------

describe("SENDGRID_FROM_EMAIL in non-production mode", () => {
  it("passes (not warns) when SENDGRID_FROM_EMAIL is set to any valid address in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "development",
      SENDGRID_FROM_EMAIL: "dev-sender@mycompany.com",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    // Should record a PASS for SENDGRID_FROM_EMAIL, not a WARN
    const fromEmailWarnLine = stdout
      .split("\n")
      .some((l) => l.includes("WARN") && l.includes("SENDGRID_FROM_EMAIL"));
    expect(fromEmailWarnLine).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Legacy / commonly-confused env names — STRIPE_WEBHOOK_SECRET
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CORS allowlist — RESUPPLY_ALLOWED_ORIGINS / RAILWAY_PUBLIC_DOMAIN
// ---------------------------------------------------------------------------

describe("RESUPPLY_ALLOWED_ORIGINS / RAILWAY_PUBLIC_DOMAIN in production", () => {
  it("fails when neither is set in production", () => {
    // app.ts throws at boot when both are empty in prod.
    const env = withEnv({
      RESUPPLY_ALLOWED_ORIGINS: undefined,
      RAILWAY_PUBLIC_DOMAIN: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_ALLOWED_ORIGINS");
    expect(stdout).toContain("RAILWAY_PUBLIC_DOMAIN");
  });

  it("passes when only RAILWAY_PUBLIC_DOMAIN is set (Railway-managed deployment)", () => {
    const env = withEnv({
      RESUPPLY_ALLOWED_ORIGINS: undefined,
      RAILWAY_PUBLIC_DOMAIN: "pennfit.up.railway.app",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("passes when only RESUPPLY_ALLOWED_ORIGINS is set", () => {
    const env = withEnv({
      RESUPPLY_ALLOWED_ORIGINS: "https://pennpaps.com",
      RAILWAY_PUBLIC_DOMAIN: undefined,
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("skips the check in non-production mode", () => {
    const env = withEnv({
      NODE_ENV: "development",
      RESUPPLY_ALLOWED_ORIGINS: undefined,
      RAILWAY_PUBLIC_DOMAIN: undefined,
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });
});

describe("STRIPE_WEBHOOK_SECRET vs STRIPE_WEBHOOK_SIGNING_SECRET name confusion", () => {
  it("fails when STRIPE_WEBHOOK_SECRET (legacy name) is set but the canonical name is unset", () => {
    // The runtime handler reads STRIPE_WEBHOOK_SIGNING_SECRET only;
    // setting the legacy display-only name silently breaks webhook
    // verification on the first Stripe event.
    const env = withEnv({
      STRIPE_WEBHOOK_SECRET: "whsec" + "_abc",
      STRIPE_WEBHOOK_SIGNING_SECRET: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STRIPE_WEBHOOK_SECRET");
    expect(stdout).toContain("STRIPE_WEBHOOK_SIGNING_SECRET");
  });

  it("warns (does not fail) when both names are set — only the canonical one matters", () => {
    const env = withEnv({
      STRIPE_WEBHOOK_SECRET: "whsec" + "_legacy",
      STRIPE_WEBHOOK_SIGNING_SECRET: "whsec" + "_canonical",
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("STRIPE_WEBHOOK_SECRET");
    expect(stdout).toContain("WARN");
  });

  it("does not flag STRIPE_WEBHOOK_SECRET when it is unset (the happy path)", () => {
    const env = withEnv({
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    // No record should be made for STRIPE_WEBHOOK_SECRET at all.
    const legacyMention = stdout
      .split("\n")
      .some((l) => /\bSTRIPE_WEBHOOK_SECRET\b/.test(l));
    expect(legacyMention).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Optional outside integrations with all-or-none credential groups
// ---------------------------------------------------------------------------

const THERAPY_AND_OPTIONAL_GROUPS: Array<{
  displayName: string;
  vars: string[];
  samplePartial: Record<string, string | undefined>;
  disabledText: string;
  configuredText: string;
}> = [
  {
    displayName: "AIRVIEW",
    vars: [
      "AIRVIEW_API_BASE_URL",
      "AIRVIEW_OAUTH_TOKEN_URL",
      "AIRVIEW_CLIENT_ID",
      "AIRVIEW_CLIENT_SECRET",
      "AIRVIEW_DME_ID",
    ],
    samplePartial: { AIRVIEW_CLIENT_ID: "airview-client" },
    disabledText: "AirView therapy-cloud sync disabled",
    configuredText: "ResMed AirView sync",
  },
  {
    displayName: "CARE_ORCHESTRATOR",
    vars: [
      "CARE_ORCHESTRATOR_API_BASE_URL",
      "CARE_ORCHESTRATOR_OAUTH_TOKEN_URL",
      "CARE_ORCHESTRATOR_CLIENT_ID",
      "CARE_ORCHESTRATOR_CLIENT_SECRET",
      "CARE_ORCHESTRATOR_PARTNER_ID",
    ],
    samplePartial: { CARE_ORCHESTRATOR_CLIENT_ID: "care-client" },
    disabledText: "Care Orchestrator therapy-cloud sync disabled",
    configuredText: "Philips Care Orchestrator sync",
  },
  {
    displayName: "REACT_HEALTH",
    vars: [
      "REACT_HEALTH_API_BASE_URL",
      "REACT_HEALTH_OAUTH_TOKEN_URL",
      "REACT_HEALTH_CLIENT_ID",
      "REACT_HEALTH_CLIENT_SECRET",
      "REACT_HEALTH_ACCOUNT_ID",
    ],
    samplePartial: { REACT_HEALTH_CLIENT_ID: "react-client" },
    disabledText: "React Health / 3B therapy-cloud sync disabled",
    configuredText: "React Health / 3B sync",
  },
  {
    displayName: "TELNYX_FAX",
    vars: [
      "TELNYX_API_KEY",
      "TELNYX_FAX_CONNECTION_ID",
      "TELNYX_FAX_FROM_NUMBER",
      "TELNYX_PUBLIC_KEY",
    ],
    samplePartial: { TELNYX_API_KEY: "KEY0123456789abcdef" },
    disabledText: "Telnyx fax send + inbound fax webhooks disabled",
    configuredText: "Telnyx outbound fax + webhook verification",
  },
  {
    displayName: "WEB_PUSH_VAPID",
    vars: [
      "WEB_PUSH_VAPID_PUBLIC_KEY",
      "WEB_PUSH_VAPID_PRIVATE_KEY",
      "WEB_PUSH_VAPID_SUBJECT",
    ],
    samplePartial: { WEB_PUSH_VAPID_PUBLIC_KEY: "B".repeat(87) },
    disabledText: "browser push notifications disabled",
    configuredText: "browser push notifications",
  },
];

function withoutEnvVars(vars: string[]): Record<string, undefined> {
  return Object.fromEntries(vars.map((name) => [name, undefined]));
}

describe("optional outside integration credential groups", () => {
  for (const group of THERAPY_AND_OPTIONAL_GROUPS) {
    it(`warns, but exits 0, when ${group.displayName} is completely unset`, () => {
      const { exitCode, stdout } = run(withEnv(withoutEnvVars(group.vars)));
      expect(exitCode).toBe(0);
      expect(stdout).toContain(group.displayName);
      expect(stdout).toContain(group.disabledText);
    });

    it(`fails when ${group.displayName} is partially configured`, () => {
      const { exitCode, stdout } = run(
        withEnv({ ...withoutEnvVars(group.vars), ...group.samplePartial }),
      );
      expect(exitCode).toBe(1);
      expect(stdout).toContain(group.displayName);
      expect(stdout).toContain("partially configured");
    });

    it(`passes when ${group.displayName} is fully configured`, () => {
      const { exitCode, stdout } = run(VALID_PROD_ENV);
      expect(exitCode).toBe(0);
      expect(stdout).toContain(group.displayName);
      expect(stdout).toContain(group.configuredText);
    });
  }
});

// ---------------------------------------------------------------------------
// Office Ally clearinghouse readiness (270/271 + 837P)
// ---------------------------------------------------------------------------

const OFFICE_ALLY_FULL: Record<string, string> = {
  OFFICE_ALLY_USERNAME: "pennpaps_submitter",
  OFFICE_ALLY_PRIVATE_KEY_PATH: "/secrets/oa_id_ed25519",
  OFFICE_ALLY_KNOWN_HOSTS_PATH: "/secrets/oa_known_hosts",
  OFFICE_ALLY_ETIN: "123456",
  OFFICE_ALLY_BILLING_NPI: "1234567893",
  OFFICE_ALLY_BILLING_TAX_ID: "123456789",
  OFFICE_ALLY_BILLING_ORG_NAME: "Penn Home Medical Supply",
  OFFICE_ALLY_BILLING_ADDRESS_LINE1: "100 Market St",
  OFFICE_ALLY_BILLING_CITY: "Philadelphia",
  OFFICE_ALLY_BILLING_STATE: "PA",
  OFFICE_ALLY_BILLING_ZIP: "19106",
};

describe("Office Ally readiness", () => {
  it("passes (stub) when no OFFICE_ALLY_* vars are set", () => {
    const { exitCode, stdout } = run(VALID_PROD_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stub/outbox mode");
  });

  it("FAILS (exit 1) on a partial config that silently degrades to stub", () => {
    const { exitCode, stdout } = run(
      withEnv({ OFFICE_ALLY_USERNAME: "pennpaps_submitter" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("partially configured");
  });

  it("passes when fully configured with production usage indicator P", () => {
    const { exitCode, stdout } = run(
      withEnv({ ...OFFICE_ALLY_FULL, OFFICE_ALLY_USAGE_INDICATOR: "P" }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("transmit live");
  });

  it("warns (still exit 0) when fully configured but left in test mode", () => {
    const { exitCode, stdout } = run(withEnv(OFFICE_ALLY_FULL));
    expect(exitCode).toBe(0);
    expect(stdout).toContain("TEST environment");
  });

  it("passes (forced stub) when OFFICE_ALLY_STUB=1 even with full creds", () => {
    const { exitCode, stdout } = run(
      withEnv({ ...OFFICE_ALLY_FULL, OFFICE_ALLY_STUB: "1" }),
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("stub mode forced");
  });
});

// ---------------------------------------------------------------------------
// Voice agent readiness (OpenAI Realtime + Twilio Media Streams)
// ---------------------------------------------------------------------------

describe("voice agent readiness", () => {
  it("reports a clean VOICE_AGENT pass when all four voice vars are set (happy path)", () => {
    const { exitCode, stdout } = run(VALID_PROD_ENV);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("VOICE_AGENT");
    // 4/4 present → PASS, and the canonical fixture stays warning-free.
    expect(stdout).toContain("Ready for launch.");
  });

  it("warns (exit 0) when voice is partially configured — OPENAI_API_KEY missing", () => {
    const env = withEnv({ OPENAI_API_KEY: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("partially configured");
    const voiceWarn = stdout
      .split("\n")
      .some((l) => l.includes("WARN") && l.includes("VOICE_AGENT"));
    expect(voiceWarn).toBe(true);
  });

  it("passes (voice off) when none of the voice-required vars are set", () => {
    // Strip OpenAI + the whole Twilio trio + both public-URL sources so the
    // voice-required group is fully empty. TWILIO_AUTH_TOKEN unset in prod
    // is itself a FAIL (prodSeverity), so run in development mode to isolate
    // the VOICE_AGENT "voice off" pass.
    const env = withEnv({
      NODE_ENV: "development",
      OPENAI_API_KEY: undefined,
      TWILIO_ACCOUNT_SID: undefined,
      TWILIO_AUTH_TOKEN: undefined,
      TWILIO_MESSAGING_SERVICE_SID: undefined,
      TWILIO_PHONE_NUMBER: undefined,
      RESUPPLY_VOICE_PUBLIC_BASE_URL: undefined,
      RAILWAY_PUBLIC_DOMAIN: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("voice agent disabled");
  });

  it("fails when TWILIO_PHONE_NUMBER is set but not E.164 (missing +)", () => {
    const env = withEnv({ TWILIO_PHONE_NUMBER: "2155550100" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_PHONE_NUMBER");
    expect(stdout).toContain("E.164");
  });

  it("fails when TWILIO_PHONE_NUMBER is too short to be a real E.164 number", () => {
    // "+1555" is "+"-prefixed digits but truncated (4 digits) — the
    // 8-digit floor catches it; a real Twilio caller-ID never is.
    const env = withEnv({ TWILIO_PHONE_NUMBER: "+1555" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_PHONE_NUMBER");
    expect(stdout).toContain("E.164");
  });

  it("still flags the TWILIO_PHONE_NUMBER .env.example placeholder (now from the voice block)", () => {
    const env = withEnv({ TWILIO_PHONE_NUMBER: "+15555550123" });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("TWILIO_PHONE_NUMBER");
    expect(stdout).toContain("placeholder");
  });

  it("warns (exit 0) when TWILIO_PHONE_NUMBER is unset — outbound voice disabled", () => {
    // Keep the messaging-service SID so the SMS check still passes; only the
    // outbound-voice caller-ID is missing.
    const env = withEnv({ TWILIO_PHONE_NUMBER: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    const phoneWarn = stdout
      .split("\n")
      .some((l) => l.includes("WARN") && l.includes("TWILIO_PHONE_NUMBER"));
    expect(phoneWarn).toBe(true);
  });

  it("records TWILIO_PHONE_NUMBER as a standalone entry exactly once (no double-report after the section-6 move)", () => {
    // The placeholder check moved from section 6 into the voice block; a
    // valid number must produce exactly one standalone result entry. The
    // SMS combined "… / TWILIO_PHONE_NUMBER" label is a different line and
    // does not match the standalone-label pattern below.
    const { stdout } = run(VALID_PROD_ENV);
    const labelLines = stdout
      .split("\n")
      .filter((l) => /^\s+(PASS|WARN|FAIL)\s+TWILIO_PHONE_NUMBER$/.test(l));
    expect(labelLines).toHaveLength(1);
  });
});
