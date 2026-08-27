# Deferred from comprehensive app review (PR #1330)

Items intentionally left out of the insurance-only / tenant-branding /
provider-portal hardening merge. Tracked here so a follow-up PR can pick
them up without re-discovering scope.

## Still open

| Item                                                    | Why deferred                                                                        | Suggested next step                                        |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Episode lifecycle factory has no production writer      | ~~No live enqueue path~~ — wired in #1326 (`openOutreachEpisode`)                   | Shipped: Rx create, bootstrap, post-confirm next cycle     |
| Provider portal seed-org fallback on platform host      | Intentional for single-tenant Penn; full multi-tenant routing is architectural      | Design host→org routing for provider SPA before changing   |
| Due math uses `MAX(shipped_at)` vs queued fulfillments  | Needs product decision on “due” vs “dispensed”                                      | Spec + migration if queue time should count                |
| Chatbot PII scrub scope                                 | Round four (#1335): MBI, PO Box, ZIP, member-id, card patterns                      | Shipped in round-four PR                                   |
| Platform billing payment wall                           | SaaS billing for tenants, not patient cash-pay                                      | Separate platform-billing epic                             |
| LTV including insurance claim dollars                   | UI already labeled historical shop-only                                             | New insurance LTV metric once claim dollars are trusted    |
| Back-in-stock auto-dispatch                             | ~~Catalog copy fixed; automated dispatch soft-deferred~~                            | Round five: env-gated hook on `adjustStock` restock        |
| Review-request emails still CTA to `/contact`           | ~~Flag still ON~~ — migration 0530 + DELIBERATELY_OFF                               | Shipped in #1333                                           |
| Lapsed winback uses shop `paid_at` not fulfillments     | ~~Cron env-gated; copy says “shipped” but math is last cash-pay~~                   | Fixed in round three: fulfillment activity gate            |
| Account “Track a shipment” → `/track-order` only        | ~~Tracker rejects fulfillment UUIDs~~ — CTA now `/contact`                          | Shipped in #1333                                           |
| Help / prefs still describe cart/refund/review flows    | ~~Copy + toggles~~ — help + account prefs scrubbed; abandoned/review toggles hidden | Shipped in #1333                                           |
| Account chatbot tools still coach refunds/subscriptions | ~~Tool descriptors leftover~~ — escalate + subscription tool scrubbed               | Shipped in #1333; FAQ claim-adjustment copy in round three |
| Seed tenant `assistantAdminName` returns PennBot        | Prod company-info showed PennBot for both assistants (expect PennPilot for admin)   | Migration 0531 in round three                              |

## Started in this follow-up (PR #1333) — merged 2026-08-27

| Item                                                              | Status                                                                       |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Provider RTM roster `setupDate` truncated by PostgREST `max_rows` | Fixed: per-patient first-night lookup in `routes/provider/rtm.ts`            |
| Provider RTM caseload list truncated at `max_rows`                | Fixed: page `prescriptions` with `.range()` in `listProviderPatientIds`      |
| Provider RTM detail / attestation oldest-1000-nights only         | Fixed: CMS horizon fetch (`ATTESTATION_HORIZON_DAYS`) with `.range()` paging |
| Roster recent-nights chunk still hit `max_rows`                   | Fixed: page each id-chunk’s recent-window nights                             |
| RTM setupDate lookup unbounded concurrency (review)               | Fixed: cap at 15 concurrent reads per id chunk (#1333 `0f6c83fca`)           |
| Review-request emails / `storefront.reviews_collection`           | Fixed: migration 0530 OFF + moved to `DELIBERATELY_OFF_FLAGS`                |
| Account “Track a shipment” → `/track-order`                       | Fixed: CTA → `/contact` (“Ask about a shipment”)                             |
| Account chatbot escalate / subscription tool cash-pay coaching    | Fixed: insurance-only tool descriptors + category labels                     |
| Help / account prefs cash-pay leftover copy                       | Fixed: hide abandoned/review toggles; help + SMS copy insurance-aligned      |

## Started in round three (this branch)

| Item                                             | Status                                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| Seed tenant `assistantAdminName` → PennBot       | Migration 0531: correct admin key when value is PennBot |
| Account chat KB tenant-brand guard               | `customerChatKnowledge.brand.test.ts`                   |
| Account chat FAQ still says “refund in 5-7 days” | FAQ 85/89 aligned to claim-adjustment language          |
| Lapsed winback last-activity gate                | `resolveLastCustomerShipmentActivityIso` + tests        |

## Started in round five (this branch)

| Item                        | Status                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Back-in-stock auto-dispatch | `autoDispatchBackInStockOnRestock` on positive `adjustStock`; env-gated |

## Production deploy note (2026-08-27)

After #1330 merged (`6fb33f837`), GitHub deployment `6115697681`
(`PennPaps / production`) stayed `in_progress` for ~32 minutes, then
succeeded at **03:27 UTC**. Post-deploy smoke on `https://pennpaps.com`:

```text
verify:deploy → 4 passed
/api/company-info            → "Penn Home Medical Supply"
/api/storefront-company-info → "Penn Home Medical Supply"
/api/storefront-branding     → Penn Home Medical Supply
```

Platform host `pennfit.up.railway.app` correctly stays CareMetric-branded.
