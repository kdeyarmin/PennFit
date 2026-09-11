# Isolate a Railway PR preview

A preview needs its own database **and** Supabase runtime project. Changing
`DATABASE_ENV` or disabling migrations does not isolate patient reads, writes,
storage, or background jobs. Keep the
[migration and runtime guards](migration-environment-guard.md) enabled.

## Provisioning status (2026-09-11)

PR 1373's Railway environment `1275d316-9b22-4e00-a1fa-7e59f0a95d47`
(`PennFit-pr-1373`), service `b08cfa1c-9af3-417d-b298-6fd4921d2d23`, belongs to
project `30957b23-dfb7-4751-934c-25b212ec49b7`. Failed deployment
`59ef60f5-5d69-4125-86f8-ce017feb7f53` reported database fingerprint
`28616a064d1b`, also reported by the production baseline. The migration guard
exited before connecting or executing SQL. This is not a verified preview target.

A dedicated branch was created in the existing PennPaps organization after the
provisioning cost confirmation ($0.01344/hour):

| Resource                                            | Identifier                             |
| --------------------------------------------------- | -------------------------------------- |
| Supabase parent (production)                        | `uppdjphagdildcgkvdsz`                 |
| Dedicated branch                                    | `pennfit-pr-1373`                      |
| Branch ID                                           | `4baf93dc-fb0e-4b33-bef5-0b1c2916d8dc` |
| Preview project reference                           | `dfwwhqeebadwpbzjnxuj`                 |
| Production database fingerprint observed in Railway | `28616a064d1b`                         |
| Production Supabase URL fingerprint                 | `47654561c718`                         |
| Preview Supabase URL fingerprint                    | `34b9a42a14f9`                         |

The observed production database fingerprint is the direct project endpoint on
port 5432. The equivalent connection URL with the default port omitted hashes to
`9b7fdb5b3be3`; the preview configuration pins both spellings of that endpoint.

The new branch has `with_data=false`; read-only checks found zero patients and
zero Supabase Auth users. Its automatic Supabase migration replay stopped after
35 platform migrations, leaving 85 application relations, no `organizations` or
`patient_packets` table, and no application migration ledger. The branch reports
`MIGRATIONS_FAILED` even though the database itself is `ACTIVE_HEALTHY`. It needs
initialization from the repository's authoritative application migrations before
Railway can use it. No preview deployment has passed readiness yet.

The older `bucket-b-dryrun` branch (`cgddjicbfhfsttnumwyi`) also has an incomplete
schema and belongs to another task. Do not repurpose or reset it. Production and
that older branch were not modified during this setup.

Railway's connected OAuth tool returns variable names with values redacted. The
available Supabase connector retrieves publishable keys, but has no operation to
retrieve a branch's database password or server `service_role` key. The installed
CLI supports `supabase branches get`, but its read-only credential request failed
because the CLI has no access token. Connector authentication is separate from
CLI authentication.

## Prepare the target and credentials

1. Select a dedicated PR branch or project and confirm its ownership, permitted
   lifetime, and cost before provisioning. Obtain explicit permission before
   resetting any existing branch. Use synthetic data; never copy patient rows,
   production storage objects, or production authentication/session rows.
2. Have the account owner authenticate the local CLI with `supabase login`, or
   supply a Supabase personal access token through a protected process
   environment (`SUPABASE_ACCESS_TOKEN`). Do not put tokens in chat, command-line
   arguments, repository files, or logs. Reconnecting the existing SQL connector
   alone does not authenticate the CLI.
3. Read `supabase branches get --help`, then retrieve the **selected preview
   branch's** details with `branches get <branch-name-or-id> --project-ref
<parent-project-ref> --output json`. Capture stdout privately in memory or
   protected secret storage; this output can include credentials. Transfer only
   that branch's database URL, Supabase URL, and server key into the preview's
   secret variables. If a server key is not included, the installed CLI 2.109.1
   also supports `projects api-keys --project-ref <preview-project-ref> --reveal
--output json`; capture that output privately too. Do not substitute an
   anon/publishable key for a server key.
4. Verify that the migration/queue database and runtime Supabase URL resolve to
   the same preview project. For pooled database URLs, check the project identity
   in the connection's username as well as its host. Never change the guard's
   production pins to make a pooled-host collision pass; use an identifiable
   connection endpoint or resolve the ambiguity before deployment. Use the direct
   or session endpoint on port 5432; the transaction pooler on port 6543 cannot
   preserve the migrator's session advisory lock.
5. Check the branch schema and application ledger before migrating. Supabase's
   own migration history is separate from `migrations.resupply_migrations`.
   A branch can contain only part of the application schema even when its
   database is healthy. On a verified fresh target, apply the repository's
   authoritative `lib/resupply-db/migrations` with the application migrator.
   Reconcile a partially populated branch first; do not baseline migrations
   merely to suppress missing-schema errors. See
   [migration-ledger adoption](adopt-migration-ledger.md).

For a **newly created disposable branch only**, the supported clean-start path
is `supabase db reset --linked --no-seed`. Use a separate working directory
containing this repository's `supabase/config.toml` and bootstrap migration,
explicitly link it to the verified new project reference, and re-check the
linked reference immediately before reset. This drops that branch's existing
user-created database entities and replays the local bootstrap. It does not
apply the 525 application migrations. Never run it against the parent project
or an older branch containing someone else's work.

After reset, verify the app schemas contain no application tables, views,
functions, or ledger. Run `node lib/resupply-db/scripts/migrate.mjs` with the
isolated connection and production fingerprint guards, without baseline or
break-glass arguments. A second run must report no pending migrations. Supabase's
platform migration ledger and `migrations.resupply_migrations` serve different
purposes; neither can substitute for the other.

## Configure only the selected Railway preview

| Variable                                                            | Preview value or action                                                                   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                      | Dedicated preview migration/queue database                                                |
| `SUPABASE_URL`                                                      | Matching preview Supabase runtime project                                                 |
| `SUPABASE_SERVICE_ROLE_KEY`                                         | Server key belonging to that preview project                                              |
| `SUPABASE_STORAGE_BUCKET_PRIVATE`, `SUPABASE_STORAGE_BUCKET_PUBLIC` | Buckets verified in that preview project                                                  |
| `DEPLOY_ENV`, `DATABASE_ENV`                                        | `preview`                                                                                 |
| `RUN_DB_MIGRATIONS`                                                 | `true` only after target identity/schema checks pass                                      |
| `PRODUCTION_DATABASE_FINGERPRINT`                                   | Verified production endpoint fingerprints, including all production host spellings in use |
| `PRODUCTION_SUPABASE_FINGERPRINT`                                   | Verified production runtime fingerprint                                                   |
| `MIGRATIONS_BASELINE_THROUGH`, `MIGRATIONS_BASELINE_EXCEPT`         | Remove inherited one-time production adoption settings                                    |
| `RESUPPLY_LINK_HMAC_KEY`                                            | Preview-specific signing secret                                                           |
| Public callback/base URLs and allowed origins                       | Preview URLs only                                                                         |
| `APP_CONFIG_OVERLAY_DISABLED`                                       | `1`, preventing stored configuration from overriding preview environment variables        |

Production fingerprint pins identify targets; they are not secrets. Obtain them
from verified production configuration without printing connection strings or
keys. A fingerprint mismatch is meaningful only when the production pins cover
every production endpoint in use. Production pins may be shared intentionally;
deployment labels and preview credentials must be scoped to their environment.

Review inherited email, SMS, voice, AI, payment, and manufacturer credentials
before starting the preview. Remove production delivery credentials or replace
them with verified test configurations; keep optional dispatchers disabled and
seed only synthetic recipients. Do not treat a successful deployment as permission
to contact patients or trigger external transactions.

There is no global worker-disable flag. Keep the worker running for queue
readiness, but disable each outbound dispatcher feature flag for every synthetic
tenant (including the seed tenant). Clear inherited provider credentials with
empty preview overrides when deletion would expose a shared parent value. Set
all specific public/callback URL aliases as well as `PUBLIC_BASE_URL`; an
inherited alias can otherwise keep generating production links.

On a fresh database, explicitly grant `service_role` usage of the application
schemas and access to their tables, sequences, and functions. Set corresponding
default privileges **FOR ROLE postgres**, the application migration creator.
Expose `resupply` and `resupply_auth` through managed PostgREST and preserve
anonymous/authenticated restrictions and RLS. Verify packet RPC permissions with
real role checks. Create private `attachments` and public `public-assets` buckets
through the Storage API and verify uploads using synthetic documents.

Create the preview admin using `auth:set-admin-password`, passing `ADMIN_PASSWORD`
only through a protected process environment. Verify the email address for that
specific synthetic user in the preview database; no email delivery is needed.
Avoid the demo seed defaults, which enable outbound flags and use a known
password. Sample patients need explicit overdue/current/future supply dates and
fulfillment history to exercise the CSR calendar.

## Repeatable preview helpers

With the preview connection and guard variables loaded through a protected
process environment, inspect its identity, schema, ledger, and runtime grants:

```sh
node scripts/preview/init.mjs --project-ref=dfwwhqeebadwpbzjnxuj --branch-id=4baf93dc-fb0e-4b33-bef5-0b1c2916d8dc
```

The helper verifies live branch metadata using the authenticated Supabase CLI or
`SUPABASE_ACCESS_TOKEN`. It rejects the parent/production project, conflicting
endpoints, transaction pooling, baseline settings, and break-glass settings
before connecting. Its default is read-only. `MIGRATIONS_REQUIRED`,
`RESET_REQUIRED`, and `GRANTS_REQUIRED` are incomplete setup states, not reasons
to bypass checks. `RESET_REQUIRED` requires operator review; the helper never
resets a schema or stamps a ledger.

After the authoritative migrator succeeds, add `--apply-grants` and
`--confirm-disposable-project=dfwwhqeebadwpbzjnxuj` to provision the runtime grants.
The helper verifies each required privilege and rolls back incomplete changes.

Generate the nonsecret Railway overrides with:

```sh
node scripts/preview/config.mjs --origin=https://resupply-api-pennfit-pr-1373.up.railway.app
```

This manifest pins the exact PR service/environment and includes no private
credentials. Merge its three required secrets privately, then apply only to the
pinned preview with deployment skipped until initialization is complete.

Resolve the seed and all active synthetic organization UUIDs. Inspect the
outbound-disable plan before applying it:

```sh
node scripts/preview/disable-outbound.mjs --org-ids=<seed-uuid>,<synthetic-uuid>
```

Its default is a read-only transaction. Add `--apply` and
`--confirm-disposable-project=dfwwhqeebadwpbzjnxuj` to disable outbound flags. The
helper requires every active organization plus the seed organization, preserving
module navigation and eligibility enforcement. Run it after any additional
tenant seeding and before starting the preview worker.

Focused regression checks run through the normal scripts package:

```sh
pnpm --filter @workspace/scripts exec vitest run preview
```

## Verify before handing off

1. Run the guard with the preview's actual configuration and confirm its
   migration database and runtime targets are positively non-production. Never
   use break-glass variables or relabel a production connection as preview.
2. Confirm the application migration ledger reaches the checked-out revision and
   that PostgREST exposes `resupply` and `resupply_auth` with the expected grants.
   Check runtime reads against synthetic fixture identifiers in the same target.
3. Deploy only this preview after configuration review. Confirm health/readiness,
   database and queue connectivity, and preview hostname/callback routing.
4. Run the authenticated CSR calendar, patient order/eligibility, and individual/
   bulk selection browser checks with synthetic fixtures. Keep provider sends
   intercepted or test-only. Verify fixture cleanup and record the isolated
   target and deployment IDs without credentials.
5. Remove the dedicated preview resources when their approved lifetime ends.

The concrete fixture and no-delivery browser checklist is in
[PR1373 hosted-preview verification](../reviews/pr1373-preview-verification.md).

Local setup validation on 2026-09-11 passed 52 helper regressions and eight checks
against PostgreSQL 17, including the complete 525-migration ledger, incomplete
table/sequence/default-grant rejection, public storefront table permissions,
packet RPC restrictions, and outbound flags preserving navigation. SQL fixtures
and permission changes were rolled back. The existing app also booted with the
preview override manifest and isolated local database/PostgREST credentials;
readiness reported `db=ok` and `queue=ok`. Those helper processes were stopped.
Hosted migration, storage, authentication, and CSR browser verification remain
pending; local readiness does not establish a working hosted preview.

Supabase references: [branch troubleshooting](https://supabase.com/docs/guides/deployment/branching/troubleshooting)
[incomplete branch migrations](https://supabase.com/docs/guides/troubleshooting/branch-in-migrations-failed-status),
and [CLI reference](https://supabase.com/docs/reference/cli).
