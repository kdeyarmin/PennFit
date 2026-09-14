# Pricing & Profitability operations

The `/admin/pricing` workspace implements the [accepted pricing design](pricing-profitability-plan.md). It uses the current insurance signature and fulfillment workflow. Internal self-pay scenarios are simulations; this feature does not collect patient payments.

## First-time setup

1. Apply ordered migrations `0548_pricing_profitability.sql` through `0551_csr_legacy_dispense_integrity.sql` through the normal deployment process, including `0549_csr_pricing_order_integrity.sql` and `0550_csr_delivery_reviews.sql`. These create private pricing records, quote/order/fulfillment links, and delivery review controls. They do not seed prices, margin targets, supplier agreements, or verified insurance estimates.
2. As an administrator, create a pricing policy with the company's approved target margin, hard floor and optional minimum contribution dollars. Choose contribution or profit after allocated overhead. Add dated item, category or revenue-mode overrides where needed; review the displayed effective rules before publishing.
3. Enter or import supplier offers. Map the exact catalog SKU and supplier SKU, normalize the purchase pack to the sell unit, record cost evidence and expiry, and itemize applicable dropship, delivery, handling and other charges. Explicit known zero is supported; blank costs remain unknown. An offer's delivery coverage and service must fit the evaluated destination and fulfillment method.
4. Enter verified, dated insurance collection evidence for the patient and exact items/quantities. Record allowed and expected collectible amounts. Optional insurer, secondary and patient shares plus a signed collection adjustment must reconcile exactly. This evidence does not calculate or increase patient liability.
5. Evaluate representative orders and approve reviews. For stock shipping, configure the tenant XPS warehouse account and supply measured parcel data. A returned carrier estimate is valid for 30 minutes in the app; this is not a carrier price guarantee. Supplier dropship delivery uses the verified supplier terms.
6. Publish the policy and enable pricing. Enable mandatory approved reviews only after the catalog, costs and collection evidence are ready. Existing unreviewed workflows remain available while enforcement is off. When enforcement is on, new CSR orders require an approved insurance review.

## Everyday work

**CSR:** Select the patient and exact items; compare offers, delivery cost and contribution. Save a review, request approval when needed, and attach the approved review to an order or resupply draft. Changing an attached order's lines requires another review. The server validates the quote revision, current policy, supplier evidence, delivery assumptions and exact patient/items again at order creation. Repeated submission returns the same committed order.

**Resupply batches:** Select up to 50 open drafts in the patient review tab. Each patient's existing exact-item approval is rechecked separately, with ready, stale, missing-review and unavailable results. The batch check neither contacts patients nor creates orders. Use individual review for a draft without a catalog SKU, a changed quantity, or missing evidence. The selection screen shows up to 200 open drafts at a time.

**CEO/management:** Evaluate item and order scenarios, compare supplier costs, and build a frozen bulk preview. Review old/new prices and included assumptions. An invalid entry cannot silently disappear: explicitly preview an eligible subset when appropriate. Activate the saved version now or schedule it. Scheduled activation rechecks dependencies in one database transaction; changed or expired evidence blocks the activation and appears in follow-up. The worker checks schedules every minute, and pricing reads also apply due schedules. Re-activating an eligible prior version changes future reviews only.

**Fulfillment:** Signing a priced order queues its exact SKU, quantity, fulfillment method and acquisition-cost snapshot. All lines are created together. An active prescription for every exact SKU and any address hold must be resolved before release. Retry the signed order's fulfillment action after correcting prerequisites. Stock movements use the inventory ledger once; dropship lines do not decrement owned stock. Incomplete inventory bookkeeping is flagged for warehouse review. A changed delivery destination requires review before the quoted delivery assumptions can be used.

**Finance:** Record invoice, freight, processing, collection, refund and credit events against the bound order review. Use stable source references and the same economic-event identifier when retrying an import. Events are append-only; corrections are new, documented events. Mark costs and collections complete separately with a reason. Actual-to-date results remain incomplete until both are closed. Quoted economics remain intact; current forecasts and actual variances are separate. Aggregate margin uses total contribution divided by corresponding revenue, with incomplete records disclosed.

**Delivery changes:** A manager can review a held signed order using its original items and accepted amounts, the current patient address, current costs, and fresh delivery evidence. Review the original and revised contribution, record the reason, and approve the exact review revision. A below-target exception requires an explicit acknowledgement; the hard financial floor still blocks release. Resolving a general address alert alone does not release a priced order. Already shipped work remains historical evidence.

If the original non-delivery fees or reserves expired, a manager may explicitly confirm their previously verified amounts are unchanged, recording evidence and a new expiry. This confirmation cannot verify missing or estimated amounts and cannot change a fee or reserve. Supplier costs are refreshed from the current supplier offer; update that offer when its costs or delivery coverage change. The original accepted prices, collectible amount and pricing record remain unchanged.

**Volume planning:** Enter expected monthly order counts in a frozen bulk preview to compare projected revenue and contribution dollars. These are explicit assumptions, with no invented demand. Combined margin is weighted by revenue, and incomplete costs prevent a combined profitability result. Creating another preview resets the volume assumptions.

**Discount analysis:** For internal self-pay scenarios with complete costs, choose a search limit to calculate the largest additional discount within that range that preserves the target or the hard floor. The analysis checks each cent against the full calculation and keeps quantities, supplier, service and fee assumptions fixed. Large scenarios may search a smaller interval to keep the app responsive; partial results are labeled and never described as a global maximum. Insurance revenue is fixed, and discounts are not automatically applied or collected.

**PacWare export:** The resupply preview and CSV use the signed fulfillment's exact SKU and quantity. Priced items on hold, already submitted, or requiring a new delivery review are withheld and counted. Both paths recheck the current delivery gate. Export is a manual handoff; it does not submit a supplier order or guarantee an external operator uses the newest file. The preview discloses the existing 5,000-item export window.

## Controls and boundaries

- `pricing.evaluate`: relevant cost/margin evaluation and proposals for CSRs. `pricing.manage`, `pricing.approve` and `pricing.publish`: separate management authorities. Browser database roles cannot execute pricing mutations or read private pricing tables directly.
- Pricing uses integer USD cents. Percentage decisions use exact comparisons; displayed percentages are rounded for readability. Margin is not markup or company net income. Optional overhead remains explicitly labeled.
- The patient signature workflow accepts at most 20 lines, quantities 1–99 per line and its existing amount bounds. Internal scenarios can model larger quantities, but cannot bypass those order limits. Rentals and multi-period reimbursement require their separate lifecycle model.
- Current patient addresses and saved carrier-rate contents are authoritative. Missing vendor configuration, rates or evidence produce an actionable incomplete result; they never become free delivery or a fabricated verified price.
- Supplier contracts, actual business targets, collection assumptions and carrier credentials must be entered by the business. The software does not invent them. PacWare CSV support is not a live supplier quotation or purchasing API.
- The new financial event records support documented entry and source references. Actual carrier/supplier/clearinghouse amounts must be reconciled to those records; recording an estimate does not prove settlement.
- Patient-facing signature items contain descriptions, quantities and appropriate amounts. Private supplier costs, contribution, approval notes and financial history are excluded.
- Changes to policy or supplier costs do not rewrite bound orders. Claim creation preserves the approved acquisition-cost snapshot, including exact extended cost when a dispensed pack maps to multiple HCPCS billing units.

## Verification

Run the normal repository typecheck, lint, tests, architecture checks and production build. Financial tests cover exact cents, floors, minimum dollars, processing fees, tax, discounts, split costs, allocations, returns and insurance collections. API and UI tests cover permissions, stale revisions, selected patients, source failure and account changes.

`lib/resupply-db/scripts/csr-pricing.integrity.test.ts` runs only with a loopback test/review database URL. It verifies atomic binding and dispensing, retries, tenant rejection, immutable order economics, frozen acquisition costs, prescription holds and stock/dropship behavior. The pricing persistence suite separately tests publication, scheduled activation, evidence versions, actual event deduplication and private function grants. Replay all ordered migrations against an isolated database before deployment.

Production settings and real supplier/patient communication are outside local verification. Test with synthetic records; do not run fixture suites against production.
