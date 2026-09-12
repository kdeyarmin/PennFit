# Application functional review — September 11, 2026

Baseline: `8f9b40c7bd55d1d282f0b50b73169705ba12b5ed` on `main`.

This pass combined workflow inspection, regression reproductions, the workspace
test suite, browser scenarios, and read-only production probes. It covered the
admin console, patient and order workflows, resupply eligibility and shipment
recording, session transitions, and the patient fitter/signing flows. It is not
a claim that every feature or external integration has been validated.

## Corrections

| Area                        | Reproduced problem                                                                                                                    | Result                                                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CSR order history           | Only the newest 25 signature orders were reachable. Failed history reads could also look like an empty history.                       | Paged history, retry/previous-page recovery, and loading guards on row actions.                                                                          |
| Signed orders               | Resend and Cancel were offered for signed orders, although the API rejects both.                                                      | Actions match the order lifecycle.                                                                                                                       |
| Order status wording        | An email status of `sent` appeared as “Delivered,” which could be mistaken for a physical supply delivery.                            | Email status is explicitly labelled “Email sent”; email delivery timestamps identify the channel.                                                        |
| Patient search              | Prior search results remained selectable during the next search's debounce.                                                           | Stale matches cannot be selected while the query changes.                                                                                                |
| Patient navigation          | Switching between cached patient records retained unsaved header/settings forms. Deep links could retain the old active tab.          | Patient-owned editors reset on a record change, and requested tabs follow navigation.                                                                    |
| Replacement eligibility     | A broad SKU prefix could include a different HCPCS family; a different SKU prefix for the same code could be omitted.                 | Each dispense uses its most specific SKU mapping, and allowances aggregate by HCPCS code across paged patient history.                                   |
| Shipment dates              | JavaScript normalized impossible dates; invalid/future delivery dates could reach persistence.                                        | Ship and delivery dates must be real calendar dates and pass chronology checks.                                                                          |
| Shipment concurrency        | A shipment update could overwrite a cancellation that won after the initial read.                                                     | The atomic update also excludes cancelled rows; a missed update is reread before lifecycle repair.                                                       |
| Signature canvas            | Resizing erased a drawing, and returning to Draw mode could leave an empty canvas marked as signed.                                   | Drawings survive resize and remounted canvases report their actual empty state.                                                                          |
| Fitter invitations          | Provider rerenders or StrictMode effect replay could abandon a pending invitation request.                                            | The current effect receives the shared pending result.                                                                                                   |
| Signing recovery            | A transient error had no usable retry after the token was removed from the address bar; a refresh error could hide completed signing. | Retry retains the token in memory; completed signing survives transient errors while expired/withdrawn links still take precedence.                      |
| Shared workstation sessions | Account data remained cached after sign-out; unfinished reads and writes could restore it later.                                      | Session changes cancel old queries, purge cached account data, clear both identities, and guard late cache writes against the session that started them. |

New regression tests exercise the failing behavior, including delayed responses,
cached patient navigation, signature resize/remount, failed page retrieval, and
shipment cancellation races. An isolated PGlite query also reproduced the old
shipment predicate overwriting cancellation and verified the corrected predicate.

## Follow-up review corrections

The second pass addressed the PR review and checked related asynchronous workflows:

- Feature-flag and follow-up mutations now abort if the session changes while
  query cancellation is pending, before a request can use the next account's cookie.
- The app uses a shared mutation cache that detaches old observers, suppresses
  late success/error/settled callbacks, and blocks queued or retried dispatches.
  Explicit guards also protect already-entered async callbacks and manual
  save/refresh/preview, patient creation, settings, prescription, packet, and CSV
  batch continuations. Authentication completion retains its navigation behavior.
- Cleanup runs inside dispatched authentication requests so a late password/MFA
  sign-in, sign-out, or password-reset response still purges private data if it
  changes the cookie after another account signed in. Four controlled-response
  regressions reproduced the gap; old navigation callbacks stay detached.
- Entitlement callers now pass the tenant-scoped client. SQL filters the exact
  HCPCS family; keyset pagination reads only the rolling quantity window, with
  one latest-row lookup when the replacement interval needs an older dispense.
  PostgreSQL tests check nested prefixes and literal punctuation in SKU mappings.
- Shipment and delivery dates compare UTC calendar dates, rejecting tomorrow
  even at 23:30 UTC while accepting today shortly after midnight.
- Escape dismisses patient search during debounce; retained CSR actions stay
  disabled after a failed refresh; the email timestamp says "Email sent."
  A regression also establishes that this React Query version removes placeholder
  rows after a failed next-page request, contrary to the review's suggested cause.

## Cross-tab and CSR follow-up

The third pass merged the latest main (`a1cbe82`) and addressed additional
reproduced workflow gaps:

- Browser tabs invalidate account caches after explicit sign-in/sign-out using
  BroadcastChannel and a storage-event fallback. Events contain only an opaque
  nonce. Focus, reconnect, restored pages, and a visible-session timer recheck the
  shared cookie when cross-tab delivery is unavailable.
- Session reads respect cancellation and compare all loaded auth surfaces when
  they finish. A changed identity clears private data and refreshes other mounted
  session gates. Observation-driven cleanup preserves authentication that is still
  completing its response and does not rebroadcast that observation.
- Account, billing, admin, platform, and provider pages reset their local state
  when identity changes. Gates wait for a cached signed-out result to be
  revalidated, avoiding a return-to-sign-in loop after another tab signs in.
- Account-chat persistence records its owner, rejects unowned legacy history,
  and discards streams belonging to a superseded session.
- Calendar refresh recomputes the due-now cutoff. Reviewing one patient's orders
  preserves bulk selections, unavailable selections no longer consume the 50-person
  limit, and outreach confirmation cannot submit after an account change.
- Supply history disables paging during retrieval and offers a route back to newer
  orders after an older-page error.
- An outbound call accepted by the provider remains accepted if subsequent SID
  bookkeeping fails. Independent writes and reconciliation logs retain recovery
  evidence without releasing the retry guard and redialling the patient. A failure
  registering the call before dialing no longer counts as patient contact.

## Calendar and database concurrency follow-up

The fourth pass merged main through `82490e1` and brought up a fresh, isolated
PostgreSQL 17 database with the existing PostgREST 12.2.3 test harness. The full
524-migration baseline replayed successfully. All accounts, patients, and packets
used in this stack are synthetic; vendor credentials are excluded from its
environment.

- The calendar uses the practice's America/New_York dates for month boundaries,
  day grouping, and labels, including daylight-saving transitions. Search also
  updates the day counts. Refreshed-away selections stay cleared, and a shrinking
  history retains a route back from an empty older page.
- Calendar and patient overview queries exclude expired cycles. Immutable ID
  cursors prevent an earlier cycle closing during pagination from hiding a later
  patient.
- CSR SMS, email, and voice workers share a tenant/patient claim across channels
  and episodes for a rolling 48-hour window. Definite non-send failures release
  it; uncertain provider outcomes retain it to avoid duplicate contact. Existing
  automated reminder scheduling keeps its previous keys.
- Provider signing resets consent and in-flight state when the document changes,
  blocks double submissions and conflicting actions, and offers load recovery.
- Packet editing reports load failures with retry controls and suppresses late
  save continuations after an account change. Saved edits clear stale signing
  links and direct the CSR to resend or copy the replacement link.
- Patient packet completion locks the packet and documents and commits the
  signature, acknowledgements, and completed status together. A retry of an
  already-completed valid link returns its existing result. Expired, revoked, or
  mismatched links remain rejected.
- Packet creation commits its envelope and document snapshots together. Edits
  share the signing lock and advance the link version: whichever action commits
  first prevents the other from signing or altering a stale revision. Resend and
  void also check the current lifecycle during their final write.
- Packet reminder claims and rollback updates cannot reopen completed or voided
  packets. A missing tenant signing domain leaves the prior link and reminder
  allowance intact. Four failing-before cases were reproduced through real
  PostgreSQL/PostgREST writes and now pass.

## Outreach review fixes

Review of `c755694` reproduced two dispatch regressions: CSR sends no longer
shared a claim with a previously queued scheduled send on the same channel and
cycle, and database failures before contacting a provider retained a 48-hour
CSR claim despite no message being sent.

- CSR dispatch now inserts its patient cooldown and the existing channel/day
  claim in one atomic request. A conflict rolls back both rows. Scheduled and
  CSR jobs for the same cycle/channel cannot both send, while scheduled
  escalation retains its existing independent-channel timing.
- SMS, email, and voice preserve the original exception and mark failures that
  occurred before provider invocation. Workers release every owned claim for
  definite pre-send failures; uncertain delivery and post-acceptance failures
  retain protection. Failed email rendering/signing and voice preparation also
  clean up unsent contact records without masking the original error.
- Permanent worker tests invoke the actual send helpers with mocked delivery and
  PostgreSQL-backed claims. They cover both dispatch orders, concurrent jobs,
  same/alternate-channel retries, pending voice-session failures, uncertain
  delivery, and rollback of conflicting multi-key inserts. A separate local
  PostgREST suite verifies the API transaction behavior and runs in hosted CI.
- Preview investigation confirmed that connector authentication does not supply
  the missing CLI credentials and that the existing dry-run branch is incomplete.
  The [preview isolation runbook](../runbooks/pr-preview-isolation.md) records the
  required dedicated target, credentials, configuration, and verification. No
  production variables, database rows, or delivery providers were changed.

## Verification

- The outreach review fixes passed **56 registered-worker tests**, including
  27 added regression cases, **68 reminder-library tests**, **17 voice helper/
  route tests**, and **7 new tests through real local PostgREST/PostgreSQL**.
  The complete workspace test run passed, including **8,829 backend tests in 747
  files** (24 opt-in tests skipped without their external setup) and **4,771
  frontend tests in 289 files** plus 16 model-setup tests. The new seven-test
  PostgREST suite was run separately with its local database setup enabled.
  Production build, workspace typecheck, full lint, architecture/route/
  tenant checks, and formatting passed. The root formatter now excludes
  Playwright's generated sign-in state, which is already ignored by Git.

- The fourth-pass complete frontend suite passed **4,766 tests in 288 files**,
  plus 16 model-setup tests. The frontend production bundle passed.
- The calendar/outreach worker follow-up passed **142 tests in ten files**,
  including actual PostgreSQL claim collisions across the registered SMS, email,
  and voice handlers, ambiguous provider responses, and mutable pagination.
- All **14 PostgREST integration tests in seven files** passed against the
  isolated local database, with external delivery stubbed. The packet reminder
  integration and unit checks also passed together (**8 tests**).
- All **six authenticated admin browser scenarios** reached their intended
  screens and passed, including the CSR calendar in a Tokyo browser with Eastern
  practice dates, known/unknown eligibility, order quantities and pagination, and
  retained selection after review. The local fixture supplies synthetic
  onboarding state and cleans up its own rows; no outreach request was sent.
- The final admin suite also passed with **two parallel browser workers** against
  the rebuilt backend. Packet editor recovery and stale-link checks passed
  together (**7 rendered tests**), including four failures reproduced before
  correction.
- The backend suite passed **8,779 tests**; its app-import smoke suite exceeded
  the existing 60-second setup limit under concurrent test/build/lint load.
  That unchanged suite passed **20 tests** in its isolated rerun. Database-gated
  integration suites were verified separately against the local stack.
- The final PostgreSQL suite passed **303 tests in 15 files**, with five existing
  opt-in skips. This includes **13 new real-database packet tests**, concurrent
  edit/sign ordering, document removal, rollback, empty packets, role permissions,
  and retry recovery. Fresh replay applied **all 525 migrations**; idempotency and
  from-scratch replay also passed within the database suite.
- Packet API checks passed **78 tests**, and provider signing passed **21 tests**.
  Production build, workspace typecheck, full lint, architecture/tenant/route
  checks, migration-prefix/immutability checks, source-grep test checks, and
  formatting passed. Final editor changes also passed targeted lint/typecheck.

Migration `0545_finalize_patient_packet.sql` must be applied before this API
release. It adds service-role-only, SECURITY INVOKER transaction functions and
does not rewrite historical migrations. Existing partial signature artifacts
remain blocked for staff review; previously revoked historical links are not
reactivated. Queue acceptance remains distinct from delivery; actual delivery
and replies are viewed in Conversations.

- The third-pass production build and workspace typecheck passed. The complete
  frontend suite passed **4,755 tests in 287 files**, plus 16 model-setup checks.
- The shared auth package passed **68 tests**. Coverage includes cancelled reads,
  simultaneous first session reads, cross-surface refresh, opaque transport events,
  late mutation suppression, and preserved authentication completion.
- The outbound-call and outreach follow-up passed **50 tests in six files**,
  including failures before dialing and failures after provider acceptance.
- All **44 Chromium scenarios** passed together after source changes finished,
  including independent BroadcastChannel/storage transports, two-tab account
  changes, late billing-response isolation, and session expiry. Full lint,
  architecture/route/tenant checks, formatting, and diff checks also passed.
- `pnpm build` passed, including the final workspace typecheck and both production bundles.
- `pnpm lint:resupply` passed; later edits also passed targeted ESLint.
- `node scripts/run-resupply-checks.mjs` passed architecture, route authorization,
  tenant isolation, raw query scope, and approval-link checks.
- The final second-pass frontend suite passed **4,723 tests in 284 files**.
- The shared auth package passed **52 tests**, including queued dispatch, retries,
  observer reset, late success/failure, and overlapping cache-cleanup generations.
- The backend follow-up passed **69 focused tests**, including PostgreSQL family
  pattern checks, tenant filtering, paging, interval anchors, and calendar boundaries.
- The full workspace run passed 25 package suites. The backend run passed 8,676
  tests but had timeout failures in three files; those three files subsequently
  passed **47 tests** together with reduced worker concurrency. The initial
  migration-guard subprocess timeout also passed both its isolated rerun and the
  subsequent workspace run. No assertion was removed or relaxed.
- The first pass's final browser run passed all 41 storefront/fitter scenarios
  together. Coverage includes route loading, responsive navigation, fitting
  requests, consent/population gates, camera failures, retry flows, and accessibility.
- Formatting and `git diff --check` passed for the patch.

## Production observations

The deployed baseline remains Railway release
`707aa2a6-a4b8-447e-b4d2-fc156146bda5`. Read-only probes returned:

- `/resupply-api/healthz`: HTTP 200, `status: ok`.
- `/resupply-api/readyz`: HTTP 200, database and queue `ok`.
- `pennpaps.com/api/storefront-branding`: Penn Home Medical Supply.
- `cmbreathe.com/api/storefront-branding`: CareMetric Breathe.

The retrieved error-level deployment log entries were historical duplicate
migration-prefix warnings. Historical migration filenames were not changed.
No patient messages, phone calls, production data writes, or migrations were
performed during this review.

The PR preview built successfully but its pre-deploy migration guard refused an
ambiguous database identity. Preview deployment
`76ea7396-5904-4a0f-9b9c-f51d1168ceed` and the production baseline logs report the
same database-target fingerprint (`28616a064d1b`). This is not evidence of an
isolated preview database. No environment labels, credentials, migration guards,
or staged deployment configuration were changed. Preview needs a verified isolated
database and matching Supabase runtime target before it can be deployed safely.

A read-only follow-up located the isolated `bucket-b-dryrun` Supabase branch
(`cgddjicbfhfsttnumwyi`), but it has a failed migration status, an incomplete
schema, and no application migration ledger. It is not a ready preview target.
The local Supabase CLI requires authentication before it can retrieve branch
credentials. Any reuse requires schema reconciliation first; the preview's
inherited migration-baseline settings must also be cleared. Production credentials
must not be relabelled as preview credentials, and the existing migration guard
must remain enabled. No infrastructure changes were made in this follow-up.

## Follow-up improvements and validation limits

1. Complete the existing [external validation checklist](external-validation-checklist.md):
   live delivery, manufacturer connectors, physical-device fitting, tenant voice
   routing, clearinghouse round trip, and lifecycle cutover still require the
   documented external evidence. Automated fixtures do not establish delivery.
2. Complete the isolated hosted preview configuration. Docker Desktop's daemon
   was unavailable locally, but the fourth pass used a standalone local
   PostgreSQL/PostgREST stack to exercise database-dependent tests and browser
   flows. This does not resolve the hosted preview's database identity.
3. Review long-running Windows test subprocesses and animation-sensitive browser
   helpers. This pass encountered timeout-only failures that need isolated reruns;
   assertions and application safeguards were not weakened to silence them.
4. Already-dispatched requests cannot be undone client-side. Cross-tab invalidation
   and session revalidation now cover the browser boundaries described above;
   external delivery and production acceptance still require separate evidence.
