# ADR 012 — No Turborepo, no Husky, no GitHub Actions

## Context

The original plan called for Turborepo for task orchestration, Husky +
lint-staged for pre-commit hooks, and GitHub Actions for CI.

This monorepo already runs pnpm workspaces with a small set of root scripts
(`build`, `typecheck`). Replit does not run Husky pre-commit hooks the same
way local dev environments do, and the project does not currently push to
GitHub on every change.

## Decision

- **No Turborepo.** Use the existing pnpm workspace + root scripts.
  - `pnpm run typecheck` builds composite libs first, then typechecks
    every leaf workspace package.
  - `pnpm run build` runs typecheck then `pnpm -r run build`.
  - For per-package commands: `pnpm --filter @workspace/resupply-api run dev`.
- **No Husky / lint-staged.** Replaced by a Replit "validation step"
  (`resupply-check`) that runs ESLint + `tsc --noEmit` + `vitest run`
  across the resupply tree. Operators run it on demand and the deploy
  gate runs it before publishing.
- **No GitHub Actions in Phase 0.** The validation steps above replace
  CI for the prototyping phase. If the project leaves Replit, GH Actions
  becomes the next-step gate; the same shell commands apply.

## Consequences

- Smaller surface area to maintain.
- We give up Turborepo's remote build cache. For a repo this size the
  caching win is negligible.
- We give up Husky's "you cannot commit broken code" guarantee. The
  validation step gives the same coverage on demand and at deploy.

## Alternatives Considered

- **Add Turborepo for the cache + pipeline DAG** — premature optimization.
- **Husky** — does not fit the Replit edit-and-save model.
- **GitHub Actions for the prototyping phase** — extra plumbing, no
  benefit over the local validation step until we have an external
  deploy target.

## TODO

- When the project leaves Replit (if ever), add real CI. The shell
  commands in the `resupply-check` validation step are the same ones
  CI will run.
