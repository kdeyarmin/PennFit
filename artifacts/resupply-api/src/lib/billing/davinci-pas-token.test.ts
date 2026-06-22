// Tests for resolveDavinciPasToken — the per-tenant Da Vinci PAS Bearer-token
// resolver (migration 0453). Proves the non-regression contract:
//   * NO stored credential → the legacy DAVINCI_PAS_TOKEN_<SLUG> env var is
//     used, identical to before this change.
//   * A stored, org-scoped davinci_pas_credentials row takes precedence over
//     the env var.
//   * Neither present → null (the caller maps that to no_pas_credentials 409).

import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  installSupabaseMock,
  stageSupabaseResponse,
} from "../../test-helpers/supabase-mock";

const supabaseMock = installSupabaseMock();

vi.mock("../logger", () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  resolveDavinciPasToken,
  davinciPasTokenEnvKey,
} from "./davinci-pas-token";

const ORG_ID = "00000000-0000-4000-8000-000000000000";
const PAYER_SLUG = "aetna";
const ENV_KEY = "DAVINCI_PAS_TOKEN_AETNA";

beforeEach(() => {
  supabaseMock.reset();
  delete process.env[ENV_KEY];
});

describe("davinciPasTokenEnvKey", () => {
  it("uppercases the payer slug into the legacy env var name", () => {
    expect(davinciPasTokenEnvKey("aetna")).toBe("DAVINCI_PAS_TOKEN_AETNA");
    expect(davinciPasTokenEnvKey("united_hc")).toBe(
      "DAVINCI_PAS_TOKEN_UNITED_HC",
    );
  });
});

describe("resolveDavinciPasToken", () => {
  it("falls back to the env var when no credential is stored (non-regression)", async () => {
    // No davinci_pas_credentials row staged → maybeSingle resolves { data: null }.
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
    });
    expect(token).toBe("env-token-123");
  });

  it("prefers a stored credential over the env var", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "stored-token-abc" },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
    });
    expect(token).toBe("stored-token-abc");
  });

  it("returns null when neither a stored credential nor the env var is present", async () => {
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: {},
    });
    expect(token).toBeNull();
  });

  it("treats a blank stored token as unset and falls back to env", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "   " },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
    });
    expect(token).toBe("env-token-123");
  });

  it("trims surrounding whitespace from the resolved token", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "  padded-token  " },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: {},
    });
    expect(token).toBe("padded-token");
  });

  it("falls back to env (not crash) when the credential read errors", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: null,
      error: { message: "boom" },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
    });
    expect(token).toBe("env-token-123");
  });

  it("fails closed on a missing tenant", async () => {
    await expect(
      resolveDavinciPasToken({ orgId: "", payerSlug: PAYER_SLUG, env: {} }),
    ).rejects.toThrow(/non-empty orgId/);
  });
});
