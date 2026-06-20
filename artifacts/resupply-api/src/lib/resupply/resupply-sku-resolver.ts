// Heuristic resolver: a device-reported supply (unified `category` plus a
// free-text `description` like "AirFit N30i") → a Stripe-catalog product
// id. Used only as a CONVENIENCE hint when staging a resupply order draft;
// the CSR always confirms the exact SKU at review/approve time.
//
// The match is intentionally conservative — it returns a `productId` only
// when reasonably confident and `null` (with a confidence reason)
// otherwise, so an ambiguous guess never silently lands on the wrong
// product. The catalog lives in Stripe (see worker/jobs/low-stock-alerts);
// callers pass the projected `{ id, name, category }` candidates in, which
// keeps this module pure + deterministic and unit-testable without a
// Stripe round-trip.

export interface ProductCandidate {
  id: string;
  name: string;
  /** Catalog category (e.g. from Stripe product metadata). May be absent. */
  category?: string | null;
}

export interface SupplyNeed {
  /** Unified supply category from the opportunities RPC (mask/cushion/…). */
  category: string;
  /** Device-reported item description, when the vendor supplies one. */
  description: string | null;
}

export type SkuMatchConfidence = "exact" | "category" | "ambiguous" | "none";

export interface SkuSuggestion {
  /** The suggested product, or null when ambiguous / nothing matched. */
  productId: string | null;
  confidence: SkuMatchConfidence;
  /** When ambiguous, the candidate ids that tied (for operator display). */
  alternativeIds: string[];
}

// Minimum token-overlap a description must reach for an "exact" hint.
const DESCRIPTION_MATCH_THRESHOLD = 0.6;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(" ")
    .filter((t) => t.length >= 2);
}

/** Count of `description` tokens (>= 2 chars) also present in `name`. */
function overlapHits(description: string, candidateName: string): number {
  const need = tokens(description);
  if (need.length === 0) return 0;
  const hay = new Set(tokens(candidateName));
  return need.filter((t) => hay.has(t)).length;
}

/**
 * Fraction of `description` tokens (>= 2 chars) that appear in
 * `candidateName`, in [0, 1]. "AirFit N30i" vs "ResMed AirFit N30i Mask"
 * scores 1.0; an empty/garbage description scores 0.
 */
export function descriptionScore(
  description: string,
  candidateName: string,
): number {
  const need = tokens(description);
  if (need.length === 0) return 0;
  return overlapHits(description, candidateName) / need.length;
}

/**
 * Suggest a catalog product for a due supply. Order of preference:
 *   1. A clear description match (token overlap >= threshold, no tie).
 *   2. Exactly one product in the same category.
 * Anything else returns a null suggestion with the reason
 * ("ambiguous" when several candidates tie, "none" otherwise).
 */
export function suggestProductForSupply(
  need: SupplyNeed,
  candidates: ProductCandidate[],
): SkuSuggestion {
  const none: SkuSuggestion = {
    productId: null,
    confidence: "none",
    alternativeIds: [],
  };
  if (candidates.length === 0) return none;

  const wantCategory = normalize(need.category);
  const inCategory = candidates.filter(
    (c) => c.category != null && normalize(c.category) === wantCategory,
  );
  // Score descriptions against the in-category pool when we have one,
  // otherwise the whole catalog (a missing/uncategorised catalog still
  // gets a description match).
  const pool = inCategory.length > 0 ? inCategory : candidates;

  const description = need.description?.trim();
  if (description) {
    const scored = pool
      .map((c) => ({
        candidate: c,
        score: descriptionScore(description, c.name),
        hits: overlapHits(description, c.name),
      }))
      .sort((a, b) => b.score - a.score);
    const top = scored[0];
    // Require a strong overlap AND at least two matched tokens, so a single
    // generic word ("Mask") can't anchor a confident match onto a product
    // whose name merely contains it.
    if (top && top.score >= DESCRIPTION_MATCH_THRESHOLD && top.hits >= 2) {
      const ties = scored.filter((s) => s.score === top.score);
      if (ties.length === 1) {
        return {
          productId: top.candidate.id,
          confidence: "exact",
          alternativeIds: [],
        };
      }
      return {
        productId: null,
        confidence: "ambiguous",
        alternativeIds: ties.map((t) => t.candidate.id),
      };
    }
  }

  if (inCategory.length === 1) {
    return {
      productId: inCategory[0]!.id,
      confidence: "category",
      alternativeIds: [],
    };
  }
  if (inCategory.length > 1) {
    return {
      productId: null,
      confidence: "ambiguous",
      alternativeIds: inCategory.map((c) => c.id),
    };
  }
  return none;
}
