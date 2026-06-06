// Learn the patient out-of-pocket (OOP) estimate from real claim
// outcomes (owner #O2). Pure — no I/O, unit-tested. The worker supplies
// the per-claim OOP samples it reads from Postgres; this maps each
// claim's free-text payer name to a storefront slug and rolls the
// samples up into per-slug P50/P90 stats.

import { PAYER_SLUGS } from "./data";

/**
 * Map a free-text claim payer name to one of the storefront estimate
 * slugs (lib/insurance-estimates/data.ts), or null when nothing matches
 * confidently. Deterministic keyword rules — order matters: the more
 * specific pattern (e.g. "medicare advantage") must win over the
 * generic one ("medicare"). No pg_trgm / fuzzy match (the DB ships no
 * extensions); this is a precision-first classifier — an unrecognized
 * payer simply doesn't contribute to a learned slug.
 */
export function classifyPayerSlug(payerName: string): string | null {
  const n = payerName.toLowerCase();
  // Order-sensitive: specific before generic.
  if (/medicare\s*(advantage|adv\b)|\bmapd\b|\bma\s*plan/.test(n)) {
    return "medicare_advantage";
  }
  if (/\bmedicare\b/.test(n)) return "medicare";
  if (/\bmedicaid\b|medi-?cal\b/.test(n)) return "medicaid";
  if (/blue\s*cross|blue\s*shield|\bbcbs\b|anthem|highmark|carefirst/.test(n)) {
    return "bcbs";
  }
  if (/\baetna\b/.test(n)) return "aetna";
  if (/united\s*health|\buhc\b|unitedhealthcare|\boptum\b/.test(n)) {
    return "united";
  }
  if (/\bcigna\b|evernorth/.test(n)) return "cigna";
  if (/\bhumana\b/.test(n)) return "humana";
  if (/tricare|\bchampva\b/.test(n)) return "tricare";
  if (/kaiser|\bkp\b/.test(n)) return "kaiser";
  return null;
}

/**
 * Percentile of an already-sorted (ascending) numeric array using the
 * nearest-rank method. Returns 0 for an empty array.
 */
export function percentileSorted(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0]!;
  const clamped = Math.min(1, Math.max(0, p));
  // Nearest-rank: rank = ceil(p * N), 1-indexed.
  const rank = Math.max(1, Math.ceil(clamped * sortedAsc.length));
  return sortedAsc[rank - 1]!;
}

export interface OopSample {
  /** Free-text claim payer name. */
  payerName: string;
  /** Patient OOP for the claim, in cents. */
  oopCents: number;
}

export interface SlugStat {
  slug: string;
  p50Cents: number;
  p90Cents: number;
  sampleSize: number;
}

/**
 * Roll per-claim OOP samples up into per-slug P50/P90 stats. Samples
 * whose payer name doesn't classify are dropped; a slug needs at least
 * `minSample` classified samples to produce a row (so a thin slug falls
 * back to the static estimate downstream). Output is sorted by slug for
 * deterministic upserts.
 */
export function summarizeOopBySlug(
  samples: ReadonlyArray<OopSample>,
  minSample = 10,
): SlugStat[] {
  const valid = new Set(PAYER_SLUGS);
  const bySlug = new Map<string, number[]>();
  for (const s of samples) {
    const slug = classifyPayerSlug(s.payerName);
    if (!slug || !valid.has(slug)) continue;
    const oop = Math.max(0, Math.round(s.oopCents));
    const arr = bySlug.get(slug);
    if (arr) arr.push(oop);
    else bySlug.set(slug, [oop]);
  }

  const out: SlugStat[] = [];
  for (const [slug, values] of bySlug) {
    if (values.length < minSample) continue;
    values.sort((a, b) => a - b);
    out.push({
      slug,
      p50Cents: percentileSorted(values, 0.5),
      p90Cents: percentileSorted(values, 0.9),
      sampleSize: values.length,
    });
  }
  out.sort((a, b) => a.slug.localeCompare(b.slug));
  return out;
}
