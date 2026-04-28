import type { ReactNode } from "react";

// Penn-branded card surface. Used for KPI tiles, detail panels, and
// table containers. Inline styles for the brand-tinted border so the
// brand tokens stay in lockstep with App.tsx; layout-only utilities
// stay in Tailwind classNames.

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
    <section
      className={`bg-white border rounded-lg shadow-sm ${className}`}
      style={{ borderColor: "#e5e7eb" }}
    >
      {(title || action) && (
        <header
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: "#e5e7eb" }}
        >
          <div>
            {title && (
              <h2
                className="text-base font-semibold leading-tight"
                style={{ color: "#0a1f44" }}
              >
                {title}
              </h2>
            )}
            {subtitle && (
              <p className="text-xs mt-0.5" style={{ color: "#6b7280" }}>
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

// Small KPI tile used by the dashboard summary. Numeric value is the
// star of the show; the label sits underneath in the gold accent.
export function KpiCard({
  label,
  value,
  hint,
  isLoading,
}: {
  label: string;
  value: number | string;
  hint?: string;
  isLoading?: boolean;
}) {
  return (
    <div
      className="bg-white border rounded-lg shadow-sm p-5"
      style={{ borderColor: "#e5e7eb" }}
    >
      <p
        className="text-xs uppercase tracking-[0.18em] font-semibold mb-2"
        style={{ color: "#c9a24a" }}
      >
        {label}
      </p>
      <p
        className="text-3xl font-semibold tabular-nums"
        style={{ color: "#0a1f44" }}
      >
        {isLoading ? "—" : value}
      </p>
      {hint && (
        <p className="text-xs mt-2" style={{ color: "#6b7280" }}>
          {hint}
        </p>
      )}
    </div>
  );
}
