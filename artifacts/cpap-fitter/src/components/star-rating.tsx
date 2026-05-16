// Reusable star-rating display + clickable rating input for the
// PennPaps shop. Two modes:
//
//   * <StarRating value=4.6 count=24 />  — read-only display (compact
//     by default; use `size="lg"` on product detail).
//   * <StarRating value={rating} onChange={setRating} interactive />
//     — clickable 5-star input for the write-review form.
//
// Visual treatment uses the brand soft-gold for filled stars and a
// muted slate for empty. We render half-stars in display mode by
// stacking a clipped gold star on top of an empty star — keeps SVG
// markup simple and avoids pulling in a star library.

import React from "react";
import { Star } from "lucide-react";

export type StarSize = "sm" | "md" | "lg";

const SIZE_CLASS: Record<StarSize, string> = {
  sm: "w-3.5 h-3.5",
  md: "w-4 h-4",
  lg: "w-6 h-6",
};

const TEXT_SIZE: Record<StarSize, string> = {
  sm: "text-xs",
  md: "text-sm",
  lg: "text-base",
};

export interface StarRatingProps {
  /** 0–5; supports decimals for display mode. */
  value: number;
  /** Optional review count to render after the stars. Hidden if undefined. */
  count?: number;
  size?: StarSize;
  /** When true, stars become clickable and onChange must be provided. */
  interactive?: boolean;
  onChange?: (next: 1 | 2 | 3 | 4 | 5) => void;
  /** Suppresses the numeric "(N)" suffix even when count is provided. */
  hideCount?: boolean;
  className?: string;
  testId?: string;
}

const FILLED_COLOR = "hsl(var(--penn-gold))";
const EMPTY_COLOR = "rgb(203 213 225)"; /**
 * Render a 0–5 star rating display, optionally interactive for selecting an integer rating.
 *
 * @param value - Rating to display, expected in the range 0 to 5; fractional values render partial star fills.
 * @param count - Optional review count to show as a suffix; hidden when `undefined` or when `hideCount` is true.
 * @param size - Visual scale of stars and text; one of `"sm" | "md" | "lg"`. Default: `"md"`.
 * @param interactive - When true, renders each star as a keyboard-focusable radio button allowing selection. Default: `false`.
 * @param onChange - Optional callback invoked with an integer `1 | 2 | 3 | 4 | 5` when an interactive star is clicked.
 * @param hideCount - When true, suppresses the numeric `(N)` suffix even if `count` is provided. Default: `false`.
 * @param className - Additional class names appended to the outer container.
 * @param testId - Optional test identifier applied to the wrapper and to interactive stars as `"{testId}-star-{s}"`.
 * @returns The JSX element rendering the star rating and optional count.
 */

export function StarRating({
  value,
  count,
  size = "md",
  interactive = false,
  onChange,
  hideCount = false,
  className = "",
  testId,
}: StarRatingProps) {
  const clamped = Math.max(0, Math.min(5, value));
  const stars = [1, 2, 3, 4, 5] as const;
  const sizeCls = SIZE_CLASS[size];
  const textCls = TEXT_SIZE[size];

  return (
    <div
      className={`inline-flex items-center gap-1.5 ${className}`}
      data-testid={testId}
    >
      <div
        className="inline-flex"
        role={interactive ? "radiogroup" : "img"}
        aria-label={
          interactive
            ? "Choose a star rating"
            : `${clamped.toFixed(1)} out of 5 stars`
        }
      >
        {stars.map((s) => {
          // Display-mode fill: clip to the fractional part so 4.6
          // shows the 5th star ~60% gold.
          const fillPct = Math.max(0, Math.min(1, clamped - (s - 1)));
          if (interactive) {
            return (
              <button
                key={s}
                type="button"
                role="radio"
                aria-checked={value === s}
                aria-label={`${s} ${s === 1 ? "star" : "stars"}`}
                onClick={() => onChange?.(s)}
                className="p-0.5 -m-0.5 rounded hover:scale-110 transition-transform focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-gold))]/40"
                data-testid={testId ? `${testId}-star-${s}` : undefined}
              >
                <Star
                  className={sizeCls}
                  style={{
                    color: s <= clamped ? FILLED_COLOR : EMPTY_COLOR,
                    fill: s <= clamped ? FILLED_COLOR : "transparent",
                  }}
                />
              </button>
            );
          }
          return (
            <span key={s} className="relative inline-block" aria-hidden="true">
              <Star
                className={sizeCls}
                style={{ color: EMPTY_COLOR, fill: "transparent" }}
              />
              {fillPct > 0 && (
                <span
                  className="absolute inset-0 overflow-hidden pointer-events-none"
                  style={{ width: `${fillPct * 100}%` }}
                >
                  <Star
                    className={sizeCls}
                    style={{ color: FILLED_COLOR, fill: FILLED_COLOR }}
                  />
                </span>
              )}
            </span>
          );
        })}
      </div>
      {!hideCount && count !== undefined && (
        <span
          className={`${textCls} font-medium text-[hsl(var(--penn-navy))]/80`}
        >
          {value > 0 ? value.toFixed(1) : "0.0"}{" "}
          <span className="text-muted-foreground font-normal">({count})</span>
        </span>
      )}
    </div>
  );
}
