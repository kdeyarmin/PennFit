// pg-boss job: scheduled proactive clinical outreach (RT #23).
//
// Sends the templated, consent/DND/frequency-cap-gated nudge to patients
// with an open non-adherence intervention. See lib/clinical/clinical-
// outreach.ts for the run core.
//
// SAFETY — this emits OUTBOUND patient contact on a schedule, so the cron
// is OPT-IN. The queue + worker always register (so the admin "Run now"
// trigger works), but the recurring schedule only attaches when
// CLINICAL_OUTREACH_CRON is set to a 5-field cron expression. Dev /
// preview / a fresh prod never auto-message patients until an operator
// deliberately turns it on — same posture as the eligibility batch.

import type PgBoss from "pg-boss";

import { logAudit } from "@workspace/resupply-audit";

import { runClinicalOutreachBatch } from "../../lib/clinical/clinical-outreach.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import { logger } from "../../lib/logger.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const CLINICAL_OUTREACH_BATCH_JOB = "clinical.outreach-batch";

const SYSTEM_ACTOR_EMAIL = "system:worker:clinical-outreach";

export async function registerClinicalOutreachBatchJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    CLINICAL_OUTREACH_BATCH_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work(CLINICAL_OUTREACH_BATCH_JOB, async () => {
    // Fan out across every active tenant. The run core is per-org and the
    // dispatcher flag is per-tenant (feature_flags is (org_id, key)), so
    // each tenant is swept on its own org and one tenant's opt-out — or
    // failure — never affects another. The operator "Run now" route calls
    // the run core directly and is intentionally not gated here.
    await forEachActiveOrg(
      async (orgId) => {
        // Runtime kill switch (admin Control Center), per tenant. The env
        // cron controls scheduling; this flag pauses the unattended sends
        // without a deploy.
        if (!(await isFeatureEnabled("clinical_outreach.dispatcher", orgId))) {
          logger.info(
            { queue: CLINICAL_OUTREACH_BATCH_JOB, org_id: orgId },
            "clinical outreach batch: feature flag off — skipping tenant",
          );
          return;
        }
        const result = await runClinicalOutreachBatch({ orgId });
        await logAudit({
          action: "clinical.outreach.batch.completed",
          adminEmail: SYSTEM_ACTOR_EMAIL,
          adminUserId: null,
          targetTable: null,
          targetId: null,
          metadata: { ...result, trigger: "cron", org_id: orgId },
          ip: null,
          userAgent: null,
        }).catch((err) => {
          logger.warn(
            { err },
            "clinical outreach batch completion audit failed",
          );
        });
      },
      { jobName: CLINICAL_OUTREACH_BATCH_JOB },
    );
  });

  const cron = process.env.CLINICAL_OUTREACH_CRON?.trim();
  if (cron) {
    await boss.schedule(CLINICAL_OUTREACH_BATCH_JOB, cron);
    logger.info(
      { queue: CLINICAL_OUTREACH_BATCH_JOB, cron },
      "clinical outreach batch scheduled",
    );
  } else {
    // boss.schedule() persists the cron in pg-boss; merely not
    // re-scheduling does NOT stop a previously-attached schedule.
    // Clear any stale row so removing the env var actually turns
    // the cron off (same pattern as worker/lib/table-guard.ts).
    // typeof-guarded like worker/lib/table-guard.ts — test
    // doubles (and old pg-boss) may not implement unschedule.
    if (typeof boss.unschedule === "function") {
      await boss.unschedule(CLINICAL_OUTREACH_BATCH_JOB).catch(() => undefined);
    }
    logger.info(
      { queue: CLINICAL_OUTREACH_BATCH_JOB },
      "clinical outreach batch registered (cron opt-in unset; manual-trigger only)",
    );
  }
}
