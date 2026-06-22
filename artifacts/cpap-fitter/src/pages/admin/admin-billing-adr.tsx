// /admin/billing/adr — Medicare ADR / audit-response queue (migration 0457).
//
// Every open Additional Documentation Request, soonest deadline first, with
// its SLA state (overdue / at-risk / on-track) and how many checklist items
// are still outstanding. Log a new ADR from the form; open "Build packet" to
// assemble the response. reports.read to view; patients.update to create.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldAlert } from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge } from "@/components/admin/Badge";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Spinner } from "@/components/admin/Spinner";
import {
  type AdrSlaStatus,
  type AdrSource,
  type AdrScope,
  createAdr,
  getAdrWorklist,
} from "@/lib/admin/adr-api";

const SLA_BADGE: Record<
  AdrSlaStatus,
  { variant: "danger" | "warning" | "neutral" | "success"; label: string }
> = {
  overdue: { variant: "danger", label: "overdue" },
  at_risk: { variant: "warning", label: "at risk" },
  on_track: { variant: "neutral", label: "on track" },
  decided: { variant: "success", label: "decided" },
};

const SOURCES: AdrSource[] = [
  "rac",
  "cert",
  "tpe",
  "upic",
  "payer_medical_review",
  "other",
];
const SCOPES: AdrScope[] = ["device", "supplies", "both"];

export function AdminBillingAdrPage() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["admin", "adr-worklist"] as const,
    queryFn: getAdrWorklist,
    staleTime: 30_000,
  });
  const [showForm, setShowForm] = useState(false);

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-5xl"
      data-testid="admin-adr-page"
    >
      <header className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ShieldAlert className="h-6 w-6" />
            ADR / audit response
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Payer / contractor documentation requests, soonest deadline first.
            Log an ADR, then build the response packet — the Medicare clock is
            30 days from receipt.
          </p>
        </div>
        <button
          type="button"
          className="text-sm rounded border px-3 py-1.5"
          style={{ borderColor: "hsl(var(--line-1))" }}
          onClick={() => setShowForm((v) => !v)}
        >
          {showForm ? "Cancel" : "Log ADR"}
        </button>
      </header>

      {showForm ? (
        <AdrCreateForm
          onCreated={() => {
            setShowForm(false);
            void qc.invalidateQueries({ queryKey: ["admin", "adr-worklist"] });
          }}
        />
      ) : null}

      {query.isPending ? (
        <Spinner label="Loading ADRs…" />
      ) : query.isError ? (
        <ErrorPanel error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <KpiCard label="Open ADRs" value={query.data.counts.total} />
            <KpiCard
              label="At risk (≤7 days)"
              value={query.data.counts.atRisk}
              tone="gold"
            />
            <KpiCard label="Overdue" value={query.data.counts.overdue} />
          </div>

          {query.data.items.length === 0 ? (
            <Card>
              <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
                No open ADRs. New documentation requests you log will appear
                here, ranked by response deadline.
              </p>
            </Card>
          ) : (
            <Card title={`Open ADRs (${query.data.items.length})`}>
              <div className="space-y-2">
                {query.data.items.map((item) => {
                  const sla = SLA_BADGE[item.slaStatus];
                  return (
                    <div
                      key={item.id}
                      className="rounded border p-3 space-y-2"
                      style={{ borderColor: "hsl(var(--line-1))" }}
                      data-testid="adr-row"
                    >
                      <div className="flex items-center justify-between gap-3 flex-wrap">
                        <span className="flex items-center gap-2 text-sm">
                          <Badge variant={sla.variant}>{sla.label}</Badge>
                          <Link
                            href={`/admin/patients/${item.patient_id}`}
                            className="font-medium underline"
                            style={{ color: "hsl(var(--ink-1))" }}
                          >
                            Patient
                          </Link>
                          <span style={{ color: "hsl(var(--ink-3))" }}>
                            {item.contractor_name ?? item.source.toUpperCase()}
                            {item.payer_name ? ` · ${item.payer_name}` : ""}
                          </span>
                        </span>
                        <span
                          className="text-xs flex items-center gap-3"
                          style={{ color: "hsl(var(--ink-3))" }}
                        >
                          {item.response_due ? (
                            <span>
                              due {item.response_due}
                              {item.daysOut != null
                                ? ` (${item.daysOut}d)`
                                : ""}
                            </span>
                          ) : (
                            <span>no deadline set</span>
                          )}
                          {item.outstandingDocs > 0 ? (
                            <Badge variant="neutral">
                              {item.outstandingDocs} outstanding
                            </Badge>
                          ) : null}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-xs">
                        {item.adr_reference ? (
                          <span style={{ color: "hsl(var(--ink-3))" }}>
                            Ref {item.adr_reference}
                          </span>
                        ) : null}
                        <Link
                          href={buildPacketHref(item.patient_id, {
                            adrId: item.id,
                            claimId: item.claim_id,
                            scope: item.scope,
                          })}
                          className="underline"
                          style={{ color: "hsl(var(--penn-navy))" }}
                        >
                          Build packet →
                        </Link>
                      </div>
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

function buildPacketHref(
  patientId: string,
  opts: { adrId?: string; claimId?: string | null; scope?: AdrScope },
): string {
  const params = new URLSearchParams({ patientId });
  if (opts.adrId) params.set("adrId", opts.adrId);
  if (opts.claimId) params.set("claimId", opts.claimId);
  if (opts.scope) params.set("scope", opts.scope);
  return `/admin/audit-packet?${params.toString()}`;
}

function AdrCreateForm({ onCreated }: { onCreated: () => void }) {
  const [patientId, setPatientId] = useState("");
  const [claimId, setClaimId] = useState("");
  const [source, setSource] = useState<AdrSource>("tpe");
  const [scope, setScope] = useState<AdrScope>("device");
  const [contractorName, setContractorName] = useState("");
  const [payerName, setPayerName] = useState("");
  const [adrReference, setAdrReference] = useState("");
  const [receivedAt, setReceivedAt] = useState("");
  const [responseDue, setResponseDue] = useState("");

  const mutation = useMutation({
    mutationFn: () =>
      createAdr({
        patientId: patientId.trim(),
        claimId: claimId.trim() || null,
        source,
        scope,
        contractorName: contractorName.trim() || null,
        payerName: payerName.trim() || null,
        adrReference: adrReference.trim() || null,
        receivedAt: receivedAt || null,
        responseDue: responseDue || null,
      }),
    onSuccess: onCreated,
  });

  const inputStyle = { borderColor: "hsl(var(--line-1))" };
  return (
    <Card title="Log a new ADR">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Patient ID *</span>
          <input
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            placeholder="patient UUID"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>
            Claim ID (optional)
          </span>
          <input
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={claimId}
            onChange={(e) => setClaimId(e.target.value)}
            placeholder="claim UUID"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Source</span>
          <select
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={source}
            onChange={(e) => setSource(e.target.value as AdrSource)}
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Scope</span>
          <select
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={scope}
            onChange={(e) => setScope(e.target.value as AdrScope)}
          >
            {SCOPES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Contractor name</span>
          <input
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={contractorName}
            onChange={(e) => setContractorName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Payer</span>
          <input
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={payerName}
            onChange={(e) => setPayerName(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>ADR reference</span>
          <input
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={adrReference}
            onChange={(e) => setAdrReference(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Received</span>
          <input
            type="date"
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={receivedAt}
            onChange={(e) => setReceivedAt(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span style={{ color: "hsl(var(--ink-3))" }}>Response due *</span>
          <input
            type="date"
            className="rounded border px-2 py-1.5"
            style={inputStyle}
            value={responseDue}
            onChange={(e) => setResponseDue(e.target.value)}
          />
        </label>
      </div>
      {mutation.isError ? (
        <p className="text-sm mt-3" style={{ color: "hsl(354 75% 38%)" }}>
          Could not create the ADR. Check the patient/claim IDs and try again.
        </p>
      ) : null}
      <div className="mt-4">
        <button
          type="button"
          className="text-sm rounded px-3 py-1.5 text-white disabled:opacity-50"
          style={{ background: "hsl(var(--penn-navy))" }}
          disabled={!patientId.trim() || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Saving…" : "Create ADR"}
        </button>
      </div>
    </Card>
  );
}
