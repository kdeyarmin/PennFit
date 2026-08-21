// /admin/resources/faq — frequently asked questions.
//
// Grouped by the same categories as the rest of the Help Center, with a
// filter box over the top. Each question is a disclosure so the page
// scans as a list of questions; a deep link (#patient-said-stop) opens
// that one expanded.

import { useMemo, useState } from "react";
import { Link } from "wouter";
import { MessageCircleQuestion, Search } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  Disclosure,
  HelpBreadcrumb,
  HelpParagraph,
  useHashTarget,
} from "@/components/admin/help/HelpKit";
import {
  FAQ_ENTRIES,
  HELP_CATEGORIES,
  getHowTo,
  howToHref,
  type FaqEntry,
} from "@/content/admin-help";

function matches(entry: FaqEntry, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const haystack =
    `${entry.question} ${entry.answer.join(" ")} ${(entry.keywords ?? []).join(" ")}`.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

export function AdminResourceFaqPage() {
  const [query, setQuery] = useState("");
  // A deep link (…/faq#patient-said-stop) scrolls to that question and
  // opens it, rather than dropping the reader on a wall of collapsed rows.
  const openId = useHashTarget();

  const terms = useMemo(
    () => query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    [query],
  );
  const visible = useMemo(
    () => FAQ_ENTRIES.filter((e) => matches(e, terms)),
    [terms],
  );

  return (
    <div className="admin-root space-y-6" data-testid="admin-help-faq">
      <HelpBreadcrumb trail={[{ label: "FAQ" }]} />

      <PageHeader
        title="Frequently asked questions"
        description="Short answers to what staff ask most. Each one links to the full guide when there is more to it."
        icon={MessageCircleQuestion}
        descriptionClassName="max-w-3xl"
      />

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
          placeholder="Filter questions"
          aria-label="Filter questions"
          data-testid="admin-faq-filter"
          className="block w-full rounded-lg border bg-white py-2.5 pl-9 pr-3 text-sm outline-none focus:ring-2"
          style={{
            borderColor: "hsl(var(--line-2))",
            color: "hsl(var(--ink-1))",
          }}
        />
      </div>

      {visible.length === 0 ? (
        <Card title="No matches">
          <EmptyState
            title="No question matched that filter."
            hint="Try a single word, or browse the how-to guides at /admin/resources."
          />
        </Card>
      ) : (
        <div className="max-w-3xl space-y-6">
          {HELP_CATEGORIES.map((cat) => {
            const entries = visible.filter((e) => e.category === cat.id);
            if (entries.length === 0) return null;
            return (
              <Card key={cat.id} title={cat.label} subtitle={cat.blurb}>
                <div className="-my-1">
                  {entries.map((entry) => {
                    const seeAlso = entry.seeAlso
                      ? getHowTo(entry.seeAlso)
                      : undefined;
                    return (
                      <Disclosure
                        key={entry.id}
                        id={entry.id}
                        question={entry.question}
                        defaultOpen={openId === entry.id}
                      >
                        {entry.answer.map((para) => (
                          <HelpParagraph key={para}>{para}</HelpParagraph>
                        ))}
                        {seeAlso ? (
                          <p className="text-xs">
                            <Link
                              href={howToHref(seeAlso.slug)}
                              className="font-semibold underline underline-offset-2"
                              style={{ color: "hsl(var(--penn-navy))" }}
                            >
                              Full guide: {seeAlso.title}
                            </Link>
                          </p>
                        ) : null}
                      </Disclosure>
                    );
                  })}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
