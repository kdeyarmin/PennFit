// /admin/resources/user-guide — the complete user guide.
//
// One long page rather than a chaptered reader: staff search it with
// the browser's own find, print it for training, and deep-link to a
// chapter by anchor (/admin/resources/user-guide#billing-worklists).
// A sticky table of contents carries the navigation.

import { BookOpenCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  Callout,
  HelpBreadcrumb,
  HelpParagraph,
  HelpText,
  PageTable,
  useHashTarget,
} from "@/components/admin/help/HelpKit";
import { GUIDE_SECTIONS, categoryLabel } from "@/content/admin-help";

export function AdminResourceUserGuidePage() {
  // Wouter keeps the hash out of its routing, so an anchor deep link
  // needs an explicit scroll once the (lazy-loaded) page has mounted.
  useHashTarget();

  return (
    <div className="admin-root space-y-6" data-testid="admin-help-user-guide">
      <HelpBreadcrumb trail={[{ label: "Complete user guide" }]} />

      <PageHeader
        title="Complete user guide"
        description="What every part of the console is for and how the pieces fit together. Written to be read end to end once, then searched."
        icon={BookOpenCheck}
        descriptionClassName="max-w-3xl"
      />

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <nav
          aria-label="Guide contents"
          className="lg:sticky lg:top-4 lg:self-start"
        >
          <Card title="Contents">
            <ol className="space-y-1.5">
              {GUIDE_SECTIONS.map((s, i) => (
                <li key={s.id} className="flex gap-2">
                  <span
                    className="w-4 shrink-0 text-right text-xs tabular-nums"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {i + 1}
                  </span>
                  <a
                    href={`#${s.id}`}
                    className="text-sm hover:underline"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
            </ol>
          </Card>
        </nav>

        <div className="min-w-0 space-y-6">
          {GUIDE_SECTIONS.map((section, i) => (
            <section
              key={section.id}
              id={section.id}
              className="scroll-mt-6"
              data-testid={`guide-section-${section.id}`}
            >
              <Card
                title={
                  <span>
                    <span
                      className="mr-2 tabular-nums"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {i + 1}.
                    </span>
                    {section.title}
                  </span>
                }
                subtitle={categoryLabel(section.category)}
              >
                <div className="space-y-4">
                  <HelpParagraph className="font-medium">
                    {section.intro}
                  </HelpParagraph>

                  {section.blocks.map((block, bi) => {
                    if (block.kind === "para") {
                      return (
                        <HelpParagraph key={bi}>{block.text}</HelpParagraph>
                      );
                    }
                    if (block.kind === "callout") {
                      return (
                        <Callout key={bi} tone={block.tone}>
                          {block.text}
                        </Callout>
                      );
                    }
                    if (block.kind === "bullets") {
                      return (
                        <ul key={bi} className="space-y-1.5 pl-4">
                          {block.items.map((item) => (
                            <li
                              key={item}
                              className="relative text-sm leading-relaxed"
                              style={{ color: "hsl(var(--ink-2))" }}
                            >
                              <span
                                className="absolute -left-3.5 top-2 h-1.5 w-1.5 rounded-full"
                                style={{
                                  backgroundColor:
                                    "hsl(var(--penn-navy) / 0.35)",
                                }}
                                aria-hidden
                              />
                              <HelpText>{item}</HelpText>
                            </li>
                          ))}
                        </ul>
                      );
                    }
                    return (
                      <PageTable
                        key={bi}
                        title={block.title}
                        rows={block.rows}
                      />
                    );
                  })}
                </div>
              </Card>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
