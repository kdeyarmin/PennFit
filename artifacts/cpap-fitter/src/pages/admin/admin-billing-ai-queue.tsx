// /admin/billing/ai-queue — AI-driven billing work queue.
//
// Four tabs (rendered as four card sections to keep deep-linking
// simple): scrubber-blocked drafts, scrubber-fixable drafts, denials
// awaiting AI analysis, and auto-resubmit-ready claims. Each row
// deep-links to the per-patient claim drawer at
// /admin/patients/:patientId/insurance-claims where the existing
// workbench takes over (apply patch, mark resubmit, etc.).
//
// Pure list view — pulls one round-trip from /admin/billing/ai-queue,
// no PHI in the response. Confidence values render with two decimals
// so a 0.83 reads as "83%" without surprise rounding.

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { AlertTriangle, Bot, ClipboardList, Sparkles } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchAiQueue,
  formatMoneyCents,
  formatPercent,
  type AutoResubmitReadyItem,
  type ClaimQueueItem,
} from "@/lib/admin/billing-api";

export function AdminBillingAiQueuePage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-billing-ai-queue"],
    queryFn: fetchAiQueue,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="space-y-6 max-w-5xl" data-testid="admin-billing-ai-queue">
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          AI billing queue
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Scrubber and denial-analyzer output. Each row links to the
          patient's claim workbench where you can apply the patch or
          resubmit.
        </p>
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}

      {isPending ? (
        <Spinner label="Loading queue…" />
      ) : (
        <>
          <ClaimSection
            title="Scrubber blocked"
            subtitle="Drafts the scrubber refused — need a human edit before submit"
            icon={<AlertTriangle className="h-4 w-4" />}
            items={data?.scrubBlockingClaims ?? []}
            countLabel="claim(s) blocked"
            emptyLabel="Nothing blocked right now. Nice."
          />
          <ClaimSection
            title="Scrubber fixable"
            subtitle="AI suggested a patch — review and apply"
            icon={<Sparkles className="h-4 w-4" />}
            items={data?.scrubFixableClaims ?? []}
            countLabel="claim(s) with proposed patches"
            emptyLabel="No outstanding fixable scrubs."
          />
          <ClaimSection
            title="Denials awaiting analysis"
            subtitle="No AI analysis yet — kick off the denial analyzer"
            icon={<ClipboardList className="h-4 w-4" />}
            items={data?.deniedNeedsAnalysis ?? []}
            countLabel="denied claim(s) without analysis"
            emptyLabel="No fresh denials waiting."
          />
          <AutoResubmitSection items={data?.autoResubmitReady ?? []} />
        </>
      )}
    </div>
  );
}

function ClaimSection({
  title,
  subtitle,
  icon,
  items,
  countLabel,
  emptyLabel,
}: {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  items: ClaimQueueItem[];
  countLabel: string;
  emptyLabel: string;
}) {
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <span style={{ color: "hsl(var(--penn-navy))" }}>{icon}</span>
          {title}
        </span>
      }
      subtitle={subtitle}
      action={
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {items.length} {countLabel}
        </span>
      }
    >
      {items.length === 0 ? (
        <p
          className="text-sm py-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {emptyLabel}
        </p>
      ) : (
        <ul
          className="divide-y -mt-1 -mb-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <Link
                  href={`/admin/patients/${c.patientId}/insurance-claims`}
                  className="font-medium underline truncate block"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {c.payerName || "Unknown payer"}
                </Link>
                <p
                  className="text-[11px] truncate"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {c.denialReason
                    ? `Denial: ${c.denialReason}`
                    : c.latestScrubAt
                      ? `Last scrub: ${new Date(c.latestScrubAt).toLocaleString()}`
                      : c.decisionAt
                        ? `Decision: ${new Date(c.decisionAt).toLocaleString()}`
                        : `Claim ${c.id.slice(0, 8)}`}
                </p>
              </div>
              <span
                className="text-sm tabular-nums font-semibold shrink-0"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {formatMoneyCents(c.totalBilledCents)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AutoResubmitSection({ items }: { items: AutoResubmitReadyItem[] }) {
  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <span style={{ color: "hsl(var(--penn-gold-deep))" }}>
            <Bot className="h-4 w-4" />
          </span>
          Auto-resubmit ready
        </span>
      }
      subtitle="Denial analyses confident enough to re-file with one click"
      action={
        <span
          className="text-[11px] tabular-nums"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {items.length} ready
        </span>
      }
    >
      {items.length === 0 ? (
        <p
          className="text-sm py-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          No claims queued for auto-resubmit.
        </p>
      ) : (
        <ul
          className="divide-y -mt-1 -mb-1"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          {items.map((a) => (
            <li key={a.analysisId} className="py-2.5 text-sm space-y-1">
              <div className="flex items-center justify-between gap-3">
                <Link
                  href={`/admin/billing/claims/${a.claimId}`}
                  className="font-medium underline"
                  style={{ color: "hsl(var(--ink-1))" }}
                >
                  {a.recommendation}
                </Link>
                <span
                  className="text-[11px] tabular-nums shrink-0 px-2 py-0.5 rounded-full"
                  style={{
                    backgroundColor: "rgba(201, 162, 74, 0.16)",
                    color: "hsl(var(--penn-gold-deep))",
                  }}
                >
                  conf {formatPercent(a.confidence ?? null, 0)}
                </span>
              </div>
              {a.rootCauseSummary && (
                <p
                  className="text-[12px] leading-snug"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {a.rootCauseSummary}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
