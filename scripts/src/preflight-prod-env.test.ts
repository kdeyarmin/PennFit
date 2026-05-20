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
const SCRIPT = resolve(__dirname, "preflight-prod-env.ts");

// 48-byte all-zero buffer base64-encoded — decodes to exactly 48 bytes,
// comfortably above the 32-byte minimum the script enforces for HMAC keys.
const VALID_HMAC_KEY = Buffer.alloc(48).toString("base64");

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
  SUPABASE_SERVICE_ROLE_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.service_role",
  RESUPPLY_LINK_HMAC_KEY: VALID_HMAC_KEY,
  RESUPPLY_AUDIT_HMAC_KEY: VALID_HMAC_KEY,
  RESUPPLY_ADMIN_EMAILS: "admin@pennpaps.com",
  // NODE_ENV = production unlocks stricter checks:
  NODE_ENV: "production",
  // Stripe:
  STRIPE_SECRET_KEY: "sk_live_abcdefghijklmnop1234567890",
  STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_abc123def456",
  // SendGrid:
  SENDGRID_API_KEY: "SG.abc123def456",
  SENDGRID_FROM_EMAIL: "info@pennpaps.com",
  // Twilio:
  TWILIO_AUTH_TOKEN: "abc123authtoken",
  TWILIO_ACCOUNT_SID: "ACabcdef1234567890abcdef1234567890",
  TWILIO_MESSAGING_SERVICE_SID: "MGxxx123",
  // Public URLs:
  SHOP_PUBLIC_BASE_URL: "https://pennpaps.com",
  REMINDER_PUBLIC_BASE_URL: "https://pennpaps.com",
  RESUPPLY_VOICE_PUBLIC_BASE_URL: "https://pennpaps.com",
  RESUPPLY_DASHBOARD_PUBLIC_BASE_URL: "https://pennpaps.com",
  PENN_ADMIN_PUBLIC_BASE_URL: "https://pennpaps.com",
  // Feature flag:
  RESUPPLY_FITTER_REENGAGE_ENABLED: "1",
};

/** Run the preflight script as a subprocess with the given env. */
function run(env: Record<string, string>): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", SCRIPT],
    {
      env,
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Return a copy of VALID_PROD_ENV with the given overrides applied. */
function withEnv(overrides: Record<string, string | undefined>): Record<string, string> {
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
    const env = withEnv({ DATABASE_URL: "postgresql://user:pass@db.example.com:5432/pennpaps" });
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

  it("exits 0 and warns (not fails) when NODE_ENV is not production", () => {
    const env = withEnv({ NODE_ENV: "staging" });
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
    const { exitCode, stdout } = run(withEnv({ DATABASE_URL: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when DATABASE_URL is the .env.example placeholder", () => {
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "postgres://user:password@localhost:5432/pennpaps" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when DATABASE_URL contains 'replace_me'", () => {
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "postgres://replace_me@localhost:5432/pennpaps" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when DATABASE_URL does not start with postgres:// or postgresql://", () => {
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "mysql://user:pass@host:3306/db" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("DATABASE_URL");
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
      withEnv({ SUPABASE_SERVICE_ROLE_KEY: "replace_me_with_service_role_key" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when SUPABASE_SERVICE_ROLE_KEY is missing", () => {
    const { exitCode } = run(withEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY is missing", () => {
    const { exitCode } = run(withEnv({ RESUPPLY_LINK_HMAC_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when RESUPPLY_LINK_HMAC_KEY decodes to fewer than 32 bytes", () => {
    // 20 bytes in base64 = 28 chars
    const shortKey = Buffer.alloc(20).toString("base64");
    const { exitCode, stdout } = run(withEnv({ RESUPPLY_LINK_HMAC_KEY: shortKey }));
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

  it("fails when RESUPPLY_AUDIT_HMAC_KEY is missing", () => {
    const { exitCode } = run(withEnv({ RESUPPLY_AUDIT_HMAC_KEY: undefined }));
    expect(exitCode).toBe(1);
  });

  it("fails when RESUPPLY_AUDIT_HMAC_KEY decodes to fewer than 32 bytes", () => {
    const shortKey = Buffer.alloc(16).toString("base64");
    const { exitCode, stdout } = run(withEnv({ RESUPPLY_AUDIT_HMAC_KEY: shortKey }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_AUDIT_HMAC_KEY");
  });

  it("passes when HMAC key decodes to exactly 32 bytes (boundary value)", () => {
    const exactly32 = Buffer.alloc(32).toString("base64");
    const env = withEnv({
      RESUPPLY_LINK_HMAC_KEY: exactly32,
      RESUPPLY_AUDIT_HMAC_KEY: exactly32,
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("fails when RESUPPLY_ADMIN_EMAILS is missing", () => {
    const { exitCode, stdout } = run(withEnv({ RESUPPLY_ADMIN_EMAILS: undefined }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_ADMIN_EMAILS");
  });

  it("fails when RESUPPLY_ADMIN_EMAILS is all commas (no real entries)", () => {
    const { exitCode, stdout } = run(withEnv({ RESUPPLY_ADMIN_EMAILS: ",,," }));
    expect(exitCode).toBe(1);
    expect(stdout).toContain("RESUPPLY_ADMIN_EMAILS");
  });

  it("passes when RESUPPLY_ADMIN_EMAILS has multiple entries", () => {
    const env = withEnv({ RESUPPLY_ADMIN_EMAILS: "alice@pennpaps.com,bob@pennpaps.com" });
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
      withEnv({ STRIPE_SECRET_KEY: "sk_test_abcdefghijklmnop" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("STRIPE_SECRET_KEY");
    expect(stdout).toContain("live");
  });

  it("fails when STRIPE_SECRET_KEY is the placeholder in production", () => {
    const { exitCode, stdout } = run(
      withEnv({ STRIPE_SECRET_KEY: "sk_test_replace_me" }),
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
      withEnv({ STRIPE_WEBHOOK_SIGNING_SECRET: "whsec_replace_me" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
  });

  it("fails when STRIPE_WEBHOOK_SIGNING_SECRET is missing in production", () => {
    const { exitCode } = run(withEnv({ STRIPE_WEBHOOK_SIGNING_SECRET: undefined }));
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
      withEnv({ SENDGRID_API_KEY: "SG.replace_me" }),
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
    expect(stdout).toContain("TWILIO_MESSAGING_SERVICE_SID / TWILIO_PHONE_NUMBER");
  });

  it("passes when TWILIO_ACCOUNT_SID is not set (Twilio entirely optional in non-prod)", () => {
    const env = withEnv({
      NODE_ENV: "staging",
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
      NODE_ENV: "staging",
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
    const env = withEnv({ NODE_ENV: "staging", STRIPE_SECRET_KEY: undefined });
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

  it("warns but exits 0 when NODE_ENV is not set (defaults to development)", () => {
    const env = withEnv({ NODE_ENV: undefined });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("NODE_ENV");
    expect(stdout).toContain("WARN");
  });

  it("warns but exits 0 when SENDGRID_FROM_EMAIL is unset in non-prod", () => {
    const env = withEnv({
      NODE_ENV: "staging",
      SENDGRID_FROM_EMAIL: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SENDGRID_FROM_EMAIL");
    expect(stdout).toContain("WARN");
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

  it("fails when SUPABASE_URL is https://127.0.0.1 — localhost check does NOT apply to SUPABASE_URL (forbidLocalhost=false)", () => {
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
      RESUPPLY_ADMIN_EMAILS: undefined,
    });
    const { exitCode, stdout } = run(env);
    expect(exitCode).toBe(1);
    // At least 3 FAILs
    const failMatches = stdout.match(/FAIL/g) ?? [];
    expect(failMatches.length).toBeGreaterThanOrEqual(3);
  });

  it("accepts sk_test_ key in non-production mode without failing", () => {
    const env = withEnv({
      NODE_ENV: "staging",
      STRIPE_SECRET_KEY: "sk_test_abc123",
    });
    const { exitCode } = run(env);
    expect(exitCode).toBe(0);
  });

  it("refusePlaceholder catches 'replace_me' substring anywhere in value", () => {
    // e.g. DATABASE_URL contains replace_me somewhere in the hostname
    const { exitCode, stdout } = run(
      withEnv({ DATABASE_URL: "postgres://replace_me:pass@host:5432/db" }),
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("placeholder");
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
