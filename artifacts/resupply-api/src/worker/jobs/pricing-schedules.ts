import type PgBoss from "pg-boss";
import { getOrgScopedClient } from "@workspace/resupply-db";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";

export const PRICING_SCHEDULE_JOB = "pricing.activate-scheduled";

/** Only previously approved, explicitly scheduled price lists can activate.
 * The database checks all versions again while holding the tenant state lock. */
export async function runPricingSchedules() {
  const result = await forEachActiveOrg(
    async (orgId) => {
      const { error } = await getOrgScopedClient(orgId)
        .raw()
        .schema("resupply")
        .rpc("pricing_apply_scheduled", { p_org_id: orgId });
      if (error)
        throw new Error("Scheduled pricing activation could not be checked");
    },
    { jobName: PRICING_SCHEDULE_JOB },
  );
  if (result.failedOrgIds.length)
    throw new Error("Some scheduled pricing activations need retry");
  return result;
}

export async function registerPricingScheduleJob(boss: PgBoss): Promise<void> {
  await createQueueWithDlq(boss, PRICING_SCHEDULE_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(PRICING_SCHEDULE_JOB, async () => {
    await runPricingSchedules();
  });
  await boss.schedule(PRICING_SCHEDULE_JOB, "* * * * *");
}
