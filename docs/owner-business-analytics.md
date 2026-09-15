# Owner business overview

Open **Owner overview** at `/admin/analytics/owner` to see recorded business activity, current work queues and the financial records attached to pricing reviews. Access requires both management reporting (`metrics.read`) and financial reporting (`cost.read`) permissions. The page reports the current organization only.

## Choose a period and share a report

Choose the last 7, 30, 90 or 365 days, or select **Custom dates** and **Apply dates**. Dates use UTC. Custom dates include the selected end day; when the end date is today, the period stops at the report time. Ranges can cover up to 366 days. The previous period covers exactly the same elapsed duration immediately before the selected period, including across daylight saving changes.

Use **Refresh** before making decisions from a report that has been open for a while. The displayed update time and exact period belong to the returned report. Editing custom dates hides the previous report until the new range is applied. During a refresh, the page identifies the refresh and disables export.

**Download overview CSV** exports the current returned report, its time windows, units and definitions. It does not export an unapplied date selection or a pending refresh. A downloaded file is a snapshot; later corrections, payments or cost records do not update it.

Business and financial sources load independently. If one is unavailable, its section says so and the other can remain useful. The CSV explicitly identifies the unavailable section rather than substituting zero. If both fail, retry the report. An available section showing zero means no matching recorded activity; it does not establish that all source records have been entered.

## Read each measure in its own scope

| Area                      | What the figures mean                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Period activity           | Records or events inside the displayed period, compared with the preceding equal-duration period. Order creation and signature counts use their respective dates.                                                                                                                                                                                                                              |
| Order and resupply stages | Requests and episodes created in the period, shown with their current status. A later completion can change an earlier cohort; it is not necessarily a signature or shipment during that earlier period.                                                                                                                                                                                       |
| Current queues            | Open claims, signatures, conversations, holds and other work as recorded now, including older work. Changing the reporting period does not turn these into historical balances.                                                                                                                                                                                                                |
| Claims and payers         | Claims created in the selected period, their current stages, billed amounts and payments recorded to date. A later payment or decision can change this cohort. These amounts are not cash collected during the period or expected collectible revenue. Open-claim totals and aging cover the entire current backlog separately.                                                                |
| Products and stock        | Top products rank recorded shipped units in the selected period, not prepared units, revenue or product profit. A null stock count means untracked stock, not zero or available stock. Low-stock totals use each configured threshold, or five units when no threshold is configured; an explicit zero remains zero. The detail list shows up to ten products with their effective thresholds. |
| Shipping and patients     | Queued fulfillment lines and prepared units do not prove shipment. Shipment counts require a recorded shipping or delivery date and do not prove delivery to the patient. Assumed-shipped episodes remain separate. Patients served are distinct patients with shipment evidence; returning patients also have shipment evidence before the period.                                            |
| Resupply scheduling       | Distinct active patients with nonexpired open cycles and a currently valid active prescription, scheduled due now or in the next 30 days. A patient with multiple cycles can appear in both groups. Scheduling does not establish insurance eligibility, an approved refill or consent to receive supplies. Open the resupply calendar for patient-level review and outreach.                  |
| Outreach                  | Messages created in the period, with their current recorded delivery status. Accepted or sent messages are not necessarily delivered; message and response counts are not sales conversion rates.                                                                                                                                                                                              |

Top-product and payer tables show up to ten entries. Aggregate cards cover the full matching population. Detail links open their own pages and filters; the overview does not silently apply its date range to those pages.

## Understand the financial section

**Recorded financial activity** uses the economic occurrence date supplied with each pricing actual event. Revenue is reduced by refunds; costs are reduced by cost credits. The selected-period totals can include reviews whose collections or costs are still incomplete. Subtracting these two period totals is not a reliable profit calculation when revenue and related costs are recorded in different periods.

**Completed-review contribution** is a separate lifetime measure for bound pricing reviews with both costs and collections explicitly marked complete. It equals their recorded net revenue less recorded net costs. Multiple lines or events do not count an order more than once. Zero and negative results remain visible.

A missing, invalid or future economic date makes the affected bound review uncertain. Those events are excluded from period activity; the record creation date is never substituted. That entire review is excluded from completed-review financial totals, even if both completeness flags are set. Date-quality counts disclose these events. Incomplete-cost, incomplete-collection and uncertain-date counts can overlap; the overall incomplete count counts each affected review once. Reopening a review removes it from completed totals until the evidence is complete again.

These records are not a complete company ledger, bank cash report, insurance remittance ledger or company net profit calculation. Completeness flags record an explicit reconciliation decision; the overview cannot discover an invoice or payment that was never entered. No default margin, demand or missing cost is invented.

For future scenarios, use [Owner profit models](owner-profit-models.md) and the [pricing operations guide](pricing-profitability-operations.md). Those models use entered assumptions and do not change observed results. Legacy shop sales and generic business-goal pacing are intentionally excluded because they do not represent the same insurance and pricing-review records.

## Operator notes

Deploy migrations `0556_owner_pricing_analytics.sql`, `0557_owner_business_analytics.sql` and `0558_owner_analytics_stock_threshold.sql` before using the page. They add read-only aggregate functions; they do not backfill dates, alter existing financial records or activate scheduled prices.

The API is `GET /resupply-api/admin/analytics/owner`, with `days=7|30|90|365` or both `from=YYYY-MM-DD&to=YYYY-MM-DD`. It enforces the two permissions, tenant context, bounded date ranges and private, non-cacheable responses. It passes the same report time and period to both sources. Each function reads a consistent database snapshot; the independently executed business and financial functions are not one cross-source transaction.

Both functions are `STABLE SECURITY INVOKER`, explicitly filter by organization, pin UTC comparisons and permit execution only to `service_role`. Browser roles cannot invoke them. The service role also needs the normal application schema and table read permissions. Missing functions, permissions, invalid source output or timeouts make a source unavailable rather than returning invented totals.

`lib/resupply-db/scripts/owner-pricing-analytics.test.ts` covers exact signed cents, coverage, date quality, period boundaries, daylight saving, tenant isolation and execution permissions. It runs with an isolated PGlite fixture by default; native verification accepts an explicitly guarded loopback test/review database and cleans only its synthetic organizations. Never point fixture tests at production.
