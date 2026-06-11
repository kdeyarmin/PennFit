# Railway deploy stall — June 10–11, 2026

**Status when written (2026-06-11 04:00 UTC): OPEN.** Production has
not deployed since ~20:05 UTC on June 10. Resolution requires the
Railway dashboard (see the checklist at the bottom); nothing in the
repo is broken.

## Symptom

Pushes to `main` stopped producing production deployments. The site
stays up and healthy throughout — Railway keeps serving the last good
release, which is the designed failure mode — but new merges never go
live and the pre-deploy migrator never runs.

## Timeline (all times UTC, June 10)

| Time           | Event                                                                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~16:00         | Last fully-normal deploy cycle (morning merge train, migrations through `0300`).                                                                  |
| 17:49          | PR #672 merges (`.railwayignore` only — does not match `railway.json` watchPatterns, so correctly no deploy).                                     |
| 18:46          | PR #673 merges (e-sign overhaul, migrations `0301`/`0302`). **No deploy** for ~75 minutes despite green CI.                                       |
| 20:02          | PR #675 merges (migration `0303`). **A deploy triggers and succeeds** (~20:05), carrying #673's changes + migrations `0301`–`0303`.               |
| 21:37          | PR #681 merges. Its main-branch CI run is **cancelled** (superseded by #682's push 19s later). No deploy.                                         |
| 21:37–22:40    | PRs #682, #683, #684, #685 (migrations `0304`/`0305`), #686, #687 merge. All have green CI on main. **No deploys.**                               |
| 22:40          | PR #687 merges — notably a deploy-targeted fix ("Embed the built SPA inside resupply-api/dist so it rides the surviving layer"). Still no deploy. |
| 04:00 (Jun 11) | Migrations `0304`/`0305` remain unapplied in production; ~43 commits / 8 hours of work undeployed.                                                |

## Evidence gathered

- **DB ledger:** `resupply.patient_packets.chart_document_id` (mig 0305)
  and the secondary-claims unique index (mig 0304) absent in production;
  everything through 0303 present. The `preDeployCommand` migrator
  therefore never ran after the 20:05 deploy — failures are **before or
  at build time**, not at boot (a boot crash would still have applied
  migrations first).
- **GitHub CI:** every undeployed main commit has a green `CI` workflow
  except `7a274bc4` (#681), whose run was cancelled by concurrency.
  So a Railway "wait for CI" gate can explain at most that one commit.
- **Origin probes:** `pennfit.up.railway.app` (bypassing Cloudflare)
  serves the 20:05 release — not an edge-cache artifact.
- **Ruled out:** `.railwayignore` (excludes only non-build paths; `e2e`
  is not a pnpm workspace importer), `railway.json` (intact, watch
  patterns match the changed files), repo-side build breakage (the
  "Railway prod build (Node 24)" CI job passes on every commit).

## Why this is dashboard-only from here

Anything that distinguishes "trigger never fires" from "deploy starts
and dies in build/preDeploy" lives exclusively in Railway's deployment
list and build logs. There is no Railway API access from the dev
environment, and pre-applying the pending migrations by hand was
deliberately avoided (the migrator's ledger wouldn't record them, and
the non-idempotent 0304 index would then fail the real deploy).

## Operator checklist (Railway dashboard)

1. **PennFit service → Deployments.** Two possible pictures:
   - _No entries since ~4 PM ET:_ the GitHub trigger is disconnected or
     paused. Check Settings → Source (repo connection, trigger branch
     `main`, any "wait for CI" toggle), and the Railway GitHub App's
     repo access.
   - _Failed/skipped entries:_ open the build log of the first failure —
     it names the cause directly. #683/#687 already fixed an SPA-dist
     issue speculatively; the log will confirm or refute.
2. **Either way, hit Deploy on latest `main`.** One manual deploy
   catches everything up: the migrator applies `0304` + `0305` in order
   before the release goes live; no manual DB steps are needed.
3. **Afterwards, verify:** `pnpm --filter @workspace/scripts
verify:deploy -- https://pennpaps.com`, and confirm
   `patient_packets.chart_document_id` exists (migration 0305).
4. If the trigger was broken, consider a post-fix probe: merge any
   trivial change and confirm a deployment entry appears within a
   minute or two.

## Related

- [`docs/railway-deployment.md`](./railway-deployment.md) — how the
  Railway build/run pipeline is supposed to work.
- [`docs/railway-hosting-review-2026-05-29.md`](./railway-hosting-review-2026-05-29.md)
  — hosting audit, including the deploy-gating semantics of
  `preDeployCommand`.
- PR #683 ("Refuse SPA-less boot on Railway") and PR #687 ("Embed the
  built SPA inside resupply-api/dist") — deploy-adjacent fixes made
  during this window by parallel sessions.
