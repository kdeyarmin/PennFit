# Deferred from comprehensive app review (PR #1330)

Items intentionally left out of the insurance-only / tenant-branding /
provider-portal hardening merge. Tracked here so a follow-up PR can pick
them up without re-discovering scope.

## Still open

| Item                                               | Why deferred                                                                     | Suggested next step                                      |
| -------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Provider portal seed-org fallback on platform host | Intentional for single-tenant Penn; full multi-tenant routing is architectural   | Design host→org routing for provider SPA before changing |
| Platform billing payment wall enforcement          | Epic exists; re-lock on failed invoice is env-gated (`BILLING_PAYWALL_ENFORCED`) | Enable per runbook when Stripe platform billing is live  |
| LTV including insurance claim dollars              | UI already labeled historical shop-only                                          | New insurance LTV metric once claim dollars are trusted  |
| Home status banner insurance due / next ship       | `/shop/me/dashboard` stubs `nextShipment` / `eligibility` after Subscribe&Save   | Populate from episodes + Rx cadence; CTAs to `/contact`  |

## Shipped (merged)

| Item                                                    | PR / location                                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Episode lifecycle factory writer                        | #1326 — Rx create, bootstrap, post-confirm next cycle                                 |
| Legacy fitter `fit_session` for recommend-only path     | #1326 — `createLegacyFitSessionForRequest` at fit-request time (not on recommend)     |
| Chatbot PII scrub (MBI, PO Box, ZIP, member-id, cards)  | #1335 — `chatbotPii.ts` + behavioral tests                                            |
| Back-in-stock auto-dispatch on restock                  | #1336 — `autoDispatchBackInStockOnRestock`; `RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH=1`  |
| Back-in-stock patient signup route                      | #1337 — `POST /shop/back-in-stock` with catalog SKU ids                               |
| Trust strip live reviews aggregate                      | Round seven — static badges only; helper hard-fails                                   |
| XPS shipping labels empty-state honesty                 | Round seven — PacWare / insurance copy; historical shop-order queue                   |
| Due math: queued fulfillments count via `created_at`    | Already on main — `reminders.ts` uses `shipped_at ?? created_at`; `reminders.test.ts` |
| Review-request emails / `storefront.reviews_collection` | #1333 — migration 0530 OFF + `DELIBERATELY_OFF_FLAGS`                                 |
| Lapsed winback last-activity gate                       | Round three — `resolveLastCustomerShipmentActivityIso` + tests                        |
| Account “Track a shipment” → `/contact`                 | #1333                                                                                 |
| Help / account prefs cash-pay copy                      | #1333                                                                                 |
| Account chatbot insurance-only tools                    | #1333 + round three FAQ claim-adjustment copy                                         |
| Seed tenant `assistantAdminName` → PennPilot            | Round three — migration 0531                                                          |
| Provider RTM paging / setupDate / attestation horizon   | #1333                                                                                 |

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
| Help / account prefs cash-pay leftover copy                       | Fixed: hide abandoned/review toggles; help + account prefs insurance-aligned |

## Started in round three — merged

| Item                                             | Status                                                  |
| ------------------------------------------------ | ------------------------------------------------------- |
| Seed tenant `assistantAdminName` → PennBot       | Migration 0531: correct admin key when value is PennBot |
| Account chat KB tenant-brand guard               | `customerChatKnowledge.brand.test.ts`                   |
| Account chat FAQ still says “refund in 5-7 days” | FAQ 85/89 aligned to claim-adjustment language          |
| Lapsed winback last-activity gate                | `resolveLastCustomerShipmentActivityIso` + tests        |

## Started in round four — merged #1335

| Item                             | Status                                                               |
| -------------------------------- | -------------------------------------------------------------------- |
| Chatbot PII scrub scope          | Added MBI, PO Box, state/labeled ZIP, member-id label, card patterns |
| Episode lifecycle factory writer | Already shipped in #1326 — doc updated; no code change this round    |

## Started in round five — merged #1336

| Item                        | Status                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Back-in-stock auto-dispatch | `autoDispatchBackInStockOnRestock` on positive `adjustStock`; env-gated |

## Started in round six — merged #1337

| Item                       | Status                                                          |
| -------------------------- | --------------------------------------------------------------- |
| Back-in-stock signup route | Restored `POST /shop/back-in-stock` with catalog SKU validation |

## Started in round seven (this branch)

| Item                                    | Status                                                                   |
| --------------------------------------- | ------------------------------------------------------------------------ |
| Trust strip reviews aggregate           | Removed live fetch; static badges only; helper hard-fails                |
| XPS shipping labels insurance-only copy | Header + empty state point at PacWare; nav hint updated                  |
| Legacy fit_session on `/api/recommend`  | Doc: already closed by #1326 attach-at-request; not writing on recommend |

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

Runbook for tenant payment wall: `docs/runbooks/tenant-payment-wall.md`.
