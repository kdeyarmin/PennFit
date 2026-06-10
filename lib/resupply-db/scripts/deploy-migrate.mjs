// Deploy-time migration hook — wired into railway.json as the
// `preDeployCommand`, so it runs once per deploy (in the built image,
// before the new release goes live) and GATES the deploy on success: a
// non-zero exit makes Railway keep the previous release running.
//
// Opt-in by design. It runs the migrator ONLY when RUN_DB_MIGRATIONS is
// exactly "true". With the flag unset (the default) it is a no-op that
// exits 0, so wiring this hook into railway.json is safe to merge and
// deploy BEFORE production's migration ledger has been baselined —
// otherwise the very first deploy would try a full 0000.. replay onto an
// already-populated, unledgered database (the migrator's own adoption
// guard would abort that, which would in turn fail every deploy until
// the baseline ran).
//
// One-time adoption from env (no shell needed) — set these on the
// service for ONE deploy, then remove them:
//
//   RUN_DB_MIGRATIONS=true
//   MIGRATIONS_BASELINE_THROUGH=0187
//   MIGRATIONS_BASELINE_EXCEPT=0272_payer_profile_completeness,0276_pa_payers_phase2
//
// When MIGRATIONS_BASELINE_THROUGH is set, the hook first runs the
// migrator in baseline mode (stamp the already-applied range <= that
// prefix as applied WITHOUT executing, leaving the EXCEPT tags pending),
// then runs a normal migrate that applies only the pending tail (the
// excepted payer migrations + everything above the cutoff). Both the
// baseline and the apply gate the deploy. After the cutover deploy
// succeeds, delete MIGRATIONS_BASELINE_THROUGH / _EXCEPT so subsequent
// deploys just run a normal (usually no-op) migrate. Re-running with the
// vars still set is safe — the baseline is idempotent (skips
// already-stamped migrations). See docs/runbooks/adopt-migration-ledger.md.
//
// The migrator is started as a child process (not imported) so its
// process exit code is forwarded verbatim and its advisory-lock /
// connection-retry behavior is identical to a manual invocation.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.env.RUN_DB_MIGRATIONS !== "true") {
  process.stdout.write(
    "[deploy-migrate] RUN_DB_MIGRATIONS is not 'true' — skipping migrations " +
      "for this deploy (set RUN_DB_MIGRATIONS=true once the ledger is baselined).\n",
  );
  process.exit(0);
}

const migratePath = fileURLToPath(new URL("./migrate.mjs", import.meta.url));

/** Run migrate.mjs with the given args; exit the process on failure. */
function runMigrate(args, label) {
  process.stdout.write(`[deploy-migrate] ${label}...\n`);
  const result = spawnSync(process.execPath, [migratePath, ...args], {
    stdio: "inherit",
  });
  if (result.error) {
    process.stderr.write(
      `[deploy-migrate] failed to launch migrator (${label}): ${result.error.message}\n`,
    );
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    process.stderr.write(
      `[deploy-migrate] migrator exited ${result.status} (${label}) — failing the deploy.\n`,
    );
    process.exit(result.status ?? 1);
  }
}

// One-time adoption: baseline the already-applied range first.
const baselineThrough = process.env.MIGRATIONS_BASELINE_THROUGH?.trim();
if (baselineThrough) {
  const except = process.env.MIGRATIONS_BASELINE_EXCEPT?.trim();
  const args = [`--baseline-through=${baselineThrough}`];
  if (except) args.push(`--baseline-except=${except}`);
  runMigrate(
    args,
    `one-time ledger baseline (through ${baselineThrough}${except ? `, except ${except}` : ""})`,
  );
}

// Apply pending migrations (the whole history on a fresh DB; only the
// pending tail once the ledger is baselined/healthy).
runMigrate([], "applying pending migrations");
process.stdout.write("[deploy-migrate] migrations complete.\n");
process.exit(0);
