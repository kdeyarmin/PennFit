// Close the loop from a fitting to what the patient actually bought.
//
// WHY THIS EXISTS
// ---------------
// 0483 declared `ordered_mask_model_id`, `ordered_variant_id`,
// `shop_order_id` and `dispensed_at` under the heading "Downstream
// outcome (closes the loop for later evidence work)" — and nothing ever
// wrote them. The consequence was not cosmetic: the outcome dashboard
// reported a dispense rate of zero forever, and the re-fit campaign's
// discontinued-mask branch could never find a candidate, because both
// read columns no code populated.
//
// The link is carried on the Stripe Checkout Session's metadata, which is
// the established channel for exactly this (`routes/shop/checkout.ts`
// already puts `org_id`, `fulfillment_method` and others there, and the
// webhook reads them back). Everything here is BEST EFFORT and must stay
// that way: this is attribution hanging off a money path, and a failure
// to record which mask a fitting led to may never cost a patient their
// order.
//
// WHAT "ORDERED" MEANS, and why it is not the recommendation
// ----------------------------------------------------------
// It would be easy — and wrong — to stamp the fitting's own primary
// recommendation here. Every order would then agree with the engine by
// construction and the acceptance rate would read 100% while measuring
// nothing. What is recorded instead is the mask the patient actually
// bought, which on the results page may be the top pick OR one of the
// alternatives. That difference is the entire point of the metric.
//
// PHI: none. Ids and slugs only.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger.js";

/** Metadata keys on the Stripe Checkout Session. */
export const FIT_SESSION_METADATA_KEY = "fit_session_id";
export const FIT_ORDERED_MASK_METADATA_KEY = "fit_ordered_mask_slug";
export const FIT_ORDERED_VARIANT_METADATA_KEY = "fit_ordered_variant_id";

export interface FitOrderLink {
  fitSessionId: string;
  /** The mask the patient chose, as the engine's slug (`resmed-airfit-f20`). */
  orderedMaskSlug: string | null;
  /** The size variant behind that choice (cushion preferred, else frame). */
  orderedVariantId: string | null;
}

/**
 * Pull the fitting link out of a Checkout Session's metadata.
 *
 * Returns null when the checkout did not come from a fitting, which is
 * the common case — most shop orders are ordinary resupply.
 */
export function readFitOrderLink(
  metadata: Record<string, string | null> | null | undefined,
): FitOrderLink | null {
  const fitSessionId = metadata?.[FIT_SESSION_METADATA_KEY];
  if (typeof fitSessionId !== "string" || !fitSessionId.trim()) return null;
  const slug = metadata?.[FIT_ORDERED_MASK_METADATA_KEY];
  const variantId = metadata?.[FIT_ORDERED_VARIANT_METADATA_KEY];
  return {
    fitSessionId: fitSessionId.trim(),
    orderedMaskSlug:
      typeof slug === "string" && slug.trim() ? slug.trim() : null,
    orderedVariantId:
      typeof variantId === "string" && variantId.trim()
        ? variantId.trim()
        : null,
  };
}

/**
 * Record which order a fitting produced, and which mask was bought.
 *
 * Idempotent: the write is guarded on `shop_order_id IS NULL`, so a Stripe
 * re-delivery (or the async_payment_succeeded shadow event on the same
 * session) is a no-op rather than a second, conflicting attribution.
 *
 * Never throws.
 */
export async function linkFitSessionToOrder(
  orgId: string,
  input: { link: FitOrderLink; shopOrderId: string },
): Promise<{ linked: boolean }> {
  try {
    const supabase = getOrgScopedClient(orgId);

    // `mask_fit_outcomes.mask_id` and the engine both speak slugs; the
    // catalog's primary key is a uuid. Resolve through `slug`, the same
    // join the outcome analytics uses.
    let orderedMaskModelId: string | null = null;
    if (input.link.orderedMaskSlug) {
      const { data } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_models")
        .select("id")
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq("slug", input.link.orderedMaskSlug)
        .limit(1)
        .maybeSingle()) as { data: { id?: string } | null };
      orderedMaskModelId = data?.id ?? null;
    }

    // The variant id needs the same defensive resolution as the slug —
    // for a sharper reason: `ordered_variant_id` is an FK, and the value
    // arrives from the client's checkout context via Stripe metadata. A
    // well-formed uuid that doesn't exist as a variant row would fail the
    // FK and error the WHOLE update, losing `shop_order_id` — and with it
    // any chance of `dispensed_at` — over a field that is decoration by
    // comparison. Resolve it; drop it from the patch when unknown.
    let orderedVariantId: string | null = null;
    if (input.link.orderedVariantId) {
      const { data } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_size_variants")
        .select("id")
        .eq("id", input.link.orderedVariantId)
        .limit(1)
        .maybeSingle()) as { data: { id?: string } | null };
      orderedVariantId = data?.id ?? null;
    }

    const { data: updated, error } = (await supabase
      .from("fit_sessions")
      .update({
        shop_order_id: input.shopOrderId,
        // Only overwrite the mask when we could actually resolve one. An
        // unresolvable slug still links the ORDER, which is what
        // `dispensed_at` later hangs off — losing that too would be a
        // worse outcome than a null mask.
        ...(orderedMaskModelId
          ? { ordered_mask_model_id: orderedMaskModelId }
          : {}),
        ...(orderedVariantId ? { ordered_variant_id: orderedVariantId } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", input.link.fitSessionId)
      .is("shop_order_id", null)
      .select("id")
      .limit(1)
      .maybeSingle()) as {
      data: { id?: string } | null;
      error: { message: string } | null;
    };
    if (error) {
      logger.warn(
        { event: "fit_order_link_failed", orgId, err: error.message },
        "could not link fit session to its order",
      );
      return { linked: false };
    }
    return { linked: Boolean(updated) };
  } catch (err) {
    logger.warn(
      {
        event: "fit_order_link_failed",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not link fit session to its order",
    );
    return { linked: false };
  }
}

/**
 * Stamp the dispense once the linked order actually reaches the patient.
 *
 * "Dispensed" deliberately means DELIVERED, not paid. A mask sitting in a
 * warehouse has not been dispensed, and a dispense rate that counted
 * payments would flatter itself by every order still in transit.
 *
 * Guarded on `dispensed_at IS NULL`, so the two delivery paths (carrier
 * webhook and the admin mark-delivered action) can both call it and only
 * the first one counts. Never throws.
 */
export async function markFitSessionDispensed(
  orgId: string,
  shopOrderId: string,
): Promise<{ stamped: boolean }> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data: updated, error } = (await supabase
      .from("fit_sessions")
      .update({
        dispensed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("shop_order_id", shopOrderId)
      .is("dispensed_at", null)
      .select("id")
      .limit(1)
      .maybeSingle()) as {
      data: { id?: string } | null;
      error: { message: string } | null;
    };
    if (error) {
      logger.warn(
        { event: "fit_dispense_stamp_failed", orgId, err: error.message },
        "could not stamp fit session dispense",
      );
      return { stamped: false };
    }
    return { stamped: Boolean(updated) };
  } catch (err) {
    logger.warn(
      {
        event: "fit_dispense_stamp_failed",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not stamp fit session dispense",
    );
    return { stamped: false };
  }
}

/**
 * Stamp the dispense for a fitting that never went through the shop.
 *
 * WHY THIS EXISTS ALONGSIDE THE SHOP PATH
 * ---------------------------------------
 * `markFitSessionDispensed` above keys on `shop_order_id`, because it was
 * written for the one path a fitting could reach a patient by: the
 * patient bought the mask themselves at checkout. Migration 0518 removed
 * that path — the fitter now ends in a request a CSR works, and the
 * patient is dispensed through the DME's ordinary fulfillment, which
 * produces no `shop_orders` row for the fitting to point at.
 *
 * So the loop this module exists to close was quietly opened again: the
 * outcomes dashboard's dispense rate, its accepted-vs-overridden split,
 * and the re-fit campaign's discontinued-mask branch all read columns
 * that no longer had a writer. This is that writer, on the new path.
 *
 * "Dispensed" keeps its meaning from the shop path — the patient HAS the
 * mask, not merely that someone agreed to send one. The caller is the
 * CSR closing a fit request as fulfilled, which is that same assertion
 * made by a person instead of a carrier webhook.
 *
 * `orderedMaskSlug` is the mask the PATIENT chose on the results page,
 * which may be an alternative rather than the engine's top pick. That
 * distinction is the whole value of the metric — see the note at the top
 * of this file — so it is never back-filled from the recommendation.
 *
 * Guarded on `dispensed_at IS NULL`: reopening and re-closing a request
 * must not move a dispense date that has already been recorded. Never
 * throws — attribution must not cost a CSR their close.
 */
export async function markFitSessionDispensedById(
  orgId: string,
  input: { fitSessionId: string; orderedMaskSlug?: string | null },
): Promise<{ stamped: boolean }> {
  try {
    const supabase = getOrgScopedClient(orgId);

    // Same slug → uuid resolution as the shop path, and dropped the same
    // way when it does not resolve: an unknown slug must not cost the
    // dispense stamp, which is the more valuable of the two facts.
    let orderedMaskModelId: string | null = null;
    if (input.orderedMaskSlug) {
      const { data } = (await supabase
        .raw()
        .schema("resupply")
        .from("mask_models")
        .select("id")
        .or(`org_id.is.null,org_id.eq.${orgId}`)
        .eq("slug", input.orderedMaskSlug)
        .limit(1)
        .maybeSingle()) as { data: { id?: string } | null };
      orderedMaskModelId = data?.id ?? null;
    }

    const nowIso = new Date().toISOString();
    const { data: updated, error } = (await supabase
      .from("fit_sessions")
      .update({
        dispensed_at: nowIso,
        ...(orderedMaskModelId
          ? { ordered_mask_model_id: orderedMaskModelId }
          : {}),
        updated_at: nowIso,
      })
      .eq("id", input.fitSessionId)
      .is("dispensed_at", null)
      .select("id")
      .limit(1)
      .maybeSingle()) as {
      data: { id?: string } | null;
      error: { message: string } | null;
    };
    if (error) {
      logger.warn(
        { event: "fit_dispense_stamp_failed", orgId, err: error.message },
        "could not stamp fit session dispense from a fit request",
      );
      return { stamped: false };
    }
    return { stamped: Boolean(updated) };
  } catch (err) {
    logger.warn(
      {
        event: "fit_dispense_stamp_failed",
        orgId,
        err: err instanceof Error ? err.message : String(err),
      },
      "could not stamp fit session dispense from a fit request",
    );
    return { stamped: false };
  }
}
