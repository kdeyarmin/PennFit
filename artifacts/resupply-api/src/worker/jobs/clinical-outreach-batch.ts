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
import { logger } from "../../lib/logger.js";
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
    const result = await runClinicalOutreachBatch();
    await logAudit({
      action: "clinical.outreach.batch.completed",
      adminEmail: SYSTEM_ACTOR_EMAIL,
      adminUserId: null,
      targetTable: null,
      targetId: null,
      metadata: { ...result, trigger: "cron" },
      ip: null,
      userAgent: null,
    }).catch((err) => {
      logger.warn({ err }, "clinical outreach batch completion audit failed");
    });
  });

  const cron = process.env.CLINICAL_OUTREACH_CRON?.trim();
  if (cron) {
    await boss.schedule(CLINICAL_OUTREACH_BATCH_JOB, cron);
    logger.info(
      { queue: CLINICAL_OUTREACH_BATCH_JOB, cron },
      "clinical outreach batch scheduled",
    );
  } else {
    logger.info(
      { queue: CLINICAL_OUTREACH_BATCH_JOB },
      "clinical outreach batch registered (cron opt-in unset; manual-trigger only)",
    );
  }
}
