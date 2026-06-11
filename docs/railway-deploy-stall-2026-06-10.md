# Railway deploy stall — June 10–11, 2026

**Status: RESOLVED (2026-06-11, between ~04:15 and 05:15 UTC).** A
deploy went through in that window and caught up the entire backlog:
migrations `0304` + `0305` applied via the pre-deploy migrator,
`verify:deploy` passes 3/3 against production, and the
`patient_packets.autofile_signed_pdf` flag is seeded and enabled. The
root cause was only visible from the Railway dashboard and is not
recorded here; if it recurs, the checklist below still applies.

Production had not deployed between ~20:05 UTC June 10 and the
resolution window — roughly nine hours — despite green CI on every
`main` commit. The original investigation follows, as written while
the incident was open.

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

## Probe pitfall discovered during this incident (read before declaring an outage)

A bare `curl https://<host>/` returns **404 on a perfectly healthy
deployment** of this app. The SPA history-fallback in
`artifacts/resupply-api/src/app.ts` only serves `index.html` to
requests whose `Accept` header includes `text/html` (so missing-API-route
fetches 404 as JSON callers expect, instead of silently receiving HTML).
Browsers always send it; curl's default `Accept: */*` does not — the
request falls through every handler to Express's default
`Cannot GET /`. The same applies to `/favicon.ico` (the SPA ships
`favicon.svg` / `favicon-32.png`, no `.ico`).

During this incident a parallel session probed with bare curl,
concluded the storefront was hard-down for ~14 hours, and built an
elaborate (wrong) "Railway ships images without the SPA" theory on top
— while real browsers were served the site the whole time. Probe with
the right instrument:

```bash
pnpm --filter @workspace/scripts verify:deploy -- https://<host>   # sends proper headers
curl -H "Accept: text/html" https://<host>/                       # manual equivalent
```

A bare-curl 404 on `/` with a 200 on `/resupply-api/healthz` is the
EXPECTED shape, not an outage signature. (The defensive changes from
that session — #683 boot guard, #687 SPA embed, #692 watchPatterns —
remain in place; they are sound independent of the misdiagnosis. The
incident-narrative comments they originally carried were corrected
after the fact.)

## Related

- [`docs/railway-deployment.md`](./railway-deployment.md) — how the
  Railway build/run pipeline is supposed to work.
- [`docs/railway-hosting-review-2026-05-29.md`](./railway-hosting-review-2026-05-29.md)
  — hosting audit, including the deploy-gating semantics of
  `preDeployCommand`.
- PR #683 ("Refuse SPA-less boot on Railway") and PR #687 ("Embed the
  built SPA inside resupply-api/dist") — deploy-adjacent fixes made
  during this window by parallel sessions.
