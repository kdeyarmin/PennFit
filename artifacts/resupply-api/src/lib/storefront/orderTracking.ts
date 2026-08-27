/**
 * Shared guest order-status lookup — the single implementation behind
 * BOTH the public `POST /api/orders/track` endpoint and the storefront
 * chatbot's `track_order` tool.
 *
 * Auth model (identical on both surfaces): the caller must present the
 * order reference AND the email used on the order. A reference whose
 * email doesn't match is reported exactly like "not found" so a guessed
 * reference can't be used to learn which email it belongs to.
 *
 * The per-key rate bucket lives here so the chat tool draws from the
 * SAME per-IP budget as the HTTP endpoint — adding the chatbot surface
 * must not widen the (reference × email) brute-force window.
 *
 * Privacy: no PHI fields are returned — only the operational status,
 * the mask the patient picked, and confirmation-email delivery state.
 * No addresses, physician info, or insurance.
 */

import { timingSafeEqual } from "node:crypto";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

/**
 * Reference shapes accepted by track:
 *   - "PENN-" + 6 alphanumerics (current fitter mint), or just the 6-char tail
 *   - legacy "PHM-XXX-XXX" (hyphenated) from an earlier mint format
 *   - "ORD-" + 6 alphanumerics (CSR signature-order mint)
 *
 * 6 alphanumerics is ~36^6 ≈ 2B — combined with the rate limit + the
 * email guard, that's the deterrent we want.
 */
export const ORDER_REFERENCE_PATTERN =
  /^(?:(?:PENN-|ORD-)?[A-Z0-9]{6}|PHM-[A-Z0-9]{3}-[A-Z0-9]{3})$/;

const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();
const RATE_SWEEP_EVERY = 200;
let rateBucketSweepCounter = 0;

function sweepRateBucket(now: number): void {
  for (const [key, timestamps] of rateBucket) {
    if (timestamps.every((t) => now - t >= RATE_WINDOW_MS)) {
      rateBucket.delete(key);
    }
  }
}

/**
 * True when `key` (an IP-derived string) has exhausted its lookup
 * budget. Counting a call also consumes one slot.
 */
export function trackOrderRateLimited(key: string): boolean {
  const now = Date.now();
  if (++rateBucketSweepCounter % RATE_SWEEP_EVERY === 0) {
    sweepRateBucket(now);
  }
  const arr = (rateBucket.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_MAX) {
    rateBucket.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBucket.set(key, arr);
  return false;
}

/** Test-only seam — clears the shared rate bucket between vitest runs. */
export function _resetTrackOrderRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}

/**
 * Uppercase and validate a user-supplied reference. PENN- prefixes the
 * 6-char tail when missing; ORD-… / PHM-XXX-XXX refs are kept as-is so
 * already-emailed invites and confirmations still look up.
 * Returns null when the input can't be a known order reference.
 */
export function normalizeOrderReference(raw: string): string | null {
  const candidate = raw.trim().toUpperCase();
  if (!ORDER_REFERENCE_PATTERN.test(candidate)) return null;
  if (candidate.startsWith("PHM-") || candidate.startsWith("ORD-")) {
    return candidate;
  }
  return candidate.startsWith("PENN-") ? candidate : `PENN-${candidate}`;
}

export interface TrackedOrderStatus {
  orderReference: string;
  mask: {
    name: string | null;
    manufacturer: string | null;
    modelNumber: string | null;
  };
  createdAt: string | null;
  emailStatus: string | null;
  emailDeliveredAt: string | null;
}

export type TrackOrderLookup =
  | { outcome: "found"; order: TrackedOrderStatus }
  | { outcome: "not_found" }
  | { outcome: "lookup_failed"; detail: string };

/**
 * Look up one order by (normalized reference, lowercased email).
 *
 * Constant-time compare on the email string so the response time
 * doesn't leak letter-by-letter how close a guess got. Padded to a
 * fixed buffer length so timingSafeEqual doesn't itself leak length
 * information via its length-mismatch fast-path.
 */
export async function lookupTrackedOrder(
  normalizedReference: string,
  email: string,
): Promise<TrackOrderLookup> {
  const orgId = await resolveSeedOrgId();
  if (!orgId) {
    return { outcome: "not_found" };
  }
  const supabase = getOrgScopedClient(orgId);

  if (normalizedReference.startsWith("ORD-")) {
    return lookupCsrOrder(supabase, normalizedReference, email);
  }

  // Fitter orders live in public.orders; the shop orders live in
  // resupply.shop_orders. We probe public.orders first (fitter is
  // the only path that mints a PENN- reference today) and fall back
  // to checking shop_orders by stripe_session_id only if a future
  // shop-side path starts emitting the same reference shape.
  //
  // raw-org-scope-exempt: this is a CAPABILITY lookup, not a tenant query —
  // the globally-unique random order_reference plus a constant-time email
  // match IS the bearer credential (same posture as reminder_subscriptions'
  // manage_token), so it must resolve a patient's order regardless of which
  // tenant placed it. Scoping it to one org would make every non-seed
  // tenant's reference return not_found. No org filter by design.
  const { data: legacyRow, error: legacyErr } = await supabase
    .raw()
    .schema("public")
    .from("orders")
    .select(
      // mask_model_number is included so that a session-storage-loss
      // recovery on /order-success can render the same confirmation
      // card the patient saw the first time (which references the
      // model number). Not PHI; the patient already chose the mask
      // by model number on /results.
      "order_reference, patient_email, mask_name, mask_manufacturer, mask_model_number, email_status, email_delivered_at, created_at",
    )
    .eq("order_reference", normalizedReference)
    .limit(1)
    .maybeSingle();
  if (legacyErr) {
    return { outcome: "lookup_failed", detail: legacyErr.message };
  }

  // Treat "found but email doesn't match" the same as "not found"
  // so an attacker who guesses a reference can't infer which email
  // it belongs to.
  if (!emailsMatchConstantTime(legacyRow?.patient_email, email)) {
    return { outcome: "not_found" };
  }
  if (!legacyRow) {
    return { outcome: "not_found" };
  }

  return {
    outcome: "found",
    order: {
      orderReference: legacyRow.order_reference,
      mask: {
        name: legacyRow.mask_name,
        manufacturer: legacyRow.mask_manufacturer,
        modelNumber: legacyRow.mask_model_number,
      },
      createdAt: legacyRow.created_at,
      emailStatus: legacyRow.email_status,
      emailDeliveredAt: legacyRow.email_delivered_at,
      // Future expansion: shop_orders linkage for shipped/delivered
      // timestamps + tracking carrier/number. Today public.orders
      // doesn't store fulfillment-side state.
    },
  };
}

function emailsMatchConstantTime(
  storedRaw: string | null | undefined,
  probedRaw: string,
): boolean {
  const storedEmail = (storedRaw ?? "").toLowerCase();
  const probedEmail = probedRaw.toLowerCase();
  // Empty stored email can never authenticate a guest lookup.
  if (!storedEmail) return false;
  const pad = Math.max(storedEmail.length, probedEmail.length, 320);
  const a = Buffer.alloc(pad);
  const b = Buffer.alloc(pad);
  a.write(storedEmail, "utf8");
  b.write(probedEmail, "utf8");
  return timingSafeEqual(a, b);
}

/**
 * Map CSR link-lifecycle status onto the TrackResult.emailStatus values
 * the SPA already understands (sent / pending / failed), plus a few
 * CSR-specific labels the SPA formats explicitly.
 */
function csrStatusToTrackEmailStatus(
  status: "sent" | "viewed" | "signed" | "canceled",
): string {
  switch (status) {
    case "signed":
      return "signed";
    case "canceled":
      return "canceled";
    case "viewed":
      return "awaiting_signature";
    case "sent":
    default:
      return "awaiting_signature";
  }
}

async function lookupCsrOrder(
  supabase: ReturnType<typeof getOrgScopedClient>,
  normalizedReference: string,
  email: string,
): Promise<TrackOrderLookup> {
  // raw-org-scope-exempt: ORD- references are globally UNIQUE
  // (csr_order_requests.order_reference) and the email match is the
  // second factor — same capability-token posture as fitter PENN refs.
  const { data: row, error } = await supabase
    .raw()
    .schema("resupply")
    .from("csr_order_requests")
    .select("order_reference, customer_email, status, items, created_at")
    .eq("order_reference", normalizedReference)
    .limit(1)
    .maybeSingle();
  if (error) {
    return { outcome: "lookup_failed", detail: error.message };
  }
  if (!emailsMatchConstantTime(row?.customer_email, email) || !row) {
    return { outcome: "not_found" };
  }

  const items = Array.isArray(row.items) ? row.items : [];
  const first = items[0] as { description?: unknown } | undefined;
  const firstDesc =
    typeof first?.description === "string" && first.description.trim()
      ? first.description.trim()
      : null;

  return {
    outcome: "found",
    order: {
      orderReference: row.order_reference,
      mask: {
        name: firstDesc,
        manufacturer: null,
        modelNumber: null,
      },
      createdAt: row.created_at,
      emailStatus: csrStatusToTrackEmailStatus(
        row.status as "sent" | "viewed" | "signed" | "canceled",
      ),
      emailDeliveredAt: null,
    },
  };
}
