# Owner reporting review fixes

Review of PR #1381 identified three reproducible issues, corrected in this changeset:

- A tracked product with no configured low-stock threshold was omitted from the owner overview. Migration `0558_owner_analytics_stock_threshold.sql` uses the catalog's default of five, preserves an explicit zero, and keeps untracked stock out of the alert. The published `0557` migration is unchanged.
- Negative monetary CSV values were escaped as text, preventing spreadsheet arithmetic on refunds and losses. Explicitly typed monetary cells now preserve exact signed cents and two decimal places. Untrusted text still receives formula protection.
- Retrying an actual financial event after a lost response generated a different occurrence time and conflicted with the already-recorded event. Unchanged retries now reuse the original submitted payload. The form also accepts an explicit historical occurrence date in UTC, protects newer edits from late responses, and directs conflicting edited retries to the existing history.

## Verification

The full frontend suite passed 4,919 tests, with 16 additional setup tests. Frontend typecheck, lint and the production build passed. All seven production-bundle Chromium checks passed, including the actual negative CSV download, arithmetic on exported values, permission gates, mobile layout, partial-source failures, and the pricing workspace. Desktop and mobile screenshots were inspected.

All 16 native operational-report tests passed, including the default-five and explicit-zero threshold cases, tenant boundaries and repeated application of `0558`. A fresh native PostgreSQL database passed all eight migration checks with exactly 538 canonical migration hashes through `0558`. Independent review also verified that retry payloads match the backend's exact event-deduplication contract.

## Isolated hosted preview

The PR preview is `https://resupply-api-pennfit-pr-1381.up.railway.app`. Its Railway environment is `3110549e-8dec-45c2-96fd-9583c02f7405`, service `b08cfa1c-9af3-417d-b298-6fd4921d2d23`, project `30957b23-dfb7-4751-934c-25b212ec49b7`.

The retired PR #1373 preview's existing Supabase branch was reused after confirming that PR was merged and its Railway environment removed. The branch remains named `pennfit-pr-1373`, project `dfwwhqeebadwpbzjnxuj`, branch ID `4baf93dc-fb0e-4b33-bef5-0b1c2916d8dc`. It contains the original four synthetic patients with no email addresses or phone numbers. No new paid database was created.

The guarded native migrator applied the pending changes through `0558`. Initialization then verified the complete canonical ledger, runtime schema/table/sequence/function permissions and default grants. A formatting-only local copy of `0554` was restored to the exact published Git bytes; the resulting redundant local ledger entry was removed only after verifying the canonical deployment entry, preserving all other history. No published migration content was changed.

The service received the existing preview configuration's 144 variables with the 11 public origins changed to PR #1381 and the three required secrets loaded privately from this isolated branch. Outbound credentials remain empty, optional delivery jobs remain disabled, and all 37 outbound feature flags are disabled in both preview organizations. Production endpoint fingerprint guards remain active; baseline and emergency-override settings are empty.

The historical `scripts/preview/config.mjs` manifest and PR #1373 setup scripts still pin the retired Railway target. They must not be applied verbatim to another environment. The live PR #1381 configuration uses the explicit target and origins documented above.

Production settings, real patient/supplier data and outbound communication were not changed. Hosted release status and final-commit CI results are recorded in the PR description.
