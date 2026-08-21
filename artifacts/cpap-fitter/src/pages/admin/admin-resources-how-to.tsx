// /admin/resources/how-to/:slug — one step-by-step guide.
//
// A thin renderer over a HowToGuide from src/content/admin-help. Every
// article gets the same shape on purpose: the answer up front, what you
// need before you start, numbered steps whose page references are live
// links, a troubleshooting table, and where to go next.

import { useRoute } from "wouter";

import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { PageHeader } from "@/components/admin/PageHeader";
import {
  Callout,
  HelpBreadcrumb,
  HelpParagraph,
  HelpSectionHeading,
  HelpText,
  MetaChips,
  Prerequisites,
  RelatedLink,
  Step,
  StepList,
  SubSteps,
} from "@/components/admin/help/HelpKit";
import { categoryLabel, getHowTo, howToHref } from "@/content/admin-help";
import { useCompanyContact } from "@/lib/contact";

export function AdminResourceHowToPage() {
  const [, params] = useRoute<{ slug: string }>(
    "/admin/resources/how-to/:slug",
  );
  const slug = params?.slug ?? "";
  const guide = getHowTo(slug);
  const assistantName = useCompanyContact().assistantAdminName;

  if (!guide) {
    return (
      <div className="admin-root space-y-6">
        <HelpBreadcrumb trail={[{ label: "Not found" }]} />
        <Card title="That guide doesn't exist">
          <EmptyState
            title="We couldn't find that help article."
            hint="It may have been renamed. Browse or search the Help Center at /admin/resources."
          />
        </Card>
      </div>
    );
  }

  const related = (guide.related ?? [])
    .map((s) => getHowTo(s))
    .filter((g): g is NonNullable<typeof g> => Boolean(g));

  return (
    <div
      className="admin-root space-y-6"
      data-testid={`admin-help-article-${guide.slug}`}
    >
      <HelpBreadcrumb
        trail={[
          { label: categoryLabel(guide.category) },
          { label: guide.title },
        ]}
      />

      <div className="max-w-3xl space-y-4">
        <PageHeader title={guide.title} />
        <MetaChips
          items={[
            { label: "For", value: guide.audience },
            { label: "Time", value: guide.timeEstimate },
            { label: "Main page", value: guide.primaryPath },
          ]}
        />
      </div>

      <div className="max-w-3xl space-y-6">
        <Card title="The short answer">
          <HelpParagraph>{guide.summary}</HelpParagraph>
        </Card>

        <Prerequisites items={guide.prerequisites} />

        <Card title="Steps">
          <StepList>
            {guide.steps.map((step, i) => (
              <Step key={step.title} index={i + 1} title={step.title}>
                <HelpParagraph>{step.body}</HelpParagraph>
                {step.substeps ? <SubSteps items={step.substeps} /> : null}
                {step.callout ? (
                  <Callout tone={step.callout.tone}>
                    {step.callout.text}
                  </Callout>
                ) : null}
              </Step>
            ))}
          </StepList>
        </Card>

        {guide.troubleshooting && guide.troubleshooting.length > 0 ? (
          <Card title="If something goes wrong">
            <dl className="space-y-4">
              {guide.troubleshooting.map((t) => (
                <div key={t.symptom} className="space-y-1">
                  <dt
                    className="text-sm font-semibold"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {t.symptom}
                  </dt>
                  <dd
                    className="text-sm leading-relaxed"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    <HelpText>{t.fix}</HelpText>
                  </dd>
                </div>
              ))}
            </dl>
          </Card>
        ) : null}

        {related.length > 0 ? (
          <section className="space-y-3">
            <HelpSectionHeading eyebrow="Keep going">
              Related guides
            </HelpSectionHeading>
            <div className="grid gap-3 sm:grid-cols-2">
              {related.map((r) => (
                <RelatedLink
                  key={r.slug}
                  href={howToHref(r.slug)}
                  title={r.title}
                  blurb={r.summary}
                />
              ))}
            </div>
          </section>
        ) : null}

        <Card title="Didn't answer your question?">
          <HelpParagraph>
            {`Ask ${assistantName} using the assistant widget on this page, or file a request at Support /admin/support. Keep patient identifiers out of both.`}
          </HelpParagraph>
        </Card>
      </div>
    </div>
  );
}
