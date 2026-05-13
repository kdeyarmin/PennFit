// Three Tier-2a clinical tabs that mount on admin patient-detail:
//   * SleepStudiesTab — diagnostic AHI / RDI / SpO2 records
//   * InsuranceCoveragesTab — verified payer coverage
//   * PriorAuthorizationsTab — payer auths to dispense HCPCS codes
//
// Each tab is read-mostly (list view + add modal). Edits and status
// transitions are deferred to a follow-up sprint once the
// verifications team confirms the form ergonomics.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createInsuranceCoverage,
  createPriorAuthorization,
  createSleepStudy,
  listInsuranceCoverages,
  listPriorAuthorizations,
  listSleepStudies,
  type CoverageRank,
  type CreateInsuranceCoverageRequest,
  type CreatePriorAuthorizationRequest,
  type CreateSleepStudyRequest,
  type InsuranceCoverage,
  type PriorAuthStatus,
  type SleepStudyType,
} from "@/lib/admin/clinical-tabs-api";

const HCPCS_RE = /^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/;

// ── Sleep studies ──────────────────────────────────────────────────

export function SleepStudiesTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "patient", patientId, "sleep-studies"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listSleepStudies(patientId),
  });
  const [showAdd, setShowAdd] = useState(false);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorPanel error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Diagnostic sleep-study records — AHI, RDI, lowest SpO2, sleep
          efficiency. Drives Medicare LCD L33718 coverage decisions and
          the 90-day adherence trial gate.
        </p>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Record study
        </Button>
      </div>
      {data.studies.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No studies on file.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-border/40">
              <th className="py-2 font-semibold">Date</th>
              <th className="py-2 font-semibold">Type</th>
              <th className="py-2 font-semibold">AHI</th>
              <th className="py-2 font-semibold">SpO2 low</th>
              <th className="py-2 font-semibold">Source</th>
            </tr>
          </thead>
          <tbody>
            {data.studies.map((s) => (
              <tr key={s.id} className="border-b border-border/20">
                <td className="py-2">{s.studyDate}</td>
                <td className="py-2">{humanizeStudyType(s.studyType)}</td>
                <td className="py-2 tabular-nums font-medium">
                  {s.ahi.toFixed(1)}
                </td>
                <td className="py-2 tabular-nums">
                  {s.lowestSpo2Pct == null ? "—" : `${s.lowestSpo2Pct}%`}
                </td>
                <td className="py-2 text-xs text-muted-foreground">
                  {s.source}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showAdd && (
        <AddSleepStudyModal
          patientId={patientId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}

function AddSleepStudyModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [studyDate, setStudyDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [studyType, setStudyType] = useState<SleepStudyType>("psg");
  const [ahi, setAhi] = useState("");
  const [lowestSpo2Pct, setLowestSpo2Pct] = useState("");
  const [diagnosisIcd10, setDiagnosisIcd10] = useState("G47.33");
  const [facilityName, setFacilityName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateSleepStudyRequest = {
        studyDate,
        studyType,
        ahi: Number(ahi),
        lowestSpo2Pct: lowestSpo2Pct ? Number(lowestSpo2Pct) : null,
        diagnosisIcd10: diagnosisIcd10.trim() || null,
        facilityName: facilityName.trim() || null,
      };
      return createSleepStudy(patientId, body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const ahiNum = Number(ahi);
  const ahiValid = ahi !== "" && Number.isFinite(ahiNum) && ahiNum >= 0 && ahiNum <= 150;

  return (
    <ModalShell title="Record sleep study" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label="Study date"
          type="date"
          value={studyDate}
          onChange={setStudyDate}
        />
        <div>
          <Label>Study type</Label>
          <select
            value={studyType}
            onChange={(e) => setStudyType(e.target.value as SleepStudyType)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="psg">In-lab PSG</option>
            <option value="hsat">Home sleep apnea test</option>
            <option value="split_night">Split-night</option>
            <option value="re_titration">Re-titration</option>
          </select>
        </div>
        <LabeledInput
          label="AHI (events/hr)"
          type="number"
          step="0.1"
          value={ahi}
          onChange={setAhi}
          required
        />
        <LabeledInput
          label="Lowest SpO2 (%)"
          type="number"
          value={lowestSpo2Pct}
          onChange={setLowestSpo2Pct}
        />
        <LabeledInput
          label="ICD-10 diagnosis"
          value={diagnosisIcd10}
          onChange={setDiagnosisIcd10}
          placeholder="G47.33"
        />
        <LabeledInput
          label="Facility name"
          value={facilityName}
          onChange={setFacilityName}
          placeholder="Penn Sleep Center"
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onSave={() => create.mutate()}
        saving={create.isPending}
        canSave={ahiValid}
        error={error}
      />
    </ModalShell>
  );
}

function humanizeStudyType(t: SleepStudyType): string {
  switch (t) {
    case "psg":
      return "In-lab PSG";
    case "hsat":
      return "Home test";
    case "split_night":
      return "Split-night";
    case "re_titration":
      return "Re-titration";
  }
}

// ── Insurance coverages ────────────────────────────────────────────

export function InsuranceCoveragesTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "patient", patientId, "insurance"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listInsuranceCoverages(patientId),
  });
  const [showAdd, setShowAdd] = useState(false);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorPanel error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Verified payer coverage — primary, secondary, and any tertiary
          policies. Capture-only for now; the Tier-2b sprint adds 270/271
          eligibility automation on this same data.
        </p>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add coverage
        </Button>
      </div>
      {data.coverages.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No coverage on file. Capture from the insurance lead form once
          the verifications team has confirmed benefits.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.coverages.map((c) => (
            <CoverageRow key={c.id} c={c} />
          ))}
        </ul>
      )}
      {showAdd && (
        <AddInsuranceCoverageModal
          patientId={patientId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}

function CoverageRow({ c }: { c: InsuranceCoverage }) {
  return (
    <li
      className="rounded border p-3"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex items-center justify-between">
        <div>
          <span
            className="inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider mr-2 bg-blue-100 text-blue-900"
          >
            {c.rank}
          </span>
          <span className="font-medium">{c.payerName}</span>
          {c.planName && (
            <span className="text-xs text-muted-foreground ml-2">
              · {c.planName}
            </span>
          )}
        </div>
        <span className="text-xs text-muted-foreground">
          {c.verifiedAt ? `Verified ${c.verifiedAt.slice(0, 10)}` : "Unverified"}
        </span>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-3 text-xs text-muted-foreground">
        <div>Member ID: <span className="font-mono">{c.memberId}</span></div>
        <div>Group: {c.groupNumber ?? "—"}</div>
        <div>
          Deductible:{" "}
          {c.deductibleCents == null
            ? "—"
            : `$${(c.deductibleCents / 100).toFixed(0)}`}
          {c.deductibleMetCents != null && c.deductibleCents != null
            ? ` (met $${(c.deductibleMetCents / 100).toFixed(0)})`
            : ""}
        </div>
      </div>
    </li>
  );
}

function AddInsuranceCoverageModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [rank, setRank] = useState<CoverageRank>("primary");
  const [payerName, setPayerName] = useState("");
  const [planName, setPlanName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [groupNumber, setGroupNumber] = useState("");
  const [deductibleDollars, setDeductibleDollars] = useState("");
  const [copayDollars, setCopayDollars] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateInsuranceCoverageRequest = {
        rank,
        payerName: payerName.trim(),
        planName: planName.trim() || null,
        memberId: memberId.trim(),
        groupNumber: groupNumber.trim() || null,
        deductibleCents: deductibleDollars
          ? Math.round(Number(deductibleDollars) * 100)
          : null,
        copayCents: copayDollars
          ? Math.round(Number(copayDollars) * 100)
          : null,
      };
      return createInsuranceCoverage(patientId, body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const canSave = payerName.trim().length > 0 && memberId.trim().length > 0;

  return (
    <ModalShell title="Add insurance coverage" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Rank</Label>
          <select
            value={rank}
            onChange={(e) => setRank(e.target.value as CoverageRank)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="primary">Primary</option>
            <option value="secondary">Secondary</option>
            <option value="tertiary">Tertiary</option>
          </select>
        </div>
        <LabeledInput
          label="Payer"
          value={payerName}
          onChange={setPayerName}
          placeholder="Aetna"
          required
        />
        <LabeledInput
          label="Plan name"
          value={planName}
          onChange={setPlanName}
          placeholder="Aetna Choice POS II"
        />
        <LabeledInput
          label="Member ID"
          value={memberId}
          onChange={setMemberId}
          required
        />
        <LabeledInput
          label="Group number"
          value={groupNumber}
          onChange={setGroupNumber}
        />
        <LabeledInput
          label="Deductible ($)"
          type="number"
          value={deductibleDollars}
          onChange={setDeductibleDollars}
        />
        <LabeledInput
          label="Copay ($)"
          type="number"
          value={copayDollars}
          onChange={setCopayDollars}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onSave={() => create.mutate()}
        saving={create.isPending}
        canSave={canSave}
        error={error}
      />
    </ModalShell>
  );
}

// ── Prior authorizations ───────────────────────────────────────────

export function PriorAuthorizationsTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "patient", patientId, "prior-auths"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listPriorAuthorizations(patientId),
  });
  const [showAdd, setShowAdd] = useState(false);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorPanel error={error} onRetry={() => void refetch()} />;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Payer authorizations to dispense a specific HCPCS for this
          patient. Status: draft → submitted → approved/denied (→
          appealed). Capture-only in this Tier-2a sprint.
        </p>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Record PA
        </Button>
      </div>
      {data.priorAuthorizations.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No prior authorizations on file.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left border-b border-border/40">
              <th className="py-2 font-semibold">HCPCS</th>
              <th className="py-2 font-semibold">Payer</th>
              <th className="py-2 font-semibold">Auth #</th>
              <th className="py-2 font-semibold">Through</th>
              <th className="py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.priorAuthorizations.map((p) => (
              <tr key={p.id} className="border-b border-border/20">
                <td className="py-2 font-mono">{p.hcpcsCode}</td>
                <td className="py-2">{p.payerName}</td>
                <td className="py-2 font-mono text-xs">
                  {p.authNumber ?? "—"}
                </td>
                <td className="py-2">{p.approvedThrough ?? "—"}</td>
                <td className="py-2">
                  <PaStatusBadge status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {showAdd && (
        <AddPriorAuthorizationModal
          patientId={patientId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </div>
  );
}

const PA_STATUS_COLOR: Record<PriorAuthStatus, string> = {
  draft: "bg-gray-100 text-gray-900",
  submitted: "bg-blue-100 text-blue-900",
  approved: "bg-emerald-100 text-emerald-900",
  denied: "bg-rose-100 text-rose-900",
  appealed: "bg-amber-100 text-amber-900",
  expired: "bg-orange-100 text-orange-900",
};

function PaStatusBadge({ status }: { status: PriorAuthStatus }) {
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${PA_STATUS_COLOR[status]}`}
    >
      {status}
    </span>
  );
}

function AddPriorAuthorizationModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [hcpcsCode, setHcpcsCode] = useState("");
  const [payerName, setPayerName] = useState("");
  const [authNumber, setAuthNumber] = useState("");
  const [status, setStatus] = useState<PriorAuthStatus>("draft");
  const [approvedThrough, setApprovedThrough] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreatePriorAuthorizationRequest = {
        hcpcsCode: hcpcsCode.trim().toUpperCase(),
        payerName: payerName.trim(),
        authNumber: authNumber.trim() || null,
        status,
        approvedThrough: approvedThrough || null,
      };
      return createPriorAuthorization(patientId, body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const hcpcsValid = HCPCS_RE.test(hcpcsCode.trim().toUpperCase());
  const canSave = hcpcsValid && payerName.trim().length > 0;

  return (
    <ModalShell title="Record prior authorization" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <LabeledInput
          label="HCPCS code"
          value={hcpcsCode}
          onChange={setHcpcsCode}
          placeholder="E0601 or A7030-KX"
          required
        />
        <LabeledInput
          label="Payer"
          value={payerName}
          onChange={setPayerName}
          placeholder="Aetna"
          required
        />
        <LabeledInput
          label="Auth number"
          value={authNumber}
          onChange={setAuthNumber}
        />
        <div>
          <Label>Status</Label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as PriorAuthStatus)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="draft">Draft</option>
            <option value="submitted">Submitted</option>
            <option value="approved">Approved</option>
            <option value="denied">Denied</option>
          </select>
        </div>
        <LabeledInput
          label="Approved through"
          type="date"
          value={approvedThrough}
          onChange={setApprovedThrough}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onSave={() => create.mutate()}
        saving={create.isPending}
        canSave={canSave}
        error={error}
      />
    </ModalShell>
  );
}

// ── Shared modal primitives ────────────────────────────────────────

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      className="text-xs font-semibold block mb-1"
      style={{ color: "hsl(var(--penn-navy))" }}
    >
      {children}
    </label>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  type = "text",
  step,
  placeholder,
  required,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  step?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <div>
      <Label>{label}{required && " *"}</Label>
      <Input
        type={type}
        step={step}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

function ModalShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <h2
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {title}
          </h2>
          {children}
        </div>
      </div>
    </div>
  );
}

function ModalFooter({
  onCancel,
  onSave,
  saving,
  canSave,
  error,
}: {
  onCancel: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
  error: string | null;
}) {
  return (
    <>
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {error}
        </div>
      )}
      <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
        <Button intent="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          disabled={!canSave || saving}
          onClick={onSave}
          isLoading={saving}
        >
          Save
        </Button>
      </div>
    </>
  );
}
