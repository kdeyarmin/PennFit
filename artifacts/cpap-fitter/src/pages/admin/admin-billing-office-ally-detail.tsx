// /admin/billing/office-ally/:submissionId — full detail for a
// single Office Ally 837P batch.
//
// Drills down on a row from the OA Operations dashboard. Renders:
//   * Header: status badge, ISA/GS control numbers, file name, size,
//     submitted by/when, transport (sftp/file-stub from the original
//     submission row).
//   * Lineage: parent row (if this is a resubmit) + any child rows
//     that resubmit this one — so the chain is walkable from any
//     point.
//   * Acks: 999 + 277CA file names and timestamps.
//   * Linked claims: per-claim row with patient name, claim number,
//     DOS, status, billed amount. For transport_failed rows, falls
//     back to attempted_claim_ids so the op can still see what was
//     attempted.
//   * Actions: Download raw 837P, Resubmit (when transport_failed).
//
// All data is fetched from the enriched
// GET /admin/office-ally-submissions/:id endpoint.

import { useState } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchOaSubmissionDetail,
  rawEdiDownloadHref,
  resubmitOaSubmission,
  type OaSubmission,
  type OaSubmissionLinkedClaim,
} from "@/lib/admin/office-ally-api";

export function AdminOfficeAllySubmissionDetailPage({
  submissionId,
}: {
  submissionId: string;
}) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin-oa-submission-detail", submissionId],
    queryFn: () => fetchOaSubmissionDetail(submissionId),
    staleTime: 15_000,
  });

  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const resubmitMutation = useMutation({
    mutationFn: () => resubmitOaSubmission(submissionId),
    onSuccess: async (r) => {
      setActionMsg(
        r.ok
          ? `Resubmitted as new batch ${r.submissionId.slice(0, 8)} (${r.claimCount} claims, ${r.transport})`
          : `Resubmit failed: ${r.uploadError ?? "unknown"}`,
      );
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-submission-detail", submissionId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["admin-oa-submissions"],
      });
    },
    onError: (err: unknown) => {
      setActionMsg(err instanceof Error ? err.message : String(err));
    },
  });

  return (
    <div
      className="admin-root space-y-4 max-w-5xl"
      data-testid="admin-oa-submission-detail"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/admin/billing/office-ally"
            className="text-[12px] font-semibold hover:underline"
            style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
          >
            ← Office Ally Operations
          </Link>
          <h1
            className="text-2xl font-semibold mt-1"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {data?.submission.fileName ?? "Submission"}
          </h1>
          <p
            className="text-[12px] font-mono mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            id {submissionId}
          </p>
        </div>
        {data?.submission.status === "transport_failed" &&
          (data.submission.attemptedClaimIds.length ?? 0) > 0 && (
            <div className="flex flex-col items-end gap-2">
              <a
                href={rawEdiDownloadHref(submissionId)}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
                style={{ color: "hsl(var(--ink-1))" }}
                data-testid="oa-detail-download-raw"
              >
                ↓ Raw 837P
              </a>
              <button
                type="button"
                onClick={() => {
                  setActionMsg(null);
                  resubmitMutation.mutate();
                }}
                disabled={resubmitMutation.isPending}
                className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
                data-testid="oa-detail-resubmit"
              >
                {resubmitMutation.isPending ? "Resubmitting…" : "↻ Resubmit batch"}
              </button>
              {actionMsg && (
                <p
                  className="text-[11px] max-w-[240px] text-right"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {actionMsg}
                </p>
              )}
            </div>
          )}
        {data && data.submission.status !== "transport_failed" && (
          <a
            href={rawEdiDownloadHref(submissionId)}
            className="rounded border border-slate-300 px-3 py-1.5 text-sm font-semibold hover:bg-slate-50"
            style={{ color: "hsl(var(--ink-1))" }}
            data-testid="oa-detail-download-raw"
          >
            ↓ Raw 837P
          </a>
        )}
      </header>

      {isError && <ErrorPanel error={error} onRetry={() => void refetch()} />}
      {isPending && <Spinner label="Loading submission…" />}

      {data && (
        <>
          <DetailSummary s={data.submission} />
          {(data.lineage.parent || data.lineage.children.length > 0) && (
            <LineageCard
              parent={data.lineage.parent}
              children={data.lineage.children}
            />
          )}
          <ClaimsTable claims={data.claims} />
        </>
      )}
    </div>
  );
}

// ── Summary card ────────────────────────────────────────────────────

function DetailSummary({ s }: { s: OaSubmission }) {
  return (
    <Card title="Submission summary">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
        <Field label="Status">
          <StatusBadge status={s.status} />
        </Field>
        <Field label="Claim count">{s.claimCount}</Field>
        <Field label="File size">{(s.fileSizeBytes / 1024).toFixed(1)} KB</Field>
        <Field label="ISA control #">
          <code className="font-mono text-[12px]">{s.isaControlNumber}</code>
        </Field>
        <Field label="GS control #">
          <code className="font-mono text-[12px]">{s.gsControlNumber}</code>
        </Field>
        <Field label="OA session id">
          <code className="font-mono text-[11px]">
            {s.officeAllySessionId ?? "—"}
          </code>
        </Field>
        <Field label="Submitted">
          {new Date(s.submittedAt).toLocaleString()}
        </Field>
        <Field label="Submitted by">{s.submittedByEmail}</Field>
        <Field label="Updated">
          {new Date(s.updatedAt).toLocaleString()}
        </Field>
        <Field label="999 ack file">
          <code className="font-mono text-[11px]">
            {s.ack999FileName ?? "—"}
          </code>
        </Field>
        <Field label="999 received">
          {s.ack999ReceivedAt
            ? new Date(s.ack999ReceivedAt).toLocaleString()
            : "—"}
        </Field>
        <Field label="277CA ack file">
          <code className="font-mono text-[11px]">
            {s.ack277caFileName ?? "—"}
          </code>
        </Field>
        <Field label="277CA received">
          {s.ack277caReceivedAt
            ? new Date(s.ack277caReceivedAt).toLocaleString()
            : "—"}
        </Field>
      </dl>
      {s.rejectionReason && (
        <p
          className="mt-3 rounded border p-2 text-[12px]"
          style={{
            backgroundColor: "rgba(190,18,60,0.06)",
            borderColor: "#be123c",
            color: "#9f1239",
          }}
        >
          <strong>Rejection reason:</strong> {s.rejectionReason}
        </p>
      )}
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </dt>
      <dd className="mt-0.5" style={{ color: "hsl(var(--ink-1))" }}>
        {children}
      </dd>
    </div>
  );
}

// ── Lineage card ────────────────────────────────────────────────────

function LineageCard({
  parent,
  children,
}: {
  parent: OaSubmission | null;
  children: OaSubmission[];
}) {
  return (
    <Card title="Resubmit lineage">
      {parent && (
        <div className="mb-3">
          <p
            className="text-[10px] font-semibold uppercase tracking-wider mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Parent (this is a resubmit of)
          </p>
          <LineageRow s={parent} />
        </div>
      )}
      {children.length > 0 && (
        <div>
          <p
            className="text-[10px] font-semibold uppercase tracking-wider mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Children (rows that resubmit this one)
          </p>
          <div className="space-y-1">
            {children.map((c) => (
              <LineageRow key={c.id} s={c} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
}

function LineageRow({ s }: { s: OaSubmission }) {
  return (
    <Link
      href={`/admin/billing/office-ally/${s.id}`}
      className="flex flex-wrap items-center gap-3 rounded border p-2 hover:bg-slate-50"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <StatusBadge status={s.status} />
      <code
        className="font-mono text-[11px]"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {s.fileName}
      </code>
      <span className="text-[11px]" style={{ color: "hsl(var(--ink-3))" }}>
        {s.claimCount} claims · {new Date(s.submittedAt).toLocaleString()}
      </span>
    </Link>
  );
}

// ── Claims table ────────────────────────────────────────────────────

function ClaimsTable({ claims }: { claims: OaSubmissionLinkedClaim[] }) {
  return (
    <Card title={`Claims in this batch (${claims.length})`}>
      {claims.length === 0 ? (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          No claims linked. For a transport_failed batch this may mean the
          attempted-claims list is empty (rows submitted before migration 0150).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left text-[11px] uppercase tracking-wider"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                <th className="p-2">Patient</th>
                <th className="p-2">Payer</th>
                <th className="p-2">DOS</th>
                <th className="p-2">Claim #</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Billed</th>
                <th className="p-2" />
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr
                  key={c.id}
                  className="border-t"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <td className="p-2" style={{ color: "hsl(var(--ink-1))" }}>
                    {c.patientName ?? <em style={{ color: "hsl(var(--ink-3))" }}>unknown</em>}
                  </td>
                  <td className="p-2" style={{ color: "hsl(var(--ink-2))" }}>
                    {c.payerName}
                  </td>
                  <td className="p-2 font-mono text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
                    {c.dateOfService}
                  </td>
                  <td className="p-2 font-mono text-[12px]" style={{ color: "hsl(var(--ink-3))" }}>
                    {c.claimNumber ?? "—"}
                  </td>
                  <td className="p-2">
                    <ClaimStatusBadge status={c.status} />
                  </td>
                  <td className="p-2 text-right font-mono text-[12px]" style={{ color: "hsl(var(--ink-1))" }}>
                    ${(c.totalBilledCents / 100).toFixed(2)}
                  </td>
                  <td className="p-2 text-right">
                    <Link
                      href={`/admin/patients/${c.patientId}/insurance-claims`}
                      className="text-[12px] font-semibold hover:underline"
                      style={{ color: "hsl(var(--penn-navy, 215 70% 35%))" }}
                    >
                      Open →
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function StatusBadge({ status }: { status: OaSubmission["status"] }) {
  const map: Record<
    OaSubmission["status"],
    { bg: string; fg: string; label: string }
  > = {
    queued: { bg: "rgba(100,116,139,0.16)", fg: "#475569", label: "queued" },
    uploaded: { bg: "rgba(2,132,199,0.16)", fg: "#0284c7", label: "uploaded" },
    accepted_999: { bg: "rgba(21,128,61,0.14)", fg: "#15803d", label: "999 OK" },
    rejected_999: { bg: "rgba(190,18,60,0.14)", fg: "#be123c", label: "999 REJECT" },
    accepted_277ca: { bg: "rgba(21,128,61,0.14)", fg: "#15803d", label: "277CA OK" },
    rejected_277ca: { bg: "rgba(190,18,60,0.14)", fg: "#be123c", label: "277CA REJECT" },
    transport_failed: { bg: "rgba(180,83,9,0.18)", fg: "#b45309", label: "transport failed" },
  };
  const c = map[status];
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {c.label}
    </span>
  );
}

function ClaimStatusBadge({ status }: { status: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    draft: { bg: "rgba(100,116,139,0.16)", fg: "#475569" },
    submitted: { bg: "rgba(2,132,199,0.16)", fg: "#0284c7" },
    accepted: { bg: "rgba(21,128,61,0.14)", fg: "#15803d" },
    denied: { bg: "rgba(190,18,60,0.14)", fg: "#be123c" },
    paid: { bg: "rgba(21,128,61,0.14)", fg: "#15803d" },
    appealed: { bg: "rgba(180,83,9,0.18)", fg: "#b45309" },
    closed: { bg: "rgba(100,116,139,0.16)", fg: "#475569" },
  };
  const c = map[status] ?? { bg: "rgba(100,116,139,0.16)", fg: "#475569" };
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase"
      style={{ backgroundColor: c.bg, color: c.fg }}
    >
      {status}
    </span>
  );
}
