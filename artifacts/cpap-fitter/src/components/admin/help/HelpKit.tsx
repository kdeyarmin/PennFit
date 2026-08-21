// Shared render primitives for the staff Help Center (/admin/resources).
//
// The Help Center's content is plain data (src/content/admin-help); these
// are the pieces that turn it into pages. Kept in one file because they
// are small, only used together, and share a visual language that is
// easier to keep consistent when it is visible on one screen.
//
// Everything here is presentational — no data fetching, no state beyond
// a disclosure toggle — so the pages stay trivial to test.

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Info,
  Lightbulb,
} from "lucide-react";

import { splitAdminPaths } from "@/lib/admin/admin-path-segments";
import type { HelpCallout } from "@/content/admin-help";

// ---------------------------------------------------------------------
// Hash deep links
// ---------------------------------------------------------------------

/**
 * Scroll to the element named by the URL hash once, on mount, and return
 * the hash id so a page can also open that item expanded.
 *
 * Wouter routes on the path and ignores the hash, so a link like
 * /admin/resources/faq#patient-said-stop lands at the top of the page
 * unless something scrolls for it. `scrollIntoView` is guarded because
 * it is absent in jsdom and in a few embedded browsers — a missing
 * scroll should leave the reader at the top of a working page, not throw
 * out of an effect during mount.
 */
export function useHashTarget(): string | null {
  const [target] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.location.hash.slice(1) || null,
  );

  useEffect(() => {
    if (!target) return;
    const el = document.getElementById(target);
    if (el && typeof el.scrollIntoView === "function") {
      el.scrollIntoView({ block: "start" });
    }
  }, [target]);

  return target;
}

// ---------------------------------------------------------------------
// Text with live console links
// ---------------------------------------------------------------------

/**
 * Render help copy, turning every bare `/admin/...` path into a link to
 * that page. This is what lets an article say "open Verify insurance
 * /admin/billing/verify" and have the reader arrive there in one click.
 */
export function HelpText({
  children,
}: {
  children: string;
}): React.JSX.Element {
  const segments = splitAdminPaths(children);
  return (
    <>
      {segments.map((seg, i) =>
        seg.type === "link" ? (
          <Link
            key={i}
            href={seg.value}
            className="font-medium underline underline-offset-2 hover:opacity-80"
            style={{ color: "hsl(var(--penn-navy))" }}
            data-testid="help-console-link"
          >
            {seg.value}
          </Link>
        ) : (
          <span key={i}>{seg.value}</span>
        ),
      )}
    </>
  );
}

/** A paragraph of help copy with console links live. */
export function HelpParagraph({
  children,
  className = "",
}: {
  children: string;
  className?: string;
}): React.JSX.Element {
  return (
    <p
      className={`text-sm leading-relaxed ${className}`}
      style={{ color: "hsl(var(--ink-2))" }}
    >
      <HelpText>{children}</HelpText>
    </p>
  );
}

// ---------------------------------------------------------------------
// Callouts
// ---------------------------------------------------------------------

const CALLOUT_STYLE: Record<
  HelpCallout["tone"],
  { bg: string; border: string; fg: string; label: string; Icon: typeof Info }
> = {
  tip: {
    bg: "hsl(152 60% 38% / 0.08)",
    border: "hsl(152 60% 38% / 0.28)",
    fg: "hsl(152 70% 22%)",
    label: "Tip",
    Icon: Lightbulb,
  },
  note: {
    bg: "hsl(213 80% 50% / 0.07)",
    border: "hsl(213 80% 50% / 0.26)",
    fg: "hsl(213 80% 28%)",
    label: "Note",
    Icon: Info,
  },
  warning: {
    bg: "hsl(38 95% 48% / 0.11)",
    border: "hsl(38 95% 48% / 0.38)",
    fg: "hsl(38 80% 26%)",
    label: "Important",
    Icon: AlertTriangle,
  },
};

export function Callout({
  tone,
  children,
}: {
  tone: HelpCallout["tone"];
  children: string;
}): React.JSX.Element {
  const s = CALLOUT_STYLE[tone];
  return (
    <div
      className="flex gap-2.5 rounded-lg border px-3.5 py-3"
      style={{ backgroundColor: s.bg, borderColor: s.border }}
      data-testid={`help-callout-${tone}`}
    >
      <s.Icon
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: s.fg }}
        aria-hidden
      />
      <p
        className="text-sm leading-relaxed"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        <span className="font-semibold" style={{ color: s.fg }}>
          {s.label}:{" "}
        </span>
        <HelpText>{children}</HelpText>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------

export function StepList({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  return <ol className="space-y-5">{children}</ol>;
}

export function Step({
  index,
  title,
  children,
}: {
  index: number;
  title: string;
  children: ReactNode;
}): React.JSX.Element {
  return (
    <li className="flex gap-3.5" data-testid={`help-step-${index}`}>
      <span
        className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold"
        style={{
          backgroundColor: "hsl(var(--penn-navy) / 0.09)",
          color: "hsl(var(--penn-navy-deep))",
        }}
        aria-hidden
      >
        {index}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <h3
          className="text-sm font-semibold leading-snug"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {title}
        </h3>
        {children}
      </div>
    </li>
  );
}

/** The bulleted detail under a step. */
export function SubSteps({
  items,
}: {
  items: readonly string[];
}): React.JSX.Element {
  return (
    <ul className="space-y-1.5 pl-4">
      {items.map((item) => (
        <li
          key={item}
          className="relative text-sm leading-relaxed"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          <span
            className="absolute -left-3.5 top-2 h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: "hsl(var(--penn-navy) / 0.35)" }}
            aria-hidden
          />
          <HelpText>{item}</HelpText>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------

/** Section heading inside an article or guide chapter. */
export function HelpSectionHeading({
  id,
  children,
  eyebrow,
}: {
  id?: string;
  children: ReactNode;
  eyebrow?: string;
}): React.JSX.Element {
  return (
    <div className="space-y-1" id={id}>
      {eyebrow ? (
        <p
          className="text-[11px] font-semibold uppercase tracking-wide"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {eyebrow}
        </p>
      ) : null}
      <h2
        className="text-lg font-bold tracking-tight"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {children}
      </h2>
    </div>
  );
}

/** Breadcrumb back to the Help Center hub. */
export function HelpBreadcrumb({
  trail,
}: {
  trail: readonly { label: string; href?: string }[];
}): React.JSX.Element {
  return (
    <nav aria-label="Breadcrumb" className="text-xs">
      <ol className="flex flex-wrap items-center gap-1.5">
        <li>
          <Link
            href="/admin/resources"
            className="underline underline-offset-2 hover:opacity-80"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Help &amp; Resources
          </Link>
        </li>
        {trail.map((crumb) => (
          <li key={crumb.label} className="flex items-center gap-1.5">
            <span style={{ color: "hsl(var(--ink-3))" }} aria-hidden>
              /
            </span>
            {crumb.href ? (
              <Link
                href={crumb.href}
                className="underline underline-offset-2 hover:opacity-80"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {crumb.label}
              </Link>
            ) : (
              <span style={{ color: "hsl(var(--ink-1))" }}>{crumb.label}</span>
            )}
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The "what you'll need" list above an article's steps. */
export function Prerequisites({
  items,
}: {
  items: readonly string[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <div
      className="rounded-lg border px-4 py-3"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor: "hsl(var(--surface-2))",
      }}
      data-testid="help-prerequisites"
    >
      <p
        className="mb-1.5 text-xs font-semibold uppercase tracking-wide"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        Before you start
      </p>
      <ul className="space-y-1">
        {items.map((item) => (
          <li
            key={item}
            className="text-sm leading-relaxed"
            style={{ color: "hsl(var(--ink-2))" }}
          >
            <HelpText>{item}</HelpText>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A page-reference table used by the user guide. */
export function PageTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly { path: string; label: string; what: string }[];
}): React.JSX.Element {
  return (
    <div className="space-y-2">
      <p
        className="text-xs font-semibold uppercase tracking-wide"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {title}
      </p>
      <div
        className="overflow-x-auto rounded-lg border"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <table className="w-full min-w-[34rem] border-collapse text-sm">
          <tbody>
            {rows.map((row) => (
              <tr
                key={row.path}
                className="border-b last:border-b-0"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <th
                  scope="row"
                  className="w-56 whitespace-nowrap px-3.5 py-2.5 text-left align-top font-semibold"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  <Link
                    href={row.path}
                    className="underline underline-offset-2 hover:opacity-80"
                    style={{ color: "hsl(var(--penn-navy))" }}
                  >
                    {row.label}
                  </Link>
                  <span
                    className="mt-0.5 block font-mono text-[11px] font-normal"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {row.path}
                  </span>
                </th>
                <td
                  className="px-3.5 py-2.5 align-top"
                  style={{ color: "hsl(var(--ink-2))" }}
                >
                  {row.what}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Collapsible question — used by the FAQ and article troubleshooting. */
export function Disclosure({
  id,
  question,
  defaultOpen = false,
  children,
}: {
  id?: string;
  question: string;
  defaultOpen?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  const generatedId = useId();
  const panelId = `${id ?? generatedId}-panel`;
  return (
    <div
      className="border-b last:border-b-0"
      style={{ borderColor: "hsl(var(--line-1))" }}
      id={id}
    >
      <h3>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex w-full items-start justify-between gap-3 py-3.5 text-left"
        >
          <span
            className="text-sm font-semibold leading-snug"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {question}
          </span>
          <ChevronDown
            className={`mt-0.5 h-4 w-4 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
            style={{ color: "hsl(var(--ink-3))" }}
            aria-hidden
          />
        </button>
      </h3>
      <div id={panelId} hidden={!open} className="space-y-2.5 pb-4">
        {children}
      </div>
    </div>
  );
}

/** Link out to a related article. */
export function RelatedLink({
  href,
  title,
  blurb,
}: {
  href: string;
  title: string;
  blurb?: string;
}): React.JSX.Element {
  return (
    <Link
      href={href}
      className="group flex items-start gap-2.5 rounded-lg border px-3.5 py-3 transition-colors"
      style={{
        borderColor: "hsl(var(--line-1))",
        backgroundColor: "hsl(var(--surface-1))",
      }}
    >
      <ExternalLink
        className="mt-0.5 h-4 w-4 shrink-0"
        style={{ color: "hsl(var(--ink-3))" }}
        aria-hidden
      />
      <span className="min-w-0">
        <span
          className="block text-sm font-semibold group-hover:underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {title}
        </span>
        {blurb ? (
          <span
            className="mt-0.5 block text-xs leading-relaxed"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {blurb}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

/** Small metadata chip row under an article title. */
export function MetaChips({
  items,
}: {
  items: readonly { label: string; value: string }[];
}): React.JSX.Element {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1.5">
      {items.map((item) => (
        <div key={item.label} className="flex items-baseline gap-1.5">
          <dt
            className="text-[11px] font-semibold uppercase tracking-wide"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {item.label}
          </dt>
          <dd className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
