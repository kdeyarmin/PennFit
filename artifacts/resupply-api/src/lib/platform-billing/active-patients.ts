import { getOrgScopedClient } from "@workspace/resupply-db";

/**
 * Billing-grade active-patient count for a tenant — the quantity the founder
 * plans' per-active-patient charge bills on (migration 0426). A patient counts
 * when they are active AND have an active prescription (resupply-eligible) AND
 * had an outbound touch or a fulfillment in the trailing 90 days. The logic
 * lives in the `count_active_patients_for_billing` Postgres function (it spans
 * patients/prescriptions/messages/fulfillments with a 90-day window).
 *
 * THROWS on a query error — it deliberately does NOT fall back to 0. A
 * transient RPC failure that silently returned 0 would be written into
 * `billable_active_patients` and then zero the per-active-patient Stripe line
 * quantity (the item is only attached when the count is > 0), silently
 * dropping the entire per-patient revenue line for the period with no failure
 * signal. The sole caller (founder-active-patient-billing) catches per-tenant,
 * counts the tenant as failed, and skips the write+sync so the prior quantity
 * is preserved and retried on the next run.
 */
export async function countActivePatientsForBilling(
  orgId: string,
): Promise<number> {
  const { data, error } = await getOrgScopedClient(orgId)
    .raw()
    .schema("resupply")
    .rpc("count_active_patients_for_billing", { p_org_id: orgId });
  if (error) throw error;
  return typeof data === "number" && Number.isFinite(data) && data >= 0
    ? Math.floor(data)
    : 0;
}
