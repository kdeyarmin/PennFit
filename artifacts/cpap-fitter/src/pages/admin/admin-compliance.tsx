// /admin/compliance — accreditation evidence binder.
//
// Two tabs, both surveyor-facing (ACHC, BOC, TJC):
//   1. Training records — per-staff training events with
//      current/due-soon/expired bucketing computed server-side.
//   2. Grievances — patient complaints, grievances, and adverse
//      events with the documented state machine.
//
// Identity fields on training records are immutable post-create
// (CSR enters from a certificate; if mistyped, retire + add new).
// Grievance state transitions follow GRIEVANCE_TRANSITIONS in the
// API layer.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, ShieldCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createGrievance,
  createTrainingRecord,
  listGrievances,
  listTrainingRecords,
  patchGrievance,
  type CreateGrievanceRequest,
  type CreateTrainingRecordRequest,
  type Grievance,
  type GrievanceKind,
  type GrievanceSeverity,
  type GrievanceSource,
  type GrievanceStatus,
  type TrainingExpiryBucket,
  type TrainingType,
} from "@/lib/admin/compliance-api";

type Tab = "training" | "grievances";

export function AdminCompliancePage() {
  const [tab, setTab] = useState<Tab>("training");
  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" />
          Compliance binder
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Accreditation evidence for DMEPOS surveyors (ACHC, BOC, TJC).
          Training records and patient grievances live here so a site
          visit can answer "show me X" in one query.
        </p>
      </header>

      <div className="flex items-center gap-2">
        <TabChip
          label="Staff training"
          active={tab === "training"}
          onClick={() => setTab("training")}
        />
        <TabChip
          label="Patient grievances"
          active={tab === "grievances"}
          onClick={() => setTab("grievances")}
        />
      </div>

      {tab === "training" ? <TrainingPanel /> : <GrievancesPanel />}
    </div>
  );
}

function TabChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full px-3 py-1 text-xs font-semibold transition-colors"
      style={{
        backgroundColor: active
          ? "hsl(var(--penn-gold))"
          : "hsl(var(--line-2))",
        color: active ? "hsl(var(--penn-navy))" : "hsl(var(--ink-2))",
      }}
    >
      {label}
    </button>
  );
}

// ── Training tab ────────────────────────────────────────────────────

const TRAINING_TYPE_LABEL: Record<TrainingType, string> = {
  hipaa_privacy: "HIPAA Privacy",
  hipaa_security: "HIPAA Security",
  osha_bloodborne: "OSHA — Bloodborne",
  osha_general: "OSHA — General",
  infection_control: "Infection control",
  fit_test: "Fit-test",
  new_hire_orientation: "New-hire orientation",
  dmepos_supplier_stds: "DMEPOS supplier stds",
  other: "Other",
};

const BUCKET_COLOR: Record<TrainingExpiryBucket, string> = {
  current: "bg-emerald-100 text-emerald-900",
  due_soon: "bg-amber-100 text-amber-900",
  expired: "bg-rose-100 text-rose-900",
};

function TrainingPanel() {
  const qc = useQueryClient();
  const queryKey = ["admin", "compliance", "training"] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: listTrainingRecords,
  });
  const [showAdd, setShowAdd] = useState(false);

  if (isPending) return <Spinner />;
  if (isError) return <ErrorPanel error={error} onRetry={() => void refetch()} />;

  const totals = data.records.reduce(
    (acc, r) => {
      acc[r.expiryBucket] += 1;
      return acc;
    },
    { current: 0, due_soon: 0, expired: 0 } as Record<
      TrainingExpiryBucket,
      number
    >,
  );

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-6 text-sm">
          <BucketStat
            label="Current"
            count={totals.current}
            bucket="current"
          />
          <BucketStat
            label="Due soon"
            count={totals.due_soon}
            bucket="due_soon"
          />
          <BucketStat
            label="Expired"
            count={totals.expired}
            bucket="expired"
          />
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Record training
        </Button>
      </div>

      {data.records.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          No training records on file yet.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">Staff</th>
              <th className="py-2 font-semibold">Training</th>
              <th className="py-2 font-semibold">Completed</th>
              <th className="py-2 font-semibold">Expires</th>
              <th className="py-2 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.records.map((r) => (
              <tr
                key={r.id}
                className="border-b"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                <td className="py-1.5 font-mono text-xs">
                  {r.staffUserId.slice(0, 8)}
                </td>
                <td className="py-1.5">
                  <div>{TRAINING_TYPE_LABEL[r.trainingType]}</div>
                  {r.courseTitle && (
                    <div className="text-xs text-muted-foreground">
                      {r.courseTitle}
                    </div>
                  )}
                </td>
                <td className="py-1.5 text-xs">{r.completedAt}</td>
                <td className="py-1.5 text-xs">{r.expiresAt ?? "—"}</td>
                <td className="py-1.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${BUCKET_COLOR[r.expiryBucket]}`}
                  >
                    {r.expiryBucket.replace("_", " ")}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showAdd && (
        <AddTrainingModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </Card>
  );
}

function BucketStat({
  label,
  count,
  bucket,
}: {
  label: string;
  count: number;
  bucket: TrainingExpiryBucket;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider font-semibold"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </div>
      <div
        className={`inline-block px-1.5 py-0.5 rounded text-sm font-semibold mt-1 ${BUCKET_COLOR[bucket]}`}
      >
        {count}
      </div>
    </div>
  );
}

function AddTrainingModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [staffUserId, setStaffUserId] = useState("");
  const [trainingType, setTrainingType] =
    useState<TrainingType>("hipaa_privacy");
  const [courseTitle, setCourseTitle] = useState("");
  const [completedAt, setCompletedAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [expiresAt, setExpiresAt] = useState(
    new Date(new Date().setUTCFullYear(new Date().getUTCFullYear() + 1))
      .toISOString()
      .slice(0, 10),
  );
  const [provider, setProvider] = useState("");
  const [certificateReference, setCertificateReference] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateTrainingRecordRequest = {
        staffUserId: staffUserId.trim(),
        trainingType,
        courseTitle: courseTitle.trim() || null,
        completedAt,
        expiresAt: expiresAt || null,
        provider: provider.trim() || null,
        certificateReference: certificateReference.trim() || null,
      };
      return createTrainingRecord(body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(staffUserId.trim());
  const canSave = isUuid && completedAt;

  return (
    <ModalShell title="Record staff training" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>Staff user ID (UUID from /admin/team)</Label>
          <Input
            value={staffUserId}
            onChange={(e) => setStaffUserId(e.target.value)}
            placeholder="00000000-0000-0000-0000-000000000000"
          />
          {staffUserId.trim() && !isUuid && (
            <p className="text-[10px] text-rose-700 mt-1">
              Must be a UUID.
            </p>
          )}
        </div>
        <div>
          <Label>Training type</Label>
          <select
            value={trainingType}
            onChange={(e) =>
              setTrainingType(e.target.value as TrainingType)
            }
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            {(Object.keys(TRAINING_TYPE_LABEL) as TrainingType[]).map((t) => (
              <option key={t} value={t}>
                {TRAINING_TYPE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <LabeledInput
          label="Course title"
          value={courseTitle}
          onChange={setCourseTitle}
          placeholder="HealthStream HIPAA 101 v2026"
        />
        <LabeledInput
          label="Completed on"
          type="date"
          value={completedAt}
          onChange={setCompletedAt}
        />
        <LabeledInput
          label="Expires on"
          type="date"
          value={expiresAt}
          onChange={setExpiresAt}
        />
        <LabeledInput
          label="Provider"
          value={provider}
          onChange={setProvider}
          placeholder="HealthStream, Internal…"
        />
        <LabeledInput
          label="Certificate reference"
          value={certificateReference}
          onChange={setCertificateReference}
        />
      </div>
      <ModalFooter
        onCancel={onClose}
        onSave={() => create.mutate()}
        saving={create.isPending}
        canSave={Boolean(canSave)}
        error={error}
      />
    </ModalShell>
  );
}

// ── Grievances tab ─────────────────────────────────────────────────

const KIND_LABEL: Record<GrievanceKind, string> = {
  complaint: "Complaint",
  grievance: "Grievance",
  adverse_event: "Adverse event",
};

const SEVERITY_COLOR: Record<GrievanceSeverity, string> = {
  low: "bg-blue-100 text-blue-900",
  moderate: "bg-amber-100 text-amber-900",
  high: "bg-rose-100 text-rose-900",
};

const STATUS_COLOR: Record<GrievanceStatus, string> = {
  open: "bg-amber-100 text-amber-900",
  acknowledged: "bg-blue-100 text-blue-900",
  escalated: "bg-rose-100 text-rose-900",
  resolved: "bg-emerald-100 text-emerald-900",
  reopened: "bg-orange-100 text-orange-900",
};

function GrievancesPanel() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState<"active" | "all" | "resolved">(
    "active",
  );
  const queryKey = ["admin", "compliance", "grievances", filter] as const;
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey,
    queryFn: () => listGrievances(filter),
  });
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState<Grievance | null>(null);

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          {(["active", "all", "resolved"] as const).map((f) => (
            <TabChip
              key={f}
              label={f === "active" ? "Active" : f === "all" ? "All" : "Resolved"}
              active={filter === f}
              onClick={() => setFilter(f)}
            />
          ))}
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Record issue
        </Button>
      </div>

      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : data.grievances.length === 0 ? (
        <p className="text-sm text-muted-foreground py-2">
          Nothing in this view.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr
              className="text-left border-b"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <th className="py-2 font-semibold">Received</th>
              <th className="py-2 font-semibold">Kind</th>
              <th className="py-2 font-semibold">Sev.</th>
              <th className="py-2 font-semibold">Summary</th>
              <th className="py-2 font-semibold">Status</th>
              <th className="py-2 font-semibold"></th>
            </tr>
          </thead>
          <tbody>
            {data.grievances.map((g) => (
              <tr
                key={g.id}
                className="border-b"
                style={{ borderColor: "hsl(var(--line-2))" }}
              >
                <td className="py-1.5 text-xs">{g.receivedAt}</td>
                <td className="py-1.5 text-xs">{KIND_LABEL[g.kind]}</td>
                <td className="py-1.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${SEVERITY_COLOR[g.severity]}`}
                  >
                    {g.severity}
                  </span>
                </td>
                <td className="py-1.5">{g.summary}</td>
                <td className="py-1.5">
                  <span
                    className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${STATUS_COLOR[g.status]}`}
                  >
                    {g.status}
                  </span>
                </td>
                <td className="py-1.5 text-right">
                  <Button
                    intent="ghost"
                    size="sm"
                    onClick={() => setEditing(g)}
                  >
                    Update
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showAdd && (
        <AddGrievanceModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
      {editing && (
        <EditGrievanceModal
          grievance={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
    </Card>
  );
}

function AddGrievanceModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [patientId, setPatientId] = useState("");
  const [kind, setKind] = useState<GrievanceKind>("complaint");
  const [severity, setSeverity] = useState<GrievanceSeverity>("low");
  const [source, setSource] = useState<GrievanceSource>("phone");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [receivedAt, setReceivedAt] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: CreateGrievanceRequest = {
        patientId: patientId.trim(),
        kind,
        severity,
        source,
        summary: summary.trim(),
        description: description.trim() || null,
        receivedAt,
      };
      return createGrievance(body);
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(patientId.trim());
  const canSave = isUuid && summary.trim().length > 0;

  return (
    <ModalShell title="Record patient issue" onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <Label>Patient ID</Label>
          <Input
            value={patientId}
            onChange={(e) => setPatientId(e.target.value)}
            placeholder="UUID — copy from /admin/patients"
          />
        </div>
        <div>
          <Label>Kind</Label>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as GrievanceKind)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="complaint">Complaint</option>
            <option value="grievance">Grievance</option>
            <option value="adverse_event">Adverse event</option>
          </select>
        </div>
        <div>
          <Label>Severity</Label>
          <select
            value={severity}
            onChange={(e) =>
              setSeverity(e.target.value as GrievanceSeverity)
            }
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="low">Low</option>
            <option value="moderate">Moderate</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <Label>Source</Label>
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as GrievanceSource)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="phone">Phone</option>
            <option value="email">Email</option>
            <option value="sms">SMS</option>
            <option value="in_person">In person</option>
            <option value="letter">Letter</option>
            <option value="portal">Portal</option>
            <option value="other">Other</option>
          </select>
        </div>
        <LabeledInput
          label="Received on"
          type="date"
          value={receivedAt}
          onChange={setReceivedAt}
        />
        <div className="col-span-2">
          <LabeledInput
            label="Summary (one line — surveyors scan this)"
            value={summary}
            onChange={setSummary}
            placeholder="Mask leak caused arousals; requested re-fit"
          />
        </div>
        <div className="col-span-2">
          <Label>Description (the patient's own words when possible)</Label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={4}
            maxLength={10000}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          />
        </div>
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

function EditGrievanceModal({
  grievance,
  onClose,
  onSaved,
}: {
  grievance: Grievance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [status, setStatus] = useState<GrievanceStatus>(grievance.status);
  const [resolution, setResolution] = useState(grievance.resolution ?? "");
  const [reportedToFda, setReportedToFda] = useState(grievance.reportedToFda);
  const [fdaReportReference, setFdaReportReference] = useState(
    grievance.fdaReportReference ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  const patch = useMutation({
    mutationFn: () =>
      patchGrievance(grievance.id, {
        status,
        resolution: resolution.trim() || null,
        reportedToFda,
        fdaReportReference: fdaReportReference.trim() || null,
      }),
    onSuccess: () => onSaved(),
    onError: (e: Error) => setError(e.message),
  });

  return (
    <ModalShell title={`Update — ${grievance.summary}`} onClose={onClose}>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Status</Label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as GrievanceStatus)}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="escalated">Escalated</option>
            <option value="resolved">Resolved</option>
            <option value="reopened">Reopened</option>
          </select>
          <p className="text-[10px] text-muted-foreground mt-1">
            Server rejects illegal transitions.
          </p>
        </div>
        {grievance.kind === "adverse_event" && (
          <div>
            <Label>FDA MedWatch report</Label>
            <select
              value={reportedToFda}
              onChange={(e) =>
                setReportedToFda(
                  e.target.value as typeof reportedToFda,
                )
              }
              className="w-full rounded border px-2 py-1.5 text-sm"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              <option value="not_applicable">N/A</option>
              <option value="yes">Yes</option>
              <option value="no">No</option>
            </select>
          </div>
        )}
        {grievance.kind === "adverse_event" && reportedToFda === "yes" && (
          <div className="col-span-2">
            <LabeledInput
              label="MedWatch reference"
              value={fdaReportReference}
              onChange={setFdaReportReference}
              placeholder="MW-2026-0001"
            />
          </div>
        )}
        <div className="col-span-2">
          <Label>Resolution</Label>
          <textarea
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
            rows={4}
            maxLength={5000}
            className="w-full rounded border px-2 py-1.5 text-sm"
            style={{ borderColor: "hsl(var(--line-1))" }}
            placeholder="What was done to address the issue."
          />
        </div>
      </div>
      <ModalFooter
        onCancel={onClose}
        onSave={() => patch.mutate()}
        saving={patch.isPending}
        canSave={true}
        error={error}
      />
    </ModalShell>
  );
}

// ── modal primitives (shared) ──────────────────────────────────────

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
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        type={type}
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
