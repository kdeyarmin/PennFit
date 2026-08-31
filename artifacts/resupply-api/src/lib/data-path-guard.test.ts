// Boot-time data-path guard. The migration guard's own matrix is tested
// exhaustively in lib/resupply-db/scripts/deploy-environment.test.ts;
// what matters here is the asymmetry this module deliberately introduces
// — refuse on a positive cross-tier match, warn (never crash) on
// ambiguity — because getting it backwards takes production dark over an
// unset variable.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fingerprintDatabaseUrl } from "@workspace/resupply-db/deploy-environment";

import { assertDataPathMatchesDeployment } from "./data-path-guard";

vi.mock("./logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { logger } = await import("./logger");

const PROD_DB =
  "postgresql://postgres:pw@db.prod-ref.supabase.co:5432/postgres";
const PROD_SUPABASE = "https://prod-ref.supabase.co";
const PREVIEW_SUPABASE = "https://preview-ref.supabase.co";

const PROD_DB_FP = (fingerprintDatabaseUrl(PROD_DB) as { fingerprint: string })
  .fingerprint;
const PROD_SUPABASE_FP = (
  fingerprintDatabaseUrl(PROD_SUPABASE) as { fingerprint: string }
).fingerprint;

function env(overrides: Record<string, string>): NodeJS.ProcessEnv {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("assertDataPathMatchesDeployment", () => {
  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  it("refuses a preview wired to the production Supabase project", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          DEPLOY_ENV: "preview",
          RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
          SUPABASE_URL: PROD_SUPABASE,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
        }),
      ),
    ).toThrow(/PRODUCTION/);
    expect(logger.error).toHaveBeenCalled();
  });

  it("refuses a preview wired to the production Postgres", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          DEPLOY_ENV: "preview",
          DATABASE_URL: PROD_DB,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_DB_FP,
        }),
      ),
    ).toThrow(/PRODUCTION/);
  });

  it("refuses a preview that declares DATABASE_ENV=production", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          RAILWAY_ENVIRONMENT_NAME: "pennfit-pr-9",
          DEPLOY_ENV: "preview",
          DATABASE_ENV: "production",
        }),
      ),
    ).toThrow();
  });

  it("never names the host or credentials in the refusal", () => {
    let message = "";
    try {
      assertDataPathMatchesDeployment(
        env({
          DEPLOY_ENV: "preview",
          SUPABASE_URL: PROD_SUPABASE,
          DATABASE_URL: PROD_DB,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_DB_FP,
        }),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("prod-ref.supabase.co");
    expect(message).not.toContain("pw@");
    expect(message).toContain(PROD_SUPABASE_FP);
  });

  it("allows a preview with its own Supabase project", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          DEPLOY_ENV: "preview",
          SUPABASE_URL: PREVIEW_SUPABASE,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
        }),
      ),
    ).not.toThrow();
  });

  it("allows production against production", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          DEPLOY_ENV: "production",
          RAILWAY_ENVIRONMENT_NAME: "production",
          SUPABASE_URL: PROD_SUPABASE,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
        }),
      ),
    ).not.toThrow();
  });

  it("WARNS but does not crash when the deployment identity is ambiguous", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          RAILWAY_PROJECT_ID: "30957b23",
          SUPABASE_URL: PROD_SUPABASE,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
        }),
      ),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("WARNS but does not crash when no production fingerprint is pinned", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({ DEPLOY_ENV: "preview", SUPABASE_URL: PREVIEW_SUPABASE }),
      ),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("stays quiet on a fully-configured local shell", () => {
    expect(() =>
      assertDataPathMatchesDeployment(
        env({
          SUPABASE_URL: PREVIEW_SUPABASE,
          PRODUCTION_SUPABASE_FINGERPRINT: PROD_SUPABASE_FP,
        }),
      ),
    ).not.toThrow();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
