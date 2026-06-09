// PatientBillingTab — per-patient billing 360.
//
// One tab on the patient detail page that aggregates every billing
// surface that touches THIS patient: open balance, recent claims,
// recent eligibility checks, open prior auths, past statements, and
// a one-click "generate statement" action that downloads the PDF.
//
// Designed for CSR throughput — phase 3c of the billing build. The
// reasoning: the existing per-action UIs (claim workbench at
// /admin/patients/:id/insurance-claims, the system-wide eligibility
// + PA queues, the admin statement generator) are powerful but
// scattered. When a CSR is working a single patient they don't want
// to context-switch to a different URL for each piece. This tab is
// the "one record, end-to-end" view.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  ClipboardCheck,
  DollarSign,
  FileText,
  FolderArchive,
  Mail,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { PaymentPlansSection } from "@/components/admin/PaymentPlansSection";
import { Spinner } from "@/components/admin/Spinner";
import {
  listInsuranceCoverages,
  verifyEligibility,
} from "@/lib/admin/clinical-tabs-api";
import { csrfHeader } from "@/lib/csrf";
import { formatDateOnly } from "@/lib/utils";

const BASE = "/resupply-api";

interface ClaimRow {
  id: string;
  payer_name: string;
  status: string;
  total_billed_cents: number | null;
  total_paid_cents: number | null;
  patient_responsibility_cents: number | null;
  date_of_service: string | null;
  submitted_at: string | null;
  decision_at: string | null;
  denial_reason: string | null;
}

interface EligibilityRow {
  id: string;
  status: string;
  service_hcpcs: string | null;
  is_active: boolean | null;
  in_network: boolean | null;
  deductible_cents: number | null;
  oop_max_cents: number | null;
  copay_cents: number | null;
  coinsurance_pct: number | null;
  requires_prior_auth: boolean | null;
  error_message: string | null;
  requested_at: string;
}

interface PaRow {
  id: string;
  payerName: string;
  hcpcsCode: string;
  status: string;
  authNumber: string | null;
  approvedThrough: string | null;
  submittedAt: string | null;
}

interface StatementRow {
  id: string;
  total_patient_responsibility_cents: number;
  delivery_method: string | null;
  delivered_at: string | null;
  created_at: string;
  line_items_json: unknown;
}

type PacketKind =
  | "prior_auth_support"
  | "appeal_support"
  | "accreditation_audit"
  | "medical_records_request";

const PACKET_KIND_LABEL: Record<PacketKind, string> = {
  prior_auth_support: "Prior-auth support",
  appeal_support: "Appeal support",
  accreditation_audit: "Accreditation audit",
  medical_records_request: "Medical records request",
};

interface DocPacketRow {
  id: string;
  kind: PacketKind;
  page_count: number | null;
  notes: string | null;
  generated_by_email: string;
  created_at: string;
}

function formatMoney(cents: number | null | undefined): string {
  if (cents == null || Number.isNaN(cents)) return "—";
  return `$${(cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`GET ${path} failed (${res.status})`);
  return (await res.json()) as T;
}

export function PatientBillingTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();

  const claims = useQuery({
    queryKey: ["patient-claims", patientId],
    queryFn: () =>
      getJSON<{ claims: ClaimRow[] }>(
        `/admin/patients/${patientId}/insurance-claims`,
      ),
    staleTime: 30_000,
  });
  const eligibility = useQuery({
    queryKey: ["patient-eligibility", patientId],
    queryFn: () =>
      getJSON<{ checks: EligibilityRow[] }>(
        `/admin/patients/${patientId}/eligibility-checks`,
      ),
    staleTime: 30_000,
  });
  const priorAuths = useQuery({
    queryKey: ["patient-prior-auths", patientId],
    queryFn: () =>
      getJSON<{ priorAuthorizations: PaRow[] }>(
        `/admin/patients/${patientId}/prior-authorizations`,
      ),
    staleTime: 30_000,
  });
  const statements = useQuery({
    queryKey: ["patient-statements", patientId],
    queryFn: () =>
      getJSON<{ statements: StatementRow[] }>(
        `/admin/patients/${patientId}/billing-statements`,
      ),
    staleTime: 30_000,
  });
  const packets = useQuery({
    queryKey: ["patient-doc-packets", patientId],
    queryFn: () =>
      getJSON<{ packets: DocPacketRow[] }>(
        `/admin/patients/${patientId}/documentation-packets`,
      ),
    staleTime: 30_000,
  });
  const coverages = useQuery({
    queryKey: ["patient-coverages", patientId],
    queryFn: () => listInsuranceCoverages(patientId),
    staleTime: 60_000,
  });

  // The coverage we run eligibility against from this tab: the primary,
  // or the first on file. (Multi-coverage selection lives in the claim
  // workbench; here we optimize for the one-click common case.)
  const billableCoverage = useMemo(() => {
    const list = coverages.data?.coverages ?? [];
    return list.find((c) => c.rank === "primary") ?? list[0] ?? null;
  }, [coverages.data]);

  // Sum patient responsibility across paid/denied/closed/appealed
  // claims (the only statuses that contribute to a current balance).
  const openBalanceCents = useMemo(() => {
    const list = claims.data?.claims ?? [];
    return list.reduce((acc, c) => {
      if (!["paid", "denied", "appealed", "closed"].includes(c.status)) {
        return acc;
      }
      return acc + (c.patient_responsibility_cents ?? 0);
    }, 0);
  }, [claims.data]);

  // ── Generate-statement mutation. POSTs to the admin endpoint and
  // surfaces the response PDF as a download.
  const [generateError, setGenerateError] = useState<string | null>(null);
  const generateStatement = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch(
        `${BASE}/admin/patients/${patientId}/billing-statements`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({}),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          const json = (await res.json()) as {
            error?: string;
            message?: string;
          };
          detail = json.message ?? json.error ?? "";
        } catch {
          // ignore
        }
        if (res.status === 409 && detail.includes("no_open_balance")) {
          throw new Error("No claims with outstanding patient balance.");
        }
        throw new Error(detail || `request failed (${res.status})`);
      }
      const blob = await res.blob();
      const statementId = res.headers.get("X-Statement-Id") ?? "statement";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `statement-${statementId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      setGenerateError(null);
      void qc.invalidateQueries({
        queryKey: ["patient-statements", patientId],
      });
    },
    onError: (err) => {
      setGenerateError(err instanceof Error ? err.message : "Failed.");
    },
  });

  // ── Documentation-packet generator. A minimal picker — choose
  // the packet kind and compliance window; the backend snapshots
  // the patient's sleep studies / Rx / DWO catalog at render time
  // (we send empty include-* arrays so the route falls back to its
  // "everything available" defaults). Per-document selection lives
  // on the existing /documents tab; this is for the most-common
  // case where billing just wants the standard packet.
  const [packetKind, setPacketKind] =
    useState<PacketKind>("prior_auth_support");
  const [packetWindow, setPacketWindow] = useState(30);
  const [packetError, setPacketError] = useState<string | null>(null);
  const generatePacket = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch(
        `${BASE}/admin/patients/${patientId}/documentation-packets`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            kind: packetKind,
            includeSleepStudyIds: [],
            includePrescriptionIds: [],
            includeDwoDocumentIds: [],
            includeComplianceWindowDays: packetWindow,
          }),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          const json = (await res.json()) as {
            error?: string;
            message?: string;
          };
          detail = json.message ?? json.error ?? "";
        } catch {
          // ignore
        }
        throw new Error(detail || `request failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `packet-${packetKind}-${patientId.slice(0, 8)}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => {
      setPacketError(null);
      void qc.invalidateQueries({
        queryKey: ["patient-doc-packets", patientId],
      });
    },
    onError: (err) => {
      setPacketError(err instanceof Error ? err.message : "Failed.");
    },
  });

  // ── Run eligibility (270/271) for the billable coverage, right here —
  // no need to leave the patient for the system-wide queue. Real-time
  // (when configured) answers inline; otherwise the 270 is submitted and
  // the 271 lands shortly. Either way the new row shows in the list below.
  const [eligMessage, setEligMessage] = useState<string | null>(null);
  const [eligError, setEligError] = useState<string | null>(null);
  const checkEligibility = useMutation({
    mutationFn: async () => {
      if (!billableCoverage) {
        throw new Error("Add an insurance coverage first.");
      }
      return verifyEligibility(patientId, billableCoverage.id);
    },
    onSuccess: (r) => {
      setEligError(null);
      if (r.realtime && r.status === "parsed") {
        const secs =
          typeof r.latencyMs === "number"
            ? ` (${(r.latencyMs / 1000).toFixed(1)}s)`
            : "";
        setEligMessage(`Verified in real time${secs} — result below.`);
      } else if (r.status === "submitted") {
        setEligMessage(
          "270 submitted — the 271 lands shortly; refresh in a minute.",
        );
      } else {
        setEligMessage(r.errorMessage ?? "Submitted.");
      }
      void qc.invalidateQueries({
        queryKey: ["patient-eligibility", patientId],
      });
    },
    onError: (err) => {
      setEligMessage(null);
      setEligError(
        err instanceof Error ? err.message : "Eligibility check failed.",
      );
    },
  });

  return (
    <div className="space-y-6" data-testid="patient-billing-tab">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Tile
          icon={<DollarSign className="h-4 w-4" />}
          label="Open patient balance"
          value={formatMoney(openBalanceCents)}
          tone={openBalanceCents > 0 ? "warning" : "success"}
        />
        <Tile
          icon={<FileText className="h-4 w-4" />}
          label="Claims on file"
          value={(claims.data?.claims.length ?? 0).toLocaleString()}
        />
        <Tile
          icon={<ShieldAlert className="h-4 w-4" />}
          label="Prior auths"
          value={(
            priorAuths.data?.priorAuthorizations.length ?? 0
          ).toLocaleString()}
        />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Link
          href={`/admin/patients/${patientId}/insurance-claims`}
          className="inline-flex"
        >
          <Button intent="primary" size="sm">
            <FileText className="h-3.5 w-3.5" />
            Open claim workbench
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </Link>
        <Button
          intent="secondary"
          size="sm"
          disabled={generateStatement.isPending}
          isLoading={generateStatement.isPending}
          onClick={() => generateStatement.mutate()}
          data-testid="patient-billing-generate-statement"
        >
          <FileText className="h-3.5 w-3.5" />
          {generateStatement.isPending
            ? "Generating…"
            : "Generate statement (PDF)"}
        </Button>
        {generateError && (
          <span
            className="text-xs"
            style={{ color: "#b91c1c" }}
            data-testid="patient-billing-generate-error"
          >
            {generateError}
          </span>
        )}
      </div>

      <StatementDeliveryCard patientId={patientId} />

      <Card
        title="Recent claims"
        subtitle="Newest first. Open the workbench to edit lines or transition state."
      >
        {claims.isPending ? (
          <Spinner label="Loading claims…" />
        ) : claims.isError ? (
          <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
            {claims.error instanceof Error
              ? claims.error.message
              : "Failed to load claims."}
          </p>
        ) : (claims.data?.claims.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No claims on file.
          </p>
        ) : (
          <ul
            className="divide-y -mt-1 -mb-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(claims.data?.claims ?? []).slice(0, 10).map((c) => (
              <li key={c.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span
                    className="font-medium"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {c.payer_name}
                  </span>
                  <span className="inline-flex items-center gap-3 text-[11px]">
                    <ClaimStatusBadge status={c.status} />
                    <span className="tabular-nums font-semibold">
                      {formatMoney(c.total_billed_cents)}
                    </span>
                  </span>
                </div>
                <p
                  className="text-[11px]"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  DOS{" "}
                  {c.date_of_service ? formatDateOnly(c.date_of_service) : "—"}
                  {c.patient_responsibility_cents != null &&
                  c.patient_responsibility_cents > 0 ? (
                    <>
                      {" · patient owes "}
                      <span
                        className="font-semibold"
                        style={{ color: "#b45309" }}
                      >
                        {formatMoney(c.patient_responsibility_cents)}
                      </span>
                    </>
                  ) : null}
                  {c.denial_reason && (
                    <>
                      {" · "}
                      <span style={{ color: "#b91c1c" }}>
                        {c.denial_reason}
                      </span>
                    </>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Recent eligibility checks"
        subtitle="Latest 270/271 round trips for this patient"
        action={
          <div className="flex items-center gap-3">
            <Button
              intent="secondary"
              size="sm"
              disabled={checkEligibility.isPending || !billableCoverage}
              isLoading={checkEligibility.isPending}
              onClick={() => {
                setEligMessage(null);
                setEligError(null);
                checkEligibility.mutate();
              }}
              data-testid="patient-billing-check-eligibility"
              title={
                billableCoverage
                  ? `Run a 270/271 for ${billableCoverage.payerName}`
                  : "Add an insurance coverage first"
              }
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              {checkEligibility.isPending ? "Checking…" : "Check eligibility"}
            </Button>
            <Link
              href="/admin/billing/eligibility"
              className="text-xs underline"
              style={{ color: "hsl(var(--penn-navy))" }}
            >
              System-wide →
            </Link>
          </div>
        }
      >
        {(eligMessage || eligError) && (
          <p
            className="text-xs mb-2"
            style={{ color: eligError ? "#b91c1c" : "#15803d" }}
            data-testid="patient-billing-eligibility-result"
          >
            {eligError ?? eligMessage}
          </p>
        )}
        {eligibility.isPending ? (
          <Spinner label="Loading eligibility…" />
        ) : eligibility.isError ? (
          <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
            {eligibility.error instanceof Error
              ? eligibility.error.message
              : "Failed to load eligibility checks."}
          </p>
        ) : (eligibility.data?.checks.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No eligibility checks on file yet.
          </p>
        ) : (
          <ul
            className="divide-y -mt-1 -mb-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(eligibility.data?.checks ?? []).slice(0, 5).map((c) => (
              <li key={c.id} className="py-2 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="inline-flex items-center gap-2">
                    <EligibilityStatusBadge status={c.status} />
                    {c.service_hcpcs && (
                      <span
                        className="font-mono text-[11px]"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        {c.service_hcpcs}
                      </span>
                    )}
                  </span>
                  <span
                    className="text-[11px]"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {new Date(c.requested_at).toLocaleString()}
                  </span>
                </div>
                {c.is_active != null && (
                  <p
                    className="text-[11px] mt-0.5"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {c.is_active ? (
                      <span style={{ color: "#15803d" }}>
                        active
                        {c.in_network === true ? " · in-network" : ""}
                        {c.in_network === false ? " · out-of-network" : ""}
                      </span>
                    ) : (
                      <span style={{ color: "#b91c1c" }}>inactive</span>
                    )}
                    {c.requires_prior_auth === true && (
                      <span style={{ color: "#b45309" }}> · PA required</span>
                    )}
                    {c.deductible_cents != null && (
                      <>
                        {" · ded "}
                        {formatMoney(c.deductible_cents)}
                      </>
                    )}
                    {c.oop_max_cents != null && (
                      <>
                        {" · OOP max "}
                        {formatMoney(c.oop_max_cents)}
                      </>
                    )}
                  </p>
                )}
                {c.error_message && (
                  <p
                    className="text-[11px] mt-0.5"
                    style={{ color: "#b91c1c" }}
                  >
                    {c.error_message}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Prior authorizations"
        subtitle="See the Prior auths tab for full state-machine transitions"
        action={
          <Link
            href="/admin/billing/prior-auths"
            className="text-xs underline"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            System-wide queue →
          </Link>
        }
      >
        {priorAuths.isPending ? (
          <Spinner label="Loading prior auths…" />
        ) : priorAuths.isError ? (
          <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
            {priorAuths.error instanceof Error
              ? priorAuths.error.message
              : "Failed to load prior authorizations."}
          </p>
        ) : (priorAuths.data?.priorAuthorizations.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No prior authorizations on file.
          </p>
        ) : (
          <ul
            className="divide-y -mt-1 -mb-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(priorAuths.data?.priorAuthorizations ?? [])
              .slice(0, 5)
              .map((p) => (
                <li
                  key={p.id}
                  className="py-2 text-sm flex items-center justify-between gap-3"
                >
                  <div>
                    <span
                      className="font-medium"
                      style={{ color: "hsl(var(--ink-1))" }}
                    >
                      {p.payerName}
                    </span>
                    <span
                      className="ml-2 font-mono text-[11px]"
                      style={{ color: "hsl(var(--ink-2))" }}
                    >
                      {p.hcpcsCode}
                    </span>
                    {p.authNumber && (
                      <span
                        className="ml-2 font-mono text-[11px]"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        #{p.authNumber}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 text-[11px]">
                    <span
                      className="inline-block px-2 py-0.5 rounded-full font-semibold uppercase tracking-wider"
                      style={{
                        backgroundColor: "rgba(0,0,0,0.06)",
                        color: "hsl(var(--ink-2))",
                      }}
                    >
                      {p.status}
                    </span>
                    {p.approvedThrough && (
                      <span style={{ color: "hsl(var(--ink-3))" }}>
                        thru {new Date(p.approvedThrough).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </li>
              ))}
          </ul>
        )}
      </Card>

      <Card
        title="Statement history"
        subtitle="Past patient billing statements"
      >
        {statements.isPending ? (
          <Spinner label="Loading statements…" />
        ) : statements.isError ? (
          <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
            {statements.error instanceof Error
              ? statements.error.message
              : "Failed to load statements."}
          </p>
        ) : (statements.data?.statements.length ?? 0) === 0 ? (
          <div className="flex items-start gap-2 text-sm">
            <AlertTriangle
              className="h-4 w-4 mt-0.5 shrink-0"
              style={{ color: "hsl(var(--ink-3))" }}
            />
            <p style={{ color: "hsl(var(--ink-3))" }}>
              No statements generated yet. Use{" "}
              <strong>Generate statement</strong> above when there's an
              outstanding patient balance.
            </p>
          </div>
        ) : (
          <ul
            className="divide-y -mt-1 -mb-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(statements.data?.statements ?? []).slice(0, 5).map((s) => (
              <li
                key={s.id}
                className="py-2 text-sm flex items-center justify-between gap-3"
              >
                <div>
                  <span
                    className="font-semibold tabular-nums"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {formatMoney(s.total_patient_responsibility_cents)}
                  </span>
                  <span
                    className="ml-2 text-[11px]"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {new Date(s.created_at).toLocaleString()}
                    {s.delivery_method && ` · ${s.delivery_method}`}
                  </span>
                </div>
                <span
                  className="text-[11px]"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  #{s.id.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title={
          <span className="inline-flex items-center gap-2">
            <FolderArchive className="h-4 w-4" />
            Documentation packets
          </span>
        }
        subtitle="Bundle face-to-face, sleep study, Rx, CMN/DWO into one PDF for audits, appeals, or prior-auth submissions"
      >
        <div className="flex flex-wrap items-end gap-3 mb-4">
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Packet kind
            </span>
            <select
              value={packetKind}
              onChange={(e) => setPacketKind(e.target.value as PacketKind)}
              disabled={generatePacket.isPending}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[220px]"
              data-testid="packet-kind-select"
            >
              {(Object.keys(PACKET_KIND_LABEL) as PacketKind[]).map((k) => (
                <option key={k} value={k}>
                  {PACKET_KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Compliance window (days)
            </span>
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              value={packetWindow}
              onChange={(e) =>
                setPacketWindow(
                  Math.max(0, Math.min(120, Number(e.target.value) || 0)),
                )
              }
              disabled={generatePacket.isPending}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm w-[80px] tabular-nums"
              data-testid="packet-window-input"
            />
          </label>
          <Button
            intent="primary"
            size="sm"
            disabled={generatePacket.isPending}
            isLoading={generatePacket.isPending}
            onClick={() => generatePacket.mutate()}
            data-testid="patient-billing-generate-packet"
          >
            <FolderArchive className="h-3.5 w-3.5" />
            {generatePacket.isPending ? "Generating…" : "Generate packet (PDF)"}
          </Button>
          {packetError && (
            <span
              className="text-xs"
              style={{ color: "#b91c1c" }}
              data-testid="patient-billing-packet-error"
            >
              {packetError}
            </span>
          )}
        </div>

        {packets.isPending ? (
          <Spinner label="Loading packets…" />
        ) : packets.isError ? (
          <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
            {packets.error instanceof Error
              ? packets.error.message
              : "Failed to load packets."}
          </p>
        ) : (packets.data?.packets.length ?? 0) === 0 ? (
          <p className="text-sm py-1" style={{ color: "hsl(var(--ink-3))" }}>
            No packets generated yet.
          </p>
        ) : (
          <ul
            className="divide-y -mt-1 -mb-1"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(packets.data?.packets ?? []).slice(0, 8).map((p) => (
              <li
                key={p.id}
                className="py-2 text-sm flex items-center justify-between gap-3"
              >
                <div>
                  <span
                    className="font-medium"
                    style={{ color: "hsl(var(--ink-1))" }}
                  >
                    {PACKET_KIND_LABEL[p.kind] ?? p.kind}
                  </span>
                  <span
                    className="ml-2 text-[11px]"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {new Date(p.created_at).toLocaleString()}
                    {p.page_count != null && ` · ${p.page_count}pp`}
                    {` · by ${p.generated_by_email}`}
                  </span>
                </div>
                <span
                  className="text-[11px]"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  #{p.id.slice(0, 8)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <PaymentPlansSection patientId={patientId} />
    </div>
  );
}

interface StatementDeliveryPref {
  statementDeliveryMethod: "email" | "mail";
  email: string | null;
}

// Collect the patient's email + how they want bills delivered. The
// preference is stamped on each statement at generation, segregating
// emailed bills (sent automatically) from mailed bills (print queue).
function StatementDeliveryCard({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const pref = useQuery({
    queryKey: ["patient-statement-delivery", patientId],
    queryFn: () =>
      getJSON<StatementDeliveryPref>(
        `/admin/patients/${patientId}/statement-delivery`,
      ),
    staleTime: 30_000,
  });

  const [method, setMethod] = useState<"email" | "mail">("mail");
  const [email, setEmail] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    if (pref.data) {
      setMethod(pref.data.statementDeliveryMethod);
      setEmail(pref.data.email ?? "");
      setDirty(false);
    }
  }, [pref.data]);

  const save = useMutation({
    mutationFn: async (): Promise<void> => {
      const res = await fetch(
        `${BASE}/admin/patients/${patientId}/statement-delivery`,
        {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", ...csrfHeader() },
          body: JSON.stringify({
            statementDeliveryMethod: method,
            email: email.trim() ? email.trim() : null,
          }),
        },
      );
      if (!res.ok) {
        let detail = "";
        try {
          const json = (await res.json()) as { error?: string };
          detail = json.error ?? "";
        } catch {
          // ignore
        }
        throw new Error(
          detail === "invalid_body"
            ? "Enter a valid email address."
            : detail || `request failed (${res.status})`,
        );
      }
    },
    onSuccess: () => {
      setError(null);
      setSavedAt(Date.now());
      void qc.invalidateQueries({
        queryKey: ["patient-statement-delivery", patientId],
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Failed.");
    },
  });

  const emailRequiredButMissing = method === "email" && !email.trim();

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Mail className="h-4 w-4" />
          Statement delivery
        </span>
      }
      subtitle="How this patient receives bills. Emailed bills send automatically; mailed bills go to the print/mail queue."
    >
      {pref.isPending ? (
        <Spinner label="Loading preference…" />
      ) : pref.isError ? (
        <p className="text-sm py-1" style={{ color: "#b91c1c" }}>
          {pref.error instanceof Error
            ? pref.error.message
            : "Failed to load delivery preference."}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="block">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Delivery method
            </span>
            <select
              value={method}
              onChange={(e) => {
                setMethod(e.target.value as "email" | "mail");
                setDirty(true);
              }}
              disabled={save.isPending}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm min-w-[160px]"
              data-testid="statement-delivery-method"
            >
              <option value="mail">Mailed (paper)</option>
              <option value="email">Emailed</option>
            </select>
          </label>
          <label className="block flex-1 min-w-[220px]">
            <span
              className="text-xs font-semibold block mb-1"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Email address
            </span>
            <input
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                setDirty(true);
              }}
              placeholder="patient@example.com"
              disabled={save.isPending}
              className="rounded border border-slate-300 px-2 py-1.5 text-sm w-full"
              data-testid="statement-delivery-email"
            />
          </label>
          <Button
            intent="primary"
            size="sm"
            disabled={save.isPending || !dirty || emailRequiredButMissing}
            isLoading={save.isPending}
            onClick={() => save.mutate()}
            data-testid="statement-delivery-save"
          >
            Save
          </Button>
          {savedAt && Date.now() - savedAt < 4000 && (
            <span className="text-xs" style={{ color: "#15803d" }}>
              Saved
            </span>
          )}
          {emailRequiredButMissing && (
            <span className="text-xs w-full" style={{ color: "#b45309" }}>
              Add an email address to deliver bills by email.
            </span>
          )}
          {error && (
            <span
              className="text-xs w-full"
              style={{ color: "#b91c1c" }}
              data-testid="statement-delivery-error"
            >
              {error}
            </span>
          )}
        </div>
      )}
    </Card>
  );
}

function Tile({
  icon,
  label,
  value,
  tone = "default",
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "default" | "success" | "warning";
}) {
  const color =
    tone === "warning"
      ? "#b45309"
      : tone === "success"
        ? "#15803d"
        : "hsl(var(--ink-1))";
  return (
    <div className="surface-card p-4">
      <p
        className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1 inline-flex items-center gap-1.5"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        <span style={{ color }}>{icon}</span>
        {label}
      </p>
      <p
        className="text-2xl font-semibold tabular-nums leading-none"
        style={{ color }}
      >
        {value}
      </p>
    </div>
  );
}

function ClaimStatusBadge({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case "paid":
        return { bg: "rgba(21, 128, 61, 0.12)", color: "#15803d" };
      case "denied":
        return { bg: "rgba(185, 28, 28, 0.12)", color: "#b91c1c" };
      case "appealed":
        return { bg: "rgba(180, 83, 9, 0.12)", color: "#b45309" };
      case "submitted":
        return { bg: "rgba(29, 78, 216, 0.12)", color: "#1d4ed8" };
      case "draft":
        return { bg: "rgba(0,0,0,0.06)", color: "hsl(var(--ink-2))" };
      default:
        return { bg: "rgba(0,0,0,0.06)", color: "hsl(var(--ink-3))" };
    }
  })();
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: tone.bg, color: tone.color }}
    >
      {status}
    </span>
  );
}

function EligibilityStatusBadge({ status }: { status: string }) {
  const tone = (() => {
    switch (status) {
      case "parsed":
        return { bg: "rgba(21, 128, 61, 0.12)", color: "#15803d" };
      case "submitted":
        return { bg: "rgba(29, 78, 216, 0.12)", color: "#1d4ed8" };
      case "queued":
        return { bg: "rgba(180, 83, 9, 0.12)", color: "#b45309" };
      case "rejected":
      case "transport_failed":
        return { bg: "rgba(185, 28, 28, 0.12)", color: "#b91c1c" };
      default:
        return { bg: "rgba(0,0,0,0.06)", color: "hsl(var(--ink-3))" };
    }
  })();
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
      style={{ backgroundColor: tone.bg, color: tone.color }}
    >
      <ClipboardCheck
        className="inline h-3 w-3 mr-0.5 -mt-0.5"
        style={{ color: tone.color }}
      />
      {status.replace("_", " ")}
    </span>
  );
}
