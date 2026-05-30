# Stripe webhook event-handler matrix

The single Stripe webhook endpoint `/resupply-api/stripe/webhook`
dispatches by event type. This file is the single source of truth
for "which event mutates which table?" so on-call doesn't need to
read the 1k-line `webhook-handler.ts` to answer a sev-2 question.

When you add an event handler, update this table in the same PR.

## Endpoint

- Mount: `artifacts/resupply-api/src/app.ts:132` — `app.post(...)`.
- Body parser: `express.raw({ type: "application/json", limit: "256kb" })`.
- Signature verification: `stripe.webhooks.constructEvent(rawBody, sig, secret)`.
  The static test in `app.middleware-order.test.ts` enforces that
  `express.raw()` is mounted before `app.use(express.json())`, so a
  reorder of `app.ts` can't silently break verification.
- Response: `200 { received: true }` on success, `500 { error: "internal_error" }`
  on a thrown handler (Stripe will retry per its retry policy —
  seven attempts over ~3 days).

## Subscribed events

| Stripe event                               | Tables read                            | Tables written                                                                                                                                                                                                                          | Side effects                                                                                                                      | Idempotency                                                                                                                              |
| ------------------------------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `checkout.session.completed`               | `shop_orders` (lookup by `session.id`) | `shop_orders` (status → `paid`, `payment_intent`, `amount_total`, `currency`, `customer_id`, `paid_at`, `shipping_address_json`, `customer_email`, `confirmation_email_sent_at`); `shop_order_items` (line items upserted from session) | Sends order-confirmation email via SendGrid (with `withRetry` on 5xx); marks any matching `shop_abandoned_carts` row as recovered | Atomic claim on `confirmation_email_sent_at IS NULL` + 1-row update — replays don't re-send the email or duplicate items.                |
| `checkout.session.async_payment_succeeded` | same as `completed`                    | same as `completed`                                                                                                                                                                                                                     | same as `completed`                                                                                                               | same as `completed`                                                                                                                      |
| `checkout.session.expired`                 | `shop_orders` (by session id)          | `shop_orders` (status → `expired`)                                                                                                                                                                                                      | none                                                                                                                              | One UPDATE; replay-safe.                                                                                                                 |
| `checkout.session.async_payment_failed`    | `shop_orders` (by session id)          | `shop_orders` (status → `failed`)                                                                                                                                                                                                       | none                                                                                                                              | One UPDATE; replay-safe.                                                                                                                 |
| `customer.subscription.created`            | `shop_subscriptions`                   | `shop_subscriptions` (UPSERT keyed by `stripeSubscriptionId`)                                                                                                                                                                           | none                                                                                                                              | event-ordering guard: the upsert filters on `event.created` so an out-of-order delivery doesn't roll back to a stale state.              |
| `customer.subscription.updated`            | same                                   | same                                                                                                                                                                                                                                    | none                                                                                                                              | same as `created`                                                                                                                        |
| `customer.subscription.deleted`            | same                                   | same (status reflects cancellation)                                                                                                                                                                                                     | none                                                                                                                              | same as `created`                                                                                                                        |
| `charge.refunded`                          | `shop_orders` (by `payment_intent`)    | `shop_orders` (status → `refunded`); `resupply.audit_log` (action `shop_order.refunded`)                                                                                                                                                | none                                                                                                                              | Single UPDATE returns the matched row; audit row only written when the UPDATE matched (no row ⇒ no audit). Idempotent on Stripe retries. |

Anything else Stripe delivers is silently 200-acked (debug-logged
only) so Stripe's retry budget isn't burned on event types we
intentionally ignore.

## What the handler explicitly does NOT do

- Refund issuance — that's an outbound `stripe.refunds.create` call
  in `routes/admin/shop-returns.ts` and `routes/admin/shop-orders.ts`,
  both with explicit idempotency keys.
- Customer creation — outbound only, in `lib/stripe/customer.ts`,
  also with an idempotency key keyed on the local customer id.
- Shipping notification email — gated by the admin-side "enter
  tracking" route, NOT this webhook.

## Failure modes

| Symptom                               | Likely cause                                                                                      | Where to look                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Stripe dashboard shows webhook 500s   | Handler threw — check pino logs for the matching `stripe webhook handler threw` line              | API logs around the event timestamp                                                                      |
| Webhook 200s but DB row didn't update | Replay-protection collapsed two events into one (expected) OR a sibling worker won the row update | `shop_orders.updatedAt` vs `event.created`                                                               |
| Confirmation email not sent           | SendGrid 4xx (permanent — no retry) OR claim was already taken by an earlier run                  | `shop_orders.confirmation_email_sent_at` should be set; SendGrid error event in audit                    |
| Refund audit missing                  | The UPDATE matched 0 rows (no shop_orders row has that `payment_intent`)                          | `markStatusByPaymentIntent` returns early in that case — log line "shop order marked refunded matched=0" |

## Local development

The webhook is gated by signature verification. To exercise it
locally:

```bash
stripe listen --forward-to localhost:5000/resupply-api/stripe/webhook
stripe trigger checkout.session.completed
```

The `stripe listen` command prints the webhook-signing secret to
configure as `STRIPE_WEBHOOK_SECRET`.

## Related docs

- `RUNBOOK-worker.md` — pg-boss queue / cron health.
- `RUNBOOK-secrets.md` — secret rotation procedures.
