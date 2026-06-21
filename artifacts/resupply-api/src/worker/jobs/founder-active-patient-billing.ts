// pg-boss job: monthly refresh of the founder plans' per-active-patient
// billing quantity (migration 0426).
//
// For every tenant on a founder plan (billing_plans.per_active_patient_cents
// set), recompute the billable active-patient count, store it on
// tenant_billing_subscriptions.billable_active_patients, and re-sync the Stripe
// subscription so the per-patient line item's quantity matches. Runs near the
// start of the billing period (1st of the month). Per-tenant errors are
// isolated so one bad tenant never stalls the rest; the whole job no-ops
// cleanly when platform Stripe billing is unconfigured (the re-sync returns
// stripeConfigured:false).

import type PgBoss from "pg-boss";

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { countActivePatientsForBilling } from "../../lib/platform-billing/active-patients.js";
import { syncTenantStripeSubscription } from "../../lib/platform-billing/stripe.js";
import { createQueueWithDlq } from "../lib/queue-options.js";

export const FOUNDER_ACTIVE_PATIENT_BILLING_JOB =
  "founder.active-patient-billing";

const ACTIVE_SUB_STATUSES = ["active", "trialing", "past_due"];

export async function registerFounderActivePatientBillingJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, FOUNDER_ACTIVE_PATIENT_BILLING_JOB, {
    expireInMinutes: 30,
  });
  await boss.work(FOUNDER_ACTIVE_PATIENT_BILLING_JOB, async () => {
    await runFounderActivePatientBilling();
  });
  // Monthly, 1st at 06:00 UTC — near the start of the billing period so the
  // updated quantity applies to the upcoming month with minimal proration.
  await boss.schedule(FOUNDER_ACTIVE_PATIENT_BILLING_JOB, "0 6 1 * *");
  logger.info(
    { queue: FOUNDER_ACTIVE_PATIENT_BILLING_JOB },
    "founder active-patient billing worker registered",
  );
}

export interface FounderBillingResult {
  tenants: number;
  updated: number;
  failed: number;
}

export async function runFounderActivePatientBilling(): Promise<FounderBillingResult> {
  const result: FounderBillingResult = { tenants: 0, updated: 0, failed: 0 };
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return result;
  const raw = getOrgScopedClient(seedOrgId).raw();

  // Founder plans = those carrying a per-active-patient rate.
  const { data: plans, error: plansErr } = await raw
    .schema("resupply")
    .from("billing_plans")
    .select("id")
    .not("per_active_patient_cents", "is", null);
  if (plansErr) throw plansErr;
  const planIds = (plans ?? []).map((p) => p.id as string);
  if (planIds.length === 0) return result;

  // Page through ALL founder-plan subscriptions — an unbounded select stops at
  // PostgREST's default row cap, which would leave tenants past the first page
  // with stale per-patient quantities.
  const PAGE = 1000;
  const orgIds: string[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await raw
      .schema("resupply")
      .from("tenant_billing_subscriptions")
      .select("org_id")
      .in("plan_id", planIds)
      .in("status", ACTIVE_SUB_STATUSES)
      .order("org_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const page = data ?? [];
    for (const s of page) {
      const o = (s as { org_id?: string }).org_id;
      if (o) orgIds.push(o);
    }
    if (page.length < PAGE) break;
  }

  for (const orgId of orgIds) {
    result.tenants += 1;
    try {
      const count = await countActivePatientsForBilling(orgId);
      const { error: updErr } = await raw
        .schema("resupply")
        .from("tenant_billing_subscriptions")
        .update({ billable_active_patients: count })
        .eq("org_id", orgId)
        .in("status", ACTIVE_SUB_STATUSES);
      if (updErr) throw updErr;
      // Re-sync so the per-patient item quantity matches the new count.
      await syncTenantStripeSubscription({ orgId });
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      logger.warn(
        {
          event: "founder_active_patient_billing_failed",
          orgId,
          err: err instanceof Error ? err : new Error(String(err)),
        },
        "founder active-patient billing: tenant refresh failed (skipped)",
      );
    }
  }

  logger.info(
    { event: "founder_active_patient_billing_done", ...result },
    "founder active-patient billing run complete",
  );
  return result;
}
