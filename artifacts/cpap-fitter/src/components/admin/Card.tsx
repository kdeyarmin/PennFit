import type { ReactNode } from "react";

// PennPaps-branded card surface. Now driven by the .surface-card token
// utility (defined in index.css) so border / shadow / radius can be
// retuned in one place. Layout stays inline; everything else moves to
// the token system.

export function Card({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={`surface-card overflow-hidden ${className}`}>
      {(title || action) && (
        <header
          className="flex items-center justify-between px-5 py-3.5 border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <div>
            {title && (
              <h2
                className="text-sm font-semibold leading-tight"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {title}
              </h2>
            )}
            {subtitle && (
              <p
                className="text-xs mt-1"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {subtitle}
              </p>
            )}
          </div>
          {action && <div>{action}</div>}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

// Small KPI tile used by the dashboard summary. Now wraps an internal
// gradient sheen so the tile doesn't read as a flat box — closer to
// Stripe / Linear KPI cards. The numeric value uses tabular-nums so a
// row of tiles aligns vertically even with different magnitudes.
export function KpiCard({
  label,
  value,
  hint,
  isLoading,
  tone = "navy",
}: {
  label: string;
  value: number | string;
  hint?: string;
  isLoading?: boolean;
  tone?: "navy" | "gold";
}) {
  const accent =
    tone === "gold"
      ? "hsl(var(--penn-gold-deep))"
      : "hsl(var(--penn-navy))";
  return (
    <div
      className="surface-card relative overflow-hidden p-5 lift-on-hover animate-shimmer-in"
      style={{
        // Inner gradient sheen — bottom-right glow tinted by the tone,
        // very faint, just enough to give the tile a sense of depth.
        backgroundImage: `radial-gradient(ellipse 60% 50% at 90% 110%, ${accent.replace("hsl", "hsla").replace(")", " / 0.05)")}, transparent 70%)`,
      }}
    >
      <p
        className="text-[10px] uppercase tracking-[0.22em] font-semibold mb-2"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </p>
      <p
        className="text-3xl font-semibold tabular-nums leading-none"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {isLoading ? (
          <span
            className="skeleton inline-block h-7 w-16 align-middle"
            aria-hidden
          />
        ) : (
          value
        )}
      </p>
      {hint && (
        <p
          className="text-xs mt-2 leading-snug"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {hint}
        </p>
      )}
    </div>
  );
}
