// /admin/resources — the staff Help Center hub.
//
// Three kinds of content, one search box: task-oriented how-to guides,
// a complete user guide describing every area of the console, and an
// FAQ. The content itself lives in src/content/admin-help as data; this
// page is the browse-and-search surface over it, plus the downloadable
// PDF setup guides that predate it.
//
// The hub is intentionally not permission-gated: it explains the app
// rather than exposing any of its data, and a CSR who cannot open a
// billing page still benefits from understanding what it is for.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  BookOpen,
  BookOpenCheck,
  FileText,
  LifeBuoy,
  MessageCircleQuestion,
  Search,
  Sparkles,
} from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { PageHeader } from "@/components/admin/PageHeader";
import { HelpText } from "@/components/admin/help/HelpKit";
import {
  FAQ_ENTRIES,
  GUIDE_SECTIONS,
  HELP_CATEGORIES,
  HOW_TO_GUIDES,
  faqHref,
  featuredHowTos,
  guideHref,
  howToHref,
  howTosInCategory,
  searchHelp,
  type SearchKind,
} from "@/content/admin-help";
import { useCompanyContact } from "@/lib/contact";

interface DownloadableGuide {
  title: string;
  description: string;
  href: string;
}

// Printable setup guides served from the SPA's public/guides/ directory.
const DOWNLOADS: DownloadableGuide[] = [
  {
    title: "Set up Slack",
    description:
      "Connect your Slack workspace for real-time CS alerts and in-Slack actions (Claim / Escalate / Snooze). One-click setup or full manual steps, with troubleshooting.",
    href: "/guides/setup-slack.pdf",
  },
];

const KIND_LABEL: Record<SearchKind, string> = {
  "how-to": "How-to",
  guide: "User guide",
  faq: "FAQ",
};

const KIND_VARIANT: Record<SearchKind, "neutral" | "info" | "muted"> = {
  "how-to": "neutral",
  guide: "info",
  faq: "muted",
};

export function AdminResourcesPage() {
  const [query, setQuery] = useState("");
  const assistantName = useCompanyContact().assistantAdminName;
  const results = useMemo(() => searchHelp(query), [query]);
  const searching = query.trim().length > 0;

  return (
    <div className="admin-root space-y-6" data-testid="admin-resources-page">
      <PageHeader
        title="Help Center"
        description="How-to guides for everyday tasks, a complete user guide to every part of the console, and answers to the questions staff ask most."
        icon={BookOpen}
        descriptionClassName="max-w-3xl"
      />

      {/* ---------------------------------------------------------- */}
      {/* Search                                                      */}
      {/* ---------------------------------------------------------- */}
      <div className="relative max-w-2xl">
        <Search
          className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2"
          style={{ color: "hsl(var(--ink-3))" }}
          aria-hidden
        />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help — try “denial”, “fitting invite”, or “who can see this page”"
          aria-label="Search the Help Center"
          data-testid="admin-help-search"
          className="block w-full rounded-lg border bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-2"
          style={{
            borderColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-1))",
          }}
        />
      </div>

      {searching ? (
        <Card
          title={`${results.length} result${results.length === 1 ? "" : "s"} for “${query.trim()}”`}
        >
          {results.length === 0 ? (
            <EmptyState
              title="Nothing matched that search."
              hint={`Try a single word, or ask ${assistantName} — the assistant widget answers in your own words.`}
            />
          ) : (
            <ul
              className="divide-y"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {results.map((r) => (
                <li
                  key={`${r.kind}:${r.id}`}
                  className="py-3 first:pt-0 last:pb-0"
                >
                  <Link href={r.href} className="group block">
                    <span className="flex flex-wrap items-center gap-2">
                      <span
                        className="text-sm font-semibold group-hover:underline"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {r.title}
                      </span>
                      <Badge variant={KIND_VARIANT[r.kind]}>
                        {KIND_LABEL[r.kind]}
                      </Badge>
                    </span>
                    <span
                      className="mt-1 block text-xs leading-relaxed"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {r.excerpt}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : (
        <>
          {/* ------------------------------------------------------ */}
          {/* The three entry points                                  */}
          {/* ------------------------------------------------------ */}
          <div className="grid gap-4 sm:grid-cols-3">
            <EntryCard
              href="/admin/resources/user-guide"
              icon={BookOpenCheck}
              title="Complete user guide"
              blurb={`Every area of the console, what it is for, and how the pieces fit together — ${GUIDE_SECTIONS.length} chapters.`}
            />
            <EntryCard
              href="/admin/resources/faq"
              icon={MessageCircleQuestion}
              title="FAQ"
              blurb={`${FAQ_ENTRIES.length} short answers to the questions staff ask most in their first months.`}
            />
            <EntryCard
              href="/admin/support"
              icon={LifeBuoy}
              title="Support"
              blurb="File a request when you need a person. The intake assistant answers what it can immediately."
            />
          </div>

          {/* ------------------------------------------------------ */}
          {/* Featured how-tos                                        */}
          {/* ------------------------------------------------------ */}
          <Card
            title="Start here"
            subtitle="The tasks new staff need first, and the ones everyone does weekly."
          >
            <ul className="grid gap-3 sm:grid-cols-2">
              {featuredHowTos().map((g) => (
                <li key={g.slug}>
                  <Link
                    href={howToHref(g.slug)}
                    className="group flex h-full items-start gap-3 rounded-lg border px-3.5 py-3 transition-colors"
                    style={{
                      borderColor: "hsl(var(--line-1))",
                      backgroundColor: "hsl(var(--surface-1))",
                    }}
                  >
                    <Sparkles
                      className="mt-0.5 h-4 w-4 shrink-0"
                      style={{ color: "hsl(var(--penn-gold-deep))" }}
                      aria-hidden
                    />
                    <span className="min-w-0">
                      <span
                        className="block text-sm font-semibold group-hover:underline"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {g.title}
                      </span>
                      <span
                        className="mt-1 block text-xs leading-relaxed"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {g.summary}
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {/* ------------------------------------------------------ */}
          {/* Browse every how-to, by category                        */}
          {/* ------------------------------------------------------ */}
          <Card
            title={`All how-to guides (${HOW_TO_GUIDES.length})`}
            subtitle="Step-by-step, with the exact page each step happens on."
          >
            <div className="space-y-6">
              {HELP_CATEGORIES.map((cat) => {
                const guides = howTosInCategory(cat.id);
                if (guides.length === 0) return null;
                return (
                  <section key={cat.id} data-testid={`help-category-${cat.id}`}>
                    <h3
                      className="text-sm font-semibold"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {cat.label}
                    </h3>
                    <p
                      className="mt-0.5 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {cat.blurb}
                    </p>
                    <ul className="mt-2.5 space-y-1.5">
                      {guides.map((g) => (
                        <li key={g.slug} className="flex items-baseline gap-2">
                          <span
                            className="h-1.5 w-1.5 shrink-0 translate-y-[-1px] rounded-full"
                            style={{
                              backgroundColor: "hsl(var(--penn-navy) / 0.3)",
                            }}
                            aria-hidden
                          />
                          <Link
                            href={howToHref(g.slug)}
                            className="text-sm hover:underline"
                            style={{ color: "hsl(var(--ink-2))" }}
                          >
                            {g.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
          </Card>

          {/* ------------------------------------------------------ */}
          {/* Popular questions                                       */}
          {/* ------------------------------------------------------ */}
          <Card
            title="Common questions"
            subtitle="A sample — the full list is in the FAQ."
            action={
              <Link
                href="/admin/resources/faq"
                className="text-xs font-semibold underline underline-offset-2"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                All {FAQ_ENTRIES.length} questions
              </Link>
            }
          >
            <ul className="space-y-2">
              {FAQ_ENTRIES.slice(0, 6).map((f) => (
                <li key={f.id}>
                  <Link
                    href={faqHref(f.id)}
                    className="text-sm hover:underline"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {f.question}
                  </Link>
                </li>
              ))}
            </ul>
          </Card>

          {/* ------------------------------------------------------ */}
          {/* Guide chapters + downloads                              */}
          {/* ------------------------------------------------------ */}
          <div className="grid gap-4 lg:grid-cols-2">
            <Card
              title="User guide chapters"
              subtitle="Read it end to end, or jump to the area you work in."
            >
              <ul className="space-y-1.5">
                {GUIDE_SECTIONS.map((s) => (
                  <li key={s.id}>
                    <Link
                      href={guideHref(s.id)}
                      className="text-sm font-medium hover:underline"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {s.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>

            <Card
              title="Downloadable setup guides"
              subtitle="Printable PDFs for setup tasks that involve a third-party service."
            >
              <ul
                className="divide-y"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                {DOWNLOADS.map((g) => (
                  <li
                    key={g.href}
                    className="flex items-start gap-3 py-3 first:pt-0"
                  >
                    <FileText
                      className="mt-0.5 h-5 w-5 shrink-0"
                      style={{ color: "hsl(var(--ink-3))" }}
                      aria-hidden
                    />
                    <div className="min-w-0 flex-1">
                      <a
                        href={g.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-semibold underline"
                        style={{ color: "hsl(var(--ink-1))" }}
                      >
                        {g.title} (PDF)
                      </a>
                      <p
                        className="mt-0.5 text-xs leading-relaxed"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {g.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </div>

          {/* ------------------------------------------------------ */}
          {/* Still stuck                                             */}
          {/* ------------------------------------------------------ */}
          <Card title="Still stuck?">
            <p
              className="text-sm leading-relaxed"
              style={{ color: "hsl(var(--ink-2))" }}
            >
              <HelpText>
                {`Ask ${assistantName} — the assistant widget on every page answers in your own words and links straight to the right screen. When you need a person, file a request at Support /admin/support. Please keep patient identifiers out of both.`}
              </HelpText>
            </p>
          </Card>
        </>
      )}
    </div>
  );
}

function EntryCard({
  href,
  icon: Icon,
  title,
  blurb,
}: {
  href: string;
  icon: typeof BookOpen;
  title: string;
  blurb: string;
}) {
  return (
    <Link
      href={href}
      className="surface-card lift-on-hover group flex h-full flex-col gap-2 p-5"
    >
      <Icon
        className="h-5 w-5"
        style={{ color: "hsl(var(--penn-navy))" }}
        aria-hidden
      />
      <span
        className="text-sm font-semibold group-hover:underline"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {title}
      </span>
      <span
        className="text-xs leading-relaxed"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {blurb}
      </span>
    </Link>
  );
}
