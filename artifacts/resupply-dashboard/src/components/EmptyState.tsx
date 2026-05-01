import type { ReactNode } from "react";

// Shared empty state for tables and lists. Title is a single short
// sentence ("No conversations match this filter."); the optional hint
// suggests the next admin action ("Try clearing filters." etc).

export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="text-center py-12 px-4">
      <div
        className="mx-auto h-10 w-10 rounded-full flex items-center justify-center mb-3 icon-halo-navy"
        aria-hidden="true"
      >
        <span className="text-lg leading-none">·</span>
      </div>
      <p
        className="text-sm font-semibold mb-1"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {title}
      </p>
      {hint && (
        <p className="text-xs mb-3" style={{ color: "hsl(var(--ink-3))" }}>
          {hint}
        </p>
      )}
      {action}
    </div>
  );
}
