import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

/**
 * Billing-grade active-patient count for a tenant — the quantity the founder
 * plans' per-active-patient charge bills on (migration 0426). A patient counts
 * when they are active AND have an active prescription (resupply-eligible) AND
 * had an outbound touch or a fulfillment in the trailing 90 days. The logic
 * lives in the `count_active_patients_for_billing` Postgres function (it spans
 * patients/prescriptions/messages/fulfillments with a 90-day window).
 *
 * Fail-soft: returns 0 on any error rather than throwing — it's called from
 * the monthly billing job and must never block a sync, and an undercount is
 * the safe direction (never over-bills on a transient DB hiccup).
 */
export async function countActivePatientsForBilling(
  orgId: string,
): Promise<number> {
  try {
    const { data, error } = await getOrgScopedClient(orgId)
      .raw()
      .schema("resupply")
      .rpc("count_active_patients_for_billing", { p_org_id: orgId });
    if (error) throw error;
    return typeof data === "number" && Number.isFinite(data) && data >= 0
      ? Math.floor(data)
      : 0;
  } catch (err) {
    logger.warn(
      {
        event: "active_patient_count_failed",
        orgId,
        err: err instanceof Error ? err : new Error(String(err)),
      },
      "billable active-patient count failed (treated as 0)",
    );
    return 0;
  }
}
