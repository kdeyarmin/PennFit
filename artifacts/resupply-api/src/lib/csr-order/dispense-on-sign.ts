// Turn a SIGNED CSR order into insurance work.
//
// WHY THIS EXISTS
//   Before the cash-pay removal, a CSR order ended at Stripe Checkout and
//   the charge webhook mirrored it into `shop_orders`, which the retail
//   fulfillment machinery then worked. Deleting checkout removed that
//   downstream entirely: a patient could complete the signature flow and
//   nothing would happen. The signature became terminal.
//
//   Signing is the moment the patient commits, so it is where the order
//   has to enter `fulfillments` → claim-builder → Office Ally.
//
// WHAT IT CAN AND CANNOT RESOLVE
//   `csr_order_requests` carries a customer NAME and contact, not a
//   patient id, and its line items are free text with no SKU — so a
//   signed request is not by itself enough to file a claim against. What
//   IS enough is the resupply draft that produced it: drafts carry
//   `patient_id`, the supply `category`, and a `csr_order_request_id`
//   back-link (routes/admin/resupply-order-drafts.ts). So this resolves
//   through the draft, which covers exactly the flow that regressed.
//
//   An ad-hoc CSR order — one a rep built by hand, with no draft behind
//   it — has no patient to attribute and is deliberately left alone. It
//   stays visible as `signed` on the admin Orders page for a human to
//   work, which is the honest outcome: guessing a patient from a name
//   would be worse than doing nothing.
//
// FAIL-SOFT
//   Never throws. The signature is already committed and acknowledged to
//   the patient by the time this runs; a downstream hiccup must not turn
//   a completed signing into an error page. Failures log and leave the
//   request in `signed`, where the drafts queue still shows it.

import type { OrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { ensureFulfillments } from "../messaging/order-flow";

export interface DispenseOnSignResult {
  /** Fulfillment ids created (or already present). Empty when skipped. */
  fulfillmentIds: string[];
  /** Why nothing was created, for logs and tests. */
  skipped: "no_draft" | "no_patient" | "no_sku" | "error" | null;
}

/**
 * Create the fulfillment(s) a signed CSR order represents, resolving the
 * patient through the resupply draft that produced it.
 */
export async function dispenseSignedCsrOrder(
  supabase: OrgScopedClient,
  orderRequestId: string,
): Promise<DispenseOnSignResult> {
  const none = (skipped: DispenseOnSignResult["skipped"]) => ({
    fulfillmentIds: [],
    skipped,
  });

  try {
    const { data: draft, error } = await supabase
      .from("resupply_order_drafts")
      .select("id, patient_id, category, suggested_product_id")
      .eq("csr_order_request_id", orderRequestId)
      .limit(1)
      .maybeSingle();
    if (error) throw error;

    if (!draft) return none("no_draft");

    const row = draft as {
      id: string;
      patient_id: string | null;
      category: string | null;
      suggested_product_id: string | null;
    };
    if (!row.patient_id) return none("no_patient");

    // The SKU the warehouse will pick. `suggested_product_id` is the
    // catalog SKU the draft proposed; `category` is the fallback the
    // resupply engine itself uses when no specific item was chosen.
    const itemSku = row.suggested_product_id?.trim() || row.category?.trim();
    if (!itemSku) return none("no_sku");

    // Episode id is the draft: it is the unit of resupply work this order
    // fulfils, and keying on it makes ensureFulfillments idempotent — a
    // double-submitted signature returns the existing rows rather than
    // dispensing twice.
    const fulfillmentIds = await ensureFulfillments(supabase, {
      patientId: row.patient_id,
      episodeId: row.id,
      itemSku,
    });

    logger.info(
      {
        event: "csr_order.signed.fulfillments_created",
        orderRequestId,
        draftId: row.id,
        count: fulfillmentIds.length,
      },
      "csr order signed — queued for insurance fulfillment",
    );
    return { fulfillmentIds, skipped: null };
  } catch (err) {
    logger.warn(
      { event: "csr_order.signed.dispense_failed", orderRequestId, err },
      "csr order signed but could not be queued for fulfillment (non-fatal)",
    );
    return none("error");
  }
}
