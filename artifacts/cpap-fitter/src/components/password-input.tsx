// PasswordInput — text input with a show/hide toggle, plus an
// optional strength meter for the sign-up flow.
//
// Why a dedicated component (vs. inlining the show/hide button in
// every auth page): the auth pages all use the same plain <input>
// markup, so a shared wrapper keeps the visibility toggle, the
// aria semantics, and the strength meter in one place. The
// strength meter is opt-in (`showStrength` prop) — sign-in doesn't
// want one (returning users already chose a password), only
// sign-up does.

import {
  forwardRef,
  useId,
  useMemo,
  useState,
  type InputHTMLAttributes,
} from "react";
import { Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "size"
> {
  /**
   * When true, render a four-segment strength meter under the
   * input that updates as the user types. Pairs with the server-
   * enforced `minLength={12}` rule on the sign-up form.
   */
  showStrength?: boolean;
  /** Optional helper text rendered below the input + meter. */
  helperText?: string;
  /** Forwarded to the underlying <input> for tests. */
  inputTestId?: string;
}

type StrengthLabel = "Too short" | "Weak" | "OK" | "Strong" | "Excellent";

interface Strength {
  /** 0..4 — number of filled segments in the visual meter. */
  score: 0 | 1 | 2 | 3 | 4;
  label: StrengthLabel;
}

/**
 * Light-weight password strength heuristic. We deliberately do NOT
 * pull in zxcvbn (300+ KB gzipped, much of it dictionary data) for
 * a single field — the storefront bundle stays small. The score is
 * a hint to the shopper, not an enforcement boundary; the server
 * applies the actual length + complexity rules.
 *
 * Scoring rubric:
 *   length < 12       → score 0 (we surface the minimum requirement)
 *   length 12..14     → score 1 (Weak)
 *   length 15..17     → score 2 (OK)
 *   length 18..23     → score 3 (Strong)
 *   length >= 24, OR  → score 4 (Excellent)
 *     length 18+ AND uses 3+ character classes
 *
 * Character classes considered: lowercase, uppercase, digit, symbol.
 */
function scorePassword(password: string): Strength {
  const len = password.length;
  if (len === 0) return { score: 0, label: "Too short" };
  if (len < 12) return { score: 0, label: "Too short" };

  const classes =
    (/[a-z]/.test(password) ? 1 : 0) +
    (/[A-Z]/.test(password) ? 1 : 0) +
    (/\d/.test(password) ? 1 : 0) +
    (/[^A-Za-z0-9]/.test(password) ? 1 : 0);

  let score: Strength["score"];
  if (len >= 24 || (len >= 18 && classes >= 3)) {
    score = 4;
  } else if (len >= 18) {
    score = 3;
  } else if (len >= 15) {
    score = 2;
  } else {
    score = 1;
  }

  const labels: Record<Strength["score"], StrengthLabel> = {
    0: "Too short",
    1: "Weak",
    2: "OK",
    3: "Strong",
    4: "Excellent",
  };
  return { score, label: labels[score] };
}

const SEGMENT_COLORS = [
  // index 0 unused (score 0 = no fill) but keeps the index→color map
  // 1:1 with strength score below.
  "bg-slate-200",
  "bg-rose-400",
  "bg-amber-400",
  "bg-emerald-400",
  "bg-emerald-500",
] as const;

const LABEL_COLORS: Record<Strength["score"], string> = {
  0: "text-rose-700",
  1: "text-rose-700",
  2: "text-amber-700",
  3: "text-emerald-700",
  4: "text-emerald-700",
};

export const PasswordInput = forwardRef<HTMLInputElement, Props>(
  function PasswordInput(
    {
      showStrength = false,
      helperText,
      className,
      value,
      inputTestId,
      ...rest
    },
    ref,
  ) {
    const [visible, setVisible] = useState(false);
    const reactId = useId();
    const helperId = `${reactId}-help`;
    const meterId = `${reactId}-strength`;

    // The strength meter only consumes the password when it's a
    // controlled string. Avoids reading event.target on every
    // keystroke and keeps the component pure.
    const strength = useMemo<Strength | null>(() => {
      if (!showStrength) return null;
      const v = typeof value === "string" ? value : "";
      return scorePassword(v);
    }, [value, showStrength]);

    return (
      <div>
        <div className="relative">
          <input
            {...rest}
            ref={ref}
            type={visible ? "text" : "password"}
            value={value}
            aria-describedby={
              [
                helperText || rest["aria-describedby"] ? helperId : null,
                strength ? meterId : null,
              ]
                .filter(Boolean)
                .join(" ") || undefined
            }
            data-testid={inputTestId}
            className={cn(
              "mt-1 w-full rounded-md border px-3 py-2 pr-10 text-sm",
              className,
            )}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            className="absolute right-2 top-1/2 -translate-y-1/2 mt-0.5 inline-flex items-center justify-center h-7 w-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            data-testid="password-toggle-visibility"
          >
            {visible ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        </div>

        {strength && typeof value === "string" && value.length > 0 && (
          <div
            id={meterId}
            className="mt-2"
            data-testid="password-strength"
            data-strength-score={strength.score}
          >
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={strength.score}
              aria-label="Password strength"
              className="grid grid-cols-4 gap-1"
            >
              {[1, 2, 3, 4].map((seg) => (
                <span
                  key={seg}
                  className={cn(
                    "h-1.5 rounded-full transition-colors",
                    seg <= strength.score
                      ? SEGMENT_COLORS[strength.score]
                      : "bg-slate-200",
                  )}
                />
              ))}
            </div>
            <p
              className={cn(
                "mt-1 text-[11px] font-semibold",
                LABEL_COLORS[strength.score],
              )}
              aria-live="polite"
            >
              {strength.label}
            </p>
          </div>
        )}

        {helperText && (
          <span
            id={helperId}
            className="block text-xs mt-1 text-muted-foreground"
          >
            {helperText}
          </span>
        )}
      </div>
    );
  },
);
