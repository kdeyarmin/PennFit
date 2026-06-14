# Runbook: preventing resupply migration-prefix collisions

## Symptom

`main` goes red on the **"Schema + codegen + architecture drift"** CI job
(`.github/workflows/ci.yml` → `drift`) with:

```
ERROR: duplicated resupply migration prefix(es) in the tree.
    prefix 03NN: 2 files (allowed 1)
        lib/resupply-db/drizzle/03NN_<series-a>.sql
        lib/resupply-db/drizzle/03NN_<series-b>.sql
```

This fired three times on 2026-06-14 alone (prefixes 0325–0330, 0337/0338,
0342 — fixed by PRs #788, #814, #824). Every branch cut from a red `main`
inherits the failing check, so it blocks unrelated work too.

## Why it keeps happening (the race)

Two PRs are opened off the same `main`. Each adds a migration with the
**same "next free" prefix** (e.g. both pick `0342_…`). While they're open:

- The **diff-based** per-PR check (`check-resupply-migration-prefix.sh`)
  passes on each — neither PR's own diff collides against its base.
- The **tree-wide** check (`check-resupply-migration-prefix-tree.sh`)
  passes on each — the duplicate doesn't exist yet on either branch.

Both merge. Only **after the second merge** does the tree-wide check (which
also runs on pushes to `main`) finally see two files sharing a prefix, and
`main` turns red. `migrate.mjs` applies migrations in filename order, so a
shared prefix makes apply order filesystem-dependent — a real correctness
hazard, not just a red check.

The checks are working as designed; what's missing is a **merge gate** that
forces the second PR to re-validate against the first before it lands.

## The durable fix (repo settings — requires admin)

Both parts are needed; either alone leaves the race open.

1. **Make the drift job a required status check.**
   GitHub → repo **Settings → Branches → Branch protection rule** for
   `main` → **Require status checks to pass before merging** → add
   **"Schema + codegen + architecture drift"**.

2. **Require branches to be up to date before merging.**
   Same rule → check **"Require branches to be up to date before merging."**
   This is the piece that closes the race: once PR A merges, PR B can no
   longer merge until it's rebased onto the new `main`; the rebase re-runs
   CI, and now the prefix checks see A's migration and **block B until it
   renumbers** — pre-merge instead of post-merge.

   Alternative (lower friction at higher PR volume): enable a **GitHub
   merge queue** for `main` with the drift job as a required check. The
   queue builds each PR against the actual post-merge tree, catching the
   collision before it lands without contributors hand-rebasing.

### Verify

Open a throwaway PR that adds `lib/resupply-db/drizzle/0016_dupe_test.sql`
(0016 is a known duplicate prefix). The drift check should fail and — with
the settings above — the PR should be **unmergeable** (not merely
"unstable").

## Interim remediation (when it has already happened)

`main` is red and needs to go green now. The tree check's own message says
it: **rename the most-recently-merged file(s) to the next free prefix.**

1. Identify the colliding prefix(es) from the failing job log.
2. For each, find which of the two files merged **most recently**
   (`git log -1 --format=%cI origin/main -- <file>` — compare in UTC).
   The newer one moves; it hasn't been applied anywhere yet.
3. Rename it (and, if it's the tail of an ordered series, the rest of that
   series, to keep intra-series apply order) to the next free prefix with
   `git mv` — **byte-identical content** so the immutability guard
   (`check-resupply-migration-immutability.sh`) still passes:

   ```bash
   git mv lib/resupply-db/drizzle/0342_asset_recovery_auto_populate_flag.sql \
          lib/resupply-db/drizzle/0343_asset_recovery_auto_populate_flag.sql
   ```

4. Do **NOT** extend the grandfathered allowlist in
   `check-resupply-migration-prefix-tree.sh` — that list freezes only the
   historical duplicates production has already applied.
5. Verify locally, then open a fix PR:

   ```bash
   bash scripts/check-resupply-migration-prefix-tree.sh
   BASE_REF=origin/main DIFF_TARGET= bash scripts/check-resupply-migration-prefix.sh
   BASE_REF=origin/main DIFF_TARGET= bash scripts/check-resupply-migration-immutability.sh
   ```

   The "Migration replay (Postgres)" CI job confirms the new apply order
   replays cleanly.

Worked examples: PRs #814 (0337/0338 → 0340–0342) and #824
(0342 → 0343).

## See also

- `lib/resupply-db/drizzle/README.md` — migration conventions.
- `docs/migration-state-investigation-2026-05-08.md` — why the journal is
  frozen and a code-only fix to the drift is unsafe.
- `docs/runbooks/adopt-migration-ledger.md` — the deploy-time migrator.
