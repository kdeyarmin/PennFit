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

## Verification

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
2. Add a persistent isolated database environment for the authenticated admin
   browser suite and migration replay. Docker Desktop's daemon was unavailable
   locally, so database-dependent tests remain skipped by their existing gates.
3. Review long-running Windows test subprocesses and animation-sensitive browser
   helpers. This pass encountered timeout-only failures that need isolated reruns;
   assertions and application safeguards were not weakened to silence them.
4. Already-dispatched requests cannot be undone client-side. Cross-tab invalidation
   and session revalidation now cover the browser boundaries described above;
   external delivery and production acceptance still require separate evidence.
