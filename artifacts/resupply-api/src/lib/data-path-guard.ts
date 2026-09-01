// data-path-guard.ts — refuse to boot a preview that is wired to
// production patient data.
//
// The migration guard (lib/resupply-db/scripts/deploy-environment.mjs)
// stops a non-production deployment from changing production's SCHEMA.
// This stops one from reading and writing production's ROWS, which is the
// same misconfiguration one layer down: the runtime data path is Supabase,
// and a preview that inherited SUPABASE_URL + the service-role key can
// serve, mutate and export production PHI without applying a migration.
//
// The rule is deliberately asymmetric with the migrator's, and the
// asymmetry is the whole design:
//
//   * The migrator refuses on AMBIGUITY, because a refused
//     preDeployCommand gates the deploy and the previous release keeps
//     serving. The cost of a false positive is a deploy that does not
//     happen.
//   * This refuses only on a POSITIVE, unambiguous cross-tier violation,
//     because a boot refusal has no previous release to fall back to for
//     a first deploy, and taking production dark over an unset variable
//     is a worse outcome than the one being prevented. Ambiguity here is
//     logged loudly and allowed.
//
// Both halves live in the same module so they cannot drift.

import { evaluateRuntimeDataPathGuard } from "@workspace/resupply-db/deploy-environment";

import { logger } from "./logger";

/**
 * Evaluate the runtime data-path guard and throw when a non-production
 * deployment is positively pointed at production data.
 *
 * Called from the boot-env assertion module so it runs before the HTTP
 * listener binds — a refusal fails the health check, which is how a
 * deploy is rejected here.
 *
 * @param env - Environment to inspect. Defaults to `process.env`.
 */
export function assertDataPathMatchesDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  const result = evaluateRuntimeDataPathGuard(env);

  for (const warning of result.warnings) {
    logger.warn(
      { event: "boot.data_path_guard.warning", code: result.code },
      `data-path guard: ${warning}`,
    );
  }

  if (!result.safe) {
    logger.error(
      {
        event: "boot.data_path_guard.refused",
        code: result.code,
        deploymentTier: result.deploymentTier,
      },
      "data-path guard: refusing to boot",
    );
    throw new Error(`[data-path-guard] ${result.message}`);
  }
}
