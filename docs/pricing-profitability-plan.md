# CareMetric Breathe — Pricing & Profitability Plan

Prepared September 14, 2026 for Penn Home Medical Supply. Repository: kdeyarmin/PennFit. Status: accepted implementation design. See the [operations guide](pricing-profitability-operations.md) for implemented workflows, setup, and verification. Business pricing policies and production data are not seeded by this feature.

## 1. Executive recommendation

Build one Pricing & Profitability module with two connected experiences: a CEO pricing workbench and a CSR item-review panel. Both must use the same server-validated calculation. The CEO establishes profit objectives and approves prices; CSRs evaluate a specific item or order, understand its delivered cost, and prepare an approved quote without rebuilding the calculation in a spreadsheet.

The system should answer five questions immediately:

1. What will this specific item and fulfillment arrangement cost us?
2. What revenue can we reasonably collect?
3. What price would achieve the selected margin, and what profit dollars would remain?
4. Is the proposed order within policy, or what needs review?
5. After fulfillment and settlement, did the expected profit materialize?

Use **contribution margin after variable costs** as the default pricing objective. Display product gross margin and optional profit after allocated overhead separately. A contribution percentage is not company net profit: rent, fixed payroll, and other overhead still have to be covered by total contribution. The CEO can select a clearly labeled overhead-inclusive pricing policy when needed; the selected basis is saved with every calculation.

Protect the target at quote approval and order release using current verified inputs. Actual carrier adjustments, returns, supplier invoice changes, and collections can still change realized profit. Preserve the original promise and show the variance; do not claim an estimate guarantees final profit.

## 2. Current application and required changes

The review covered the local functional-review branch at `ed00c4bff1b08d17f820742bbdc023e79ad14ef8`, checked against the relevant current main-branch paths. This is an extension of existing workflows, not a replacement application.

| Area             | What exists                                                                                             | Required extension                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Catalog          | SKU, description, manufacturer, unit of measure, stock management                                       | Supplier offers, sellable variants and pack conversions, cost details, approved price versions                                                                      |
| Product costs    | Organization-scoped current unit cost, currency, source, notes, audit; CSV import tooling               | Usable cost editor, supplier-specific history, verification, validity, scheduled updates and cost inclusions                                                        |
| Margin analytics | Historical paid shop lines minus product COGS                                                           | Clearly label product gross profit; add delivered contribution, complete cost coverage, and estimated-versus-actual results                                         |
| Payer analytics  | Billed, allowed, paid and known COGS summaries                                                          | Integrate fulfillment costs and collection assumptions without double-counting revenue or presenting partial costs as complete                                      |
| CSR orders       | Description, quantity and unit amount entered manually; signature workflow                              | Canonical SKU/order lines, saved pricing calculation, supplier, delivery costs, margin rules and approval                                                           |
| Resupply drafts  | Existing review/approval step                                                                           | The same item-review calculator, durable quote association, and exact approved-item fulfillment                                                                     |
| Shipping         | XPS can return rates before label purchase for legacy shop orders; booking records actual shipping cost | Quote service usable before creating a CSR order, validated package data, supplier dropship fees, saved rate expiry, split shipments and actual-cost reconciliation |
| Permissions      | Management can read/write costs; CSR is deliberately excluded                                           | Explicit permission for CSRs to evaluate relevant items and see their cost/margin breakdown; separate authority to change costs or publish prices                   |
| Payments         | Equipment is currently insurance-billed; patient card checkout is retired                               | Insurance evaluation first; optional internal self-pay quotes. Patient payment collection is a separate project                                                     |

The current shipping rate endpoint is not yet a supplier dropshipping integration. No live supplier offer, dropship contract, supplier order-routing, or split-shipment pricing model was found. PacWare support is CSV based and should not be represented as a real-time supplier quotation API.

## 3. Financial definitions

| Label                           | Definition and use                                                                                                                                         |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product COGS                    | Acquisition cost of the quantity being sold, with documented inclusions                                                                                    |
| Delivered fulfillment cost      | Product COGS plus applicable dropship fees, freight, packing, handling and other variable fulfillment expenses                                             |
| Net sales revenue               | Merchandise after discounts plus customer-paid shipping, excluding pass-through sales tax; expected/actual refunds reduce net sales in the applicable view |
| Product gross profit            | Net sales on the defined product basis minus product COGS; retain historical report semantics and label its exclusions                                     |
| Contribution dollars            | Net sales revenue minus delivered fulfillment cost, applicable payment/selling costs, and explicitly modeled variable risk costs                           |
| Contribution margin             | Contribution dollars divided by the same net sales revenue                                                                                                 |
| Profit after allocated overhead | Contribution minus an explicitly chosen overhead allocation; an estimate, not accounting net income                                                        |
| Customer total                  | Merchandise after discounts plus customer shipping and applicable tax; insurance responsibility is presented separately                                    |

Margin and markup must never be interchangeable. With no other costs, an item costing $60 needs a $100 price to achieve a 40% margin. Adding a 40% markup produces $84 and a 28.57% margin.

The CEO dashboard should show both margin percentage and contribution dollars. A higher percentage does not necessarily improve total business profit if order volume falls. Demand and volume scenarios must be labeled as assumptions, not presented as a proven optimal price.

## 4. Complete cost record

Each component needs an amount or formula, currency, charge basis, inclusion flags, source, effective date, expiry or review date, and verification status. A value can be verified, estimated, missing, or stale. Explicitly known zero is valid; missing must never become zero.

| Component                | Required treatment                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Supplier goods cost      | Supplier SKU mapped to the exact internal SKU/variant; buy unit versus sell unit; quantity tiers; committed discounts; verified net acquisition cost |
| Inbound landed costs     | Include applicable inbound freight, duties and nonrecoverable tax for owned inventory; identify what is already included in current landed unit cost |
| Dropship fee             | Support per supplier order, shipment, package or item; apply the contracted basis exactly once                                                       |
| Freight                  | Origin, destination, service, parcel count, actual/dimensional weight, fuel, residential/remote surcharges, signature and insurance as applicable    |
| Handling and packing     | Warehouse pick/pack for stocked goods, supplier handling for dropship goods, packaging materials and approved variable labor rates                   |
| Payment and selling fees | Actual configured payment method and contract: percentage, fixed fee, fee basis, caps and any applicable channel commission                          |
| Returns and replacements | Evidence-based expected refunds, return freight, restocking, replacement costs and recoverable inventory/vendor credits                              |
| Collection risk          | Explicit expected collectible amounts or loss scenarios; do not deduct the same risk twice through both revenue reduction and a reserve              |
| Overhead                 | Optional separate allocation with a documented method and period; distinguish fixed allocation from variable handling                                |

Freight already included in a landed unit cost cannot be added again. A supplier quote that includes dropshipping, packing or delivery must mark those inclusions. Direct dropshipping and shipping from owned stock have different cost paths.

Phase one supports USD. Reject mixed-currency calculations unless an approved exchange-rate and conversion-fee policy is added later. Do not silently treat a non-USD supplier cost as dollars.

Payment fees are optional inputs. The app's platform subscription payment configuration does not establish patient-order fees. If a future collection method uses Stripe, use the business's actual agreement and refund treatment; Stripe lists method-dependent pricing and notes that original processing fees generally are not returned under standard pricing. [Stripe pricing and refund terms](https://stripe.com/pricing)

## 5. Pricing calculation and worked example

For a simple order with no tax or returns, let:

- `C` = all variable fulfillment costs, excluding payment fees.
- `F` = fixed payment fee, if applicable.
- `p` = percentage payment fee on revenue.
- `m` = selected contribution margin.
- `R` = net revenue from merchandise and customer shipping.

Then the initial required revenue is:

`R = (C + F) / (1 - m - p)`

If the selected policy targets profit after a fixed per-order overhead allocation `H`, use `(C + H + F) / (1 - m - p)` for this simple case, and label the result accordingly. Continue displaying contribution before that allocation separately. Percentage or volume-dependent overhead needs its own explicit evaluation rule.

This is an analytical starting point. The production calculator must apply actual discounts, tax, fee rounding, price increments, quantity breaks, shipping thresholds and fulfillment choices, then verify the resulting margin in cents. A single formula does not cover every order.

### Illustrative self-pay quote

The following numbers are examples, not proposed business settings. This example does not activate patient payments.

| Input or result                                    |       Amount |
| -------------------------------------------------- | -----------: |
| Supplier goods cost                                |       $42.00 |
| Dropship fee                                       |        $3.00 |
| Supplier delivery to customer                      |        $7.00 |
| Variable handling                                  |        $2.00 |
| Delivered fulfillment cost                         |   **$54.00** |
| Hypothetical processing                            |   3% + $0.30 |
| Illustrative target contribution margin            |          40% |
| Required free-shipping price, rounded and verified |   **$95.27** |
| Processing fee at this price                       |        $3.16 |
| Total variable business cost                       |   **$57.16** |
| Contribution dollars                               |   **$38.11** |
| Contribution margin                                | **40.0021%** |

The formula produces $95.263157…; $95.27 satisfies the target. $95.26 yields 39.9958% and fails, even though a two-decimal display could make both appear to be 40.00%. Enforcement must use exact amounts, not the displayed percentage.

Charging the customer $6 shipping permits an $89.27 merchandise price for the same $95.27 pre-tax revenue, assuming identical fee and tax treatment. Customer shipping is revenue; the supplier's $7 freight remains a cost.

Without any payment fee, this same $54 cost requires $90 to achieve 40%. Fees must therefore follow the actual collection method rather than being assumed on every insurance order.

### Rules for realistic orders

- **Tax:** Pass-through tax is excluded from margin revenue. Where a processor charges fees on the tax-inclusive amount, that fee still counts as a business cost. Calculate the actual tax treatment of each item and shipping charge using approved tax inputs.
- **Discounts:** Recompute revenue after the exact rounded discount. Show the maximum permitted discount for the current order; do not offer a generic discount that might cross the floor.
- **Rounding:** Support cents or an approved price-ending rule. Choose a qualifying allowed price, then rerun the entire calculation. If a price ceiling prevents a valid price, show the conflict.
- **Minimum dollars:** Enforce both percentage margin and minimum contribution dollars where the CEO enables them.
- **Bundles:** Calculate shared shipment/order costs once. Apply a documented allocation for item reporting that adds up exactly to the order totals. Enforce order margin and any line-level floor; intentional bundle subsidies need an explicit policy.
- **Split shipments:** Apply each supplier's fees and each parcel's freight. A single payment does not acquire another fixed processing fee merely because a second parcel ships.
- **Thresholds:** Evaluate separate shipping/quantity/fee scenarios where rules change discontinuously. Do not assume that every extra cent changes profit monotonically across all policy branches.
- **Returns:** Expected refunds reduce expected net sales; expected return costs increase cost, and recoveries reduce cost. Preserve the original processing fee according to the fee contract. Do not deduct a retained fee twice.
- **Invalid or impossible cases:** Reject negative costs, invalid quantities, unresolved currency, nonfinite values, invalid targets and unreachable targets. Zero revenue has no meaningful percentage margin.

For an insurance order with fixed expected collectible revenue, calculate the achieved contribution and the maximum affordable fulfillment cost. If the ceiling is insufficient, report the gap and review permitted fulfillment alternatives; do not manufacture a selling price that cannot be collected.

## 6. CEO pricing workbench

Add a primary **Pricing & Profitability** navigation item, with links from catalog, purchasing/cost records and analytics.

The opening view contains a searchable item grid and an action queue. Columns include product/variant, supplier, verified cost date, delivered cost for the selected scenario, current approved price, expected revenue basis, target margin, achieved margin, contribution dollars, recommended price and review status. Filters include category, supplier, payer/revenue mode, missing cost, stale cost, below target and pending approval.

Selecting an item opens a simple calculator with the cost breakdown on the left and these prominent results on the right: **Recommended price**, **Customer total or estimated responsibility**, **Total business cost**, **Contribution dollars**, and **Margin versus target**. Assumptions and cost sources are available without leaving the page.

The CEO workflow is:

1. Import supplier price lists or edit a verified item cost, resolving unit/pack mismatches and duplicate supplier SKUs.
2. Set the company target margin, hard floor and optional minimum contribution dollars. Add category, channel/payer and item overrides with explicit precedence and effective dates.
3. Choose fulfillment and shipping policy: owned stock or supplier dropship; shipping charged separately, included within defined zones, or quoted individually.
4. Compare supplier offers using delivered cost, margin dollars, availability, lead time, return terms and clinical suitability.
5. Review normal, remote-destination, higher-freight, discount and cost-increase scenarios. The app states which geography, quantity and service a catalog price assumes.
6. Preview recommended prices individually or in bulk, including all exceptions and the expected effect under explicit volume assumptions.
7. Approve immediate or scheduled activation of a versioned internal price list.
8. Review actual contribution, erosion alerts, exceptions, and supplier performance after orders complete.

A catalog price cannot guarantee a margin for an unknown destination and package. For included shipping, define the covered delivery area and cost envelope. Orders outside that envelope require a fresh quote. Insurance orders must also respect whether separate shipping charges are permitted.

### Bulk pricing controls

Support selection by item, category, supplier or filtered list. Before activation, show the exact number and identity of affected products, old/new price, percentage change, old/new projected margin, assumptions, exclusions and missing inputs. Preserve the selection snapshot so a changing filter cannot change the approved batch.

Stage the complete valid batch and activate its version atomically. If rows cannot qualify, the CEO must explicitly approve the remaining subset. Provide import dry runs, per-row errors, resumable processing and an audit trail. Rollback activates a prior or corrected version for future quotes; it does not rewrite accepted orders.

Large increases, new suppliers, below-target proposals and provisional costs appear in the approval queue. Proposed changes may be generated automatically from cost updates; activation remains subject to the approved publishing policy.

## 7. CSR item-review experience

Embed the same review panel in the catalog, patient order screen, CSR order request and resupply draft approval. Preload the patient's intended item, previous order details where available, quantity and current delivery information. Financial review must preserve existing prescription, eligibility and clinical suitability requirements.

A normal CSR workflow should be:

1. Search by item name, SKU, barcode or manufacturer, then confirm model, size and sellable quantity.
2. Confirm payer/revenue mode, delivery destination, requested date, fulfillment source and shipping service.
3. See the approved price or reimbursement expectation alongside goods cost, dropship fee, delivery, other relevant costs, contribution dollars and margin status.
4. Compare permitted supplier/fulfillment options. Unavailable or clinically unsuitable alternatives cannot become the default merely because their margin is higher.
5. Adjust only permitted quantities, delivery choices and discounts. Every adjustment immediately recalculates and explains any change in status.
6. Save and issue a server-validated quote that meets policy without waiting for individual manager approval, request an exception, or request missing cost information.
7. Attach the reviewed quote to the order and use the existing signature/communication workflow. Send customer communications only through an explicit CSR action.

Provide these plain-language states with an icon, explanation and next action, not color alone:

| State                   | Meaning                                                                                               | CSR action                                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Meets target            | Complete verified inputs, at or above target and all other rules satisfied                            | Prepare the approved quote/order                                      |
| Approval needed         | Below target but potentially permissible, or within an explicitly approved estimation process         | Submit the reason and proposed option for review                      |
| Blocked                 | Below hard floor, invalid data, prohibited pricing/fulfillment, or unresolved contractual restriction | Resolve the cause; normal approval cannot silently bypass a hard rule |
| Cost information needed | Missing, stale or unverified required cost/rate                                                       | Request a verified cost or a specifically authorized bounded estimate |

The CSR should not need to interpret formulas. Show messages such as “Delivery increased by $5; this option is below your approved margin” with actions to refresh the rate, choose an allowed alternative, or request review.

CSRs may submit a supplier estimate with its source for verification. They cannot change the authoritative cost, publish portfolio prices or approve their own exceptions unless an explicit role policy permits it.

### Evaluate a new item before it has a price

Provide an **Items awaiting pricing** queue. A CSR can submit an unpriced item proposal with manufacturer/part number, model/size, unit and pack size, supplier, quoted acquisition cost, dropship terms, availability, lead time, return terms, evidence and expiry. The app identifies duplicates and missing information, and shows an explicitly provisional delivered-cost comparison. Finance verifies the cost and item mapping; the CEO sets the policy and approves a price. The proposal becomes a canonical catalog item or links to an existing one, and the requesting CSR sees that it is ready to quote. An incomplete proposal cannot be sent as a firm customer price.

For resupply work, support a batch evaluation of selected drafts with a per-patient result and exception queue. Calculate each patient's item quantities, payer terms and delivery separately. Batch review must never copy one patient's quote to another or send communications automatically.

Customer-facing quotes show item descriptions, quantities, appropriate prices/estimated responsibility, shipping, tax, total, validity and terms. Internal supplier costs, margins, approval notes and financial reports never appear in customer exports or signature packets.

## 8. Insurance and self-pay revenue modes

The current application primarily supports insurance-billed equipment. The default operational mode must therefore distinguish:

- The amount billed on a claim.
- The applicable allowed amount and its effective payer terms.
- Expected insurer payment and any permitted patient/secondary-payer share.
- Expected total collectible revenue after justified collection assumptions.
- Estimated contribution and the difference from target.

Do not add the entire allowed amount to patient responsibility: the allowed amount already includes the relevant payer/patient portions. A bill charge is not evidence that the amount will be collected. Show collection assumptions and confidence, and flag unavailable or stale payer rates.

For Medicare assignment, the approved amount is accepted as payment in full subject to applicable cost-sharing rules. The feature must not increase patient responsibility to repair an internal margin shortfall. Other payers require their own contract rules. [CMS Medicare participation requirements](https://www.cms.gov/medicare-participation)

If expected reimbursement is too low, show the permitted cost ceiling, supplier negotiation opportunity, approved equivalent fulfillment choices and management review. Never make financial optimization override clinical appropriateness or automatically convert an insured order to self-pay.

Provide an internal self-pay quote mode if needed by the business. Treat taking patient payments, choosing a payment processor, refund operations and customer checkout as a separately scoped integration. Existing platform subscription billing credentials and product prices must remain outside patient-order pricing.

Initial item-pricing scope covers outright supply sales. Rental equipment, capped rental periods and multi-period reimbursement require a separate life-cycle model rather than applying a one-time margin formula to one monthly payment. Future resupply orders receive fresh cost/quote reviews; today's approval does not fix future supplier costs indefinitely.

## 9. Approval, permissions and durable records

| Role               | Proposed authority                                                                                                   |
| ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| CEO/owner          | Full cost visibility; targets, floors, shipping policies, publishing, scheduled changes and authorized exceptions    |
| Finance/purchasing | Verify supplier costs, fee contracts, imports and actual invoices; delegated approval where configured               |
| CSR                | Read relevant item cost and margin details, evaluate orders, prepare quotes, submit estimates and exception requests |
| Fulfillment        | Verify package/service details, report supplier and freight actuals, request review of changes                       |
| Customer           | View only their authorized customer-facing quote/order information                                                   |

Use an explicit CSR pricing-evaluation permission rather than granting unrestricted cost-management access. Limit data to the current organization and relevant items; separate export and bulk financial access. Enforce permissions on the server, not only through hidden controls.

Version every approved policy and quote. Save the exact item lines, quantities, supplier/offer versions, cost inclusions, shipment assumptions, rate quote and expiry, fee profile, revenue basis, discount/tax treatment, rounding method, result, engine version, approver and timestamp.

Draft → evaluated → approval required or ready → approved → issued → accepted/expired/cancelled → fulfillment → reconciliation is the proposed quote life cycle. A within-policy quote is approved by the server against the saved policy version and can be issued by an authorized CSR immediately. An exception requires a named approver and reason. Approval and customer acceptance are different events.

Changes to quantity, item, destination, supplier, service or material assumptions invalidate the corresponding draft calculation. Recheck rate validity and policy conditions before committing an order. Approved exceptions are limited to a specific quote revision, amount and expiry.

Once a customer commitment is binding, retain its agreed terms. Later cost increases become an internal variance and escalation; any revised customer terms require a new explicit agreement. Cost updates must never silently alter signed documents or previously accepted prices.

## 10. Technical implementation design

### Shared calculation service

Add a pure contribution-pricing module beside the existing gross-margin domain code. Keep the current `margin.ts` meaning stable. Use integer currency units and exact ratio comparisons for policy checks; store percentages as a validated fixed-scale value. Test the real rounding sequence for each fee/discount profile.

The Express API owns calculation, quote revision, approval and order validation. The SPA can preview results using shared logic, but submitted browser totals are not trusted. Bulk pricing, CSR quotes, exports and order release all use the same calculation version.

Proposed service boundaries are: evaluate a scenario, save/revise a quote, request/record approval, activate a price-list batch, attach a valid quote to an order, record cost/revenue actuals, and reconcile results. Use idempotency for retried commits and transactional writes for quote approval, exact order lines, links and audit records. A cost or policy version changed during approval must trigger a fresh evaluation.

### Data model

Names below are conceptual and should be reconciled with existing tables during implementation.

| Record                             | Purpose                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Supplier and supplier-item mapping | Exact internal SKU/variant, supplier SKU, pack conversion, origin, availability and terms                              |
| Supplier offer/cost version        | Effective price, quantity tier, currency, inclusion flags, source evidence, verification and expiry                    |
| Fulfillment and fee profiles       | Dropship basis, shipping contract/rate card, package definitions, handling and applicable selling fees                 |
| Pricing policy/version             | Revenue and margin basis, target/floor/minimum dollars, override precedence, rounding, validity and approval rules     |
| Price list/version/batch           | Approved catalog prices with scenario assumptions, affected-item snapshot and activation history                       |
| Quote, lines and shipments         | Patient/order linkage, precise item quantities, supplier allocation, immutable calculation inputs/results and validity |
| Approval record                    | Requester, approver, reason, scope, permitted exception and quote revision                                             |
| Actual cost/revenue events         | Supplier invoice, freight invoice/label cost, adjustments, refunds, credits and collections with provenance            |

Reuse current catalog, cost-import tooling, audit patterns and cost snapshots where appropriate. Preserve `product_costs` compatibility as a current-cost projection if necessary; do not silently reinterpret existing landed values as goods-only cost.

Historical shipping specifications use product identifiers that need an explicit mapping to current SKU/variants. Missing package dimensions or a default weight are estimates, not a verified rate. Support supplier-specific packaging and multiple parcels before presenting a firm multi-supplier quote.

### Integration work required before release

1. **Canonical order lines:** Require organization, patient, stable order-line ID and structured SKU/variant/quantity references across the workflow. Normal CSR entry replaces free-form identity with these links. Exceptional custom items remain unresolved until their cost and identity are approved.
2. **Exact fulfillment:** Current signature-based dispense logic derives one suggested SKU from a draft. It must fulfill the exact approved lines and quantities before the feature supports priced multi-item orders end to end. Per-line idempotency and recoverable partial failures must prevent duplicate dispensing or supplier orders during concurrent signing or retries.
3. **Cost timing:** Capture the approved cost basis at quote/order approval. A later claim builder must not substitute today's cost for the historical approved snapshot.
4. **Shipping quote adapter:** Reuse XPS capability through a quote interface that accepts a planned shipment without requiring an existing legacy shop order. Rate retrieval must not buy a label. Save the provider quote, service, assumptions and validity. The existing rate endpoint requires an order row; its separate label-booking path also enforces paid status.
5. **Supplier fulfillment:** Start with verified supplier price-list and fee-card imports/manual quotes. Add supplier APIs only after confirming their availability, contract scope and supported operations. Purchase-order routing and booking have their own authorization and retry rules.
6. **Revenue reconciliation:** Link quote → order lines → fulfillment → claim/collection or future self-pay settlement. Do not count a quote as revenue or count both a legacy shop payment and the corresponding claim as separate sales.
7. **Reporting:** Rename misleading “Net margin” labels where the report only subtracts product COGS. Distinguish uncosted, partly costed and fully costed lines/orders and display the coverage of each profitability figure.

All new records and queries must use the existing organization-scoped access model. Customer documents, caches, exports and audit output must receive explicit field filtering. Clear private pricing state on identity/organization changes using the app's existing session protections.

## 11. Maintaining margin after activation

Capture supplier invoices and credits, actual freight and carrier adjustments, applicable payment costs, refunds/returns and collected revenue. Keep these events separate from the approved estimate, and reconcile using the order/line/shipment relationships.

Show **Quoted**, **Current forecast** and **Actual to date** with a completeness indicator. Mark a result as settled only when the required cost and collection events are complete under the finance team's close policy. A partially paid insurance claim must not appear to have a final loss or final margin prematurely.

Create a management queue for supplier cost increases, expired offers, missing rates, actual shipping overruns, return losses, weak collections, below-floor results and approved exceptions. Each alert shows the dollar impact, affected future prices and a suggested next action. Deduplicate repeated unchanged alerts and allow an owner and review date.

Repricing suggestions apply to future quotes. Do not automatically raise an accepted customer's total, reopen a signature or send a new price message. Updating a cost is distinct from activating a new price list.

For aggregate margin, divide total contribution by the corresponding total revenue; do not average item percentages. Show cost/collection completeness and exclude or clearly separate unresolved records. Optional return reserves must be replaced by actual outcomes as they settle, not deducted again alongside those outcomes.

## 12. Implementation phases, ownership and gates

This is an initial planning range, not a delivery commitment. With two full-stack engineers, shared QA and part-time finance/operations ownership, allow approximately **8–12 weeks**, including data review, integration uncertainty and pilot stabilization. Supplier API work, payment collection and rental pricing can extend that range and require separate estimates.

| Phase                                    | Indicative effort               | Deliverables                                                                                                     | Exit gate                                                                                          |
| ---------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1. Business definitions and data audit   | 1 week                          | Approved margin basis, sample cost sheets, supplier terms, payer/revenue modes, role policy, item/pack mapping   | Finance can reproduce a representative order manually and reconcile every component                |
| 2. Cost and order foundations            | 1–2 weeks                       | Cost editor/import, supplier offers/history, validity, canonical item/order relationships, package/rate profiles | No silent currency/pack assumptions; exact priced lines can become exact fulfilled lines           |
| 3. Calculator and CEO workbench          | About 2 weeks                   | Tested calculator, scenario comparison, targets/floors, bulk preview and versioned activation                    | Finance-approved examples pass; invalid/missing costs block; bulk activation and rollback verified |
| 4. CSR review and approvals              | 1–2 weeks                       | Embedded panel, saved quotes, exception queue, safe customer documents, server enforcement                       | Normal and exception workflows pass from draft through signature and fulfillment                   |
| 5. Actual costs and management reporting | 1–2 weeks                       | Shipping/supplier actuals, collection links, forecast/actual comparison, alert queue                             | Selected orders reconcile to source invoices and collections with no duplicated costs or revenue   |
| 6. Pilot and staged activation           | About 1 week plus stabilization | Shadow calculations, staff training, operational playbook, monitored rollout                                     | Finance, operations and representative CSRs sign off on acceptance criteria                        |

Use feature flags by organization and role. Pilot 20–50 representative SKUs across inexpensive supplies, larger items, multiple suppliers, remote destinations, bundles and split shipments. Include insurance cases with missing or constrained reimbursement and allowed internal self-pay examples.

First run in shadow mode, comparing recommendations to manually verified historical/sample orders. Then enable quote preparation for a small CSR group, followed by broader activation. Rollback disables new policy activation/quote creation while preserving accepted orders, their audit records and fulfillment access.

Suggested ownership: CEO owns target/floor and publishing policy; finance owns cost/revenue definitions and verification; purchasing owns supplier data; fulfillment owns package/rate accuracy; operations owns CSR workflow; engineering owns shared calculation and transactional integrity; QA coordinates acceptance evidence.

## 13. Acceptance criteria

### Financial examples

All amounts below are hypothetical and use the specified fee/rounding assumptions.

| Case                                                                                                          | Expected result                                                                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| $54 delivered cost; no selling fee; 40% target                                                                | $90 revenue, $36 contribution, 40% margin                                                                              |
| $54 delivered cost; 3% + $0.30 fee; no tax; 40% target                                                        | $95.27 passes with $38.11 contribution; $95.26 fails                                                                   |
| Same order with $6 customer shipping                                                                          | $89.27 merchandise + $6 shipping reproduces the same pre-tax revenue and contribution                                  |
| Same fee profile; 10% tax on all net sales                                                                    | $95.77 net sales, $9.58 tax, $3.46 fee and $38.31 contribution satisfy 40%; tax is excluded from revenue               |
| 10% merchandise discount; free shipping; no tax                                                               | $105.86 list price minus a $10.59 rounded discount produces $95.27 qualifying net sales                                |
| Extra $3 supplier fee and $7 freight; one payment                                                             | $64 cost; $112.80 revenue qualifies at exactly 40% with a $3.68 rounded fee; avoid unnecessary per-parcel payment fees |
| Original example with a $90 permitted price ceiling                                                           | 36.6667% achieved margin; show target cannot be met under that ceiling                                                 |
| $100 original revenue, $10 expected refunds, $60 cost, $2 return cost, $5 recovered value, retained $3.30 fee | $90 expected net revenue, $57 expected cost, $29.70 contribution and 33% expected realized margin                      |

An analytical unrounded solution can be slightly above or below the smallest qualifying cent price after fee rounding. The final exact evaluator is authoritative.

### Functional and integrity checks

- Missing cost, stale rate, unverified pack size, currency mismatch and supplier outage cannot produce an ordinary approved firm quote. An explicitly approved estimate remains labeled with its range and validity.
- An included freight component is not charged twice; shared fees and allocations reproduce the exact order total.
- Discounts, free-shipping thresholds, remote surcharges, supplier changes, quantity tiers and split packages trigger a full order reevaluation.
- Every active price is traceable to a policy/cost version and scenario. Every committed priced order has a server-validated quote revision and exact item/quantity links.
- Editing browser totals, retrying a request or making simultaneous approvals cannot bypass a floor or create duplicate orders.
- Changing inputs after approval requires re-review when material; binding customer terms and signed documents remain intact.
- Cross-organization access and unauthorized cost edits, bulk exports, publication and exception approval are rejected.
- CSR views show the allowed item cost/margin information; customer links, PDFs and signature packets expose no internal financial data.
- Multi-item approval, signature, dispense and fulfillment use the exact same approved items and quantities.
- Invoice/label/credit imports are idempotent, preserve sources and reconcile quote versus actual cost without overwriting history.
- Insurance billed, allowed, expected collectible, actual collected and patient responsibility remain distinct; a target gap never automatically changes patient liability.
- Uncosted and partially costed records are visibly incomplete. Mixed payment/claim records do not double-count revenue.
- Batch previews preserve selected products, explain exclusions, support safe activation and restore a prior policy for future orders.
- Keyboard navigation, clear currency formatting, visible loading/error/empty states, accessible status text and recovery from a failed rate request are verified with CSRs.

## 14. Success measures and operating cadence

Release measures:

- 100% of priceable pilot items have complete verified inputs, or an explicit blocked/approved-estimate state.
- 100% of committed priced pilot orders retain a valid calculation snapshot and server policy check.
- Zero unexplained floor bypasses, duplicate cost charges or duplicated revenue in the reconciliation sample.
- A trained CSR can evaluate a normal stocked/rate-known item and save its review in under 60 seconds during usability testing.
- A CEO can review and activate a prepared batch in under five minutes, excluding deliberate exception review.
- Target cached evaluation response time below 500 ms at the agreed pilot load; live external rate lookups have a separate measured timeout and visible progress state.

Ongoing measures include contribution dollars, weighted contribution margin, estimated-versus-actual cost variance, missing/stale cost coverage, supplier delivery cost and reliability, return rate, approval turnaround, exception frequency, quote completion time and quote acceptance by price scenario. Set commercial targets from the pilot baseline instead of inventing expected revenue improvements.

Finance should review significant cost/reimbursement changes when they arrive, reconcile open variances on a regular operating schedule, and revisit targets and cost assumptions at an agreed monthly or quarterly cadence. The app should assign ownership and due dates so an alert results in a decision.

## 15. Decisions to record before implementation

These are business setup decisions for the first phase, not reasons to delay preparing this plan.

| Decision                                     | Recommended starting approach                                                                                           |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Which profit measure is controlled?          | Contribution after variable delivery/selling costs; show overhead allocation separately                                 |
| What targets apply?                          | CEO chooses company target, hard floor and minimum dollars, with limited documented overrides; 40% here is illustrative |
| Which revenue modes launch?                  | Insurance evaluation first; internal self-pay quotes only where business needs them; payment collection separate        |
| Which suppliers and costs are authoritative? | Finance-approved price lists/invoices and supplier fee contracts with exact unit conversions                            |
| How is shipping charged?                     | Define covered zones/services and treatment per revenue mode; individually quote exceptions                             |
| How current must data be?                    | Provider quote expiry for rates; supplier effective dates and a finance-set cost review interval                        |
| May estimates be used?                       | Planning scenarios by default; firm quotes require verified inputs or a specific bounded-estimate approval              |
| Who can approve and publish?                 | Named CEO/finance delegates; CSR evaluation and request authority; separate cost write/publish permissions              |
| How are returns and overhead treated?        | Start with transparent available evidence; configure assumptions explicitly and reconcile to actual outcomes            |
| What may be automatically activated?         | Start with proposals and human review; revisit limited automation only after pilot accuracy is demonstrated             |

## 16. Repository implementation references

These references anchor the plan to inspected code; they do not imply the proposed feature already exists.

| Code                                                                                                                                                     | Relevance                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [Product cost API](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/product-costs.ts:44)               | Current cost fields, permissions and upsert behavior            |
| [Catalog API](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/catalog.ts:67)                          | Existing item/inventory foundation                              |
| [Gross-margin domain code](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/lib/resupply-domain/src/margin.ts:62)                              | Preserve existing gross-margin semantics and unknown costs      |
| [Margin reporting API](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/analytics-margin.ts:102)       | Historical shop-line revenue and COGS basis                     |
| [Payer profitability API](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/payer-profitability.ts:190) | Existing billed/allowed/paid data and cost coverage             |
| [CSR order panel](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/cpap-fitter/src/components/admin/CsrOrderRequestsPanel.tsx:549)   | Existing insurance/signature workflow and UI insertion point    |
| [CSR order schema](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/csr-order-requests.ts:69)          | Free-form items requiring structured quote links                |
| [Resupply approval UI](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/cpap-fitter/src/pages/admin/admin-therapy-resupply.tsx:590)  | Additional CSR review integration                               |
| [Signature dispense](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/lib/csr-order/dispense-on-sign.ts:14)         | Exact approved-item fulfillment dependency                      |
| [XPS rate endpoint](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/routes/admin/xps-shipping.ts:235)              | Existing rate retrieval, separate from label purchase           |
| [Shipping actual cost](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/lib/shipping/xps-core.ts:342)               | Capture actual shipping without replacing the quote             |
| [Claim cost capture](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/artifacts/resupply-api/src/lib/billing/claim-builder.ts:392)             | Carry forward approval-time cost basis                          |
| [Role definitions](C:/Users/kdeya/Documents/Codex/2026-09-10/kde/work/PennFit/lib/resupply-auth/src/rbac.ts:286)                                         | CSR financial visibility requires an explicit permission design |
