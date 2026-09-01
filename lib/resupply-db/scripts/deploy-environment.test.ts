// Regression tests for the deployment/database migration guard.
//
// THE INCIDENT
// ------------
// A Railway PR-preview environment inherited the production service's
// shared variables — DATABASE_URL among them — and its preDeployCommand
// applied an unmerged migration to the PRODUCTION database. Every case
// below is a point on the matrix that accident traced through, plus the
// paths that must keep working so the fix does not brick real deploys.
//
// The tests deliberately construct the production fingerprint from the
// same helper the guard uses, rather than hard-coding a digest: the salt
// is an implementation detail, "this URL is the production one" is not.

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations.
import {
  BREAK_GLASS_PHRASE,
  BREAK_GLASS_REASON_VAR,
  BREAK_GLASS_VAR,
  evaluateMigrationGuard,
  fingerprintDatabaseUrl,
  formatGuardReport,
  inferDeploymentTierFromPlatform,
  normalizeTier,
  resolveDatabaseIdentity,
  resolveDeploymentIdentity,
} from "./deploy-environment.mjs";

const PROD_URL =
  "postgresql://postgres:s3cret@db.prod-project.supabase.co:5432/postgres";
const PREVIEW_URL =
  "postgresql://postgres:other@db.preview-project.supabase.co:5432/postgres";
const LOCAL_URL = "postgresql://postgres:postgres@localhost:5432/resupply_ci";

const PROD_FINGERPRINT = (
  fingerprintDatabaseUrl(PROD_URL) as { fingerprint: string }
).fingerprint;

/** A bare env with none of the ambient CI/Railway variables leaking in. */
function env(overrides: Record<string, string | undefined>) {
  return { ...overrides } as NodeJS.ProcessEnv;
}

describe("fingerprintDatabaseUrl", () => {
  it("is stable for the same host/port/database", () => {
    expect(fingerprintDatabaseUrl(PROD_URL)?.fingerprint).toBe(
      PROD_FINGERPRINT,
    );
  });

  it("ignores credentials, so a password rotation does not change it", () => {
    const rotated = PROD_URL.replace("s3cret", "a-totally-different-password");
    expect(fingerprintDatabaseUrl(rotated)?.fingerprint).toBe(PROD_FINGERPRINT);
  });

  it("ignores query parameters (sslmode, pgbouncer, …)", () => {
    expect(
      fingerprintDatabaseUrl(`${PROD_URL}?sslmode=require&pgbouncer=true`)
        ?.fingerprint,
    ).toBe(PROD_FINGERPRINT);
  });

  it("distinguishes different databases on the same host", () => {
    const other = PROD_URL.replace(/\/postgres$/, "/postgres_shadow");
    expect(fingerprintDatabaseUrl(other)?.fingerprint).not.toBe(
      PROD_FINGERPRINT,
    );
  });

  it("returns null rather than throwing on junk", () => {
    expect(fingerprintDatabaseUrl("")).toBeNull();
    expect(fingerprintDatabaseUrl(undefined)).toBeNull();
    expect(fingerprintDatabaseUrl("not a url")).toBeNull();
  });

  it("never leaks the password or username", () => {
    const fp = fingerprintDatabaseUrl(PROD_URL) as Record<string, string>;
    expect(JSON.stringify(fp)).not.toContain("s3cret");
    expect(JSON.stringify(fp)).not.toContain("postgres:");
  });
});

describe("normalizeTier", () => {
  it.each([
    ["production", "production"],
    ["PROD", "production"],
    [" Live ", "production"],
    ["preview", "preview"],
    ["pr", "preview"],
    ["staging", "staging"],
    ["dev", "development"],
    ["ci", "test"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeTier(raw)).toEqual({ tier: expected });
  });

  it("returns null for unset", () => {
    expect(normalizeTier(undefined)).toBeNull();
    expect(normalizeTier("  ")).toBeNull();
  });

  it("refuses to guess at an unrecognized spelling", () => {
    expect(normalizeTier("prodction")).toEqual({
      tier: null,
      invalid: "prodction",
    });
  });
});

describe("inferDeploymentTierFromPlatform", () => {
  it.each([
    "PennFit-pr-1366",
    "pennfit-pr-1366",
    "pr-42",
    "pr_42",
    "preview-main",
    "ephemeral-7",
  ])("reads %j as a preview environment", (name) => {
    expect(
      inferDeploymentTierFromPlatform(env({ RAILWAY_ENVIRONMENT_NAME: name })),
    ).toEqual({ tier: "preview", signal: "RAILWAY_ENVIRONMENT_NAME" });
  });

  it("reads a deploy from a non-production branch as non-production", () => {
    expect(
      inferDeploymentTierFromPlatform(
        env({
          RAILWAY_ENVIRONMENT_NAME: "custom",
          RAILWAY_GIT_BRANCH: "claude/some-feature",
        }),
      ),
    ).toEqual({ tier: "preview", signal: "RAILWAY_GIT_BRANCH" });
  });

  it("honours PRODUCTION_GIT_BRANCH for a repo whose trunk is not main", () => {
    expect(
      inferDeploymentTierFromPlatform(
        env({
          RAILWAY_ENVIRONMENT_NAME: "production",
          RAILWAY_GIT_BRANCH: "release",
          PRODUCTION_GIT_BRANCH: "release",
        }),
      ),
    ).toEqual({ tier: "production", signal: "RAILWAY_ENVIRONMENT_NAME" });
  });

  it("has no opinion about an unrecognized environment name on trunk", () => {
    expect(
      inferDeploymentTierFromPlatform(
        env({
          RAILWAY_ENVIRONMENT_NAME: "eu-west",
          RAILWAY_GIT_BRANCH: "main",
        }),
      ),
    ).toBeNull();
  });
});

describe("resolveDeploymentIdentity", () => {
  it("treats a bare shell with no platform markers as development", () => {
    const identity = resolveDeploymentIdentity(env({}));
    expect(identity).toMatchObject({ tier: "development", ambiguous: false });
  });

  it("treats a bare shell under NODE_ENV=test as test", () => {
    expect(resolveDeploymentIdentity(env({ NODE_ENV: "test" }))).toMatchObject({
      tier: "test",
      ambiguous: false,
    });
  });

  it("is ambiguous on a platform container with no declared identity", () => {
    const identity = resolveDeploymentIdentity(
      env({ RAILWAY_PROJECT_ID: "30957b23" }),
    );
    expect(identity.ambiguous).toBe(true);
    expect(identity.reason).toContain("DEPLOY_ENV");
  });

  it("is ambiguous when DEPLOY_ENV is misspelled", () => {
    expect(
      resolveDeploymentIdentity(env({ DEPLOY_ENV: "produciton" })).ambiguous,
    ).toBe(true);
  });

  it("is ambiguous when an inherited production claim is denied by the platform", () => {
    const identity = resolveDeploymentIdentity(
      env({
        DEPLOY_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
      }),
    );
    expect(identity.ambiguous).toBe(true);
    expect(identity.reason).toContain("shared variable");
  });

  it("accepts production when the platform corroborates it", () => {
    expect(
      resolveDeploymentIdentity(
        env({
          DEPLOY_ENV: "production",
          RAILWAY_ENVIRONMENT_NAME: "production",
          RAILWAY_GIT_BRANCH: "main",
        }),
      ),
    ).toMatchObject({ tier: "production", ambiguous: false });
  });

  it("accepts a non-production declaration without corroboration", () => {
    expect(
      resolveDeploymentIdentity(
        env({ DEPLOY_ENV: "preview", RAILWAY_PROJECT_ID: "x" }),
      ),
    ).toMatchObject({ tier: "preview", ambiguous: false });
  });
});

describe("resolveDatabaseIdentity", () => {
  it("identifies production by fingerprint", () => {
    expect(
      resolveDatabaseIdentity(
        env({
          DATABASE_URL: PROD_URL,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        }),
      ),
    ).toMatchObject({ tier: "production", ambiguous: false });
  });

  it("lets the fingerprint override a DATABASE_ENV that disagrees", () => {
    const identity = resolveDatabaseIdentity(
      env({
        DATABASE_URL: PROD_URL,
        DATABASE_ENV: "preview",
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(identity.tier).toBe("production");
    expect(identity.reason).toContain("overriding");
  });

  it("accepts a comma-separated fingerprint list (primary + replica)", () => {
    expect(
      resolveDatabaseIdentity(
        env({
          DATABASE_URL: PROD_URL,
          PRODUCTION_DATABASE_FINGERPRINT: `deadbeefcafe, ${PROD_FINGERPRINT}`,
        }),
      ).tier,
    ).toBe("production");
  });

  it("proves a non-match is not production once a fingerprint is pinned", () => {
    expect(
      resolveDatabaseIdentity(
        env({
          DATABASE_URL: PREVIEW_URL,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        }),
      ),
    ).toMatchObject({ tier: "preview", ambiguous: false });
  });

  it("reads a loopback host as development", () => {
    expect(
      resolveDatabaseIdentity(env({ DATABASE_URL: LOCAL_URL })),
    ).toMatchObject({ tier: "development", ambiguous: false });
  });

  it("is ambiguous for a remote host with nothing declared", () => {
    expect(
      resolveDatabaseIdentity(env({ DATABASE_URL: PREVIEW_URL })).ambiguous,
    ).toBe(true);
  });

  it("is ambiguous when DATABASE_ENV is misspelled", () => {
    expect(
      resolveDatabaseIdentity(
        env({ DATABASE_URL: PREVIEW_URL, DATABASE_ENV: "prevue" }),
      ).ambiguous,
    ).toBe(true);
  });
});

describe("evaluateMigrationGuard — the decision matrix", () => {
  it("BLOCKS a preview deployment against the production database", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "preview",
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("nonproduction_deployment_production_database");
  });

  it("BLOCKS the exact incident shape: inherited DEPLOY_ENV=production in a PR environment", () => {
    const result = evaluateMigrationGuard(
      env({
        // Inherited from the production service's shared variables.
        DEPLOY_ENV: "production",
        RUN_DB_MIGRATIONS: "true",
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        // Set by Railway itself, per environment, and NOT inheritable.
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
        RAILWAY_GIT_BRANCH: "claude/episode-lifecycle-closeout",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("ambiguous_deployment_identity");
  });

  it("BLOCKS a PR deployment against production even with no fingerprint pinned", () => {
    const result = evaluateMigrationGuard(
      env({
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
        DATABASE_URL: PROD_URL,
        DATABASE_ENV: "production",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("nonproduction_deployment_production_database");
  });

  it("BLOCKS a local shell against the production database", () => {
    const result = evaluateMigrationGuard(
      env({
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("nonproduction_deployment_production_database");
  });

  it("BLOCKS a test runner against the production database", () => {
    const result = evaluateMigrationGuard(
      env({
        NODE_ENV: "test",
        DEPLOY_ENV: "test",
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it("BLOCKS a preview whose database tier nobody declared", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "preview",
        DATABASE_URL: PREVIEW_URL,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("ambiguous_database_identity");
  });

  it("BLOCKS an ambiguous deployment identity on a platform container", () => {
    const result = evaluateMigrationGuard(
      env({
        RAILWAY_PROJECT_ID: "30957b23",
        DATABASE_URL: LOCAL_URL,
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("ambiguous_deployment_identity");
  });

  it("BLOCKS when DATABASE_URL is absent entirely", () => {
    expect(evaluateMigrationGuard(env({ DEPLOY_ENV: "preview" })).allowed).toBe(
      false,
    );
  });

  it("ALLOWS a production deployment against the production database", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "production",
        RAILWAY_GIT_BRANCH: "main",
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("allowed");
    expect(result.warnings).toEqual([]);
  });

  it("ALLOWS a preview deployment against its own preview database", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "preview",
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
        DATABASE_URL: PREVIEW_URL,
        DATABASE_ENV: "preview",
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS a preview against a database proven non-production by fingerprint mismatch", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "preview",
        DATABASE_URL: PREVIEW_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
      }),
    );
    expect(result.allowed).toBe(true);
  });

  it("ALLOWS local development against a local database", () => {
    expect(
      evaluateMigrationGuard(env({ DATABASE_URL: LOCAL_URL })).allowed,
    ).toBe(true);
  });

  it("ALLOWS CI against its service-container database", () => {
    expect(
      evaluateMigrationGuard(
        env({ NODE_ENV: "test", CI: "true", DATABASE_URL: LOCAL_URL }),
      ).allowed,
    ).toBe(true);
  });

  it("ALLOWS a production deployment against an undeclared database, but warns", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "production",
        DATABASE_URL: PROD_URL,
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("production_deployment_undeclared_database");
    expect(result.warnings.join(" ")).toContain(
      "PRODUCTION_DATABASE_FINGERPRINT",
    );
  });
});

describe("evaluateMigrationGuard — break-glass", () => {
  const nonProdAgainstProd = {
    DEPLOY_ENV: "development",
    DATABASE_URL: PROD_URL,
    PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
  };

  it("is off by default", () => {
    expect(evaluateMigrationGuard(env(nonProdAgainstProd)).allowed).toBe(false);
  });

  it("stays closed when only the confirmation phrase is set", () => {
    const result = evaluateMigrationGuard(
      env({ ...nonProdAgainstProd, [BREAK_GLASS_VAR]: BREAK_GLASS_PHRASE }),
    );
    expect(result.allowed).toBe(false);
    expect(result.warnings.join(" ")).toContain(BREAK_GLASS_REASON_VAR);
  });

  it("stays closed when only a reason is set", () => {
    const result = evaluateMigrationGuard(
      env({
        ...nonProdAgainstProd,
        [BREAK_GLASS_REASON_VAR]:
          "INC-4412 restoring a dropped index after the outage",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.warnings.join(" ")).toContain(BREAK_GLASS_VAR);
  });

  it("stays closed on a near-miss confirmation phrase", () => {
    const result = evaluateMigrationGuard(
      env({
        ...nonProdAgainstProd,
        [BREAK_GLASS_VAR]: "true",
        [BREAK_GLASS_REASON_VAR]:
          "INC-4412 restoring a dropped index after the outage",
      }),
    );
    expect(result.allowed).toBe(false);
  });

  it("stays closed when the reason is a token gesture", () => {
    expect(
      evaluateMigrationGuard(
        env({
          ...nonProdAgainstProd,
          [BREAK_GLASS_VAR]: BREAK_GLASS_PHRASE,
          [BREAK_GLASS_REASON_VAR]: "fix",
        }),
      ).allowed,
    ).toBe(false);
  });

  it("opens only with both values, and reports the override", () => {
    const result = evaluateMigrationGuard(
      env({
        ...nonProdAgainstProd,
        [BREAK_GLASS_VAR]: BREAK_GLASS_PHRASE,
        [BREAK_GLASS_REASON_VAR]:
          "INC-4412 restoring a dropped index after the outage",
      }),
    );
    expect(result.allowed).toBe(true);
    expect(result.code).toBe("break_glass_override");
    expect(result.breakGlass.engaged).toBe(true);
  });

  it("cannot be used to paper over an ambiguous identity", () => {
    const result = evaluateMigrationGuard(
      env({
        DEPLOY_ENV: "production",
        RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
        DATABASE_URL: PROD_URL,
        PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        [BREAK_GLASS_VAR]: BREAK_GLASS_PHRASE,
        [BREAK_GLASS_REASON_VAR]:
          "INC-4412 restoring a dropped index after the outage",
      }),
    );
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("ambiguous_deployment_identity");
  });
});

describe("formatGuardReport", () => {
  it("emits a machine-parseable audit line", () => {
    const report = formatGuardReport(
      evaluateMigrationGuard(
        env({
          DEPLOY_ENV: "preview",
          DATABASE_URL: PROD_URL,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        }),
      ),
    );
    const jsonLine = report
      .split("\n")
      .find((line) => line.startsWith("{")) as string;
    expect(JSON.parse(jsonLine)).toMatchObject({
      event: "migration.guard.blocked",
      code: "nonproduction_deployment_production_database",
      deploymentTier: "preview",
      databaseTier: "production",
    });
  });

  it("shouts about a break-glass override", () => {
    const report = formatGuardReport(
      evaluateMigrationGuard(
        env({
          DEPLOY_ENV: "development",
          DATABASE_URL: PROD_URL,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
          [BREAK_GLASS_VAR]: BREAK_GLASS_PHRASE,
          [BREAK_GLASS_REASON_VAR]:
            "INC-4412 restoring a dropped index after the outage",
        }),
      ),
    );
    expect(report).toContain("BREAK-GLASS OVERRIDE");
    expect(report).toContain("INC-4412");
    expect(report).toContain('"event":"migration.guard.break_glass"');
  });

  it("never prints the database URL, host, or credentials", () => {
    const report = formatGuardReport(
      evaluateMigrationGuard(
        env({
          DEPLOY_ENV: "preview",
          DATABASE_URL: PROD_URL,
          PRODUCTION_DATABASE_FINGERPRINT: PROD_FINGERPRINT,
        }),
      ),
    );
    expect(report).not.toContain("s3cret");
    expect(report).not.toContain("db.prod-project.supabase.co");
    expect(report).toContain(PROD_FINGERPRINT);
  });
});
