# Deferred from comprehensive app review (PR #1330)

Items intentionally left out of the insurance-only / tenant-branding /
provider-portal hardening merge. Tracked here so a follow-up PR can pick
them up without re-discovering scope.

## Still open

| Item                                                   | Why deferred                                                                   | Suggested next step                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Episode lifecycle factory has no production writer     | No live enqueue path; analytics read zeros                                     | Wire a single production writer or retire the readers     |
| Provider portal seed-org fallback on platform host     | Intentional for single-tenant Penn; full multi-tenant routing is architectural | Design host→org routing for provider SPA before changing  |
| Due math uses `MAX(shipped_at)` vs queued fulfillments | Needs product decision on “due” vs “dispensed”                                 | Spec + migration if queue time should count               |
| Chatbot PII scrub scope                                | Broader than this review’s surface                                             | Expand scrub allowlist with behavioral tests              |
| Platform billing payment wall                          | SaaS billing for tenants, not patient cash-pay                                 | Separate platform-billing epic                            |
| LTV including insurance claim dollars                  | UI already labeled historical shop-only                                        | New insurance LTV metric once claim dollars are trusted   |
| Back-in-stock auto-dispatch                            | Catalog copy fixed; automated dispatch soft-deferred                           | Opt-in dispatcher behind env flag when stock RPC is ready |
| Review-request emails still CTA to `/contact`          | ~~Flag still ON~~ — migration 0530 + DELIBERATELY_OFF             | Shipped in #1333                                          |
| Lapsed winback uses shop `paid_at` not fulfillments    | Cron env-gated; copy says “shipped” but math is last cash-pay                  | Gate on fulfillment/`shipped_at` or retire dispatcher     |
| Account “Track a shipment” → `/track-order` only       | ~~Tracker rejects fulfillment UUIDs~~ — CTA now `/contact`         | Shipped in #1333                                          |
| Help / prefs still describe cart/refund/review flows   | Copy + toggles lag insurance-only                                              | Align labels with resupply / fit requests                 |
| Account chatbot tools still coach refunds/subscriptions | ~~Tool descriptors leftover~~ — escalate + subscription tool scrubbed          | Shipped in #1333; knowledge KB still has seed placeholders |

## Started in this follow-up (PR #1333)

| Item                                                              | Status                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Provider RTM roster `setupDate` truncated by PostgREST `max_rows` | Fixed: per-patient first-night lookup in `routes/provider/rtm.ts`                              |
| Provider RTM caseload list truncated at `max_rows`                | Fixed: page `prescriptions` with `.range()` in `listProviderPatientIds`                        |
| Provider RTM detail / attestation oldest-1000-nights only         | Fixed: CMS horizon fetch (`ATTESTATION_HORIZON_DAYS`) with `.range()` paging                   |
| Roster recent-nights chunk still hit `max_rows`                   | Fixed: page each id-chunk’s recent-window nights                                               |
| Review-request emails / `storefront.reviews_collection`           | Fixed: migration 0530 OFF + moved to `DELIBERATELY_OFF_FLAGS`                                  |
| Account “Track a shipment” → `/track-order`                       | Fixed: CTA → `/contact` (“Ask about a shipment”)                                               |
| Account chatbot escalate / subscription tool cash-pay coaching    | Fixed: insurance-only tool descriptors + category labels                                       |

## Already shipped in #1330 / #1332

- Tenant branding / `storefront-company-info` / `verify:deploy` Penn gate
- Cash-pay copy + redirects + retired feature-flag presets
- Provider portal org-scoped accounts, invite email rebind, auth `uiPathPrefix`
- Review-thread items (CI concurrency, batch NPI cache, CCPA export, reminder dedup release, NPS redirect order)
