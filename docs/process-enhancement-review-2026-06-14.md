# Process Enhancement & Functionality Review — 2026-06-14

**Scope.** Review the repository's operational, delivery, data, support, and
user-facing processes for enhancements that improve reliability, reduce manual
work, and make functionality easier to operate. This complements the
2026-05-21 simplification review by focusing on repeatable processes rather
than individual funnel friction.

**Inputs reviewed.** `CLAUDE.md`, `README.md`, root `package.json`,
`scripts/`, the existing process simplification review, runbooks, deploy
configuration, and the two runnable app packages.

---

## Executive priorities

1. **Add one command for local readiness.** Developers currently stitch
   together Node version checks, `.env` loading, local Supabase startup, API
   startup, and SPA startup from docs. A `pnpm dev:doctor` or `pnpm dev:ready`
   script should validate the prerequisites and print exact next commands.
2. **Promote production preflight into the default release gate.** The repo has
   strong checks, but deployment-specific validation remains separate from the
   root `verify` script. Add a documented release command that chains static
   checks, migration checks, env preflight, and deploy verification.
3. **Make background jobs observable from one place.** Many patient and admin
   outcomes depend on pg-boss jobs. Add a worker operations dashboard/runbook
   that shows schedules, feature flags, last success, failure counts, and manual
   "run now" links per dispatcher.
4. **Turn existing process reviews into a backlog.** The May review is rich,
   but it is a long recommendation document. Convert findings into a scored
   tracking table with owner, impact, effort, risk, and status so improvements do
   not get lost.
5. **Standardize incident and rollback drills.** Deployment, migrations, queue
   processing, and integrations have good primitives. Operators need a concise
   "if X fails, do Y" playbook and quarterly drill checklist.

---

## Current strengths

- **Clear monorepo contract.** The repo documents the two runnable apps, shared
  libraries, Node/pnpm versions, and standard verification commands in one
  place.
- **Defensive deploy posture.** Railway deploys run migrations before the new
  release is live, with migration execution controlled by an explicit flag.
- **Architecture drift checks exist.** Custom scripts enforce route gates,
  migration immutability, migration prefix ordering, TypeScript syntax, and
  schema drift.
- **Local Supabase bootstrap is automated.** A single helper brings up the local
  Supabase stack, applies migrations, grants data-API roles, creates storage,
  and seeds a dev admin.
- **Integrations degrade gracefully.** Optional vendors are designed to skip or
  fail-soft when credentials are absent.

---

## Findings and recommendations

### 1. Developer onboarding and local readiness

**Today.** Local development requires several correct steps: Node 24, pnpm,
Docker daemon, Supabase startup, `.env` sourcing, API command, and SPA command.
The instructions are accurate, but the process is manual and easy to partially
complete.

**Enhancement.** Add a root script such as `pnpm dev:doctor` that checks:

- `node --version` satisfies `24.x`.
- `pnpm --version` satisfies the package manager pin.
- Docker is reachable or prints the exact `dockerd` fallback command.
- `.env` exists and contains the local Supabase defaults required by the API.
- Supabase containers are running and `/resupply-api/readyz` dependencies can be
  reached once the API is started.
- `PORT`, `BASE_PATH`, and `API_PROXY_TARGET` are either exported or printed for
  the SPA command.

**Better functionality.** Developers get deterministic setup feedback before
opening three terminals. This also reduces false bug reports caused by Node ABI,
Docker, or missing-env issues.

**Suggested implementation path.** Create `scripts/src/dev-doctor.ts`, expose it
from `scripts/package.json`, then add a root `dev:doctor` script. Keep it
read-only and side-effect free by default; offer `--fix-local-db` as a separate
flag that invokes `scripts/dev-local-supabase.sh`.

### 2. Verification and release gates

**Today.** Root `pnpm verify` runs lint, typecheck, architecture checks, and
workspace tests. Production-specific checks live in separate scripts and
runbooks.

**Enhancement.** Add a release-specific command, for example
`pnpm verify:release`, that runs:

1. `pnpm verify`.
2. `pnpm format:check`.
3. `pnpm audit` with the existing high-severity threshold.
4. `pnpm --filter @workspace/scripts preflight:prod` when the required env file
   or environment is present.
5. A dry-run or read-only migration ledger check.
6. Optional `scripts/src/verify-deploy.ts` against a supplied preview URL.

**Better functionality.** Contributors can distinguish "safe to merge" from
"safe to deploy." This makes Railway preview validation more repeatable and
keeps deploy-only assumptions close to code.

**Suggested implementation path.** Start with documentation and a package script
that skips env-bound checks with an explicit warning when required variables are
missing. Avoid blocking local development on production secrets.

### 3. Database and migration operations

**Today.** Migration guidance is detailed, including adoption history and a hard
warning not to hand-edit the frozen Drizzle journal. The local bootstrap applies
hundreds of SQL migrations and grants Supabase data-API roles.

**Enhancement.** Add a compact migration operator checklist covering:

- How to verify the local ledger after `scripts/dev-local-supabase.sh`.
- How to inspect pending production migrations before a Railway deploy.
- How to recover when PostgREST schema cache or role grants lag newly-created
  objects.
- What files are immutable and what generated files can be regenerated.

**Better functionality.** Operators get a shorter action-oriented checklist
without re-reading the full architecture notes during a release window.

**Suggested implementation path.** Add `docs/runbooks/migration-operations.md`
and link it from `CLAUDE.md` near the migration deploy contract.

### 4. Background jobs, reminders, and automation

**Today.** The API process also boots the pg-boss worker. Many dispatchers are
environment- and feature-flag gated, including reminders, cart abandonment,
coaching, billing, packet reminders, and failed email digests.

**Enhancement.** Create a worker operations surface that lists each dispatcher
with:

- Feature flag / env gate state.
- Cron expression or schedule source.
- Last run, last success, last failure, and next scheduled run.
- Queue depth and retry count.
- Manual run-now action with audit logging.
- Patient-impact summary, such as "may send SMS/email/fax".

**Better functionality.** Staff can distinguish "job disabled," "job scheduled
but idle," and "job failing" without reading logs or env vars. This is
especially important for patient communications and money-moving jobs.

**Suggested implementation path.** First add an internal API endpoint that
normalizes worker status; then render it in the admin Control Center. Keep
manual run actions behind existing admin authorization and audit logs.

### 5. Admin support workflow

**Today.** The admin console covers orders, patients, billing, integrations,
returns, calls, and operational controls. The prior process review identified
several workflows where staff still trigger automation manually.

**Enhancement.** Group admin work by operational queue rather than underlying
resource type:

- **Needs patient contact**: failed emails, pending reminders, call follow-ups,
  incomplete packets.
- **Needs billing action**: eligibility failures, bill holds, claim rejects,
  autopay exceptions.
- **Needs fulfillment action**: abandoned carts, return approvals, prescription
  requests, shipment exceptions.
- **Needs integration action**: vendor auth failures, stale syncs, webhook
  signature failures.

**Better functionality.** Staff get a daily triage view that turns raw system
state into next actions. This reduces context switching across admin sections.

**Suggested implementation path.** Start with a read-only "Operations Inbox"
that deep-links into existing pages. Add mutation actions only after the queue
semantics stabilize.

### 6. Patient storefront and account processes

**Today.** The May simplification review already documents patient-facing
friction: duplicate consent, limited prefill, token-only reminder management,
questionnaire skip handling, return discoverability, and account navigation.

**Enhancement.** Convert those recommendations into a scored implementation
backlog with columns for patient impact, engineering effort, compliance risk,
analytics event, and rollout flag.

**Better functionality.** The team can ship the highest-confidence improvements
first and measure abandonment, completion, and support-ticket deltas per change.

**Suggested implementation path.** Add `docs/process-enhancement-backlog.md` or
issue templates that seed the top recommendations. Prioritize no-schema changes
first: account navigation, signed-in reminder links, order prefill, and clearer
skip states.

### 7. Integration lifecycle

**Today.** Vendor integrations are optional and degrade gracefully when keys are
unset. Office Ally and therapy-cloud flows have dedicated packages and runbooks.

**Enhancement.** Add a standard integration lifecycle checklist:

- Credential presence and expiry checks.
- Sandbox smoke test.
- Production smoke test.
- Webhook signature verification check.
- Last successful inbound and outbound exchange.
- Owner and escalation contact.
- Feature flag / kill switch location.

**Better functionality.** Integrations move from "configured or not" to a
visible lifecycle with health, ownership, and rollback levers.

**Suggested implementation path.** Represent this as metadata in code or a JSON
registry, then render the registry in admin Integrations and reuse it in
`preflight-prod-env.ts`.

### 8. Security, compliance, and auditability

**Today.** The codebase has audit, auth, secrets, PHI sweep, MFA, and webhook
verification concepts. Production env validation exists for critical settings.

**Enhancement.** Add a recurring compliance process:

- Monthly audit-log sampling for admin mutations and manual job runs.
- Quarterly webhook secret rotation checklist.
- Quarterly PHI retention sweep verification.
- MFA enforcement review for admin users.
- Access review for service-role keys and third-party dashboards.

**Better functionality.** Security work becomes a repeatable process with
artifacts instead of an ad hoc review after incidents.

**Suggested implementation path.** Add a checklist runbook and store completed
reviews as dated files under `docs/compliance/`.

### 9. Observability and incident response

**Today.** Health and readiness endpoints exist, deployment verification scripts
exist, and many features fail gracefully. The missing piece is one operator path
from symptom to root cause.

**Enhancement.** Add an incident runbook organized by symptom:

- Site unavailable.
- API readiness failing.
- Queue backlog growing.
- Sign-in failures.
- Email/SMS/fax delivery failures.
- Payment or checkout failures.
- Migration failure during deploy.
- Supabase/PostgREST schema-cache mismatch.

For each symptom, include first commands, dashboards/logs, likely causes,
rollback options, and customer-communication guidance.

**Better functionality.** On-call response becomes faster and less dependent on
tribal knowledge.

**Suggested implementation path.** Start with a one-page
`docs/runbooks/incident-response.md`, then expand each symptom after the first
real drill.

### 10. Documentation discoverability

**Today.** The important information exists, but it is distributed between
`README.md`, `CLAUDE.md`, runbooks, ADRs, and dated reviews.

**Enhancement.** Add a documentation index with clear audiences:

- New developer setup.
- Daily development.
- Testing and verification.
- Release and rollback.
- Database and migrations.
- Integrations.
- Security/compliance.
- Admin operations.

**Better functionality.** Humans and agents both find the right process faster,
and future docs can be attached to an obvious home.

**Suggested implementation path.** Add `docs/README.md` as the top-level index
and link it from the root `README.md`.

---

## Suggested near-term roadmap

### Week 1: Make local and release checks obvious

- Add `pnpm dev:doctor`.
- Add `pnpm verify:release` with clear skip messages for secret-bound checks.
- Add `docs/README.md` documentation index.

### Week 2: Improve operations visibility

- Add worker status API shape and read-only admin view.
- Add migration operations runbook.
- Add incident response starter runbook.

### Week 3: Convert recommendations into delivery backlog

- Convert the May process simplification findings into a scored backlog.
- Pick two low-risk patient-flow improvements for implementation.
- Add analytics events before/after those changes.

### Week 4: Integration and compliance hardening

- Add integration lifecycle registry/checklist.
- Add quarterly compliance checklist templates.
- Run a rollback and queue-failure tabletop drill.

---

## Acceptance criteria for follow-up work

- Every new process has a single owner, a command or UI entry point, and a clear
  pass/fail signal.
- Env- or secret-bound checks never fail mysteriously; they either run or print
  the exact missing prerequisite.
- Patient-contacting and money-moving automation always exposes gate state,
  last execution, and audit trail.
- Process documentation links to executable scripts whenever possible.
- Reviews become backlog items with status, not static documents.
