// /admin/documents/retention — the document-retention worklist.
//
// The admin UI for the retention surface that already shipped server-side
// (routes/admin/patient-documents-retention.ts): patient documents whose
// retention clock is up (or close), with the two retention actions the
// API offers — a legal hold (with a required reason) and the one-way byte
// destruction. The server is the authority on every gate: viewing requires
// `audit.export` (admin / supervisor / compliance_officer), destruction is
// admin-only AND requires the retention sweep to have marked the row; this
// page mirrors those gates for legibility, never replaces them.
//
// Destruction UX intentionally mirrors the API contract: the operator must
// type DESTROY (the exact body token the route validates) before the
// button arms. The row itself survives destruction (destroyed_at +
// destroyed_by stay on the record); the bytes are erased by the
// object-storage sweep once the route releases the object's ACL row.
//
// PHI posture: this list renders document metadata only (type, filename,
// size, dates) plus a link to the patient chart — no document content.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Archive, Gavel, ShieldAlert, Trash2 } from "lucide-react";

import { useGetAdminMe } from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card, KpiCard } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  destroyDocument,
  listRetentionDocuments,
  setLegalHold,
  type RetentionBucket,
  type RetentionDocument,
} from "@/lib/admin/document-retention-api";
import { formatDateOnly } from "@/lib/utils";

// null = the API's default surface: the actionable queue (due_now ∪ due_soon).
type BucketFilter = RetentionBucket | null;

const FILTERS: ReadonlyArray<{ value: BucketFilter; label: string }> = [
  { value: null, label: "Actionable" },
  { value: "due_now", label: "Due now" },
  { value: "due_soon", label: "Due soon" },
  { value: "marked", label: "Marked" },
  { value: "legal_hold", label: "Legal hold" },
  { value: "destroyed", label: "Destroyed" },
];

const BUCKET_BADGE: Record<
  RetentionBucket,
  {
    label: string;
    variant: "neutral" | "info" | "success" | "warning" | "danger" | "muted";
  }
> = {
  active: { label: "Active", variant: "neutral" },
  due_soon: { label: "Due soon", variant: "info" },
  due_now: { label: "Due now", variant: "warning" },
  marked: { label: "Marked", variant: "warning" },
  legal_hold: { label: "Legal hold", variant: "danger" },
  destroyed: { label: "Destroyed", variant: "muted" },
};

function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AdminDocumentRetentionPage() {
  const qc = useQueryClient();
  const me = useGetAdminMe();
  const canDestroy = me.data?.role === "admin";

  const [bucket, setBucket] = useState<BucketFilter>(null);
  const query = useQuery({
    queryKey: ["admin", "document-retention", bucket ?? "actionable"] as const,
    queryFn: () => listRetentionDocuments(bucket ?? undefined),
    staleTime: 30_000,
  });

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["admin", "document-retention"] });

  // ── Legal hold — per-row reason capture, then POST. ────────────────
  const [holdTarget, setHoldTarget] = useState<RetentionDocument | null>(null);
  const [holdReason, setHoldReason] = useState("");
  const holdMutation = useMutation({
    mutationFn: (input: { id: string; hold: boolean; reason: string }) =>
      setLegalHold(input.id, { hold: input.hold, reason: input.reason }),
    onSuccess: () => {
      setHoldTarget(null);
      setHoldReason("");
      invalidate();
    },
  });

  // ── Destroy — type-to-confirm, admin-only. ─────────────────────────
  const [destroyTarget, setDestroyTarget] = useState<RetentionDocument | null>(
    null,
  );
  const [destroyConfirm, setDestroyConfirm] = useState("");
  const destroyMutation = useMutation({
    mutationFn: (id: string) => destroyDocument(id),
    onSuccess: () => {
      setDestroyTarget(null);
      setDestroyConfirm("");
      invalidate();
    },
  });

  const counts = useMemo(() => {
    const docs = query.data?.documents ?? [];
    return {
      shown: docs.length,
      onHold: docs.filter((d) => d.legalHold && !d.destroyedAt).length,
      totalBytes: docs.reduce((acc, d) => acc + (d.sizeBytes ?? 0), 0),
    };
  }, [query.data]);

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-document-retention-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Archive className="h-6 w-6" />
          Document retention
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Patient documents whose retention period is up (or coming up). Place a
          legal hold to pause the clock, or — admins only, once the retention
          sweep has marked a row — destroy the document. Destruction is one-way:
          the stored bytes are queued for permanent erasure and the record
          itself stays on the patient chart.
        </p>
      </header>

      <div
        className="flex flex-wrap gap-2"
        role="group"
        aria-label="Bucket filter"
      >
        {FILTERS.map((f) => (
          <Button
            key={f.label}
            size="sm"
            intent={bucket === f.value ? "primary" : "secondary"}
            onClick={() => setBucket(f.value)}
            data-testid={`retention-filter-${f.label.toLowerCase().replace(/ /g, "-")}`}
          >
            {f.label}
          </Button>
        ))}
      </div>

      {query.isPending ? (
        <Spinner label="Loading retention queue…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Documents shown" value={counts.shown} />
            <KpiCard label="On legal hold" value={counts.onHold} />
            <KpiCard
              label="Stored bytes"
              value={humanBytes(counts.totalBytes)}
            />
          </div>

          {query.data.documents.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                Nothing in this bucket. When a document's retention clock comes
                due it will appear here.
              </p>
            </Card>
          ) : (
            <Card title={`Documents (${query.data.count})`}>
              <div className="space-y-2">
                {query.data.documents.map((doc) => {
                  const badge = BUCKET_BADGE[doc.bucket];
                  const destroyed = doc.destroyedAt != null;
                  const isHoldTarget = holdTarget?.id === doc.id;
                  const isDestroyTarget = destroyTarget?.id === doc.id;
                  return (
                    <div
                      key={doc.id}
                      className="rounded border p-3 space-y-2"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                      data-testid="retention-row"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="flex items-center gap-2 text-sm min-w-0">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                          {doc.legalHold &&
                          !destroyed &&
                          doc.bucket !== "legal_hold" ? (
                            <Badge variant="danger">Legal hold</Badge>
                          ) : null}
                          <span
                            className="font-medium truncate"
                            style={{ color: "hsl(var(--ink-1))" }}
                          >
                            {doc.filename?.trim() || doc.documentType}
                          </span>
                          <span
                            className="text-xs"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {doc.documentType} · {humanBytes(doc.sizeBytes)}
                          </span>
                        </span>
                        <span
                          className="text-xs flex items-center gap-3"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          <span>
                            {destroyed
                              ? `Destroyed ${formatDateOnly(doc.destroyedAt!)}`
                              : doc.retentionUntilAt
                                ? `Retain until ${formatDateOnly(doc.retentionUntilAt)}`
                                : "No retention date"}
                          </span>
                          <Link
                            href={`/admin/patients/${doc.patientId}`}
                            className="underline"
                            style={{ color: "hsl(var(--penn-navy))" }}
                          >
                            Patient chart →
                          </Link>
                        </span>
                      </div>

                      {!destroyed ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            size="sm"
                            intent="ghost"
                            data-testid="retention-hold-toggle"
                            onClick={() => {
                              setDestroyTarget(null);
                              setDestroyConfirm("");
                              setHoldReason("");
                              setHoldTarget(isHoldTarget ? null : doc);
                            }}
                          >
                            <Gavel className="h-3.5 w-3.5" />
                            {doc.legalHold
                              ? "Release legal hold"
                              : "Place legal hold"}
                          </Button>
                          {/* Destruction is offered only when the server
                            would accept it: admin role, no hold, AND the
                            retention sweep has marked the row — the API
                            409s `not_marked` otherwise, so an unmarked
                            row must not walk the operator through a
                            confirmation that cannot succeed. */}
                          {canDestroy &&
                          !doc.legalHold &&
                          doc.retentionMarkedAt != null ? (
                            <Button
                              size="sm"
                              intent="ghost"
                              data-testid="retention-destroy-toggle"
                              onClick={() => {
                                setHoldTarget(null);
                                setHoldReason("");
                                setDestroyConfirm("");
                                setDestroyTarget(isDestroyTarget ? null : doc);
                              }}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                              Destroy bytes…
                            </Button>
                          ) : null}
                        </div>
                      ) : null}

                      {isHoldTarget ? (
                        <div
                          className="rounded border p-3 space-y-2"
                          style={{ borderColor: "hsl(var(--line-1))" }}
                          data-testid="retention-hold-form"
                        >
                          <label
                            className="text-xs font-medium block"
                            htmlFor={`hold-reason-${doc.id}`}
                          >
                            Reason for {doc.legalHold ? "releasing" : "placing"}{" "}
                            the hold (required)
                          </label>
                          <input
                            id={`hold-reason-${doc.id}`}
                            className="w-full rounded border px-2 py-1.5 text-sm"
                            style={{ borderColor: "hsl(var(--line-1))" }}
                            maxLength={500}
                            value={holdReason}
                            onChange={(e) => setHoldReason(e.target.value)}
                            placeholder="e.g. litigation hold — Smith v. …"
                          />
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              intent="primary"
                              disabled={holdReason.trim().length === 0}
                              isLoading={holdMutation.isPending}
                              data-testid="retention-hold-submit"
                              onClick={() =>
                                holdMutation.mutate({
                                  id: doc.id,
                                  hold: !doc.legalHold,
                                  reason: holdReason.trim(),
                                })
                              }
                            >
                              {doc.legalHold ? "Release hold" : "Place hold"}
                            </Button>
                            <Button
                              size="sm"
                              intent="secondary"
                              onClick={() => setHoldTarget(null)}
                            >
                              Cancel
                            </Button>
                            {holdMutation.isError && isHoldTarget ? (
                              <span
                                className="text-xs"
                                style={{ color: "#b91c1c" }}
                              >
                                {holdMutation.error instanceof Error
                                  ? holdMutation.error.message
                                  : "Failed."}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}

                      {isDestroyTarget ? (
                        <div
                          className="rounded border p-3 space-y-2"
                          style={{ borderColor: "#b91c1c66" }}
                          data-testid="retention-destroy-form"
                        >
                          <p
                            className="text-xs flex items-center gap-1.5"
                            style={{ color: "#b91c1c" }}
                          >
                            <ShieldAlert className="h-3.5 w-3.5" />
                            This is one-way: the document becomes unreadable
                            immediately and its bytes are queued for permanent
                            erasure. Type DESTROY to arm the button.
                          </p>
                          <input
                            aria-label="Type DESTROY to confirm"
                            className="w-full rounded border px-2 py-1.5 text-sm font-mono"
                            style={{ borderColor: "#b91c1c66" }}
                            value={destroyConfirm}
                            onChange={(e) => setDestroyConfirm(e.target.value)}
                            placeholder="DESTROY"
                          />
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              intent="primary"
                              disabled={destroyConfirm !== "DESTROY"}
                              isLoading={destroyMutation.isPending}
                              data-testid="retention-destroy-submit"
                              onClick={() => destroyMutation.mutate(doc.id)}
                            >
                              Destroy document bytes
                            </Button>
                            <Button
                              size="sm"
                              intent="secondary"
                              onClick={() => setDestroyTarget(null)}
                            >
                              Cancel
                            </Button>
                            {destroyMutation.isError && isDestroyTarget ? (
                              <span
                                className="text-xs"
                                style={{ color: "#b91c1c" }}
                              >
                                {destroyMutation.error instanceof Error
                                  ? destroyMutation.error.message
                                  : "Failed."}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
