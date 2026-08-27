# Deferred from comprehensive app review (PR #1330)

**Status: complete for this deferred backlog.** Every code-actionable item
from the comprehensive review follow-ups has shipped. Residual work below is
**ops enablement** or **new epics** — not unfinished deferred-review debt.

## Residual (not deferred-review blockers)

| Item                                          | Status                                                                                             | Where tracked                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Flip `BILLING_PAYWALL_ENFORCED` in production | Code + preflight guard shipped; env still OFF by design until ops validates Stripe                 | `docs/runbooks/tenant-payment-wall.md`                      |
| Channel LTV:CAC including claim dollars       | ERA remittance companion on LTV page + revenue-by-source; ratio stays shop-only until patient join | New epic: `customer_acquisition.patient_id` (or equivalent) |
| Full multi-org provider org-picker            | Fail-closed API + SPA WrongTenantHost + invite domain gate shipped                                 | `docs/provider-portal-tenant-host-routing.md` (Future epic) |

## Shipped (merged)

| Item                                                    | PR / location                                                                        |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Provider SPA wrong-host honesty + admin domain callout  | Round ten — `ProviderPortalRoute`, `admin-provider-esign`                            |
| LTV page ERA remittance companion (not in ratio)        | Round ten — `GET /admin/analytics/ltv-cac` `insuranceRemittance`                     |
| Provider portal / RTM seed-org soft-fallback            | #1341 — brand host resolve; 403 `provider_tenant_host_required`                      |
| Preflight: paywall requires Stripe platform credentials | #1341 — `preflight-prod-env.ts`                                                      |
| Revenue-by-source ERA payer-paid cents                  | #1341 — labeled `totalPayerPaidCents` (not LTV)                                      |
| Control Center stale cash-pay module framing            | #1341 — comment scrub                                                                |
| Episode lifecycle factory writer                        | #1326 — Rx create, bootstrap, post-confirm next cycle                                |
| Legacy fitter `fit_session` for recommend-only path     | #1326 — `createLegacyFitSessionForRequest` at fit-request time (not on recommend)    |
| Chatbot PII scrub (MBI, PO Box, ZIP, member-id, cards)  | #1335 — `chatbotPii.ts` + behavioral tests                                           |
| Back-in-stock auto-dispatch on restock                  | #1336 — `autoDispatchBackInStockOnRestock`; `RESUPPLY_BACK_IN_STOCK_AUTO_DISPATCH=1` |
| Back-in-stock patient signup route                      | #1337 — `POST /shop/back-in-stock` with catalog SKU ids                              |
| Trust strip live reviews aggregate                      | Round seven — static badges only; helper hard-fails                                  |
| XPS shipping labels empty-state honesty                 | Round seven — PacWare / insurance copy; historical shop-order queue                  |
| Home status banner insurance due / next ship            | Round eight / #1340 — episodes → `nextShipment` / `eligibility`                      |
| Due math: queued fulfillments count via `created_at`    | Already on main — `reminders.ts` uses `shipped_at ?? created_at`                     |
| Review-request emails / `storefront.reviews_collection` | #1333 — migration 0530 OFF + `DELIBERATELY_OFF_FLAGS`                                |
| Lapsed winback last-activity gate                       | Round three — `resolveLastCustomerShipmentActivityIso` + tests                       |
| Account “Track a shipment” → `/contact`                 | #1333                                                                                |
| Help / account prefs cash-pay copy                      | #1333                                                                                |
| Account chatbot insurance-only tools                    | #1333 + round three FAQ claim-adjustment copy                                        |
| Seed tenant `assistantAdminName` → PennPilot            | Round three — migration 0531                                                         |
| Provider RTM paging / setupDate / attestation horizon   | #1333                                                                                |

## Round history (merged)

Rounds three through nine closed prior deferred rows (see git history / PRs
#1333–#1341). Round ten closes SPA honesty + LTV remittance companion and
marks this tracker complete.

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

Runbooks: `docs/runbooks/tenant-payment-wall.md`,
`docs/provider-portal-tenant-host-routing.md`.
