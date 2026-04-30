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
    "inline-flex items-center justify-center gap-2 rounded-md font-semibold border transition-all disabled:opacity-50 disabled:cursor-not-allowed";
  // Primary uses a navy gradient + soft inner highlight + brand glow on
  // shadow so it reads as a finished, premium control instead of a flat
  // navy fill. Secondary uses a gold outline; ghost is borderless.
  const intentStyle =
    intent === "primary"
      ? {
          background:
            "linear-gradient(180deg, hsl(var(--penn-navy)) 0%, hsl(var(--penn-navy-deep)) 100%)",
          color: "#ffffff",
          borderColor: "hsl(var(--penn-navy-deep))",
          boxShadow:
            "0 1px 0 rgba(255,255,255,0.18) inset, 0 1px 2px hsl(var(--penn-navy) / 0.30), 0 4px 10px hsl(var(--penn-navy) / 0.20)",
        }
      : intent === "secondary"
        ? {
            backgroundColor: "hsl(var(--surface-2))",
            color: "hsl(var(--penn-navy-deep))",
            borderColor: "hsl(var(--penn-gold))",
          }
        : {
            backgroundColor: "transparent",
            color: "hsl(var(--penn-navy))",
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
