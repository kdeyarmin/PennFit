// Platform-billing (SaaS) Stripe webhook.
//
// This is the ONLY Stripe webhook the app serves. It receives events from
// the dedicated Stripe account that tenants pay the platform through
// (subscriptions, invoices, metered usage) — the tenant→platform revenue
// path, not patient money. Patient/storefront card payments were removed
// with the cash-pay storefront: patients receive equipment through
// insurance only, so there is no patient-facing Checkout, Connect account,
// or customer webhook anymore.
//
// Raw-body contract: registered in app.ts BEFORE express.json() because
// Stripe's signature is computed over the exact bytes Stripe sent.

import type { RequestHandler, Request, Response } from "express";
import type Stripe from "stripe";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { handlePlatformTenantStripeEvent } from "../platform-billing/stripe";
import {
  getStripeClient,
  readPlatformBillingStripeConfigOrNull,
} from "./config";
import { stripeErrLogFields } from "./err-log-fields";
import { enterWebhookOrg } from "./webhook-org-context";

/**
 * Try to record this event in stripe_webhook_events. Resolves to one
 * of three outcomes:
 *
 *   - "inserted"  → first time we've seen this event_id. Caller
 *                   proceeds to dispatch.
 *   - "duplicate" → INSERT failed with UNIQUE-violation (PostgREST
 *                   `23505`). Caller short-circuits with 200 +
 *                   {ok: true, deduped: true} so Stripe stops
 *                   retrying.
 *   - "error"     → INSERT failed for some other reason (DB
 *                   unreachable, etc.). Caller proceeds anyway —
 *                   downstream per-table UNIQUE guards still catch
 *                   the most-load-bearing double-writes, and we'd
 *                   rather risk a duplicate side-effect than
 *                   permanently drop a real event because the
 *                   idempotency table is offline.
 *
 * This helper NEVER throws — every code path returns a string so the
 * caller branches without try/catch.
 */
export async function tryRecordWebhookEvent(
  eventId: string,
  eventType: string,
  log: { warn?: (...args: unknown[]) => void } | undefined,
): Promise<"inserted" | "duplicate" | "error"> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) {
      // Tenant context missing — proceed un-gated (same non-fatal
      // "error" outcome the catch below returns; callers treat it as
      // "dedup table unavailable, proceed anyway").
      return "error";
    }
    // stripe_webhook_events is GLOBAL (no org_id) — idempotency is
    // keyed on event_id across all tenants, so use the unscoped client.
    const supabase = getOrgScopedClient(orgId).raw();
    const { error } = await supabase
      .schema("resupply")
      .from("stripe_webhook_events")
      .insert({
        event_id: eventId,
        event_type: eventType,
      });
    if (!error) return "inserted";
    if ((error as { code?: string }).code === "23505") {
      return "duplicate";
    }
    log?.warn?.(
      { code: (error as { code?: string }).code },
      "stripe webhook: dedup INSERT failed (non-fatal, proceeding)",
    );
    return "error";
  } catch (err) {
    log?.warn?.(
      { err },
      "stripe webhook: dedup INSERT threw (non-fatal, proceeding)",
    );
    return "error";
  }
}

export async function tryDeleteWebhookEventRecord(
  eventId: string,
  log: { warn?: (...args: unknown[]) => void } | undefined,
): Promise<void> {
  try {
    const orgId = await resolveSeedOrgId();
    if (!orgId) {
      // Tenant context missing — nothing we can release; log + return
      // (this cleanup is best-effort and never throws).
      log?.warn?.(
        { eventId },
        "stripe webhook: dedup record cleanup skipped — tenant context missing",
      );
      return;
    }
    // stripe_webhook_events is GLOBAL (no org_id) — use the unscoped client.
    const supabase = getOrgScopedClient(orgId).raw();
    const { error } = await supabase
      .schema("resupply")
      .from("stripe_webhook_events")
      .delete()
      .eq("event_id", eventId);
    if (!error) return;
    log?.warn?.(
      { code: (error as { code?: string }).code, eventId },
      "stripe webhook: failed to release dedup record after handler error",
    );
  } catch {
    log?.warn?.({ eventId }, "stripe webhook: dedup record cleanup threw");
  }
}

export const stripePlatformBillingWebhookHandler: RequestHandler = async (
  req: Request,
  res: Response,
) => {
  const config = readPlatformBillingStripeConfigOrNull();
  if (!config || config.mode !== "dedicated" || !config.webhookSigningSecret) {
    req.log?.warn(
      { hasConfig: !!config, mode: config?.mode ?? null },
      "platform-billing stripe webhook hit while not in dedicated mode / not configured",
    );
    // 503 in prod so a misconfigured dedicated webhook surfaces loudly via
    // Stripe's retry alerts; 200 elsewhere so a stray delivery doesn't burn
    // the retry budget on preview/dev.
    if (process.env.NODE_ENV === "production") {
      res.status(503).json({ error: "platform_billing_webhook_unconfigured" });
    } else {
      res
        .status(200)
        .json({ ok: true, ignored: "platform_billing_not_dedicated" });
    }
    return;
  }

  const signature = req.headers["stripe-signature"];
  if (typeof signature !== "string") {
    res.status(400).json({ error: "missing_stripe_signature" });
    return;
  }

  const rawBody = req.body;
  if (!Buffer.isBuffer(rawBody)) {
    req.log?.error(
      { bodyType: typeof rawBody },
      "platform-billing stripe webhook: raw body was not a Buffer — body parser order is wrong",
    );
    res.status(400).json({ error: "raw_body_missing" });
    return;
  }

  const stripe = getStripeClient(config);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      config.webhookSigningSecret,
    );
  } catch (err) {
    req.log?.warn(
      { ...stripeErrLogFields(err) },
      "platform-billing stripe webhook signature verification failed",
    );
    res.status(400).json({ error: "invalid_signature" });
    return;
  }

  const log = req.log?.child?.({
    stripeEventId: event.id,
    type: event.type,
    channel: "platform-billing",
  });

  // Event-id idempotency gate — the dedup table is global and Stripe event
  // ids are unique across accounts.
  const dedupeOutcome = await tryRecordWebhookEvent(event.id, event.type, log);
  if (dedupeOutcome === "duplicate") {
    log?.info?.(
      "platform-billing stripe webhook: event_id already recorded — deduped",
    );
    res.status(200).json({ ok: true, deduped: true });
    return;
  }
  if (dedupeOutcome === "error") {
    res.status(500).json({ error: "dedup_unavailable" });
    return;
  }
  const dedupeInserted = dedupeOutcome === "inserted";

  // Platform billing is seed-org scoped (handlePlatformTenantStripeEvent →
  // rawClient() resolves the seed org). Bind it so any scoped reads inside
  // resolve.
  const seedOrgId = await resolveSeedOrgId();
  if (seedOrgId) enterWebhookOrg(seedOrgId);

  try {
    const handled = await handlePlatformTenantStripeEvent(event);
    if (!handled) {
      // Not a platform-billing event (or not ours). Only the SaaS-billing
      // event families should be routed to this endpoint from the dedicated
      // account's dashboard; ack anything else so Stripe stops retrying.
      log?.debug?.(
        "platform-billing stripe webhook: event not handled — acking",
      );
    }
  } catch (err) {
    if (dedupeInserted) {
      await tryDeleteWebhookEventRecord(event.id, log);
    }
    log?.error?.(
      { err, ...stripeErrLogFields(err) },
      "platform-billing stripe webhook handler threw — Stripe will retry",
    );
    res.status(500).json({ error: "internal_error" });
    return;
  }

  res.status(200).json({ received: true });
};
