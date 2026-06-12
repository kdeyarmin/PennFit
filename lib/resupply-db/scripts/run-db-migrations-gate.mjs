// RUN_DB_MIGRATIONS gate classification, shared by deploy-migrate.mjs
// and its tests. Kept in its own module because deploy-migrate.mjs
// runs (and exits) at import time, so it can't be imported by a test.
//
// Historically the gate was an exact-string `=== "true"` check, which
// meant `TRUE`, `True `, or `1` silently skipped migrations while the
// deploy proceeded — the exact schema-drift incident class in
// docs/git-state-2026-05-01.md (app-review 2026-06-10, P2-16).
//
// Classification:
//   - truthy spellings (true/1/yes/on, any case, trimmed) → "run"
//   - falsy spellings (unset/""/false/0/no/off)           → "skip"
//   - anything else                                       → "invalid"
//     An operator who set the flag intended migrations to run;
//     silently skipping on a typo is the dangerous outcome, so the
//     caller must fail the deploy loudly on "invalid".

/**
 * Classify a raw RUN_DB_MIGRATIONS value.
 *
 * @param {string | undefined} raw
 * @returns {"run" | "skip" | "invalid"}
 */
export function classifyRunDbMigrations(raw) {
  const normalized = (raw ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return "run";
  if (["", "false", "0", "no", "off"].includes(normalized)) return "skip";
  return "invalid";
}
