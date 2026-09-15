// A signature commits the patient-facing order before fulfillment starts.
// Both reviewed and legacy draft orders use atomic database operations;
// failures leave a visible, retryable signed order without losing a signature.
import type { OrgScopedClient } from "@workspace/resupply-db";
import { logger } from "../logger";

export interface DispenseOnSignResult {
  fulfillmentIds: string[];
  skipped:
    | "no_draft"
    | "no_patient"
    | "no_sku"
    | "error"
    | "not_found"
    | "not_signed"
    | "needs_prescription"
    | "address_hold"
    | null;
}
const holds = new Set<DispenseOnSignResult["skipped"]>([
  "no_draft",
  "no_patient",
  "no_sku",
  "not_found",
  "not_signed",
  "needs_prescription",
  "address_hold",
]);
export async function dispenseSignedCsrOrder(
  supabase: OrgScopedClient,
  orderRequestId: string,
): Promise<DispenseOnSignResult> {
  try {
    const args = { p_org_id: supabase.orgId, p_order_id: orderRequestId };
    const reviewed = await supabase
      .raw()
      .schema("resupply")
      .rpc("dispense_csr_priced_order", args);
    if (reviewed.error) throw reviewed.error;
    // Only an explicitly unpriced order enters the legacy path. Stale or
    // held financial reviews never fall back to an unreviewed substitution.
    const result =
      reviewed.data?.status === "no_pricing_quote"
        ? await supabase
            .raw()
            .schema("resupply")
            .rpc("dispense_csr_legacy_order", args)
        : reviewed;
    if (result.error) throw result.error;
    if (result.data?.status === "queued")
      return {
        fulfillmentIds: result.data.fulfillmentIds ?? [],
        skipped: null,
      };
    const reason = result.data?.status as DispenseOnSignResult["skipped"];
    return {
      fulfillmentIds: [],
      skipped: holds.has(reason) ? reason : "error",
    };
  } catch (error) {
    logger.warn(
      {
        event: "csr_order.signed.dispense_failed",
        orderRequestId,
        errName: error instanceof Error ? error.name : "database_error",
      },
      "Signed CSR order could not be queued; staff can retry fulfillment",
    );
    return { fulfillmentIds: [], skipped: "error" };
  }
}
