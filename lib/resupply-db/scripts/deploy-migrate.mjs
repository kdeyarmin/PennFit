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
// the baseline ran). The intended rollout:
//
//   1. Baseline prod's ledger ONCE (see
//      docs/runbooks/adopt-migration-ledger.md):
//        DATABASE_URL=<prod> node lib/resupply-db/scripts/migrate.mjs \
//          --baseline-through=<last-applied-prefix>
//      then apply the pending tail with a normal run.
//   2. Set RUN_DB_MIGRATIONS=true on the Railway service.
//   3. From then on every deploy auto-applies pending migrations and
//      fails the deploy (previous release stays live) if one errors.
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
process.stdout.write("[deploy-migrate] running database migrations...\n");
const result = spawnSync(process.execPath, [migratePath], { stdio: "inherit" });

if (result.error) {
  process.stderr.write(
    `[deploy-migrate] failed to launch migrator: ${result.error.message}\n`,
  );
  process.exit(1);
}
process.exit(result.status ?? 1);
