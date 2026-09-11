# CareMetric Hub administration adapter

The Hub can request safe Breathe platform metadata at
`POST /resupply-api/central-admin/read`. This connection is **disabled by default**.
It does not create a native session, change billing, grant roles, or access patient
records. The current endpoint is an authenticated read API, not an in-app SSO
redirect or a replacement for every native platform operation.

## Authorization and configuration

The adapter accepts the Hub user's bearer JWT only. It calls the fixed issuer
`https://xgauehtwksmnoqhgqegm.supabase.co/rest/v1/rpc/authorize_platform_admin`
on every request. That RPC must verify the live session, platform-admin role, and
MFA assurance level `aal2`. There is no JWT payload-only trust, email inference,
browser cookie fallback, or configurable upstream destination.

The verified Hub UUID must appear in the explicit server configuration map. The
mapped **native** identity must currently exist in `resupply_auth.users`, have
`role = 'admin'`, `status = 'active'`, and a valid `email_verified_at`, and have a
current row in `resupply.platform_admins`. A native lock, revocation, demotion,
membership removal, or mapping removal denies the next read. Mappings confer no
native grants and the endpoint never writes identity tables.

| Server variable                      | Meaning                                                                                                                      |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `CAREMETRIC_ADMIN_ENABLED`           | Exactly `true` to enable; unset, empty, or `false` disables.                                                                 |
| `HUB_SUPABASE_PUBLISHABLE_KEY`       | The fixed Hub project's `sb_publishable_…` key. Never a secret/service key.                                                  |
| `CAREMETRIC_ADMIN_IDENTITY_MAP_JSON` | JSON object of explicit Hub UUID → native user ID pairs, with 1–100 distinct mappings.                                       |
| `RAILWAY_GIT_COMMIT_SHA`             | Existing Railway revision metadata; only a full hexadecimal SHA is returned by capabilities. `GIT_COMMIT_SHA` is a fallback. |

Native reads use the existing `getOrgScopedClient(seedOrgId).raw()` acquisition
path and existing deployment/database guards. The native service-role key remains
inside Breathe. The Hub does not receive it. Do not use `VITE_*` configuration for
adapter variables.

Hub IDs remain UUIDs. Native auth IDs are stored as TEXT: new accounts use the
database's UUID default, while existing opaque IDs remain supported. Mapping
values and staff IDs accept 1–128 ASCII letters, digits, underscores, or hyphens
starting with a letter/digit, and preserve native case. Organization and SaaS
subscription IDs remain UUIDs. Never invent a UUID conversion for an existing
native identity.

## Contract version 1

Successful responses use:

```json
{
  "contractVersion": 1,
  "product": "breathe",
  "operation": "overview",
  "generatedAt": "2026-09-11T18:00:00.000Z",
  "data": {}
}
```

The timestamp is response generation time, not proof that provider billing data
was recently synchronized. Billing is explicitly an `application_database`
snapshot; this API makes no Stripe calls.

| Operation                    | Request fields beyond `operation`                                                       | Response data                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `capabilities`               | None                                                                                    | `apiVersion: 1`, supported `operations`, deployed `sourceRevision` or null. Requires the full authorization boundary.                                                                                                                                                                                                          |
| `overview`                   | None                                                                                    | Exact `organizationCount`, `activeUserCount` of active staff only, and `subscriptionCount`.                                                                                                                                                                                                                                    |
| `organizations.list`         | Optional `search` on organization name, `limit`, `offset`                               | `items`, exact filtered `total`, `limit`, `offset`. Each item: `id`, `name`, `slug`, `status`, `createdAt`.                                                                                                                                                                                                                    |
| `users.list`                 | Optional `search` on email, `limit`, `offset`                                           | Staff `items`, exact filtered `total`, `limit`, `offset`. Each item: `id`, `email`, `displayName`, `role`, `status`, `createdAt`. Roles are strictly `admin` or `agent`; native `customer` identities are excluded and rejected if returned by an inconsistent upstream.                                                       |
| `billing.overview`           | None                                                                                    | `source: 'application_database'`, `subscriptionCount`, and `statusCounts` containing `{status,count}` for active, trialing, past_due, canceled. Uses exact HEAD counts; no revenue estimate.                                                                                                                                   |
| `billing.subscriptions.list` | Optional `search` on provider subscription ID, `organizationId` UUID, `limit`, `offset` | `source: 'application_database'`, `items`, exact filtered `total`, `limit`, `offset`. Each item: `id`, `organizationId`, `organizationName`, `planCode`, `planName`, `status`, `providerStatus`, `providerCustomerId`, `providerSubscriptionId`, `currentPeriodEnd`, `updatedAt`. Nullable native/provider fields remain null. |

List limits are 1–50 (default 20), offsets 0–10,000, search strings at most 100
characters. Search is a literal substring on the documented single column, with
SQL LIKE metacharacters escaped. Control characters and `*` are rejected. Paging
uses deterministic ordering with an ID tie-breaker. Requests reject unknown
fields and unimplemented operations. The staff directory is global; it does not
pretend that `resupply_auth.users` has an organization relationship.

Subscription rows include native historical/canceled records as well as current
records. `status` is Breathe's recorded lifecycle state; `providerStatus` is the
last recorded Stripe state. Counts are individual database reads, not a
transactional cross-operation snapshot. Billing status counts must sum to an
independent exact total; schema drift or concurrent updates that make those
counts disagree return `503 upstream`. No patient subscription, insurance claim,
payment method, billing note, custom metadata, credentials, or session data enters
the response.

## Ingress and failure behavior

The endpoint is mounted before the general Express body parser, with a 2 KB
request cap and the existing administrator read rate limiter. It rejects browser
`Origin` headers, native cookies, unsupported content types, and unsupported
methods. Requests have a 12-second abort deadline, propagated to the issuer and
PostgREST queries. Success output is projected onto reviewed columns and capped
at 512 KB. All responses are `no-store`; upstream exceptions and row contents are
never logged or echoed by the adapter.

Errors are `{ "error": { "code": "…" } }`:

- `401 unauthenticated`: missing/invalid bearer or rejected issuer session.
- `403 forbidden`: insufficient issuer/native role, MFA, mapping, or membership.
- `400 invalid_request`: invalid JSON, fields, search, or pagination.
- `413 invalid_request`: ingress body limit exceeded.
- `415 unsupported_content_type`: the handler requires JSON.
- `503 unconfigured`: disabled or invalid adapter configuration.
- `503 upstream`: failed native/issuer lookup, malformed data, or timeout. Missing
  counts do not become zero.

## Rollout and rollback

1. Merge and deploy the default-off code. Confirm the real endpoint returns JSON
   `503 unconfigured` rather than the SPA HTML fallback. This deployment alone
   grants no central access.
2. Verify the intended existing administrator's Hub UUID and native ID through
   controlled administration. Confirm the native account is active and verified
   and already has platform membership. Do not create grants based on matching
   email strings.
3. Configure the reviewed mapping and Hub publishable key on the Breathe server,
   then enable the adapter. Preserve the existing production/preview database
   separation.
4. Through an authenticated Hub AAL2 session, verify capabilities, source revision,
   overview, directories, and billing snapshots. Compare sample records to the
   native platform console. Confirm denied access from an unmapped identity and
   a non-platform role. Do not use synthetic production identity overrides.
5. Roll back by setting `CAREMETRIC_ADMIN_ENABLED=false`. Existing Breathe
   administration and native cookie sessions remain independent.

The repository includes fixture-based authorization/contract tests using the real
Supabase client HTTP query generation, plus Express ingress tests. These checks
do not establish a completed production login or a live Stripe reconciliation.

## App-owned Hub SMS sessions

The adapter also accepts opaque, one-use Hub SMS delegations. It calls the fixed Hub application authorization endpoint for the Breathe audience, checks the exact operation and SMS method, then retains the existing explicit identity mapping, active native administrator and platform-admin membership checks. No new Breathe variables or native sign-in session are created. Legacy Hub AAL2 tokens retain their original verification path. Deploy this adapter before the paired Hub SMS release; real SMS and administrator reads still require production validation.
