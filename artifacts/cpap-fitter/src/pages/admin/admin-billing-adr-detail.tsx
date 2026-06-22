// /admin/billing/adr/:id — ADR detail + response checklist.
//
// Work a single Additional Documentation Request: see its deadline/SLA, update
// status + outcome, and run the document checklist (attach a stored chart
// document, waive an item, or mark a generated item satisfied). "Build packet"
// jumps to the assembler pre-scoped to this ADR. reports.read to view;
// patients.update to act.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldAlert } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  type AdrDocument,
  type AdrOutcome,
  type AdrSlaStatus,
  type AdrStatus,
  getAdr,
  updateAdr,
  updateAdrDocument,
} from "@/lib/admin/adr-api";

const SLA_BADGE: Record<
  AdrSlaStatus,
  "danger" | "warning" | "neutral" | "success"
> = {
  overdue: "danger",
  at_risk: "warning",
  on_track: "neutral",
  decided: "success",
};

const DOC_BADGE: Record<
  AdrDocument["status"],
  "success" | "info" | "neutral" | "warning"
> = {
  attached: "success",
  generated: "info",
  outstanding: "warning",
  waived: "neutral",
  na: "neutral",
};

const STATUSES: AdrStatus[] = ["open", "in_progress", "submitted", "closed"];
const OUTCOMES: AdrOutcome[] = [
  "pending",
  "favorable",
  "partial",
  "unfavorable",
  "withdrawn",
];

export function AdminBillingAdrDetailPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "adr", id] as const,
    queryFn: () => getAdr(id),
    staleTime: 15_000,
  });

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ["admin", "adr", id] });

  if (query.isPending) {
    return (
      <div className="admin-root p-6">
        <Spinner label="Loading ADR…" />
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="admin-root p-6 max-w-3xl">
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      </div>
    );
  }

  const { adr, documents, patientDocuments } = query.data;
  const inputStyle = { borderColor: "hsl(var(--line-1))" };

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-4xl"
      data-testid="admin-adr-detail"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" />
            ADR / audit response
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            {adr.contractor_name ?? adr.source.toUpperCase()}
            {adr.payer_name ? ` · ${adr.payer_name}` : ""}
            {adr.adr_reference ? ` · Ref ${adr.adr_reference}` : ""}
          </p>
        </div>
        <Link
          href={`/admin/audit-packet?patientId=${adr.patient_id}&adrId=${adr.id}${adr.claim_id ? `&claimId=${adr.claim_id}` : ""}&scope=${adr.scope}`}
          className="text-sm rounded px-3 py-1.5 text-white"
          style={{ background: "hsl(var(--penn-navy))" }}
        >
          Build packet →
        </Link>
      </header>

      <Card title="Request">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <Field label="Deadline">
            {adr.response_due ?? "—"}{" "}
            <Badge variant={SLA_BADGE[adr.slaStatus]}>{adr.slaStatus}</Badge>
          </Field>
          <Field label="Received">{adr.received_at ?? "—"}</Field>
          <Field label="Scope">{adr.scope}</Field>
          <Field label="Patient">
            <Link
              href={`/admin/patients/${adr.patient_id}`}
              className="underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              open
            </Link>
          </Field>
        </div>
      </Card>

      <StatusControls
        adrId={adr.id}
        status={adr.status}
        outcome={adr.outcome}
        notes={adr.notes}
        onSaved={invalidate}
      />

      <Card title={`Response checklist (${documents.length})`}>
        <div className="space-y-2">
          {documents.map((doc) => (
            <div
              key={doc.id}
              className="rounded border p-3 flex items-center justify-between gap-3 flex-wrap"
              style={inputStyle}
            >
              <span className="flex items-center gap-2 text-sm">
                <Badge variant={DOC_BADGE[doc.status]}>{doc.status}</Badge>
                <span style={{ color: "hsl(var(--ink-1))" }}>{doc.label}</span>
              </span>
              <div className="flex items-center gap-2 text-xs">
                <select
                  className="rounded border px-2 py-1"
                  style={inputStyle}
                  value=""
                  onChange={(e) => {
                    if (!e.target.value) return;
                    void updateAdrDocument(adr.id, doc.id, {
                      status: "attached",
                      documentId: e.target.value,
                    }).then(invalidate);
                  }}
                >
                  <option value="">Attach document…</option>
                  {patientDocuments.map((pd) => (
                    <option key={pd.id} value={pd.id}>
                      {pd.filename ?? pd.document_type} ·{" "}
                      {pd.created_at.slice(0, 10)}
                    </option>
                  ))}
                </select>
                <DocAction
                  label="Waive"
                  onClick={() =>
                    void updateAdrDocument(adr.id, doc.id, {
                      status: "waived",
                    }).then(invalidate)
                  }
                />
                <DocAction
                  label="Reset"
                  onClick={() =>
                    void updateAdrDocument(adr.id, doc.id, {
                      status: "outstanding",
                    }).then(invalidate)
                  }
                />
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
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
    <div className="flex flex-col gap-0.5">
      <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        {label}
      </span>
      <span style={{ color: "hsl(var(--ink-1))" }}>{children}</span>
    </div>
  );
}

function DocAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="rounded border px-2 py-1"
      style={{ borderColor: "hsl(var(--line-1))" }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function StatusControls({
  adrId,
  status,
  outcome,
  notes,
  onSaved,
}: {
  adrId: string;
  status: AdrStatus;
  outcome: AdrOutcome;
  notes: string | null;
  onSaved: () => void;
}) {
  const [s, setS] = useState<AdrStatus>(status);
  const [o, setO] = useState<AdrOutcome>(outcome);
  const [n, setN] = useState(notes ?? "");
  const inputStyle = { borderColor: "hsl(var(--line-1))" };
  const mutation = useMutation({
    mutationFn: () =>
      updateAdr(adrId, { status: s, outcome: o, notes: n.trim() || null }),
    onSuccess: onSaved,
  });

  return (
    <Card title="Status & outcome">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Status</span>
          <select
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={s}
            onChange={(e) => setS(e.target.value as AdrStatus)}
          >
            {STATUSES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Outcome</span>
          <select
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={o}
            onChange={(e) => setO(e.target.value as AdrOutcome)}
          >
            {OUTCOMES.map((x) => (
              <option key={x} value={x}>
                {x}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm mt-3">
        <span style={{ color: "hsl(var(--ink-3))" }}>Notes</span>
        <textarea
          className="rounded border px-2 py-1.5"
          style={inputStyle}
          rows={2}
          value={n}
          onChange={(e) => setN(e.target.value)}
        />
      </label>
      <div className="mt-3">
        <button
          type="button"
          className="text-sm rounded px-3 py-1.5 text-white disabled:opacity-50"
          style={{ background: "hsl(var(--penn-navy))" }}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </button>
        {mutation.isSuccess ? (
          <span className="text-sm ml-2" style={{ color: "hsl(152 70% 24%)" }}>
            Saved.
          </span>
        ) : null}
      </div>
    </Card>
  );
}
