# Manual deploys (turning off deploy-on-every-merge)

By default, Railway's GitHub integration auto-deploys production from the
**`main`** branch: every merge into `main` builds and ships. This runbook
documents how to switch to **manual-only** deploys. There is **no
`railway.json` field** for this — auto-deploy is controlled in the Railway
dashboard, not in repo config — so at least one dashboard change is
required no matter which option you pick.

Pick one of the two options below.

## Option A — Disable auto-deploy in Railway (dashboard only)

Simplest. Nothing in the repo changes; deploys keep coming from `main` but
only when you trigger them.

1. Open the Railway project → click the **PennFit** service.
2. **Settings** tab → **Source** / **Build & Deploy** section (shows the
   connected GitHub repo + branch).
3. Turn **off automatic deploys** — depending on your Railway UI version
   this is an **"Automatic Deploys" / "Auto Deploy"** toggle, or removing
   the branch deploy trigger.
4. To deploy from then on, either:
   - click **Deploy / Redeploy** on the service in the dashboard, or
   - run the Railway CLI against the prod environment:
     ```bash
     railway up          # build + deploy current main HEAD
     # or
     railway redeploy    # re-ship the latest build
     ```

Merges into `main` will now queue but not ship until you trigger a deploy.

## Option B — Deploy from a dedicated `release` branch (git-native)

Keeps all per-deploy control in git: merges to `main` never deploy; you
"deploy" by advancing the `release` branch. The `release` branch already
exists (created off `main`).

**One-time dashboard change:**

1. Railway project → **PennFit** service → **Settings** → **Source**.
2. Change the deployed branch from **`main`** to **`release`** (leave
   automatic deploys ON — they now only fire on `release`).

**To deploy** (ship whatever is on `main`):

```bash
git fetch origin
git checkout release
git merge --ff-only origin/main   # fast-forward release up to main
git push origin release           # this push triggers the Railway deploy
```

To deploy a _specific_ commit rather than all of `main`, fast-forward
`release` to that commit's SHA instead of `origin/main`.

> Keep `release` strictly behind/equal to `main` (fast-forward only). Don't
> commit directly to `release` — it's a deploy pointer, not a work branch.

## Notes

- **Preview environments are unaffected.** PR-branch preview builds come
  from Railway's PR integration, separate from the production branch
  trigger; disabling production auto-deploy does not turn those off.
- **Migrations** still run via the `preDeployCommand` on each _actual_
  deploy (gated by `RUN_DB_MIGRATIONS=true`), so deferring a deploy also
  defers its migrations — expected.
- After any manual deploy, verify the API is routed:
  ```bash
  pnpm --filter @workspace/scripts verify:deploy -- https://<host>
  ```
