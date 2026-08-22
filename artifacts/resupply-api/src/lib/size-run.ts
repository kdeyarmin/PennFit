/**
 * Size-run bucket resolution — shared by every code path that has to
 * partition ONE measurement axis across a mask's size codes (the static
 * fallback catalog's derived bands and the legacy engine's size picker).
 *
 * The rule is migration 0511's ("wide sizes are not simply bigger"):
 * "Small Wide" means a small nose HEIGHT with a WIDER nose, so a linear
 * S < SW < M < W ladder puts a small-wide patient two sizes off. On a
 * single-axis partition that translates to:
 *
 *   * WIDTH axis (nasal / nasal-pillow runs): a wide code whose plain
 *     base is in the run steps one bucket UP from that base — SW shares
 *     M's width bucket, W takes the bucket above M;
 *   * HEIGHT axis (full-face / hybrid nose-to-chin runs): a wide code
 *     shares its base's bucket — wide is not taller;
 *   * a wide code with NO plain base before it (the AirFit F40 ships
 *     Small Wide / Medium / Large with no plain Small) is an ordinary
 *     ladder step whose smallest size merely has "wide" in its name.
 *
 * `isWideStep` marks the sizes mapped as a wide of a base, so callers
 * can prefer the plain base when the two share a bucket — without a
 * second axis the pair is indistinguishable, and the base cut fits more
 * faces.
 */

/** Matches the wide size codes manufacturers actually ship: W, SW, MW,
 *  XLW, "Wide" — and nothing that merely contains a W ("S/M", "XS-S"). */
const WIDE_CODE = /^(?:(?:XS|S|M|L|XL)?W|Wide)$/i;

export interface SizeRunBuckets {
  /** Per size index, which partition bucket that size occupies. */
  bucketOf: number[];
  bucketCount: number;
  /** Per size index, whether it was mapped as the wide cut of a base. */
  isWideStep: boolean[];
}

export function resolveSizeRunBuckets(
  sizes: readonly string[],
  axis: "width" | "height",
): SizeRunBuckets {
  // A wide code binds to the nearest preceding plain code; with none, it
  // joins the plain ladder itself (0511's F40 rule).
  const wideBaseOf = new Map<number, number>();
  const plainPos = new Map<number, number>();
  for (let i = 0; i < sizes.length; i += 1) {
    if (WIDE_CODE.test(sizes[i]!.trim())) {
      for (let j = i - 1; j >= 0; j -= 1) {
        if (!WIDE_CODE.test(sizes[j]!.trim())) {
          wideBaseOf.set(i, j);
          break;
        }
      }
      if (wideBaseOf.has(i)) continue;
    }
    plainPos.set(i, plainPos.size);
  }

  const bucketOf = sizes.map((_, i) => {
    const base = wideBaseOf.get(i);
    if (base === undefined) return plainPos.get(i)!;
    const basePos = plainPos.get(base)!;
    return axis === "width" ? basePos + 1 : basePos;
  });

  return {
    bucketOf,
    bucketCount: Math.max(...bucketOf) + 1,
    isWideStep: sizes.map((_, i) => wideBaseOf.has(i)),
  };
}
