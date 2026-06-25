// Carrier tracking webhook ingest.
//
// shop_orders carries tracking_carrier / tracking_number / shipped_at /
// delivered_at, and the POD auto-send + delivery-followup flows key off
// shop_orders.delivered_at — but until now those timestamps were only stamped
// by an admin clicking "shipped" / "delivered". This lets a carrier webhook
// (EasyPost / Shippo, or any HMAC-signed tracker push) advance the order's
// state automatically, firing the SAME delivered side effect (patient-packet
// auto-send) the admin "mark delivered" route runs.
//
// Posture:
//   * Feature-gated + fail-soft: no CARRIER_WEBHOOK_SECRET set → the route is
//     disabled (503), so a preview/dev deploy never needs it.
//   * Fail-CLOSED on a bad signature (401) once the secret IS configured.
//   * Idempotent: only stamps a timestamp that's still NULL, so a re-delivered
//     event is a no-op and the customer-facing "delivered on" date never drifts.
//   * Tracking numbers are globally unique, so the order lookup is unscoped
//     (a carrier push carries no tenant context) and updates by row id.
//   * PHI/log posture: logs counts + order id only — never the tracking number.

import { createHmac, timingSafeEqual } from "node:crypto";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { autoSendPatientPacketOnDelivery } from "../patient-packet/auto-send-on-delivery";
import { sendDeliveredNotificationIfNew } from "../order-emails/delivered-notification";
import { logger } from "../logger";

export interface CarrierWebhookConfig {
  secret: string;
}

export function readCarrierWebhookConfigOrNull(): CarrierWebhookConfig | null {
  const secret = process.env.CARRIER_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  return { secret };
}

/** Verify an HMAC-SHA256 (hex) signature of the raw body. Tolerates the
 *  `hmac-sha256-hex=` prefix EasyPost prepends. Constant-time. */
export function verifyCarrierSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  const provided = signatureHeader.replace(/^hmac-sha256-hex=/i, "").trim();
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(provided, "hex");
    const b = Buffer.from(expected, "hex");
    if (a.length === 0 || a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type NormalizedTrackingStatus = "shipped" | "delivered" | "other";

export interface ParsedTrackingEvent {
  trackingNumber: string;
  status: NormalizedTrackingStatus;
}

/**
 * Normalize a carrier tracker payload. Supports EasyPost's
 * `{ result: { tracking_code, status } }` shape and a generic
 * `{ tracking_number, status }`. Returns null when no tracking number is
 * present (the route ACKs those so the carrier stops retrying).
 */
export function parseCarrierEvent(body: unknown): ParsedTrackingEvent | null {
  if (!body || typeof body !== "object") return null;
  const obj = body as Record<string, unknown>;
  const result =
    obj.result && typeof obj.result === "object"
      ? (obj.result as Record<string, unknown>)
      : obj;
  const trackingNumber =
    (typeof result.tracking_code === "string" && result.tracking_code) ||
    (typeof result.tracking_number === "string" && result.tracking_number) ||
    (typeof obj.tracking_number === "string" && obj.tracking_number) ||
    null;
  if (!trackingNumber) return null;
  const raw = String(result.status ?? obj.status ?? "").toLowerCase();
  let status: NormalizedTrackingStatus = "other";
  if (raw === "delivered") status = "delivered";
  else if (
    raw === "in_transit" ||
    raw === "out_for_delivery" ||
    raw === "available_for_pickup"
  )
    status = "shipped";
  return { trackingNumber, status };
}

export interface ApplyTrackingResult {
  matched: boolean;
  updated: boolean;
}

/**
 * Apply a parsed tracking event to its shop_order: stamp shipped_at /
 * delivered_at (idempotently) and, on a fresh delivery, run the patient-packet
 * auto-send the admin "mark delivered" route runs. Fail-soft.
 */
export async function applyCarrierTrackingEvent(
  event: ParsedTrackingEvent,
  log: { warn?: (obj: unknown, msg?: string) => void } = logger,
): Promise<ApplyTrackingResult> {
  if (event.status === "other") return { matched: false, updated: false };
  // The carrier push carries NO tenant context, and tracking numbers are
  // globally unique, so this is a genuinely unscoped lookup. Application code
  // must still reach the DB through the org-scoped chokepoint and drop to its
  // `.raw()` escape hatch — check-tenant-isolation.sh forbids calling the raw
  // service-role client directly outside lib/resupply-db. The seed org is
  // resolved only to construct that client; its scoping is unused because
  // every query below runs on `.raw()`.
  const orgId = await resolveSeedOrgId();
  if (!orgId) {
    // Not silent: surface that the tenant directory was unavailable so an
    // operator can tell "no order matched" apart from "couldn't look it up"
    // (e.g. a fresh / mis-seeded DB) rather than swallowing the event.
    log.warn?.(
      { event: "carrier_tracking_tenant_directory_unavailable" },
      "carrier-tracking: tenant directory unavailable; skipping event",
    );
    return { matched: false, updated: false };
  }
  try {
    // Unscoped lookup by tracking number. `tracking_number` carries NO
    // uniqueness constraint, and the carrier push has no tenant context, so
    // two tenants' orders CAN share a value (carriers reuse number formats;
    // a manual entry can collide). A `.limit(1)` would silently act on
    // whichever row PostgREST returned first — possibly the WRONG tenant's
    // order. Fetch up to 2 and refuse to act when the match is ambiguous.
    const supabase = getOrgScopedClient(orgId).raw();
    const { data: orders, error } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .select("id, org_id, shipped_at, delivered_at")
      .eq("tracking_number", event.trackingNumber)
      .limit(2);
    if (error || !orders || orders.length === 0) {
      return { matched: false, updated: false };
    }
    if (orders.length > 1) {
      // PHI rule: counts/status only — never the tracking number.
      log.warn?.(
        { event: "carrier_tracking_ambiguous", match_count: orders.length },
        "carrier-tracking: multiple orders share this tracking number; cannot disambiguate tenant — skipping",
      );
      return { matched: false, updated: false };
    }
    const order = orders[0];

    const nowIso = new Date().toISOString();
    if (event.status === "delivered") {
      if (order.delivered_at) return { matched: true, updated: false };
      const { data: updated, error: updErr } = await supabase
        .schema("resupply")
        .from("shop_orders")
        .update({
          delivered_at: nowIso,
          // Delivered implies shipped — backfill shipped_at if the carrier
          // never sent (or we never recorded) the in-transit event.
          shipped_at: order.shipped_at ?? nowIso,
          updated_at: nowIso,
        })
        .eq("id", order.id)
        .is("delivered_at", null)
        .select("id")
        .limit(1)
        .maybeSingle();
      if (updErr || !updated) return { matched: true, updated: false };
      // Mirror the admin mark-delivered side effects. Best-effort —
      // neither may fail the webhook ACK.
      const orderOrgId = order.org_id ?? orgId;
      // (a) POD / patient-packet auto-send.
      try {
        await autoSendPatientPacketOnDelivery({
          orderId: order.id,
          orgId: orderOrgId,
        });
      } catch (packetErr) {
        log.warn?.(
          { event: "carrier_tracking_autosend_failed", orderId: order.id },
          "carrier-tracking: patient-packet auto-send failed (non-fatal)",
        );
        void packetErr;
      }
      // (b) "Your order arrived" notification. Idempotent with the admin
      // route via the atomic delivered_email_sent_at claim, so the patient
      // gets exactly one notice whether the admin or the carrier marks it
      // delivered first.
      try {
        await sendDeliveredNotificationIfNew({
          orderId: order.id,
          orgId: orderOrgId,
          log,
        });
      } catch (notifyErr) {
        log.warn?.(
          {
            event: "carrier_tracking_delivered_notify_failed",
            orderId: order.id,
          },
          "carrier-tracking: delivered notification failed (non-fatal)",
        );
        void notifyErr;
      }
      return { matched: true, updated: true };
    }

    // shipped
    if (order.shipped_at) return { matched: true, updated: false };
    const { data: updated, error: updErr } = await supabase
      .schema("resupply")
      .from("shop_orders")
      .update({ shipped_at: nowIso, updated_at: nowIso })
      .eq("id", order.id)
      .is("shipped_at", null)
      .select("id")
      .limit(1)
      .maybeSingle();
    if (updErr || !updated) return { matched: true, updated: false };
    return { matched: true, updated: true };
  } catch (err) {
    log.warn?.(
      { event: "carrier_tracking_apply_threw", err },
      "carrier-tracking: apply threw (non-fatal)",
    );
    return { matched: false, updated: false };
  }
}
