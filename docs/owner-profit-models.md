# Owner profit models

Owner models in **Pricing & Profitability** are management planning tools built on an item or order scenario. They use its quantities, supplier costs, delivery charges, revenue assumptions, processing fees and reserves. They do not publish prices, approve patient orders, collect payments or change insurance reimbursement.

Access requires `pricing.manage`. Start with an evaluated item review using **Use in owner models**, or select a saved review in the **Owner models** tab; use **Next saved scenarios** for later pages. A saved review supplies the scenario, and each calculation rechecks its evidence. Enter the assumptions for the sections you need and calculate each section separately. Editing an assumption hides that section's old result until you recalculate. Missing assumptions remain missing, including costs and expected demand; an explicit zero is different from a blank field.

For an expired catalog scenario, **Refresh catalog assumptions** can load current offer versions where available. Starting a refresh clears prior results and removes them from the downloadable report immediately; a late calculation from the previous source cannot restore them. Expired manual or patient-linked evidence needs a fresh review; calculation does not extend its deadline.

**Download scenario report** exports the current calculated sections and their entered assumptions as CSV. Each section records the server response used for that calculation: source items and quantities, baseline amounts, the item selected for repricing, policy and supplier-offer versions, evidence deadlines and calculation time. Sections calculated at different times retain their own source details. Assumptions remain while switching workspace tabs, but these models do not save a durable planning record; download a report before leaving when one is needed.

## Shared definitions

- **Net revenue** excludes pass-through sales tax and deducts modeled refunds. For insurance it starts from expected collectible revenue, not billed charges or an invented patient balance.
- **Contribution per order** is net revenue less variable costs: acquisition and fulfillment costs, applicable processing fees, return costs and other modeled variable losses, with explicit recoveries and fee credits accounted for.
- **Allocated overhead** is available in the underlying pricing review. The monthly, price/volume and acquisition projections start with contribution before that allocation and subtract the fixed costs entered for their own period once. Do not enter the same expense as both a variable cost and a fixed cost.
- **Planning profit** is the result after the explicit costs entered in that model. It is not a complete company income statement or a guarantee of demand, collections or profitability.

Amounts use USD cents. Percentages are entered explicitly; the software does not select a recommended business margin. A calculation can be complete while its assumptions are estimates or its result fails pricing policy. Read the model status and policy results together.

## 1. Pricing strategies

This compares four ways of choosing one line's unit amount while holding the other items and scenario assumptions fixed:

| Strategy           | Meaning                                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Target margin      | Find an amount that reaches the entered whole-order contribution margin.                                                                  |
| Cost markup        | Apply the entered markup to **all variable costs**, including applicable fees; this is not just a markup on merchandise acquisition cost. |
| Fixed contribution | Find an amount that reaches the entered whole-order contribution dollars.                                                                 |
| Reference price    | Evaluate the selected line at an amount supplied by the user; the app does not retrieve a competitor or market price.                     |

Markup and margin have different denominators. The model converts markup to its margin equivalent, `markup / (1 + markup)`, rounded upward to the next basis point, then uses the existing exact-cent price recommendation engine. This conservative conversion can produce slightly more than the requested markup. Recommendations obey the applicable hard floor, minimum contribution, price increments, endings and ceiling. An original policy floor after overhead can require a higher amount than the owner's contribution goal alone. The resulting scenario is also evaluated against the original policy, so meeting a planning target does not itself authorize a price. Automated strategy search is bounded to 160 combined input components; larger scenarios require an explicit reference-price case.

A percentage markup requires a positive net variable-cost base. If recoveries or fee rounding leave the candidate with zero or negative variable costs, its economics remain visible for review but the model withholds the markup recommendation. A reference price or contribution target remains available where applicable.

For multiple items, select the line whose unit amount may change. Its quantity stays fixed, and automated recommendations use that item's resolved price increment, ending and ceiling. Every item's ceiling is checked, including unchanged items; exceeding one blocks the affected result rather than allowing another line's price to conceal it. Explicit reference-price and price/volume cases remain visible for diagnosis when blocked. Processing fees, discounts and tax are recalculated by the shared pricing engine. Insurance collectible revenue is fixed: changing a billed unit amount does not increase reimbursement, so price strategies cannot solve an insurance revenue shortfall.

## 2. Monthly break-even and profit

Enter monthly fixed costs, expected orders and a target monthly profit. Every modeled order repeats the baseline scenario with the same contribution and item mix.

- Break-even orders = monthly fixed costs / contribution per order, rounded upward to a whole order.
- Orders for target profit = (monthly fixed costs + target profit) / contribution per order, rounded upward.
- Projected profit = contribution per order × expected orders − monthly fixed costs.

A positive profit requirement cannot be reached by adding orders with nonpositive contribution. Expected order counts are supplied assumptions, not a sales forecast inferred by the app.

## 3. Cost, freight and collection sensitivity

Enter up to 12 named cases with percentage changes to line acquisition unit costs, freight costs or expected insurance collections. The model reevaluates each case through the same pricing engine and shows its contribution difference from the baseline. Changed unit or component amounts round to the nearest cent before the normal quantity calculation. Multiple changes in one case occur together; it is not a probability-weighted forecast.

Freight sensitivity changes separately itemized `freight` and `shipping` components. An included freight entry can point through other included entries to a separately priced freight charge; that parent charge changes once, without charging its included entries again. Freight bundled into goods or another non-freight charge still needs separate evidence. Missing or stale parent evidence cannot be replaced by a verified included entry. Other handling or dropship fees remain as entered. Goods sensitivity changes each line's acquisition unit cost, not unrelated shared charges.

Collection changes apply to insurance expected collectible revenue. They do not rewrite contracted allowed amounts, calculate patient liability or apply a self-pay price discount. When a resolved allowed amount is available, a projection above it is retained for review but blocked. A sensitivity case does not verify a new supplier cost or collection estimate; it remains a hypothetical change to the scenario's evidence.

## 4. Price and volume

For up to 12 cases, enter the selected line's unit amount and expected orders, plus fixed costs for the comparison period. Each order repeats the whole scenario; the volume is order count, not the selected line's item quantity.

Projected revenue and contribution multiply the reevaluated order totals by the entered orders. Projected profit subtracts the supplied fixed costs once. Price and demand are independent inputs: the app does not infer elasticity or claim that a different price will produce the entered volume. Insurance collectible revenue remains fixed, so this price-changing model is not applicable to insurance scenarios.

## 5. Acquisition and repeat orders

Enter a finite horizon in months, acquired customers, orders per customer over that **whole horizon**, acquisition cost per customer, retention cost per order and fixed costs for the entire horizon.

- Total orders = customers × orders per customer.
- Contribution per customer = baseline contribution per order × orders per customer, before the additional retention and acquisition costs.
- Net per customer = (baseline contribution per order − retention cost per order) × orders per customer − acquisition cost per customer.
- Projected profit = net per customer × customers − the horizon's fixed costs.
- Acquisition payback orders divides acquisition cost per customer by contribution after retention cost, rounded upward when the denominator is positive. The model compares this count with orders per customer to show whether payback fits within the horizon.

This is a finite repeat-order scenario, not an infinite customer lifetime value or a subscription model. It assumes the same order economics for every repeat. It does not infer retention, churn, clinical eligibility, resupply cadence or future contracted reimbursement. Payback covers acquisition cost; it does not allocate the horizon's fixed costs to each customer.

## 6. Working capital

Enter the period length in days, orders during that period, cash outlay per order, inventory days, days to collect and days to pay the vendor. Cash outlay is explicit because expense recognition and cash payment can differ.

- Funding gap days = max(inventory days + days to collect − days to pay vendor, 0).
- Period cash outlay = cash outlay per order × period orders.
- Estimated funding = period cash outlay × funding gap days / period days, rounded upward to cents.

This steady-rate approximation is always labeled estimated and can use explicit cash assumptions even when baseline profit evidence is incomplete. It does not assume a 30-day month. It does not include opening cash, uneven receipts, inventory minimums, borrowing costs or other cash flows unless they are reflected in the supplied assumptions. A zero gap does not mean the company needs no cash for every purpose.

## Reading results

The screen's **More information needed** status identifies missing assumptions or incomplete evidence. **Review required** identifies a policy or calculation constraint. **Not attainable with these assumptions** means the requested outcome cannot be reached within the model's constraints. **Not available for this scenario** identifies an inapplicable model, such as changing insurance reimbursement by changing billed prices. **Uses estimated inputs** includes hypothetical sensitivity and cash-funding assumptions. Calculated or estimated results remain planning outputs: inspect the source review status too, and never treat a calculated loss or below-floor scenario as an approved order.

The models do not persist a new authoritative price list or change the source review. Use the normal policy, supplier verification, pricing review and publication workflows for operational changes. See the [operations guide](pricing-profitability-operations.md) for those controls.
