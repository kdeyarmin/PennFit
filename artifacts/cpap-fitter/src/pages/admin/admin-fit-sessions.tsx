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
import { Input, Label } from "@/components/admin/Input";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import { formatDateTime } from "@/lib/admin/format";
import {
  approveFitSession,
  fetchFitSessions,
  fetchMaskCatalog,
  fetchMaskModel,
  fitReportUrl,
  overrideFitSession,
  requestRescan,
  rescanNotifyMessage,
  type FitOutcome,
  type FitSessionSummary,
  type RescanResult,
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
  const [rescanOutcome, setRescanOutcome] = useState<RescanResult | null>(null);
  const [overrideFor, setOverrideFor] = useState<string | null>(null);

  const sessions = useQuery({
    queryKey: [...QUERY_KEY, reviewStatus],
    // Same page size on every filter. "All" used to ask for 100 while the
    // named filters silently fell back to the server default of 50 — an
    // invisible inconsistency in how much of the queue each view showed.
    queryFn: () =>
      fetchFitSessions(
        reviewStatus ? { reviewStatus, limit: 100 } : { limit: 100 },
      ),
  });

  const approve = useMutation({
    mutationFn: (id: string) => approveFitSession(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: QUERY_KEY }),
  });

  const rescan = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      requestRescan(id, reason),
    // Keep the panel open on success: whether the patient was actually
    // reached is the outcome a clinician needs to see, and closing the
    // panel would hide the fallback link on every failure path.
    onSuccess: (result) => {
      setRescanReason("");
      setRescanOutcome(result);
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
  });

  const override = useMutation({
    mutationFn: (input: {
      id: string;
      maskModelId: string;
      variantId: string | null;
      reason: string;
    }) =>
      overrideFitSession(input.id, {
        maskModelId: input.maskModelId,
        variantId: input.variantId,
        reason: input.reason,
      }),
    onSuccess: () => {
      setOverrideFor(null);
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
                    {s.supersededBySessionId ? (
                      // A rescan request that the patient has since
                      // answered. Without this note the row read as
                      // eternally open work — nothing ever moves a
                      // session out of rescan_requested; the NEW session
                      // is where the fitting continued.
                      <p
                        className="text-xs text-emerald-700"
                        data-testid={`fit-session-superseded-${s.id}`}
                      >
                        Rescan completed — continued in a{" "}
                        <a
                          className="underline"
                          href={fitReportUrl(s.supersededBySessionId)}
                          target="_blank"
                          rel="noreferrer"
                        >
                          newer fitting
                        </a>
                        .
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
                          // Approving means "the engine's pick is
                          // right". A withheld outcome has no pick, and
                          // the route 409s — so the button is disabled
                          // rather than offering a dead action.
                          disabled={approve.isPending || !s.recommendedMask}
                          title={
                            s.recommendedMask
                              ? undefined
                              : "There is no automated recommendation to approve — record an override with the mask you fitted instead."
                          }
                        >
                          Approve
                        </Button>
                        <Button
                          intent="secondary"
                          onClick={() => {
                            setOverrideFor(overrideFor === s.id ? null : s.id);
                            setRescanFor(null);
                          }}
                          aria-expanded={overrideFor === s.id}
                        >
                          Override
                        </Button>
                        <Button
                          intent="secondary"
                          onClick={() => {
                            setRescanFor(rescanFor === s.id ? null : s.id);
                            setRescanOutcome(null);
                            setOverrideFor(null);
                          }}
                          aria-expanded={rescanFor === s.id}
                        >
                          Request rescan
                        </Button>
                      </>
                    ) : null}
                  </div>
                </div>

                {overrideFor === s.id ? (
                  <OverridePanel
                    sessionId={s.id}
                    pending={override.isPending}
                    error={override.error}
                    onCancel={() => setOverrideFor(null)}
                    onSubmit={(maskModelId, variantId, reason) =>
                      override.mutate({
                        id: s.id,
                        maskModelId,
                        variantId,
                        reason,
                      })
                    }
                  />
                ) : null}

                {rescanFor === s.id ? (
                  <div className="border-t pt-3 space-y-2">
                    <label
                      className="text-sm font-medium block"
                      htmlFor={`rescan-${s.id}`}
                    >
                      Why does this need a new scan?
                    </label>
                    <p className="text-xs text-muted-foreground">
                      Sending this re-issues the patient&apos;s fitting link
                      over the channel their invite used. Your note is recorded
                      on the session and printed on the fit report — it is not
                      sent to the patient.
                    </p>
                    <textarea
                      id={`rescan-${s.id}`}
                      className="w-full text-sm border rounded p-2"
                      rows={2}
                      value={rescanReason}
                      onChange={(e) => setRescanReason(e.target.value)}
                      placeholder="e.g. the frame was badly backlit and the chin was cropped"
                    />
                    {rescan.isError ? (
                      <ErrorPanel
                        title="Couldn't request a rescan"
                        error={rescan.error}
                      />
                    ) : null}
                    {rescanOutcome ? (
                      <div
                        className={`text-sm rounded border px-3 py-2 ${
                          rescanOutcome.patientNotified
                            ? "bg-emerald-50 text-emerald-900 border-emerald-200"
                            : "bg-amber-50 text-amber-900 border-amber-200"
                        }`}
                        role="status"
                      >
                        <p>{rescanNotifyMessage(rescanOutcome)}</p>
                        {rescanOutcome.inviteLink ? (
                          <p className="mt-1 break-all font-mono text-xs">
                            {rescanOutcome.inviteLink}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
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
                        onClick={() => {
                          setRescanFor(null);
                          setRescanOutcome(null);
                        }}
                      >
                        {rescanOutcome ? "Done" : "Cancel"}
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

/**
 * Record that the clinician dispensed something other than what the
 * engine recommended.
 *
 * This is the single most important control on the page, and it was the
 * one the UI didn't offer: the route existed, but there was no way to
 * reach it, so a clinician who fitted a different mask had no way to say
 * so. The engine's own closed loop depends on this — an override is how
 * it learns its recommendation was wrong.
 *
 * The mask picker searches the tenant's catalog rather than accepting a
 * raw UUID, and the size list comes from that model's own variants, so
 * an override can only name a mask and size that actually exist for this
 * organization.
 */
function OverridePanel({
  sessionId,
  pending,
  error,
  onCancel,
  onSubmit,
}: {
  sessionId: string;
  pending: boolean;
  error: unknown;
  onCancel: () => void;
  onSubmit: (
    maskModelId: string,
    variantId: string | null,
    reason: string,
  ) => void;
}) {
  const [search, setSearch] = useState("");
  const [maskModelId, setMaskModelId] = useState("");
  const [variantId, setVariantId] = useState("");
  const [reason, setReason] = useState("");

  const catalog = useQuery({
    queryKey: ["admin", "mask-catalog", "override-picker", search],
    queryFn: () =>
      fetchMaskCatalog({
        search: search || undefined,
        status: "current",
        limit: 50,
      }),
  });

  const model = useQuery({
    queryKey: ["admin", "mask-catalog", "detail", maskModelId],
    queryFn: () => fetchMaskModel(maskModelId),
    enabled: Boolean(maskModelId),
  });

  const variants = (model.data?.variants ?? []).filter(
    (v) => v.component !== "frame",
  );

  return (
    <div className="border-t pt-3 space-y-3">
      <div>
        <Label htmlFor={`override-search-${sessionId}`}>
          Which mask was actually fitted?
        </Label>
        <Input
          id={`override-search-${sessionId}`}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by model — AirFit, DreamWear, Evora…"
        />
      </div>

      {catalog.isLoading ? <Spinner /> : null}
      {catalog.isError ? (
        <ErrorPanel title="Couldn't load the catalog" error={catalog.error} />
      ) : null}

      <div className="flex flex-wrap gap-3">
        <div>
          <Label htmlFor={`override-model-${sessionId}`}>Mask</Label>
          <select
            id={`override-model-${sessionId}`}
            className="border rounded h-9 px-2 text-sm min-w-[260px]"
            value={maskModelId}
            onChange={(e) => {
              setMaskModelId(e.target.value);
              setVariantId("");
            }}
          >
            <option value="">Select a mask…</option>
            {(catalog.data?.models ?? []).map((m) => (
              <option key={m.id} value={m.id}>
                {m.manufacturer} {m.modelName}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Label htmlFor={`override-size-${sessionId}`}>Size</Label>
          <select
            id={`override-size-${sessionId}`}
            className="border rounded h-9 px-2 text-sm"
            value={variantId}
            onChange={(e) => setVariantId(e.target.value)}
            disabled={!maskModelId || model.isLoading}
          >
            <option value="">
              {maskModelId ? "Not recorded" : "Pick a mask first"}
            </option>
            {variants.map((v) => (
              <option key={v.id} value={v.id}>
                {v.sizeLabel}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div>
        <Label htmlFor={`override-reason-${sessionId}`}>
          Why was a different mask fitted?
        </Label>
        <textarea
          id={`override-reason-${sessionId}`}
          className="w-full text-sm border rounded p-2"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. patient could not tolerate the nasal cushion; switched to a full face at their request"
        />
        <p className="text-xs text-muted-foreground mt-1">
          This reason is printed on the fit report and is what the engine learns
          from. At least a sentence, please.
        </p>
      </div>

      {error ? (
        <ErrorPanel title="Couldn't save the override" error={error} />
      ) : null}

      <div className="flex gap-2">
        <Button
          onClick={() => onSubmit(maskModelId, variantId || null, reason)}
          disabled={!maskModelId || reason.trim().length < 10 || pending}
        >
          Record override
        </Button>
        <Button intent="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default AdminFitSessionsPage;
