// /admin/fit-sessions — the clinical fitting record and RT review queue.
//
// Default view is the review queue rather than "everything", because the
// job this page exists for is working the sessions the engine deliberately
// declined to be confident about.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCheck, Download } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatDateTime } from "@/lib/admin/format";
import {
  approveFitSession,
  fetchFitSessions,
  fitReportUrl,
  requestRescan,
  type FitOutcome,
  type FitSessionSummary,
} from "@/lib/admin/fitting-api";

const QUERY_KEY = ["admin", "fit-sessions"] as const;

/**
 * How each outcome reads on screen. The wording is deliberately the same
 * as the fit report's, so a clinician reading the queue and a clinician
 * reading the PDF see one vocabulary rather than two.
 */
const OUTCOME_META: Record<
  FitOutcome,
  { label: string; tone: "success" | "warning" | "danger" | "neutral" }
> = {
  high_confidence: { label: "High confidence", tone: "success" },
  moderate_confidence: { label: "Review recommended", tone: "warning" },
  low_confidence: { label: "Rescan or manual fitting", tone: "danger" },
  contraindicated: { label: "Contraindicated", tone: "danger" },
  outside_validated_range: { label: "Outside validated range", tone: "danger" },
};

const REVIEW_FILTERS: Array<{ value: string; label: string }> = [
  { value: "pending_review", label: "Needs review" },
  { value: "approved", label: "Approved" },
  { value: "overridden", label: "Overridden" },
  { value: "rescan_requested", label: "Rescan requested" },
  { value: "", label: "All" },
];

function toneClass(tone: "success" | "warning" | "danger" | "neutral"): string {
  switch (tone) {
    case "success":
      return "bg-emerald-50 text-emerald-800 border-emerald-200";
    case "warning":
      return "bg-amber-50 text-amber-900 border-amber-200";
    case "danger":
      return "bg-rose-50 text-rose-800 border-rose-200";
    default:
      return "bg-slate-50 text-slate-700 border-slate-200";
  }
}

export function AdminFitSessionsPage() {
  const queryClient = useQueryClient();
  const [reviewStatus, setReviewStatus] = useState("pending_review");
  const [rescanFor, setRescanFor] = useState<string | null>(null);
  const [rescanReason, setRescanReason] = useState("");

  const sessions = useQuery({
    queryKey: [...QUERY_KEY, reviewStatus],
    queryFn: () =>
      fetchFitSessions(reviewStatus ? { reviewStatus } : { limit: 100 }),
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveFitSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const rescan = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      requestRescan(id, reason),
    onSuccess: () => {
      setRescanFor(null);
      setRescanReason("");
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const rows: FitSessionSummary[] = sessions.data?.sessions ?? [];

  return (
    <div className="admin-root space-y-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <ClipboardCheck size={20} aria-hidden="true" />
            Fit review
          </h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Fittings the engine did not resolve to high confidence on its own.
            Low-confidence and contraindicated sessions do not carry an
            automated recommendation — they are here so a respiratory therapist
            can fit the patient personally.
          </p>
        </div>
      </header>

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Filter by review status"
      >
        {REVIEW_FILTERS.map((f) => (
          <Button
            key={f.value || "all"}
            intent={reviewStatus === f.value ? "primary" : "secondary"}
            onClick={() => setReviewStatus(f.value)}
            aria-pressed={reviewStatus === f.value}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {sessions.isError ? (
        <ErrorPanel
          title="Couldn't load fit sessions"
          error={sessions.error}
          onRetry={() => void sessions.refetch()}
        />
      ) : null}

      {sessions.isLoading ? <Spinner /> : null}

      {!sessions.isLoading && rows.length === 0 ? (
        <Card>
          <p className="text-sm text-muted-foreground p-4">
            Nothing here. When a fitting comes back without enough evidence for
            a confident recommendation, it lands in this queue.
          </p>
        </Card>
      ) : null}

      <div className="space-y-3">
        {rows.map((s) => {
          const meta = s.outcome ? OUTCOME_META[s.outcome] : null;
          return (
            <Card key={s.id}>
              <div className="p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {meta ? (
                        <span
                          className={`text-xs font-medium px-2 py-0.5 rounded border ${toneClass(meta.tone)}`}
                        >
                          {meta.label}
                        </span>
                      ) : null}
                      {s.degraded ? (
                        <Badge>Degraded — catalog unavailable</Badge>
                      ) : null}
                      {s.scanQualityGrade && s.scanQualityGrade !== "good" ? (
                        <Badge>Scan: {s.scanQualityGrade}</Badge>
                      ) : null}
                      <Badge>
                        {s.population} · {s.serviceLine.toUpperCase()}
                      </Badge>
                    </div>
                    <p className="text-sm font-medium">
                      {s.recommendedMask ?? "No automated recommendation"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(s.createdAt)}
                      {s.recommendationConfidence !== null
                        ? ` · confidence ${Math.round(s.recommendationConfidence * 100)}%`
                        : ""}
                      {s.measurementConfidenceBand
                        ? ` · measurement ${s.measurementConfidenceBand}`
                        : ""}
                    </p>
                    {s.reviewedByEmail ? (
                      <p className="text-xs text-muted-foreground">
                        {s.reviewStatus} by {s.reviewedByEmail}
                        {s.reviewedAt
                          ? ` · ${formatDateTime(s.reviewedAt)}`
                          : ""}
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    <a
                      href={fitReportUrl(s.id)}
                      className="inline-flex items-center gap-1 text-sm underline"
                      target="_blank"
                      rel="noreferrer"
                    >
                      <Download size={14} aria-hidden="true" />
                      Fit report
                    </a>
                    {s.reviewStatus === "pending_review" ? (
                      <>
                        <Button
                          onClick={() => approve.mutate(s.id)}
                          disabled={approve.isPending}
                        >
                          Approve
                        </Button>
                        <Button
                          intent="secondary"
                          onClick={() =>
                            setRescanFor(rescanFor === s.id ? null : s.id)
                          }
                        >
                          Request rescan
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {rescanFor === s.id ? (
                  <div className="border-t pt-3 space-y-2">
                    <label
                      className="text-sm font-medium block"
                      htmlFor={`rescan-${s.id}`}
                    >
                      Why does this need a new scan?
                    </label>
                    <textarea
                      id={`rescan-${s.id}`}
                      className="w-full text-sm border rounded p-2"
                      rows={2}
                      value={rescanReason}
                      onChange={(e) => setRescanReason(e.target.value)}
                      placeholder="e.g. the frame was badly backlit and the chin was cropped"
                    />
                    <div className="flex gap-2">
                      <Button
                        onClick={() =>
                          rescan.mutate({ id: s.id, reason: rescanReason })
                        }
                        disabled={
                          rescanReason.trim().length < 3 || rescan.isPending
                        }
                      >
                        Send rescan request
                      </Button>
                      <Button
                        intent="secondary"
                        onClick={() => setRescanFor(null)}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

export default AdminFitSessionsPage;
