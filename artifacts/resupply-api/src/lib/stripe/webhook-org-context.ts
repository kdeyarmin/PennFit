// Per-webhook tenant context (G5 — Stripe Connect routing).
//
// The Stripe webhook dispatcher resolves the owning org ONCE per event —
// from `event.account` (the connected account) for Connect events,
// otherwise the seed org — and enters it into this AsyncLocalStorage for
// the remainder of the request. The deep handler tree
// (markPaid / markStatus / upsertOrderItemsFromSession / subscription /
// payment-method / refund mirror / order-confirmation …) reads it via
// `resolveWebhookOrgId()` instead of hardcoding `resolveSeedOrgId()`, so a
// connected-tenant payment lands in the RIGHT tenant's tables.
//
// SAFETY: when called OUTSIDE a webhook context (the store is empty — any
// non-dispatcher caller, or a unit test invoking a handler directly),
// `resolveWebhookOrgId()` falls back to the seed org — exactly the pre-G5
// behavior. So this is additive and single-tenant-correct: with no
// connected accounts configured, every event resolves to the seed org as
// before.
//
// `enterWith` (rather than `run(cb)`) is used so the dispatcher's existing
// switch/try control flow — early `return`s and `break`s in case bodies —
// is untouched; each Express webhook request is its own async context, so
// the store is correctly scoped per-request.

import { AsyncLocalStorage } from "node:async_hooks";

import { resolveSeedOrgId } from "@workspace/resupply-db";

const webhookOrgStore = new AsyncLocalStorage<string>();

/** Bind the current webhook request's async context to `orgId`. */
export function enterWebhookOrg(orgId: string): void {
  webhookOrgStore.enterWith(orgId);
}

/**
 * The org the in-flight webhook belongs to, or the seed org when called
 * outside a webhook context (fail-safe; matches pre-G5 behavior).
 */
export async function resolveWebhookOrgId(): Promise<string | null> {
  return webhookOrgStore.getStore() ?? (await resolveSeedOrgId());
}
