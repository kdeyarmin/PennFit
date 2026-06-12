// Open a referral review for a just-ingested inbound fax and enqueue
// the extraction pass. Called from the fax ingest's Step 5 (flag-gated
// there, not here). Idempotent on the per-fax unique index — a Telnyx
// redelivery that somehow re-runs ingest cannot open a second review.

import type { Logger } from "pino";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { REFERRAL_REVIEW_EXTRACT_JOB } from "../../worker/jobs/referral-review-extract";
import { getBoss } from "../../worker/index";

export interface OpenReferralReviewForFaxInput {
  faxId: string;
  mediaObjectKey: string | null;
  mediaContentType: string | null;
  mediaSizeBytes: number | null;
}

export async function openReferralReviewForFax(
  input: OpenReferralReviewForFaxInput,
  logger: Logger,
): Promise<{ reviewId: string | null; enqueued: boolean }> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: inserted, error } = await supabase
    .schema("resupply")
    .from("referral_reviews")
    .insert({
      source: "fax",
      inbound_fax_id: input.faxId,
      media_object_key: input.mediaObjectKey,
      media_content_type: input.mediaContentType,
      media_size_bytes: input.mediaSizeBytes,
      status: "pending",
    })
    .select("id")
    .single();
  if (error) {
    // 23505 — a review already exists for this fax (re-run of ingest).
    if ((error as { code?: string }).code === "23505") {
      return { reviewId: null, enqueued: false };
    }
    throw error;
  }
  const reviewId = inserted.id;

  // Enqueue the extraction. When the in-process worker isn't up yet (or
  // the enqueue fails) the row simply stays `pending` — visible in the
  // reviewer queue with a "Run extraction" action.
  let enqueued = false;
  const boss = getBoss();
  if (boss) {
    try {
      await boss.send(REFERRAL_REVIEW_EXTRACT_JOB, { reviewId });
      enqueued = true;
    } catch (err) {
      logger.warn(
        { err, review_id_first8: reviewId.slice(0, 8) },
        "referral_review_enqueue_failed",
      );
    }
  }
  logger.info(
    {
      event: "referral_review_opened",
      fax_id_first8: input.faxId.slice(0, 8),
      review_id_first8: reviewId.slice(0, 8),
      enqueued,
    },
    "referral review: opened for inbound fax",
  );
  return { reviewId, enqueued };
}
