// End-to-end regression test for the deploy-time migration guard.
//
// deploy-environment.test.ts proves the decision matrix is right. This
// proves the decision is actually WIRED — that `deploy-migrate.mjs` (the
// literal `preDeployCommand` in railway.json) consults it and refuses,
// and that `migrate.mjs` refuses independently when invoked by hand.
//
// A unit test of the classifier cannot catch the regression that matters
// here: someone deleting the two lines that call it. So these spawn the
// real scripts as subprocesses, with the exact environment shape of the
// incident, and assert on the process exit code.
//
// No database is required or contacted: the guard runs before the pool
// is constructed, which is itself part of what is being asserted — a
// refused deploy must not so much as open a socket to the database it
// was told not to touch.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error — plain .mjs module without type declarations.
import { fingerprintDatabaseUrl } from "./deploy-environment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEPLOY_MIGRATE = resolve(HERE, "deploy-migrate.mjs");
const MIGRATE = resolve(HERE, "migrate.mjs");

/**
 * A host that does not exist. If the guard ever lets a run through that
 * it should not have, the migrator will try to connect and we will see a
 * connection failure rather than a silent pass — which is why the
 * positive-control test below asserts on the guard's own log line rather
 * than on exit 0.
 */
const PROD_URL = "postgresql://u:p@db.prod-guard-test.invalid:5432/postgres";
const PROD_FP = (fingerprintDatabaseUrl(PROD_URL) as { fingerprint: string })
  .fingerprint;

/** Exit code the guard uses; distinct from 1 (migration failed) and 2. */
const GUARD_REFUSED = 3;

function run(script: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [script], {
    env: { PATH: process.env.PATH ?? "", ...env },
    encoding: "utf8",
    timeout: 60_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("deploy-migrate.mjs — the railway.json preDeployCommand", () => {
  it("refuses the incident shape: a PR preview carrying production's DATABASE_URL", () => {
    const { code, stdout } = run(DEPLOY_MIGRATE, {
      RUN_DB_MIGRATIONS: "true",
      // Inherited from the production service's shared variables.
      DEPLOY_ENV: "production",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
      // Set by Railway per environment; not inheritable.
      RAILWAY_ENVIRONMENT_NAME: "PennFit-pr-1366",
      RAILWAY_GIT_BRANCH: "claude/episode-lifecycle-closeout",
    });
    expect(code).toBe(GUARD_REFUSED);
    expect(stdout).toContain('"event":"migration.guard.blocked"');
  });

  it("refuses a preview deployment honestly labelled as one", () => {
    const { code } = run(DEPLOY_MIGRATE, {
      RUN_DB_MIGRATIONS: "true",
      DEPLOY_ENV: "preview",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    expect(code).toBe(GUARD_REFUSED);
  });

  it("never prints the production host or credentials while refusing", () => {
    const { stdout, stderr } = run(DEPLOY_MIGRATE, {
      RUN_DB_MIGRATIONS: "true",
      DEPLOY_ENV: "preview",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    const output = stdout + stderr;
    expect(output).not.toContain("db.prod-guard-test.invalid");
    expect(output).not.toContain("u:p@");
    expect(output).toContain(PROD_FP);
  });

  it("still no-ops when RUN_DB_MIGRATIONS is off, without consulting the guard", () => {
    const { code, stdout } = run(DEPLOY_MIGRATE, {
      DEPLOY_ENV: "preview",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    expect(code).toBe(0);
    expect(stdout).toContain("skipping migrations");
  });

  it("lets a production deployment through to the migrator", () => {
    const { stdout } = run(DEPLOY_MIGRATE, {
      RUN_DB_MIGRATIONS: "true",
      DEPLOY_ENV: "production",
      RAILWAY_ENVIRONMENT_NAME: "production",
      RAILWAY_GIT_BRANCH: "main",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    // The DNS name is deliberately unresolvable, so the run fails at
    // connect. What matters is that it got past the guard to try.
    expect(stdout).toContain('"event":"migration.guard.allowed"');
  });
});

describe("migrate.mjs — invoked by hand", () => {
  it("refuses a developer's shell pointed at production", () => {
    const { code, stdout } = run(MIGRATE, {
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    expect(code).toBe(GUARD_REFUSED);
    expect(stdout).toContain(
      '"code":"nonproduction_deployment_production_database"',
    );
  });

  it("refuses an ambiguous identity on a platform container", () => {
    const { code } = run(MIGRATE, {
      RAILWAY_PROJECT_ID: "30957b23",
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
    });
    expect(code).toBe(GUARD_REFUSED);
  });

  it("opens only with both break-glass values, and announces itself", () => {
    const { code, stdout } = run(MIGRATE, {
      DATABASE_URL: PROD_URL,
      PRODUCTION_DATABASE_FINGERPRINT: PROD_FP,
      DANGEROUSLY_ALLOW_PRODUCTION_DB_MIGRATION_FROM_NONPRODUCTION:
        "I-UNDERSTAND-THIS-WRITES-TO-PRODUCTION",
      MIGRATION_BREAK_GLASS_REASON:
        "INC-4412 restoring a dropped index after the outage",
    });
    expect(code).not.toBe(GUARD_REFUSED);
    expect(stdout).toContain("BREAK-GLASS OVERRIDE");
    expect(stdout).toContain('"event":"migration.guard.break_glass"');
  });

  it("keeps working for local development against a local database", () => {
    const { code, stdout } = run(MIGRATE, {
      DATABASE_URL: "postgresql://postgres:postgres@localhost:1/none",
    });
    expect(code).not.toBe(GUARD_REFUSED);
    expect(stdout).toContain('"event":"migration.guard.allowed"');
  });
});
