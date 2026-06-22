// Tests for resolveDavinciPasToken — the per-tenant Da Vinci PAS Bearer-token
// resolver (migration 0453). Proves the non-regression contract:
//   * NO stored credential, SEED org → the legacy DAVINCI_PAS_TOKEN_<SLUG>
//     env var is used, identical to before this change.
//   * NO stored credential, NON-seed tenant → null (the env fallback is
//     gated to the seed org so a non-seed tenant never transmits PHI under
//     the seed/global payer token).
//   * A stored, org-scoped davinci_pas_credentials row takes precedence over
//     the env var (for any tenant).
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
const OTHER_ORG_ID = "11111111-1111-4111-8111-111111111111";
const PAYER_SLUG = "aetna";
const ENV_KEY = "DAVINCI_PAS_TOKEN_AETNA";

// Seed-org resolver stub — the existing (seed) deploy treats ORG_ID as the
// seed org, so the env fallback stays in play. Passed explicitly so the test
// never reaches the real tenant-directory read.
const seedIsOrgId = () => Promise.resolve<string | null>(ORG_ID);

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
  it("falls back to the env var when no credential is stored for the SEED org (non-regression)", async () => {
    // No davinci_pas_credentials row staged → maybeSingle resolves { data: null }.
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("env-token-123");
  });

  it("does NOT fall back to env for a NON-seed tenant with no stored credential → null", async () => {
    // A different tenant than the seed org. The process-wide env token is the
    // seed/global payer credential; a non-seed tenant must resolve to null so
    // it never transmits PHI under someone else's Bearer token.
    const token = await resolveDavinciPasToken({
      orgId: OTHER_ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBeNull();
  });

  it("uses the env token for the SEED org even when other tenants exist", async () => {
    // Seed resolves to ORG_ID; calling with ORG_ID still gets the env token.
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "seed-env-token" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("seed-env-token");
  });

  it("prefers a stored credential over the env var for a NON-seed tenant (stored always wins)", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "tenant-stored-token" },
    });
    const token = await resolveDavinciPasToken({
      orgId: OTHER_ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("tenant-stored-token");
  });

  it("returns null when the seed org cannot be resolved and no credential is stored", async () => {
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: () => Promise.resolve(null),
    });
    expect(token).toBeNull();
  });

  it("prefers a stored credential over the env var (seed org)", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "stored-token-abc" },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("stored-token-abc");
  });

  it("returns null when neither a stored credential nor the env var is present", async () => {
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: {},
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBeNull();
  });

  it("treats a blank stored token as unset and falls back to env (seed org)", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: { access_token: "   " },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
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
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("padded-token");
  });

  it("falls back to env (not crash) when the credential read errors, for the seed org", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: null,
      error: { message: "boom" },
    });
    const token = await resolveDavinciPasToken({
      orgId: ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBe("env-token-123");
  });

  it("does NOT fall back to env for a NON-seed tenant even when the credential read errors → null", async () => {
    stageSupabaseResponse("davinci_pas_credentials", "select", {
      data: null,
      error: { message: "boom" },
    });
    const token = await resolveDavinciPasToken({
      orgId: OTHER_ORG_ID,
      payerSlug: PAYER_SLUG,
      env: { [ENV_KEY]: "env-token-123" },
      resolveSeedOrgId: seedIsOrgId,
    });
    expect(token).toBeNull();
  });

  it("fails closed on a missing tenant", async () => {
    await expect(
      resolveDavinciPasToken({ orgId: "", payerSlug: PAYER_SLUG, env: {} }),
    ).rejects.toThrow(/non-empty orgId/);
  });
});
