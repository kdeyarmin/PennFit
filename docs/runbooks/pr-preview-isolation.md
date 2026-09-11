# Isolate a Railway PR preview

A preview needs its own database **and** Supabase runtime project. Changing
`DATABASE_ENV` or disabling migrations does not isolate patient reads, writes,
storage, or background jobs. Keep the
[migration and runtime guards](migration-environment-guard.md) enabled.

## Current blocker (2026-09-11)

PR 1373's Railway environment `1275d316-9b22-4e00-a1fa-7e59f0a95d47`
(`PennFit-pr-1373`), service `b08cfa1c-9af3-417d-b298-6fd4921d2d23`, belongs to
project `30957b23-dfb7-4751-934c-25b212ec49b7`. Failed deployment
`59ef60f5-5d69-4125-86f8-ce017feb7f53` reported database fingerprint
`28616a064d1b`, also reported by the production baseline. The migration guard
exited before connecting or executing SQL. This is not a verified preview target.

The authenticated Supabase connector can list PennPaps
(`uppdjphagdildcgkvdsz`) and query its development branches. Its only non-default
branch, `bucket-b-dryrun` (`cgddjicbfhfsttnumwyi`), reports `MIGRATIONS_FAILED`.
Catalog checks found an incomplete application schema, no `organizations` or
`patient_packets` table, and no application migration ledger. It belongs to an
older task; do not repurpose, reset, or migrate it without authorization for that
specific branch. A successful SQL connection does not establish schema readiness.

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
   connection endpoint or resolve the ambiguity before deployment.
5. Check the branch schema and application ledger before migrating. Supabase's
   own migration history is separate from `migrations.resupply_migrations`.
   A branch can contain only part of the application schema even when its
   database is healthy. On a verified fresh target, apply the repository's
   authoritative `lib/resupply-db/migrations` with the application migrator.
   Reconcile a partially populated branch first; do not baseline migrations
   merely to suppress missing-schema errors. See
   [migration-ledger adoption](adopt-migration-ledger.md).

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

Supabase references: [branch troubleshooting](https://supabase.com/docs/guides/deployment/branching/troubleshooting)
[incomplete branch migrations](https://supabase.com/docs/guides/troubleshooting/branch-in-migrations-failed-status),
and [CLI reference](https://supabase.com/docs/reference/cli).
