# Stripe Webhook Event-Handler Matrix

Maps the Stripe events `artifacts/resupply-api/src/lib/stripe/webhook-handler.ts`
listens to onto the database tables they mutate. Use this as the
reference when adding a new event subscription, debugging a
"why is `shop_orders` stuck at status=`paid`?" question, or
deciding whether a new feature needs a new event handler.

The webhook is mounted at `/resupply-api/stripe/webhook`
(`app.ts:132`) with `express.raw({ type: "application/json", limit:
"256kb" })` so the signature verification operates on the exact bytes
Stripe sent. Every event verifies the `Stripe-Signature` header
before reaching the switch (`webhook-handler.ts:200`); a mismatch
returns 400 with `{error: "invalid_signature"}`. Verified events
return 200 even when downstream processing fails — Stripe retries on
non-200, and we'd rather not re-run idempotent side effects (email
send, cart-recovery mark) just because a single non-essential write
failed. The wrapping `try` at `webhook-handler.ts:207` is the only
path that 500s, and that path was hardened in P3.10 to capture full
Stripe error context.

---

## Event matrix

| Stripe event                               | Handler module path                                                                                                             | Tables written                                                                                                                                                            | Idempotency                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `checkout.session.completed`               | `markPaid` → `upsertOrderItemsFromSession` → `syncCustomerAfterCheckout` → `markCartRecovered` → `sendOrderConfirmationIfFirst` | `shop_orders` (status, paid_at, shipping_address, customer_email), `shop_order_items` (insert), `shop_customers` (saved-card info), `shop_abandoned_carts` (recovered_at) | `markPaid` is gated on status currently being one of the pre-paid states (no double-flip on Stripe re-delivery); `shop_order_items` insert relies on `(stripe_session_id, product_id, price_id)` UNIQUE; confirmation email gated on `shop_orders.confirmation_email_sent_at` claim. |
| `checkout.session.async_payment_succeeded` | same as `checkout.session.completed`                                                                                            | same                                                                                                                                                                      | Stripe sends BOTH this and `checkout.session.completed` on async-payment success; both branches no-op idempotently when the row is already at `paid`.                                                                                                                                |
| `checkout.session.expired`                 | `markStatus(session.id, "expired")`                                                                                             | `shop_orders` (status='expired')                                                                                                                                          | Status flip is conditional — markStatus checks current state before writing, so a redelivery is a no-op.                                                                                                                                                                             |
| `checkout.session.async_payment_failed`    | `markStatus(session.id, "failed")`                                                                                              | `shop_orders` (status='failed')                                                                                                                                           | Same conditional-flip protection.                                                                                                                                                                                                                                                    |
| `customer.subscription.created`            | `upsertSubscription(sub, eventCreatedAt)`                                                                                       | `shop_subscriptions` (upsert on `stripe_subscription_id`)                                                                                                                 | UPSERT gated on `last_stripe_event_at` — out-of-order delivery (created arriving after updated, replays after updates, etc.) cannot overwrite newer state.                                                                                                                           |
| `customer.subscription.updated`            | same                                                                                                                            | same                                                                                                                                                                      | same                                                                                                                                                                                                                                                                                 |
| `customer.subscription.deleted`            | same                                                                                                                            | same                                                                                                                                                                      | Same upsert path; the `status` field on the Subscription object reflects the deletion.                                                                                                                                                                                               |
| `charge.refunded`                          | `markStatusByPaymentIntent(paymentIntentId, "refunded")`                                                                        | `shop_orders` (status='refunded')                                                                                                                                         | Only flips when status is currently `paid`. Driven from the Charge's `payment_intent` (resolved via the row's `stripe_payment_intent_id` set by `markPaid`).                                                                                                                         |
| _(any other event type)_                   | `log?.debug?.("ignoring stripe event type")` and 200 OK                                                                         | none                                                                                                                                                                      | Stripe webhook subscriptions in the dashboard may include event types we don't subscribe to in code; we ack them so Stripe doesn't retry.                                                                                                                                            |

---

## Helpers (private to `webhook-handler.ts` unless noted)

| Function                                                     | Lines            | Behavior                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `markPaid(session, log)`                                     | `~384`           | Returns the resulting `PaidOrderRow` (id, customerId, paidAt) only when the row was actually flipped to paid by THIS call. Returns `null` when there's nothing to do (already paid, no row found).                                                                                                                                                                               |
| `upsertOrderItemsFromSession(config, session, paidRow, log)` | `~470`           | Calls `stripe.checkout.sessions.listLineItems(session.id, { expand: ["data.price.product"] })` and INSERTS into `shop_order_items`. UNIQUE `(stripe_session_id, product_id, price_id)` makes the insert idempotent.                                                                                                                                                              |
| `syncCustomerAfterCheckout(config, session, log)`            | private          | Refreshes `shop_customers` saved-card info from the Customer object after a successful checkout. Best-effort.                                                                                                                                                                                                                                                                    |
| `markCartRecovered(session, log)`                            | exported, `~676` | UPDATE `shop_abandoned_carts SET recovered_at = now() WHERE customer_id = ? AND recovered_at IS NULL`.                                                                                                                                                                                                                                                                           |
| `sendOrderConfirmationIfFirst({...})`                        | exported, `~917` | Atomic CLAIM via `UPDATE shop_orders SET confirmation_email_sent_at = now() WHERE id = ? AND confirmation_email_sent_at IS NULL RETURNING ...`. The returning rows decide whether to actually send (zero rows → already sent; one row → we won the claim). On SendGrid failure the claim is RELEASED (`SET confirmation_email_sent_at = NULL`) so a future redelivery can retry. |
| `markStatus(sessionId, newStatus, log)`                      | `~724`           | UPDATE `shop_orders SET status = ? WHERE stripe_session_id = ? AND status IN (<allowed-prev-states>)`. The allowed-prev set is conditional on the target — `expired` only allowed from pre-paid states, `failed` only from `pending_async_payment`, etc.                                                                                                                         |
| `upsertSubscription(subscription, eventCreatedAt, log)`      | private          | UPSERT `shop_subscriptions ON CONFLICT (stripe_subscription_id) DO UPDATE SET ... WHERE EXCLUDED.last_stripe_event_at >= shop_subscriptions.last_stripe_event_at`. The WHERE on the UPDATE is the ordering guard — a stale event can't clobber newer state.                                                                                                                      |
| `markStatusByPaymentIntent(paymentIntentId, newStatus, log)` | private          | UPDATE `shop_orders SET status='refunded' WHERE stripe_payment_intent_id = ? AND status='paid'`.                                                                                                                                                                                                                                                                                 |

---

## Idempotency keys for OUTGOING Stripe API calls

Distinct from this incoming-webhook side. The Stripe SDK `idempotencyKey`
option deduplicates retries server-side at Stripe so a double-click
in our admin UI can't issue two refunds. Tracked in P1.11.

Currently keyed:

- `customer.create` — `pennpaps-shop-customer-${args.customerId}` (`lib/stripe/customer.ts`)
- `refunds.create` (admin order refund) — `shop-order-refund-${orderId}-${amountCents}` (`routes/admin/shop-orders.ts`)
- `refunds.create` (admin return refund) — `shop-return-refund-${ret.id}-${refundCents}` (`routes/admin/shop-returns.ts`)
- `checkout.sessions.create` (storefront cart checkout) — UUID forwarded from the SPA's `Idempotency-Key` request header (`routes/shop/checkout.ts`)
- `checkout.sessions.create` (admin reorder) — `admin-reorder-${userId}-${sourceOrderId}` (`routes/admin/customers.ts`)

Currently un-keyed (lower priority, follow-up; see P1.11 commit body
for the rationale):

- `subscriptions.update` (cancel / cadence change) — flag-flip operations are naturally idempotent at Stripe.
- `charges.update` (receipt_email correction) — sets a single field; double-application produces the same result.
- `products.create` / `products.update` / `prices.create` (admin catalog flows) — admin manual workflow; double-click risk is bounded.

---

## Adding a new event subscription

1. Subscribe to the event in the Stripe Dashboard webhook config; do
   NOT rely on the existing config matching the new code.
2. Add the `case` to the switch at `webhook-handler.ts:208`.
3. Add the helper, mirroring the conventions in this matrix:
   - Conditional-on-current-state UPDATEs that no-op on redelivery.
   - Best-effort try/catch around side-effects that aren't part of
     the row's primary state machine (email, cart recovery,
     customer-info sync).
   - Always return 200 from the route on a verified event, even on
     handler failure — wrap throws in the outer catch at
     `webhook-handler.ts:207` if the failure is genuinely
     unrecoverable, and accept the Stripe retry.
4. Update this matrix.
5. Add a unit test in `lib/stripe/<helper>.test.ts` that exercises
   the redelivery + concurrency contracts (the existing
   `send-order-confirmation-if-first.test.ts` is the model).
