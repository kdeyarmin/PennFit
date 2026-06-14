import type { ComponentType, ReactNode, SVGProps } from "react";

import { cn } from "@/lib/utils";

// Shared admin page header — the title + description block that sits at
// the top of (almost) every admin page.
//
// Why this exists: the console grew several near-identical header
// blocks plus a handful of divergent ones (different font weights,
// inline-styled sizes, with/without an icon). This primitive captures
// the most common shape — `text-2xl font-bold tracking-tight` in the
// `--ink-1` token over a `text-sm` muted description — so pages stop
// re-declaring it and new pages get a consistent header for free.
//
// Layout: a flex row so an optional `actions` slot (filters, an "Add"
// button) sits opposite the title; with no actions the title block is
// the sole child and renders exactly like the old `space-y-1` header.
// An optional leading `icon` renders inside the `<h1>` (matching the
// `flex items-center gap-2` + `h-6 w-6` shape pages used by hand), and
// `descriptionClassName` lets a page constrain the description width
// (e.g. `max-w-2xl`) without re-declaring the whole header.
export function PageHeader({
  title,
  description,
  icon: Icon,
  actions,
  className,
  descriptionClassName,
}: {
  /** Page title — rendered as the `<h1>`. */
  title: ReactNode;
  /** Optional sub-title / one-line description under the title. */
  description?: ReactNode;
  /** Optional leading icon rendered inside the `<h1>`. */
  icon?: ComponentType<SVGProps<SVGSVGElement>>;
  /** Optional right-aligned controls (filters, actions). */
  actions?: ReactNode;
  /** Extra classes for the outer `<header>`. */
  className?: string;
  /** Extra classes for the description `<p>` (e.g. `max-w-2xl`). */
  descriptionClassName?: string;
}) {
  return (
    <header
      className={cn(
        "flex items-start justify-between gap-4 flex-wrap",
        className,
      )}
    >
      <div className="space-y-1">
        <h1
          className={cn(
            "text-2xl font-bold tracking-tight",
            Icon && "flex items-center gap-2",
          )}
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {Icon ? <Icon className="h-6 w-6" aria-hidden /> : null}
          {title}
        </h1>
        {description ? (
          <p className={cn("text-sm text-slate-600", descriptionClassName)}>
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2 shrink-0">{actions}</div>
      ) : null}
    </header>
  );
}
