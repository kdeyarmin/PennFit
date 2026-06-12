// Shared "run extraction for a review row" routine — used by both the
// pg-boss job (fax arrival) and the on-demand re-run route, so the
// download → extract → persist sequence behaves identically everywhere.
//
// Outcome semantics: every extraction outcome — including offline /
// unsupported / failed — is PERSISTED to the row, never thrown. Only
// infrastructure errors (storage download, DB write) throw, so the
// pg-boss job can retry them while a deterministic model outcome is
// recorded once and surfaced to the reviewer.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../object-storage/objectStorage";

import { extractReferral, type ReferralExtractionResult } from "./extract";

export type RunReviewExtractionOutcome =
  | { kind: "ran"; status: ReferralExtractionResult["status"] }
  | { kind: "not_found" }
  | { kind: "already_terminal"; status: string }
  | { kind: "media_missing" };

/**
 * Load the review's media, run the extraction, persist the result.
 * `force` re-runs even when a previous pass already produced a result
 * (the admin "Re-run extraction" button); without it, accepted /
 * dismissed / already-extracted rows are left alone so a duplicate job
 * delivery never double-charges the model.
 */
export async function runReviewExtraction(
  reviewId: string,
  opts: { force?: boolean; storage?: ObjectStorageService } = {},
): Promise<RunReviewExtractionOutcome> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: review, error } = await supabase
    .schema("resupply")
    .from("referral_reviews")
    .select("id, status, media_object_key, media_content_type")
    .eq("id", reviewId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!review) return { kind: "not_found" };

  // Accepted / dismissed rows are settled regardless of force — a
  // re-extract after accept would desync the stored extraction from
  // the patient record it created.
  if (review.status === "accepted" || review.status === "dismissed") {
    return { kind: "already_terminal", status: review.status };
  }
  if (review.status !== "pending" && !opts.force) {
    return { kind: "already_terminal", status: review.status };
  }
  if (!review.media_object_key) {
    return { kind: "media_missing" };
  }

  const storage = opts.storage ?? new ObjectStorageService();
  let bytes: Buffer;
  try {
    const file = await storage.getObjectEntityFile(review.media_object_key);
    const response = await storage.downloadObject(file, 0);
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      return { kind: "media_missing" };
    }
    throw err; // transient storage error — let the job retry
  }

  const result = await extractReferral({
    bytes,
    contentType: review.media_content_type,
  });

  const nowIso = new Date().toISOString();
  const { error: upErr } = await supabase
    .schema("resupply")
    .from("referral_reviews")
    .update({
      status: result.status,
      extraction: result.status === "extracted" ? result.extraction : null,
      extraction_model: result.status === "extracted" ? result.model : null,
      extracted_at: nowIso,
      error_reason:
        result.status === "failed" || result.status === "unsupported"
          ? result.reason
          : null,
      updated_at: nowIso,
    })
    .eq("id", reviewId);
  if (upErr) throw upErr;

  logger.info(
    {
      event: "referral_review_extraction_persisted",
      review_id_first8: reviewId.slice(0, 8),
      status: result.status,
    },
    "referral review: extraction persisted",
  );
  return { kind: "ran", status: result.status };
}
