/**
 * Sign-off provenance decisions for the mask-catalog review queue.
 *
 * Extracted from the page so the behaviour can be tested against the real
 * implementation rather than a copy of it. Two questions, both about
 * telling a reviewer the truth:
 *
 *   1. Which job is this? Confirming a published value and auditing an
 *      estimate are different tasks, and mislabelling one as the other
 *      wastes the reviewer's time or borrows credibility the data has
 *      not earned.
 *   2. What can we safely pre-fill? The reference, when every pending
 *      band shares one. The evidence CLASS only when the stored
 *      provenance actually implies it — see `prefillFromPending`.
 */

import type {
  MaskSizeVariant,
  ReviewSourceKind,
} from "@/lib/admin/fitting-api";

/** The subset of a variant these decisions read. */
export type PendingBand = Pick<
  MaskSizeVariant,
  "needsClinicalReview" | "fitDataSource" | "fitDataSourceRef"
>;

export type PendingSourceKind =
  | "manufacturer"
  | "measured"
  | "estimated"
  | "mixed";

/**
 * What the pending bands for one model have in common.
 *
 * `mixed` matters: a single citation cannot describe a queue where some
 * sizes are estimates and others came from a document, so the panel has
 * to send the reviewer to the per-row Source column instead of making one
 * claim about all of them.
 */
export function pendingSourceKind(bands: PendingBand[]): PendingSourceKind {
  const pending = bands.filter((b) => b.needsClinicalReview);
  if (pending.length === 0) return "estimated";
  const sources = new Set(pending.map((b) => b.fitDataSource));
  if (sources.size > 1) return "mixed";
  if (sources.has("manufacturer")) return "manufacturer";
  if (sources.has("measured")) return "measured";
  return "estimated";
}

export interface SourcePrefill {
  /** Null when the stored provenance does not imply a document class. */
  kind: ReviewSourceKind | null;
  ref: string;
}

/**
 * What to seed the sign-off form with, or null to leave it blank.
 *
 * Deliberately conservative in two places:
 *
 *   * nothing is pre-filled when any pending band is an estimate (there
 *     is no citation to offer) or when the pending bands disagree on
 *     their source (one reference would misattribute the others);
 *   * only `measured` implies a class. `manufacturer` names the
 *     PUBLISHER, not the document type, and the review schema separates a
 *     fit guide from a spec sheet — so guessing would print the wrong
 *     evidence class on every sign-off, which is precisely the
 *     overclaiming these provenance columns exist to prevent.
 */
export function prefillFromPending(bands: PendingBand[]): SourcePrefill | null {
  const pending = bands.filter((b) => b.needsClinicalReview);
  if (pending.length === 0) return null;
  if (pending.some((b) => b.fitDataSource === "estimated")) return null;

  const refs = new Set(pending.map((b) => b.fitDataSourceRef));
  const kinds = new Set(pending.map((b) => b.fitDataSource));
  if (refs.size !== 1 || kinds.size !== 1) return null;

  const [ref] = refs;
  if (!ref) return null;

  return {
    kind: [...kinds][0] === "measured" ? "physical_measurement" : null,
    ref: String(ref),
  };
}
