# Pricing API and financial authority

`contracts.ts` is the request schema and response contract. The matching browser
types live in `lib/api-client-react/src/admin/pricing.ts`. All amounts are USD
integer cents and percentages are integer basis points. These routes are internal
staff tools; patient payment collection remains separate.

The routes begin `/admin/pricing`. `pricing.evaluate` permits CSR reads, scenarios,
quotes and sourcing proposals. `pricing.manage` controls supplier evidence,
insurance profiles, reconciliation and alerts. `pricing.approve` records a named
quote exception decision. `pricing.publish` controls policy and price-list
activation, rollback, scheduling and pause. Existing authenticated CSRF protection
applies to writes. Per-actor rate limiting supports the bounded 100-row CSV import.

## Authoritative records

- `/offers` creates a new supplier offer or appends a version using `id` and
  `expectedVersion`. `unitCostCents` is the cost per canonical sell unit; quantities
  must be whole verified supplier packs and within the offer tier. Freight,
  drop-ship, packing and other components retain their charge basis, inclusion
  reference, verification, expiry and delivery scope. `includedInId: "goods"`
  means the goods cost already includes the component. Shared charge IDs under
  the same supplier deduplicate a single order/shipment fee. Conflicting fee
  definitions are rejected. Separate supplier deliveries require separate cost
  coverage. Country, postal prefixes, service and fulfillment method are checked;
  `*` explicitly covers all postal codes in the stated country.
- Default offer reads return the newest effective version. A future version does
  not replace today's version early. Manager `view=latest` includes queued future
  versions, and `/offers/:id/versions` lists history. Exact duplicate import rows
  reuse the existing offer, including retries whose only difference is a generated
  past effective timestamp. A different cost/source remains a separate offer unless
  the caller explicitly supplies the existing offer ID and reviewed version.
- `/policies` saves an explicit policy; nothing is enabled by migration. Publishing
  uses the expected state revision. Per-item scope precedence is SKU, category,
  revenue mode, then company. Priority resolves matches within a scope. The whole
  order uses the strictest resolved target, floor and minimum dollars, and retains
  the per-line rule applications in its evaluation snapshot. Each item's own unit
  ceiling is enforced. Recommendations use the selected item's price increment,
  ending and ceiling. Quotes cannot cross an effective policy-rule change.
- `/revenue-profiles` stores manager-verified insurance evidence for one patient and
  exact SKU quantities. The expected amount cannot exceed allowed revenue. Optional
  insurer, secondary, patient and collection-adjustment shares must sum exactly
  once to that amount. CSR scenarios may reuse the exact profile version; typed-in
  insurer expectations remain estimates. Billed item amounts are independent from
  expected collections and do not establish patient responsibility.

## Quotes and publication

`POST /evaluate` and `/recommend` resolve supplier data, policy and evidence on the
server. They permit alternatives for review. A quote saved through `/quotes` retains
the input, evaluation, canonical items, source versions, destination and validity.
Browser totals and verification flags are never authoritative. Missing/stale inputs,
hard floors, minimum contribution and unit ceilings block approval. Complete
estimates and a target gap above all hard limits require an explicit approval reason.
A firm, current, within-policy quote saved with `requestApproval:false` is approved
by the server atomically; pending reviews use `/quotes/:id/approve` with the exact
revision. Revisions and decisions are retained in `pricing_events`.

`GET /active-prices` supplies the active batch for an explicit browser Apply action.
Saving a new quote enforces published unit amounts for matching revenue/SKU/quantity
contexts. Single-item published contexts can compose an order; bundles require their
exact composition. An already published SKU with an unrepresented quantity/bundle
requires a reviewed price context. Evaluation and batch preview remain available to
prepare that change. Already approved/bound snapshots are not repriced automatically.

`/batches/preview` saves immutable reviewed scenarios; `/batches/:id/activate` changes
the complete active pointer atomically. Activating a still-valid earlier batch is
rollback for future quotes. Stale sources cannot be rolled back into use silently.
`/schedule` and `/cancel-schedule` use the state revision. The scheduler and pricing
reads call `pricing_apply_scheduled`; activation is rechecked at execution, once,
and stale schedules enter a review alert without partially changing prices. Only
one pending activation is allowed per tenant. Pause remains possible after expiry.

`prepareCsrPricing` checks a current approved insurance quote and exact patient,
line IDs, SKUs, quantities, billed amounts and fulfillment methods. The CSR binding
RPC in migration 0549 repeats these checks under the same tenant state lock. Exact
bound retries reuse the accepted order even if later prices or costs have changed.

## Reconciliation and review

`POST /discount-headroom` takes `{scenario,maxAdditionalDiscountCents?}` and
returns the resolved scenario plus `discountHeadroom`. For verified self-pay
inputs it recomputes each additional fixed-discount cent, retaining the existing
percentage and fixed discount, quantities, supplier tiers, destination, billed
prices, taxes and fee assumptions. It checks the target and every hard floor and
minimum independently. This is a fixed-scenario analysis, not a promo publication
or a change to patient insurance billing. Exact variable-base capture amounts
must be revised before changing their discount.

`target` and `floor` contain the highest qualifying additional discount and its
evaluation **within** `searchUpperBoundCents`. `wholeDomainSearched:true` proves
the complete remaining merchandise-discount domain was evaluated; otherwise
`status:search_limit` identifies a partial interval, never a global maximum.
The bound is at most 100,000 cents, the caller's requested limit, and a workload
limit accounting for lines, costs and captures. Short asynchronous chunks keep
other API work responsive. No amount is applied automatically.

`/quotes/:id/actuals` accepts source events only for bound orders. A tenant-wide
economic event ID and source/reference pair make imports idempotent and reject
duplicate collection copies from different systems. Use the same economic ID when
the same collection appears in a claim and a legacy shop record. This API does not
automatically import external ledgers or infer that two unrelated source IDs are
the same money. Cost credits and refunds have distinct signs and source validation.

The original quote stays immutable. Actual events and completeness flags are read
in one locked snapshot; new events reopen both completeness flags. A current
forecast separately resolves today's offers, policy and evidence and reports why
it is unavailable when a new rate or evidence is needed. Finance explicitly closes
costs and collections with the reviewed revision. `/summary` divides aggregate
contribution by aggregate revenue and separates settled from incomplete orders.

`/alerts` includes source expiry/increases, pending quote exceptions, actual cost
overruns, closed collection shortfalls and blocked schedules. Stable keys deduplicate
unchanged signals. `/alerts/:key/review` assigns an owner/review date and records a
revisioned decision. `/proposals` is a separate sourcing queue with item identity,
pack, source, estimated costs, terms and expiry; exact duplicates reuse a proposal.
Resolving a proposal requires a real tenant catalog SKU.

## Validation

`service.test.ts` covers calculation authority and scope; `persistence.test.ts`
executes migration 0548 and its transactional operations on PGlite by default.
It also accepts `PRICING_TEST_DATABASE_URL` only for a positively identified
loopback database whose name starts `pricing_test_`; this mode recreates its test
schema and has been exercised on PostgreSQL 17. `routes/admin/pricing.test.ts`
checks role/validation boundaries and the reviewed import rate-limit ordering.
No test invokes a vendor, sends communications or collects a payment.
