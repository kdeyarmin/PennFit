import type { ButtonHTMLAttributes, ReactNode } from "react";

// Brand-aligned button. Three intents:
//   - "primary": PennPaps navy, used for the page's main CTA.
//   - "secondary": white with gold border, used inline next to a primary.
//   - "ghost": no background; used for table-row inline actions.
//
// `isLoading` swaps the label with an inline spinner glyph and disables
// the button so a fast double-click can't fire two mutations.

type Intent = "primary" | "secondary" | "ghost";
type Size = "sm" | "md";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  intent?: Intent;
  size?: Size;
  isLoading?: boolean;
  children?: ReactNode;
}

const SIZE_CLASS: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
};

export function Button({
  intent = "primary",
  size = "md",
  isLoading,
  disabled,
  children,
  className = "",
  ...rest
}: Props) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded font-semibold border transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus:ring-2 focus:ring-offset-1";
  const intentStyle =
    intent === "primary"
      ? { backgroundColor: "#0a1f44", color: "#ffffff", borderColor: "#0a1f44" }
      : intent === "secondary"
        ? { backgroundColor: "#ffffff", color: "#0a1f44", borderColor: "#c9a24a" }
        : {
            backgroundColor: "transparent",
            color: "#0a1f44",
            borderColor: "transparent",
          };

  return (
    <button
      type={rest.type ?? "button"}
      disabled={disabled || isLoading}
      className={`${base} ${SIZE_CLASS[size]} ${className}`}
      style={intentStyle}
      {...rest}
    >
      {isLoading && (
        <span
          className="inline-block h-3 w-3 rounded-full border-2 border-white/40 border-t-white animate-spin"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
