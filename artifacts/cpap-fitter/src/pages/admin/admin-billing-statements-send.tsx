// /admin/billing/statements — patient-responsibility statement send
// worklist (Biller #30).
//
// Rendered statements with a positive balance awaiting send, ranked
// oldest-first. "Send all pending" fires the capped batch; each row has
// its own "Send". Delivery is consent/DND-gated server-side — a row that
// can't be reached comes back 'skipped' (visible in the last-run line).
//
// reports.read to view; send needs admin.tools.manage (enforced
// server-side). Amounts + ids only — no patient names.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Mail, Printer } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  getMailQueueStatements,
  getPendingStatements,
  mailQueuePrintUrl,
  markStatementsMailed,
  sendStatement,
  sendStatementBatch,
  type MailQueueStatement,
  type PendingStatement,
  type StatementBatchSummary,
} from "@/lib/admin/statement-send-api";

const QUERY_KEY = ["admin", "pending-statements"] as const;
const MAIL_QUEUE_KEY = ["admin", "mail-queue-statements"] as const;

function money(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

export function AdminBillingStatementsSendPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: getPendingStatements,
    staleTime: 30_000,
  });

  const batch = useMutation({
    mutationFn: () => sendStatementBatch(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-statements-send-page"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Mail className="h-6 w-6" />
            Statement send
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Rendered patient-responsibility statements awaiting send. Delivery
            honors each patient&apos;s communication preferences and quiet hours
            — unreachable statements come back marked skipped.
          </p>
        </div>
        {query.data && query.data.count > 0 && (
          <Button isLoading={batch.isPending} onClick={() => batch.mutate()}>
            Send all pending
          </Button>
        )}
      </header>

      {batch.data && <BatchSummaryLine summary={batch.data.summary} />}
      {batch.error instanceof Error && (
        <div className="text-xs" style={{ color: "#b91c1c" }} role="alert">
          Couldn&apos;t run the batch — you may not have permission, or the
          messaging provider is unreachable.
        </div>
      )}

      {query.isPending ? (
        <Spinner label="Loading pending statements…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <Card>
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No statements are waiting to be sent. 🎉
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Pending statements" value={query.data.count} />
            <KpiCard
              label="Total outstanding"
              value={money(query.data.totalCents)}
              tone="gold"
            />
          </div>
          <Card title={`Pending (${query.data.count})`}>
            <div className="space-y-2">
              {query.data.pending.map((s) => (
                <StatementRow key={s.statementId} item={s} />
              ))}
            </div>
          </Card>
        </>
      )}

      <MailQueueSection />
    </div>
  );
}

function MailQueueSection() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: MAIL_QUEUE_KEY,
    queryFn: getMailQueueStatements,
    staleTime: 30_000,
  });

  // Mark ONLY the statements that the print batch actually rendered (the
  // oldest `printCap`). Marking the full queue here would record bills as
  // mailed that were never in the printed PDF when the backlog exceeds the
  // cap — they'd leave the queue unmailed.
  const printCap = query.data?.printCap ?? 0;
  const printBatchIds = (query.data?.queued ?? [])
    .slice(0, printCap || undefined)
    .map((s) => s.statementId);
  const markAll = useMutation({
    mutationFn: () => markStatementsMailed(printBatchIds),
    onSuccess: () => void qc.invalidateQueries({ queryKey: MAIL_QUEUE_KEY }),
  });

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Printer className="h-4 w-4" />
          Mail queue
        </span>
      }
      subtitle="Patients who chose mailed bills. Download the print batch, mail the statements, then mark them sent. These are never emailed."
    >
      {query.isPending ? (
        <Spinner label="Loading mail queue…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : query.data.count === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Nothing waiting to be mailed.
        </p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
              <strong>{query.data.count}</strong> awaiting mail ·{" "}
              {money(query.data.totalCents)} total
              {query.data.count > query.data.printCap &&
                ` · print batch covers the oldest ${query.data.printCap}`}
            </span>
            <a href={mailQueuePrintUrl()} target="_blank" rel="noreferrer">
              <Button size="sm" intent="secondary">
                <Printer className="h-3.5 w-3.5" />
                Download print batch (PDF)
              </Button>
            </a>
            <Button
              size="sm"
              isLoading={markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              {query.data.count > query.data.printCap
                ? `Mark printed batch as mailed (oldest ${query.data.printCap})`
                : "Mark all as mailed"}
            </Button>
          </div>
          {markAll.data && (
            <p className="text-xs" style={{ color: "#15803d" }} role="status">
              Marked {markAll.data.marked} statement
              {markAll.data.marked === 1 ? "" : "s"} mailed.
            </p>
          )}
          {markAll.error instanceof Error && (
            <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
              Couldn&apos;t mark the batch — you may not have permission.
            </p>
          )}
          <div className="space-y-2">
            {query.data.queued.map((s) => (
              <MailQueueRow key={s.statementId} item={s} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function MailQueueRow({ item }: { item: MailQueueStatement }) {
  return (
    <div
      className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="mail-queue-statement-row"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span
          className="font-semibold tabular-nums"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {money(item.amountCents)}
        </span>
        <Link
          href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
          className="text-xs underline decoration-dotted font-mono truncate"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {item.patientId}
        </Link>
      </span>
      <span className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
        {new Date(item.createdAt).toLocaleDateString()}
      </span>
    </div>
  );
}

function BatchSummaryLine({ summary }: { summary: StatementBatchSummary }) {
  return (
    <div
      className="rounded border px-3 py-2 text-xs"
      style={{ borderColor: "hsl(var(--line-1))", color: "hsl(var(--ink-2))" }}
      role="status"
    >
      Last batch — scanned {summary.scanned}, sent {summary.sent}
      {summary.mailQueued > 0 ? `, queued for mail ${summary.mailQueued}` : ""}
      {summary.skipped > 0 ? `, skipped ${summary.skipped}` : ""}
      {summary.failed > 0 ? `, failed ${summary.failed}` : ""}.
    </div>
  );
}

function StatementRow({ item }: { item: PendingStatement }) {
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => sendStatement(item.statementId),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  return (
    <div
      className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="pending-statement-row"
    >
      <span className="flex flex-col gap-0.5 min-w-0">
        <span
          className="font-semibold tabular-nums"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {money(item.amountCents)}
        </span>
        <Link
          href={`/admin/patients/${encodeURIComponent(item.patientId)}`}
          className="text-xs underline decoration-dotted font-mono truncate"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {item.patientId}
        </Link>
      </span>
      <span className="flex items-center gap-3 text-sm">
        <span style={{ color: "hsl(var(--ink-3))" }}>
          {new Date(item.createdAt).toLocaleDateString()}
        </span>
        <Button
          size="sm"
          intent="secondary"
          isLoading={send.isPending}
          onClick={() => send.mutate()}
        >
          Send
        </Button>
      </span>
      {send.data && (
        <p className="w-full text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {send.data.outcome.kind === "sent"
            ? `Sent via ${send.data.outcome.channel}.`
            : send.data.outcome.kind === "mail"
              ? "Queued for mail (patient prefers mailed bills)."
              : send.data.outcome.kind === "skipped"
                ? `Skipped: ${send.data.outcome.reason}.`
                : `Failed: ${send.data.outcome.reason}.`}
        </p>
      )}
    </div>
  );
}
