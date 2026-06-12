// pg-boss job: AI extraction pass for a referral review.
//
// Enqueued by the inbound-fax ingest (when `fax.referral_review` is on)
// and by the manual "Upload referral PDF" finalize route. A 10-20 page
// packet can take 30-60s through the model, which is far too long for
// the Telnyx webhook's 200 SLA — and a VENDOR_SEND queue gives the pass
// a real retry budget with backoff for transient Anthropic / storage
// blips, with exhausted retries landing in the DLQ.
//
// runReviewExtraction persists deterministic outcomes (extracted /
// failed / offline / unsupported) and completes the job; only
// infrastructure errors (storage download, DB write) propagate so
// pg-boss retries them. Duplicate deliveries are cheap no-ops — the
// routine skips any row that already left `pending`.

import type PgBoss from "pg-boss";

import { logger } from "../../lib/logger";
import { runReviewExtraction } from "../../lib/referral-review/run";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options";

export const REFERRAL_REVIEW_EXTRACT_JOB = "referral-review.extract";

export interface ReferralReviewExtractJobData {
  reviewId: string;
}

export async function registerReferralReviewExtractJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(
    boss,
    REFERRAL_REVIEW_EXTRACT_JOB,
    VENDOR_SEND_QUEUE_OPTS,
  );
  await boss.work<ReferralReviewExtractJobData>(
    REFERRAL_REVIEW_EXTRACT_JOB,
    async (jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        const outcome = await runReviewExtraction(j.data.reviewId);
        if (outcome.kind !== "ran") {
          // not_found / media_missing / already_terminal are all
          // unretryable — log and complete.
          logger.info(
            {
              event: "referral_review_extract_job_skipped",
              review_id_first8: j.data.reviewId.slice(0, 8),
              kind: outcome.kind,
            },
            "referral review extract job: nothing to do",
          );
        }
      }
    },
  );
}
