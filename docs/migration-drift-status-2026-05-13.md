# Migration Drift Status Update — 2026-05-13

**Scope:** Status check on `P0.1`/`P0.2` from
[`docs/codebase-enhancements-2026-05-08.md`](./codebase-enhancements-2026-05-08.md)
and the prior root-cause writeup at
[`docs/migration-state-investigation-2026-05-08.md`](./migration-state-investigation-2026-05-08.md).

**TL;DR:** Drift has gotten **worse**, the recommendation in the 5/8
investigation still stands, and **no code-only PR can fix this safely**.
Production-state inspection is the next required step.

---

## What changed since 2026-05-08

| Metric                                | 2026-05-08                                       | 2026-05-13 | Δ         |
| ------------------------------------- | ------------------------------------------------ | ---------- | --------- |
| `_journal.json` entries               | 52                                               | 52         | 0         |
| `lib/resupply-db/drizzle/*.sql` files | 73                                               | **120**    | **+47**   |
| Files NOT in journal                  | 21                                               | **68**     | **+47**   |
| Highest SQL prefix on disk            | `0066`                                           | `0113`     | +47       |
| Duplicate prefix pairs                | 6                                                | 6          | 0         |
| `_journal.json` last tag              | `0049_physician_fax_outreach_status_pending_idx` | _same_     | unchanged |

The recent feature wave (therapy-cloud integrations, RBAC Phase A,
multi-device MFA, HIPAA retention sweep, loss-claim UI, POD, telehealth,
recall remediation, coaching plans, accreditation, etc.) shipped **47
new migration files between 0067 and 0113**. None of them were added to
`_journal.json`. The gap between the on-disk SQL files and the journal
that `migrate.mjs` actually applies is now **3.2× wider** than when the
5/8 investigation flagged it.

## What still applies from 5/8

Everything in [`migration-state-investigation-2026-05-08.md`](./migration-state-investigation-2026-05-08.md)
remains accurate:

- `migrate.mjs` calls `drizzle-orm/migrator`'s `migrate()` against the
  on-disk `lib/resupply-db/drizzle/` directory — it only reads files
  referenced by `meta/_journal.json` and silently skips the rest.
- A fresh-DB `migrate.mjs` run applies exactly 52 migrations and ends
  the schema at the 0049 state. The 68 unjournaled files include the
  patient-therapy-links table, the therapy-cloud-snapshot table, the
  HIPAA retention columns, the new RBAC granular-role column, the
  recall-remediation tables, etc. — i.e. most of what shipped in the
  last 6 weeks.
- Running `pnpm --filter @workspace/resupply-db run generate` is still
  destructive: it would overwrite the historical 0–51 entries and
  generate ~70+ auto-prefixed new migrations from a stale snapshot.
- The 6 duplicate prefixes (0016, 0017, 0049, 0050, 0052, 0065) are
  unchanged. As the 5/8 doc notes, the duplicates are mostly harmless
  — `drizzle-orm` matches by tag, not prefix — and are not the
  failure mode worth panicking about. The 68-file gap is.

## Why production is (presumably) still working

The 5/8 investigation listed three hypotheses; I have no new information
to narrow them. The most plausible-without-evidence option remains:

> A different migration mechanism is in use — e.g. a deploy step runs
> `pnpm --filter @workspace/resupply-db run generate` before
> `migrate.mjs`, or migrations were applied out of band via `psql`.

Confirming or refuting this remains gated on production-state inspection.

## What I changed in this doc vs the 5/8 one

Nothing new analytically — the 5/8 root-cause writeup is correct and
its open questions are unchanged. This file exists to:

1. Update the numeric drift counts so reviewers don't reach for the
   stale 5/8 figures (21-file gap, "0066" as the latest prefix).
2. Re-stamp the recommendation now that the issue is 3× larger.
3. Be reachable from the
   [`2026-05-13 app review`](./app-review-2026-05-13.md) `P0.1/P0.2`
   rows so future readers don't have to retrace the analysis.

## Open questions to resolve before re-attempting (unchanged from 5/8)

Carried forward verbatim because none of them have answers yet:

1. **Production migration table contents.** What does
   `SELECT id, hash, created_at FROM drizzle.resupply_migrations
ORDER BY created_at` return on production? Specifically: are there
   rows for the tags `0050_*` through `0113_*`?
2. **Deploy command sequence.** Does production's deploy pipeline run
   `pnpm --filter @workspace/resupply-db run generate` (or any
   `drizzle-kit` command) before `migrate.mjs`? If yes, the on-disk
   journal isn't authoritative.
3. **Live feature flags.** Are post-0067 features (therapy-cloud
   integrations, RBAC granular roles, multi-device MFA, recall
   remediation, HIPAA destruction queue, telehealth, POD, coaching
   plans, accreditation) live in production today? If yes, the
   schema MUST be applied somewhere — the question is just how to
   reconcile our local journal with that reality.

## Recommended next step

Run the production-state read-only psql queries (questions 1 + 2
above) and post the results into a follow-up ticket. **Do not** open
a code PR that renames or regenerates anything until the answers are
known. The 5/8 procedure in §"What needs to happen first" remains
the safe path once the data is in hand.

In the meantime, the `check-drizzle-drift.sh` step staying at
`continue-on-error: true` (per `.github/workflows/ci.yml:97`) is the
correct posture. Flipping it to fail-on-drift _before_ resolving the
root cause would block every PR.
