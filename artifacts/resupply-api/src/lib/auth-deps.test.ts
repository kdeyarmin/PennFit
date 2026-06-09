// Unit tests for the consumeRecoveryCode method added to makeMfaProbe()
// in auth-deps.ts. This is the only changed code in auth-deps.ts for this PR.
//
// The probe is tested through getAuthDeps() so we exercise the real
// Supabase query chain, but with the shared supabase-mock standing in
// for the network. The other AuthDeps dependencies (email, audit,
// secrets) are no-op mocked so getAuthDeps() doesn't throw.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../test-helpers/supabase-mock";

// ── Module mocks (must appear before any import of the module under test) ─────

// Mock everything getAuthDeps() might call that isn't supabase.
vi.mock("@workspace/resupply-secrets", () => ({
  getLinkHmacKey: () => {
    throw new Error("not configured");
  },
}));

vi.mock("@workspace/resupply-audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@workspace/resupply-email", () => ({
  createSendgridClient: () => {
    throw new Error("not configured");
  },
  EmailApiError: class EmailApiError extends Error {},
  EmailConfigError: class EmailConfigError extends Error {},
}));

vi.mock("../logger", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

// Install the Supabase mock BEFORE importing the module under test.
const supabaseMock = installSupabaseMock();

// Now import the module under test and its peer dependencies.
// AUTH_PROVIDER is read lazily by readAuthEnv inside getAuthDeps().
process.env["AUTH_PROVIDER"] = "in_house";

const { getAuthDeps } = await import("./auth-deps");

// ── Shared test state ─────────────────────────────────────────────────────────

// Obtain the MfaProbe once. makeMfaProbe() returns an object whose methods
// each call getSupabaseServiceRoleClient() at invocation time (not at
// construction time), so the supabase-mock's staged responses apply correctly
// to each individual test call.
const mfaProbe = getAuthDeps().mfa!;
const consumeRecoveryCode = mfaProbe.consumeRecoveryCode!;
const findActiveSecret = mfaProbe.findActiveSecret!;
const findAllActiveSecrets = mfaProbe.findAllActiveSecrets!;

beforeEach(() => {
  supabaseMock.reset();
});

// ── admin not found → return null ─────────────────────────────────────────────

describe("consumeRecoveryCode: admin user lookup", () => {
  it("returns null when no admin_users row matches the auth userId", async () => {
    // admin_users select → no row
    stageSupabaseResponse("admin_users", "select", { data: null });

    const result = await consumeRecoveryCode("user-xyz", "hash-abc", null);

    expect(result).toBeNull();
    // The recovery code table must NOT be touched.
    expect(supabaseMock.callCount("admin_mfa_recovery_codes", "update")).toBe(
      0,
    );
  });
});

// ── DB error on UPDATE → throws ───────────────────────────────────────────────

describe("consumeRecoveryCode: DB error propagation", () => {
  it("throws when the recovery-code UPDATE returns an error", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-1" },
    });
    const dbErr = new Error("deadlock detected");
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: null,
      error: dbErr,
    });

    await expect(
      consumeRecoveryCode("user-abc", "hash-code", null),
    ).rejects.toThrow("deadlock detected");
  });
});

// ── UPDATE returns no row (code already spent or not found) → null ────────────

describe("consumeRecoveryCode: code already used or not found", () => {
  it("returns null when the UPDATE returns no row (used_at IS NOT NULL or wrong hash)", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-2" },
    });
    // No row matched the WHERE clause (used_at IS NULL + code_hash + staff_user_id).
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: null,
      error: null,
    });

    const result = await consumeRecoveryCode(
      "user-abc",
      "hash-spent",
      "10.0.0.1",
    );

    expect(result).toBeNull();
  });
});

// ── Happy path: first consume succeeds ───────────────────────────────────────

describe("consumeRecoveryCode: successful first use", () => {
  it("returns { id } when the atomic UPDATE succeeds", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-3" },
    });
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: { id: "rc-row-42" },
      error: null,
    });

    const result = await consumeRecoveryCode(
      "user-abc",
      "correct-hash",
      "192.168.1.1",
    );

    expect(result).toEqual({ id: "rc-row-42" });
    expect(supabaseMock.callCount("admin_mfa_recovery_codes", "update")).toBe(
      1,
    );
  });

  it("passes used_ip=null when ip is null", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-4" },
    });
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: { id: "rc-row-99" },
      error: null,
    });

    const result = await consumeRecoveryCode("user-abc", "hash-x", null);

    expect(result).toEqual({ id: "rc-row-99" });

    // Verify the payload passed to the UPDATE includes used_ip=null.
    const payloads = supabaseMock.writePayloads(
      "admin_mfa_recovery_codes",
      "update",
    );
    expect(payloads).toHaveLength(1);
    expect((payloads[0] as Record<string, unknown>)["used_ip"]).toBeNull();
  });

  it("includes used_ip in the update payload when ip is provided", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-5" },
    });
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: { id: "rc-row-55" },
      error: null,
    });

    await consumeRecoveryCode("user-abc", "hash-y", "203.0.113.1");

    const payloads = supabaseMock.writePayloads(
      "admin_mfa_recovery_codes",
      "update",
    );
    expect((payloads[0] as Record<string, unknown>)["used_ip"]).toBe(
      "203.0.113.1",
    );
  });
});

// ── Atomicity boundary: concurrent spend (regression guard) ──────────────────

describe("consumeRecoveryCode: concurrent spend behavior", () => {
  it("returns null on the second call when the first call already spent the code", async () => {
    // Simulate two concurrent callers: the first gets the row, the second gets null.
    // (In production this is enforced by Postgres; here we model it by staging
    // two sequential responses for the same scenario.)

    // First call
    stageSupabaseResponse("admin_users", "select", { data: { id: "admin-6" } });
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: { id: "rc-row-77" },
      error: null,
    });

    // Second call (same code, same user)
    stageSupabaseResponse("admin_users", "select", { data: { id: "admin-6" } });
    stageSupabaseResponse("admin_mfa_recovery_codes", "update", {
      data: null, // already spent
      error: null,
    });

    const first = await consumeRecoveryCode("user-abc", "same-hash", null);
    const second = await consumeRecoveryCode("user-abc", "same-hash", null);

    expect(first).toEqual({ id: "rc-row-77" });
    expect(second).toBeNull();
  });
});

describe("provider MFA fallback for dual-linked auth users", () => {
  it("falls through to provider_mfa_secrets when admin_mfa_secrets is empty", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-7" },
    });
    stageSupabaseResponse("admin_mfa_secrets", "select", {
      data: null,
      error: null,
    });
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { id: "provider-account-1" },
    });
    stageSupabaseResponse("provider_mfa_secrets", "select", {
      data: {
        secret_base32: "JBSWY3DPEHPK3PXP",
        last_used_counter: 9,
        verified_at: "2026-01-01T00:00:00.000Z",
      },
      error: null,
    });

    const secret = await findActiveSecret("user-dual-linked");

    expect(secret).toEqual({
      secretBase32: "JBSWY3DPEHPK3PXP",
      lastUsedCounter: 9,
    });
  });

  it("falls through to provider secrets for MFA verify when admin has zero devices", async () => {
    stageSupabaseResponse("admin_users", "select", {
      data: { id: "admin-8" },
    });
    stageSupabaseResponse("admin_mfa_secrets", "select", {
      data: [],
      error: null,
    });
    stageSupabaseResponse("provider_portal_accounts", "select", {
      data: { id: "provider-account-2" },
    });
    stageSupabaseResponse("provider_mfa_secrets", "select", {
      data: [
        {
          id: "provider-secret-1",
          secret_base32: "JBSWY3DPEHPK3PXP",
          last_used_counter: 3,
        },
      ],
      error: null,
    });

    const secrets = await findAllActiveSecrets("user-dual-linked");

    expect(secrets).toEqual([
      {
        id: "provider-secret-1",
        secretBase32: "JBSWY3DPEHPK3PXP",
        lastUsedCounter: 3,
      },
    ]);
  });
});
