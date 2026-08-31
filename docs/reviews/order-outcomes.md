# Order outcomes — what each stage counts, and what it does not

`/admin/analytics/order-outcomes`, backed by
`lib/analytics/order-outcome-funnel.ts`.

The question this answers is the one the business actually asks: **of the
patients who were due this quarter, how many ended up as money — and where
did the rest go?** The platform used to measure the resupply funnel and
the claim funnel in two places that never touched, so nobody could answer
it at all.

---

## The stages

Each is a strict subset of the one before it. The **unit is an episode** —
one resupply cycle for one patient — throughout, which is why two claims
against one shipment still count as one.

| Stage       | Denominator | What counts                                                                                                                                                                                                     |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `eligible`  | —           | Every episode that became due in the window. The mouth of the funnel.                                                                                                                                           |
| `confirmed` | eligible    | The patient **affirmatively agreed**. Either the episode says `confirmed`/`fulfilled`, or a fulfillment exists — which only a confirm creates. The second arm catches a confirm whose status write lost a race. |
| `fulfilled` | confirmed   | The supplies went out **and we know they did**.                                                                                                                                                                 |
| `claimed`   | fulfilled   | A claim exists against the fulfillment.                                                                                                                                                                         |
| `accepted`  | claimed     | `accepted`, `partially_paid` or `paid`.                                                                                                                                                                         |
| `paid`      | accepted    | `partially_paid` or `paid` — money actually arrived.                                                                                                                                                            |

Rates are `null`, never `0`, when the denominator is empty. A practice
with no eligible patients has not converted 0% of them, and rendering the
two the same makes a quiet month look like a catastrophe.

---

## `fulfilled` has one deliberate exclusion

An episode counts as fulfilled when **either**:

- a fulfillment carries a real `shipped_at` (evidence, whatever the
  episode's status — a real ship whose close-out lost a race still
  happened); **or**
- the episode is `fulfilled` **and was not closed `assumed_shipped`**.

**`assumed_shipped` is the grace sweep saying "we gave up waiting", not
"it shipped."** The sweep advances a ladder that never got confirmation so
the patient keeps being reminded, and it deliberately **never touches the
fulfillment** — inventing a ship date for a payer is a compliance problem,
not a data-quality one.

Counting it as shipped would then count it as **shipped-but-unbilled**:
an expensive product-loss number reported against product that may not
exist. So it is reported separately, as `unverified.assumedShipped`.

**The size of that bucket is the argument for connecting a ship feed.** It
is exactly the population the platform cannot account for.

---

## Losses before the shipment

`preShipLoss`, keyed by `episodes.closed_reason`:

| Reason               | Meaning                                                                                                                                      |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `patient_declined`   | "No, not this cycle."                                                                                                                        |
| `patient_opted_out`  | "Stop contacting me." A different follow-up entirely.                                                                                        |
| `no_response`        | The ladder ran out **after** we reached out.                                                                                                 |
| `never_contacted`    | The ladder ran out having **never sent anything** — no phone, no email, or a worker outage. **A patient we failed, not one who ignored us.** |
| `csr_canceled`       | A person closed it.                                                                                                                          |
| `prescription_ended` | The prescription stopped being active.                                                                                                       |
| `patient_inactive`   | The patient left active status.                                                                                                              |
| `duplicate`          | Superseded by another episode.                                                                                                               |
| `coverage_lost`      | Coverage lapsed; this cycle cannot be billed.                                                                                                |
| `legacy_unknown`     | Closed **before** the reason column existed (migration 0538). Genuinely unknown, and bucketed as such rather than back-filled with a guess.  |

---

## Losses after the shipment

| Key            | Meaning                                                                                                                                                                                                                 |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbilled`     | Shipped and **never billed**. Usually the largest single number here, and the one nobody sees: invisible from billing (which does not know the shipment happened) and from resupply (which considers the cycle closed). |
| `rejected`     | **The clearinghouse** refused the claim. It was malformed and **never reached adjudication.**                                                                                                                           |
| `denied`       | **The payer** considered it and said no.                                                                                                                                                                                |
| `closedUnpaid` | Closed with no payment and no denial.                                                                                                                                                                                   |

### Rejected is not denied

The most consequential distinction on this page. A biller who appeals a
rejection wastes the appeal _and_ the timely-filing clock — the claim was
never adjudicated, so there is nothing to appeal. It needs correcting and
resending.

`deniedByCarc` breaks denials down by CARC code. **Codes only**, never the
composed prose: free text has unbounded cardinality and payer messages can
quote claim and member detail. A denial with no parseable code is counted
as `uncoded` rather than dropped — a denial that vanishes from the
breakdown while still counting in the total makes the two numbers on the
page disagree, and then neither can be trusted.

---

## In flight is not lost

| Key                  | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `awaitingResponse`   | The patient is still deciding.                                                                     |
| `confirmedUnshipped` | Agreed, not yet shipped.                                                                           |
| `addressHold`        | Parked on an address confirmation. **The cycle is alive.**                                         |
| `claimOpen`          | `draft`, `submitting`, `submitted`, `accepted` or `appealed` — still with the biller or the payer. |

Counting these as losses makes every dashboard look like a disaster on the
day it is opened, and teaches operators to ignore it.

---

## `partially_paid` is not `paid`

It is money that arrived **and** money that did not. The funnel counts it
in `paid` because money did arrive, but the **status is preserved
distinctly** and the billing surfaces read the status. Folding the two
together hides the unpaid half, which is the half somebody has to chase.

---

## Reading the page

| Symptom                    | Where to look                                                                                                                                           |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmedOfEligible` low  | `preShipLoss` — declines vs. no-response vs. **never_contacted**. The last one is a worker problem, not a patient problem.                              |
| `fulfilledOfConfirmed` low | Confirmed orders are not shipping, or shipments are not being recorded. Check `unverified.assumedShipped` — if it is large, the _recording_ is the gap. |
| `claimedOfFulfilled` low   | `postShipLoss.unbilled`. Product went out and no claim followed.                                                                                        |
| `acceptedOfClaimed` low    | `postShipLoss.rejected` — a **format** problem, and usually the same one repeatedly.                                                                    |
| `paidOfAccepted` low       | `deniedByCarc`. One code dominating is one rule to fix.                                                                                                 |

---

## Coverage

- `order-outcome-funnel.test.ts` — the aggregation, unit by unit.
- `order-to-cash.e2e.test.ts` — thirty branches end to end through the
  real modules, including both cross-tenant attempts.
- [`../runbooks/order-to-cash-sandbox-smoke-test.md`](../runbooks/order-to-cash-sandbox-smoke-test.md)
  — what a real clearinghouse would add, and what evidence it needs.
  **Not yet performed.**
