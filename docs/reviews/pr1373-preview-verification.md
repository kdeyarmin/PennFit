# PR1373 hosted-preview CSR verification

## Status and scope

Hosted CSR verification and Railway readiness remain **pending**. CLI login is
complete. The dedicated Supabase preview is `dfwwhqeebadwpbzjnxuj`, branch
`pennfit-pr-1373` (`4baf93dc-fb0e-4b33-bef5-0b1c2916d8dc`), created without
production data. The deployed preview origin and commit still need verification
before app/browser tests. Local PostgreSQL/PostgREST results do not establish
that the hosted preview works.

Verified setup evidence on 2026-09-11:

- The new disposable branch was positively identified and reset to the local
  bootstrap; application object count was zero before application migrations.
- The initial hosted replay reached 0059, where the managed `auth` schema rejects
  custom-function CREATE. The fix preserves the 0059/0060 files and ledger hashes,
  adapts their pending executions to the owned `resupply_auth` helper, and appends
  migration 0546 to repoint existing application triggers. The hosted retry
  applied all 462 remaining migrations, completing the 526-migration chain;
  a second run applied zero migrations.
- All 526 migrations passed a separate native PostgreSQL 17 replay as a
  non-superuser without CREATE on `auth`. Both timestamp triggers updated real
  fixture rows, the managed-auth sentinel remained unchanged, and rerun applied
  zero migrations. Eight focused compatibility regressions and the broader
  61-test migration/guard suite passed (16 live-database tests skipped in that
  unit run).
- The preview Data API already exposes `graphql_public`, `public`, `resupply`,
  and `resupply_auth`; no settings change was needed.
- The preview initializer applied runtime grants and reported `READY`, with
  526 expected/applied migrations, no missing or unknown ledger entries, and
  schema/table/sequence/function/default privileges all verified. Actual Data API
  requests to `resupply.patients` and `resupply_auth.users` returned HTTP 200 for
  `service_role`; anonymous requests returned HTTP 401 with code `42501`.
- The actual preview Storage API passed signed upload and download checks and
  rejected public access to a private object. Both required buckets were verified
  again, and all probe objects were removed. These checks establish storage
  behavior only; they do not establish app authentication or CSR readiness.

See the [preview isolation runbook](../runbooks/pr-preview-isolation.md) for target
guards, credential handling, and managed-auth compatibility details.

Run against the approved preview only, after its migrations succeed. Keep real
vendor credentials absent and outbound automation disabled through the preview
configuration helpers. This plan verifies normal preview pages and the real
outreach configuration gate; it does not send messages, place calls, or establish
provider delivery.

## Routes and access

Use a verified fixture staff account belonging to the fixture organization, with
`patients.read` and `conversations.manage`. The `customer_service_rep` permission
set includes both. Complete any required preview onboarding/agreement setup so
the console is not blocked by its agreement gate.

| Purpose                     | UI                                                 | API                                                                                                                                                          |
| --------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Staff sign-in               | `/admin/sign-in?redirect=/admin/resupply-calendar` | `GET /resupply-api/auth/csrf`, then `POST /resupply-api/auth/sign-in` with `{email,password}`; MFA, if enabled, uses `/resupply-api/auth/sign-in/verify-mfa` |
| Confirm staff permissions   | Admin console                                      | `GET /resupply-api/me`                                                                                                                                       |
| Agreement gate              | Admin onboarding                                   | `GET /resupply-api/admin/agreements`                                                                                                                         |
| Patient supplies and orders | `/admin/patients/<patientId>?tab=resupply`         | `GET /resupply-api/admin/patients/<patientId>/supply-overview?offset=0`; next page uses `offset=25`                                                          |
| Calendar                    | `/admin/resupply-calendar`                         | `GET /resupply-api/admin/resupply-calendar?from=<ISO>&to=<ISO>&overdue=false`                                                                                |
| Due now and overdue         | **Due now & overdue** button                       | Same calendar endpoint, `overdue=true`; `from` is the current instant and `to` is one day later                                                              |
| Individual or bulk outreach | **Email**, **SMS**, **Automated call**             | `POST /resupply-api/admin/resupply-outreach` with `{episodeIds:[...],channel:"email"\|"sms"\|"voice"}`                                                       |
| Delivery/reply review       | `/admin/conversations`                             | No new conversation is expected from the no-delivery checks below                                                                                            |

Use the normal browser session. Mutations require the `pf_csrf` cookie echoed in
`X-PF-CSRF`; session cookies must remain same-origin. The outreach body accepts
1–50 episode UUIDs and has no dry-run parameter.

## Synthetic fixtures

Resolve the target organization by the fixture account's membership. If using
the migrated seed organization, look up slug `penn-home-medical`; its UUID is
generated during migration, not a constant. Every fixture gets random UUIDs and
a unique `csr-preview-<UUID>` marker in the patient name and `pacware_id`.
Keep `phone_e164` and `email` NULL and create no consent or communication rows.

Let `T` be the fixture creation instant. Use active adult patients, timezone
`America/New_York`, and `cadence_override_days=90`. Prescriptions are active,
have `cadence_days=90`, and validity dates `2000-01-01` through `2099-12-31`.
Use `MASK-<marker>` for the seeded A7034/90-day replacement rule and
`CUSTOM-<marker>` for an unmapped supply. A products row is unnecessary: the
overview displays the SKU when no product name exists.

| Patient                    | Fixture content                                                                                                                    | Expected result                                                                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| A — due, multiple supplies | MASK last ordered/shipped `T−91d`, current cycle due `T−1d`; CUSTOM prescription created `T−91d`, no orders, cycle also due `T−1d` | One patient, two supply cycles; MASK eligible by replacement rule; CUSTOM **Needs eligibility review** |
| B — due                    | MASK last ordered/shipped `T−95d`, cycle due `T−5d`                                                                                | Second patient available for a bulk selection                                                          |
| C — future                 | MASK last ordered/shipped `T−80d`, cycle due `T+10d`                                                                               | Future calendar date; **Interval opens** date; individual overview outreach disabled                   |
| D — expired cycle          | Active prescription and an outreach cycle due `T−2d`, but `expires_at=T−1h`                                                        | Excluded from calendar and due-recipient selection                                                     |

Use `outreach_pending` for current cycles, with expiry safely after the due date
except D. Keep prescription creation dates and latest supplied dates aligned
with each cycle's due date. This makes the fixture work whether the tenant uses
authoritative episode dates or the legacy last-supply-plus-cadence calculation.

Give A 26 fulfillment rows to exercise pagination. Reference a separate historical
`fulfilled` episode; the newest row is at `T−91d`, with older rows 180 days apart.
Set `created_at=shipped_at`, `status='shipped'`, integer `quantity=1` (one older
row can have quantity 2), and unique `pacware_order_ref` markers. An optional
`delivered_at` one day after shipment exercises the delivery column.

These columns are used by the existing migrated local browser fixtures. Seed
inside a transaction and retain a manifest of the exact organization, patient,
prescription, episode, and fulfillment IDs. Cleanup must target only that
manifest and marker, never a shared tenant's entire patient table.

## Verification sequence and expected evidence

1. Record the verified preview origin, deployed commit, migration result, and
   `/resupply-api/readyz` response. Sign in normally and confirm the expected
   organization and permissions through `/resupply-api/me`.
2. Search the calendar for the fixture marker. **Due now & overdue** should show
   A and B as **2 patients · 3 supply cycles**; C is future and D is absent.
   Verify C on its calendar date. Display dates follow the practice timezone,
   even if the browser uses another timezone.
3. Open A's **Orders & eligibility** dialog and its patient **Resupply** tab.
   Check both supplies, last ordered dates, replacement-rule wording, order
   references, quantities, shipment/delivery dates, and **1–25 of 26**. Use
   **Older**, then **Newer**, and verify the last order and return navigation.
4. Select A individually, then A and B together. Each of the three outreach
   buttons should open a confirmation listing the selected patient names once
   per patient. Cancel each dialog and confirm no outreach POST occurred.
   Filtering to a different visible set must clear hidden selections.
5. With vendor credentials still absent and the queue ready, submit one
   individual and one bulk confirmation for each channel. The actual preview
   endpoint should return **503 `channel_not_configured`** and the UI should
   show an error without marking any patient queued. Inspect the real request:
   the bulk payload has one episode per selected patient, not every supply
   cycle. Repeated attempts remain available; no job or conversation is created.
6. A **503 `queue_unavailable`** instead means the queue infrastructure is not
   ready; record that as a blocker to the channel-gate check. Authentication,
   CSRF, agreement, or tenant failures must be resolved rather than relabeled as
   successful CSR verification.

The endpoint checks channel configuration before patient-specific skip reasons.
Therefore this credential-free hosted run cannot demonstrate successful queueing,
missing-contact/48-hour skip results, partial delivery, or provider acceptance.
Those behaviors are covered by local fixtures and mocked-provider regressions.
Do not turn intercepted browser responses into claimed hosted queue/delivery
evidence, and do not add fake vendor credentials merely to pass the gate.
