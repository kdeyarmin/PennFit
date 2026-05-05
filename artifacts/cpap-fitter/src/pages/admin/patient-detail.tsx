import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getGetPatientQueryKey,
  getListPatientNotesQueryKey,
  useCreatePatientNote,
  useCreatePrescription,
  useGetPatient,
  useGetPatientTimeline,
  useListPatientNotes,
  usePlaceVoiceCall,
  useSendEmailReminder,
  useSendSmsReminder,
  useUpdatePatient,
  useUpdatePrescriptionStatus,
  type PatientDetail,
  type PatientNote,
  type PatientPrescription,
  type PatientTimelineEvent,
} from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  channelVariant,
  conversationStatusVariant,
  episodeStatusVariant,
  fulfillmentStatusVariant,
  humanizeStatus,
  patientStatusVariant,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { fullName, formatDate, formatDateTime } from "@/lib/admin/format";
import {
  AdminPatientFollowupsNotFoundError,
  completeAdminPatientFollowup,
  createAdminPatientFollowup,
  listAdminPatientFollowups,
  type AdminPatientFollowup,
} from "@/lib/admin/patient-followups-api";
import {
  enrollPatientOnboarding,
  fetchPatientOnboarding,
  setPatientOnboardingStatus,
  type PatientOnboardingJourney,
} from "@/lib/admin/patient-onboarding-api";
import {
  prescriptionAttachmentDownloadUrl,
  removePrescriptionAttachment,
  uploadPrescriptionAttachment,
} from "@/lib/admin/prescription-attachment";
import {
  createPhysicianFaxOutreach,
  listPatientPhysicianFaxOutreach,
  type PhysicianFaxOutreachRow,
} from "@/lib/admin/physician-fax-outreach-api";
import {
  deletePatientDocument,
  listPatientDocuments,
  markPatientDocumentReviewed,
  patientDocumentDownloadUrl,
  DOCUMENT_TYPE_LABELS,
  type AdminPatientDocument,
} from "@/lib/admin/patient-documents-api";

type Tab =
  | "timeline"
  | "episodes"
  | "conversations"
  | "fulfillments"
  | "prescriptions"
  | "notes"
  | "followups"
  | "onboarding"
  | "fax-outreach"
  | "documents";

export function PatientDetailPage({ id }: { id: string }) {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<Tab>("timeline");
  const { data, isPending, isError, error, refetch } = useGetPatient(id);

  if (isError) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load patient"
        />
      </div>
    );
  }

  if (isPending || !data) {
    return (
      <div className="space-y-4 max-w-4xl">
        <BackLink />
        <Card>
          <Spinner label="Loading patient…" />
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-5xl">
      <BackLink />

      <Card>
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1
              className="text-2xl font-semibold mb-1"
              style={{ color: "hsl(var(--ink-1))" }}
            >
              {fullName(data.firstName, data.lastName)}
            </h1>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              PACware ID #{data.pacwareId} · Patient created{" "}
              {formatDate(data.createdAt)}
            </p>
          </div>
          <Badge variant={patientStatusVariant(data.status)}>
            {humanizeStatus(data.status)}
          </Badge>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Channels on file
            </p>
            <div className="flex gap-2">
              {data.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
              {data.hasEmail && <Badge variant="neutral">Email</Badge>}
              {!data.hasPhone && !data.hasEmail && (
                <Badge variant="muted">No contact methods on file</Badge>
              )}
            </div>
          </div>
          <div>
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Last updated
            </p>
            <p style={{ color: "hsl(var(--ink-1))" }}>
              {formatDateTime(data.updatedAt)}
            </p>
          </div>
        </div>
        {/*
          Last contact strip. Sourced from patient_latest_message
          (refreshed in-line on every inbound/outbound write across
          SMS / email / voice transcript). Hidden entirely when the
          patient has no message history yet — the empty state would
          add visual noise without conveying anything an admin can
          act on.

          Direction is rendered as a coloured Badge (warning for
          inbound = "they're waiting on us", neutral for outbound)
          to mirror the colour cue used in the patients list. The
          preview sits below in a single ellipsised line; the full
          80-char body is also exposed via the title attribute so
          hovering reveals the rest without taking layout space.
        */}
        {data.lastMessageAt ? (
          <div
            className="mt-4 pt-4 border-t"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <p
              className="text-xs uppercase tracking-wider font-semibold mb-1"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Last contact
            </p>
            <div className="flex items-center gap-2 text-sm">
              <Badge
                variant={
                  data.lastMessageDirection === "inbound"
                    ? "warning"
                    : "neutral"
                }
              >
                {data.lastMessageDirection === "inbound"
                  ? "Inbound"
                  : "Outbound"}
              </Badge>
              <span style={{ color: "hsl(var(--ink-1))" }}>
                {formatDateTime(data.lastMessageAt)}
              </span>
            </div>
            {data.lastMessagePreview ? (
              <p
                className="mt-1 text-sm"
                style={{
                  color: "hsl(var(--ink-2))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: "48rem",
                }}
                title={data.lastMessagePreview}
              >
                {data.lastMessagePreview}
              </p>
            ) : null}
          </div>
        ) : null}
      </Card>

      <PatientActionBar patient={data} onAfterAction={() => void refetch()} />

      <SettingsCard patient={data} onSaved={() => void refetch()} />

      <div
        className="flex gap-1 border-b"
        style={{ borderColor: "hsl(var(--line-1))" }}
        role="tablist"
      >
        <TabButton
          active={tab === "timeline"}
          onClick={() => setTab("timeline")}
        >
          Timeline
        </TabButton>
        <TabButton
          active={tab === "episodes"}
          onClick={() => setTab("episodes")}
        >
          Episodes ({data.episodes.length})
        </TabButton>
        <TabButton
          active={tab === "conversations"}
          onClick={() => setTab("conversations")}
        >
          Conversations ({data.conversations.length})
        </TabButton>
        <TabButton
          active={tab === "fulfillments"}
          onClick={() => setTab("fulfillments")}
        >
          Fulfillments ({data.fulfillments.length})
        </TabButton>
        <TabButton
          active={tab === "prescriptions"}
          onClick={() => setTab("prescriptions")}
        >
          Prescriptions ({data.prescriptions.length})
        </TabButton>
        <TabButton active={tab === "notes"} onClick={() => setTab("notes")}>
          Notes
        </TabButton>
        <TabButton
          active={tab === "followups"}
          onClick={() => setTab("followups")}
        >
          Follow-ups
        </TabButton>
        <TabButton
          active={tab === "onboarding"}
          onClick={() => setTab("onboarding")}
        >
          Onboarding
        </TabButton>
        <TabButton
          active={tab === "fax-outreach"}
          onClick={() => setTab("fax-outreach")}
        >
          Fax outreach
        </TabButton>
        <TabButton
          active={tab === "documents"}
          onClick={() => setTab("documents")}
        >
          Documents
        </TabButton>
      </div>

      <Card>
        {tab === "timeline" && (
          <TimelineTab
            patientId={id}
            onConversationClick={(cid) =>
              setLocation(`/admin/conversations/${cid}`)
            }
          />
        )}
        {tab === "episodes" && <EpisodesTab episodes={data.episodes} />}
        {tab === "conversations" && (
          <ConversationsTab
            conversations={data.conversations}
            onRowClick={(cid) => setLocation(`/admin/conversations/${cid}`)}
          />
        )}
        {tab === "fulfillments" && (
          <FulfillmentsTab fulfillments={data.fulfillments} />
        )}
        {tab === "prescriptions" && (
          <PrescriptionsTab
            patientId={id}
            prescriptions={data.prescriptions}
            onChanged={() => void refetch()}
          />
        )}
        {tab === "notes" && <NotesTab patientId={id} />}
        {tab === "followups" && <FollowupsTab patientId={id} />}
        {tab === "onboarding" && <OnboardingTab patientId={id} />}
        {tab === "fax-outreach" && (
          <FaxOutreachTab patientId={id} prescriptions={data.prescriptions} />
        )}
        {tab === "documents" && <DocumentsTab patientId={id} />}
      </Card>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      href="/admin/patients"
      className="text-sm underline"
      style={{ color: "hsl(var(--ink-1))" }}
    >
      ← Back to patients
    </Link>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className="px-4 py-2 text-sm font-semibold border-b-2 -mb-px transition-colors"
      style={{
        color: active ? "#0a1f44" : "#6b7280",
        borderColor: active ? "#c9a24a" : "transparent",
      }}
    >
      {children}
    </button>
  );
}

type Episode = {
  id: string;
  prescriptionId: string;
  itemSku: string;
  status: string;
  dueAt: string;
  expiresAt?: string | null;
  createdAt: string;
};

function EpisodesTab({ episodes }: { episodes: Episode[] }) {
  const cols: Column<Episode>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={episodeStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    { key: "due", header: "Due", render: (r) => formatDate(r.dueAt) },
    { key: "exp", header: "Expires", render: (r) => formatDate(r.expiresAt) },
  ];
  return (
    <Table
      columns={cols}
      rows={episodes}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No episodes for this patient yet." />}
    />
  );
}

type Conversation = {
  id: string;
  episodeId: string;
  channel: string;
  status: string;
  lastMessageAt?: string | null;
  createdAt: string;
};

function ConversationsTab({
  conversations,
  onRowClick,
}: {
  conversations: Conversation[];
  onRowClick: (id: string) => void;
}) {
  const cols: Column<Conversation>[] = [
    {
      key: "channel",
      header: "Channel",
      render: (r) => (
        <Badge variant={channelVariant(r.channel)}>
          {humanizeStatus(r.channel)}
        </Badge>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={conversationStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "last",
      header: "Last message",
      render: (r) => formatDateTime(r.lastMessageAt),
    },
    {
      key: "open",
      header: "",
      render: () => (
        <span
          className="text-xs underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open →
        </span>
      ),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={conversations}
      rowKey={(r) => r.id}
      onRowClick={(r) => onRowClick(r.id)}
      emptyState={
        <EmptyState
          title="No recent conversations."
          hint="Up to 10 most recent are shown here."
        />
      }
    />
  );
}

type Fulfillment = {
  id: string;
  episodeId: string;
  itemSku: string;
  quantity: string;
  status: string;
  pacwareOrderRef?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  createdAt: string;
};

function FulfillmentsTab({ fulfillments }: { fulfillments: Fulfillment[] }) {
  const cols: Column<Fulfillment>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    { key: "qty", header: "Qty", render: (r) => r.quantity },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={fulfillmentStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "ref",
      header: "PACware ref",
      render: (r) => r.pacwareOrderRef ?? "—",
    },
    {
      key: "ship",
      header: "Shipped",
      render: (r) => formatDate(r.shippedAt),
    },
    {
      key: "deliv",
      header: "Delivered",
      render: (r) => formatDate(r.deliveredAt),
    },
  ];
  return (
    <Table
      columns={cols}
      rows={fulfillments}
      rowKey={(r) => r.id}
      emptyState={<EmptyState title="No fulfillment activity yet." />}
    />
  );
}

// Single-source the prescription row shape from the generated
// OpenAPI client so the dashboard cannot drift from the contract.
// Attachment metadata fields are part of the schema; the underlying
// GCS object key is intentionally not exposed (downloads go through
// the dedicated, audit-logged GET endpoint).
type Prescription = PatientPrescription;

// 10 MB hard cap, mirrored on the API. Kept as a const so the
// "Document too large" message and the file-picker hint can stay in
// sync without two truths drifting.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_ACCEPT =
  "application/pdf,image/png,image/jpeg,image/heic,image/heif,image/webp";

function formatBytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function PrescriptionsTab({
  patientId,
  prescriptions,
  onChanged,
}: {
  patientId: string;
  prescriptions: Prescription[];
  onChanged: () => void;
}) {
  const [showAdd, setShowAdd] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const updateStatus = useUpdatePrescriptionStatus();

  // Single shared mutation for all rows. Tracking which row is busy
  // prevents the "every button spins at once" UX bug.
  const [busyRxId, setBusyRxId] = useState<string | null>(null);
  // Separate busy state for attachment uploads/removes so the
  // "Mark expired" button doesn't spin while a document is being
  // attached to the same row, and vice versa. We never let the same
  // row run both concurrently anyway, but the visual feedback is
  // cleaner this way.
  const [busyAttachmentRxId, setBusyAttachmentRxId] = useState<string | null>(
    null,
  );

  async function handleUpload(rxId: string, file: File) {
    setActionError(null);
    if (file.size > MAX_ATTACHMENT_BYTES) {
      setActionError(
        `Document is too large — max ${formatBytes(MAX_ATTACHMENT_BYTES)}.`,
      );
      return;
    }
    setBusyAttachmentRxId(rxId);
    try {
      await uploadPrescriptionAttachment({ patientId, rxId, file });
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Couldn't attach document.",
      );
    } finally {
      setBusyAttachmentRxId(null);
    }
  }

  async function handleRemoveAttachment(rxId: string) {
    if (
      !window.confirm(
        "Remove the attached document? The patient's record will no longer link to it.",
      )
    ) {
      return;
    }
    setActionError(null);
    setBusyAttachmentRxId(rxId);
    try {
      await removePrescriptionAttachment({ patientId, rxId });
      onChanged();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Couldn't remove attachment.",
      );
    } finally {
      setBusyAttachmentRxId(null);
    }
  }

  async function changeStatus(rxId: string, nextStatus: "expired" | "revoked") {
    const verb = nextStatus === "revoked" ? "revoke" : "mark expired";
    if (
      !window.confirm(`Are you sure you want to ${verb} this prescription?`)
    ) {
      return;
    }
    setActionError(null);
    setBusyRxId(rxId);
    try {
      await updateStatus.mutateAsync({
        rxId,
        data: { status: nextStatus },
      });
      onChanged();
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't update prescription.";
      setActionError(msg);
    } finally {
      setBusyRxId(null);
    }
  }

  const cols: Column<Prescription>[] = [
    { key: "sku", header: "Item", render: (r) => r.itemSku },
    {
      key: "cadence",
      header: "Cadence",
      render: (r) => `${r.cadenceDays} days`,
    },
    {
      key: "from",
      header: "Valid from",
      render: (r) => formatDate(r.validFrom),
    },
    {
      key: "until",
      header: "Valid until",
      render: (r) => formatDate(r.validUntil),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={r.status === "active" ? "success" : "muted"}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "attachment",
      header: "Document",
      render: (r) => (
        <PrescriptionAttachmentCell
          patientId={patientId}
          rx={r}
          isBusy={busyAttachmentRxId === r.id}
          isDisabled={
            (busyAttachmentRxId !== null && busyAttachmentRxId !== r.id) ||
            busyRxId === r.id
          }
          onUpload={(file) => void handleUpload(r.id, file)}
          onRemove={() => void handleRemoveAttachment(r.id)}
        />
      ),
    },
    {
      key: "actions",
      header: "",
      render: (r) =>
        r.status === "active" ? (
          <div className="flex gap-2 justify-end">
            <Button
              intent="secondary"
              isLoading={busyRxId === r.id}
              disabled={busyRxId !== null && busyRxId !== r.id}
              onClick={() => void changeStatus(r.id, "expired")}
            >
              Mark expired
            </Button>
            <Button
              intent="secondary"
              isLoading={busyRxId === r.id}
              disabled={busyRxId !== null && busyRxId !== r.id}
              onClick={() => void changeStatus(r.id, "revoked")}
            >
              Revoke
            </Button>
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Clinical fields are immutable after creation — to edit, add a new
          prescription and mark the old one expired.
        </p>
        <Button onClick={() => setShowAdd(true)}>+ Add prescription</Button>
      </div>
      {actionError && (
        <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
          {actionError}
        </p>
      )}
      <Table
        columns={cols}
        rows={prescriptions}
        rowKey={(r) => r.id}
        emptyState={<EmptyState title="No prescriptions on file." />}
      />
      {showAdd && (
        <AddPrescriptionModal
          patientId={patientId}
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

// Inline cell renderer for the prescription table's "Document" column.
// Two states: "no attachment yet" (file picker label-as-button) and
// "attachment present" (download link + remove button). Kept as a
// dedicated component so the file-input ref is scoped per row and the
// `accept` / size hint stay colocated with the picker.
function PrescriptionAttachmentCell({
  patientId,
  rx,
  isBusy,
  isDisabled,
  onUpload,
  onRemove,
}: {
  patientId: string;
  rx: Prescription;
  isBusy: boolean;
  isDisabled: boolean;
  onUpload: (file: File) => void;
  onRemove: () => void;
}) {
  const inputId = `rx-attachment-${rx.id}`;

  if (rx.attachmentFilename) {
    return (
      <div className="flex flex-col gap-1">
        <a
          href={prescriptionAttachmentDownloadUrl({
            patientId,
            rxId: rx.id,
          })}
          target="_blank"
          rel="noopener"
          className="text-sm underline"
          style={{ color: "#1d4ed8" }}
          // download attribute hints the browser to save with the
          // server-supplied Content-Disposition filename. Same-origin
          // request so this works even though the link target is
          // technically a streamed binary response.
          download={rx.attachmentFilename}
        >
          {rx.attachmentFilename}
        </a>
        <div
          className="text-xs flex items-center gap-2"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          <span>{formatBytes(rx.attachmentSizeBytes)}</span>
          <button
            type="button"
            onClick={onRemove}
            disabled={isDisabled || isBusy}
            className="underline"
            style={{
              color: isBusy || isDisabled ? "#9ca3af" : "#b91c1c",
              cursor: isBusy || isDisabled ? "not-allowed" : "pointer",
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
            }}
          >
            {isBusy ? "Removing…" : "Remove"}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <input
        id={inputId}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        className="hidden"
        disabled={isDisabled || isBusy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Reset the input so picking the same filename twice in a
          // row still fires `change` (browsers suppress the event
          // when the value is identical to the prior selection).
          e.target.value = "";
          if (file) onUpload(file);
        }}
      />
      <label
        htmlFor={inputId}
        className="text-xs underline"
        style={{
          color: isBusy || isDisabled ? "#9ca3af" : "#1d4ed8",
          cursor: isBusy || isDisabled ? "not-allowed" : "pointer",
        }}
      >
        {isBusy ? "Uploading…" : "Attach document"}
      </label>
      <span className="text-xs" style={{ color: "#9ca3af" }}>
        PDF or image · max 10 MB
      </span>
    </div>
  );
}

// ----------------------
// Settings panel
// ----------------------
//
// Three admin-managed fields that override the defaults used by
// the eligibility engine:
//   - insurancePayer: free-text payer name (e.g. "Aetna"). Used as a
//     match key by frequency_rules; blank means "no payer recorded"
//     and rules with a payer constraint will not apply.
//   - cadenceOverrideDays: hard override of the days between
//     reminders. Wins over rules and the prescription cadence.
//   - channelPreference: hard override of the outbound channel.
//     Wins over rules and the SMS-then-email fallback.
//
// "Save" sends ONLY the fields the admin actually changed (the
// PATCH endpoint treats omitted keys as "leave alone" and explicit
// `null` as "clear"). "Reset to default" clears all three overrides
// in a single PATCH so the eligibility engine falls all the way
// back to rules / prescription defaults.

type ChannelChoice = "" | "sms" | "email" | "voice";

function SettingsCard({
  patient,
  onSaved,
}: {
  patient: PatientDetail;
  onSaved: () => void;
}) {
  // Local form state. We re-seed from the server snapshot whenever
  // the patient row refetches (e.g. after a successful save) so the
  // "dirty" indicator clears.
  const [insurancePayer, setInsurancePayer] = useState(
    patient.insurancePayer ?? "",
  );
  const [cadence, setCadence] = useState(
    patient.cadenceOverrideDays != null
      ? String(patient.cadenceOverrideDays)
      : "",
  );
  const [channel, setChannel] = useState<ChannelChoice>(
    (patient.channelPreference ?? "") as ChannelChoice,
  );
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const mutation = useUpdatePatient();
  const isPending = mutation.isPending;

  useEffect(() => {
    setInsurancePayer(patient.insurancePayer ?? "");
    setCadence(
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "",
    );
    setChannel((patient.channelPreference ?? "") as ChannelChoice);
    setError(null);
  }, [
    patient.insurancePayer,
    patient.cadenceOverrideDays,
    patient.channelPreference,
  ]);

  function buildPatch(): {
    body: Record<string, string | number | null>;
    error: string | null;
  } {
    const body: Record<string, string | number | null> = {};
    // insurance: empty string clears, anything else is a set.
    const insTrim = insurancePayer.trim();
    const insOnServer = patient.insurancePayer ?? "";
    if (insTrim !== insOnServer) {
      body.insurancePayer = insTrim === "" ? null : insTrim;
    }
    // cadence: empty clears, otherwise integer in [1,365].
    const cadOnServer =
      patient.cadenceOverrideDays != null
        ? String(patient.cadenceOverrideDays)
        : "";
    if (cadence.trim() !== cadOnServer) {
      if (cadence.trim() === "") {
        body.cadenceOverrideDays = null;
      } else {
        const n = Number(cadence);
        if (!Number.isInteger(n) || n < 1 || n > 365) {
          return {
            body: {},
            error: "Cadence override must be a whole number between 1 and 365.",
          };
        }
        body.cadenceOverrideDays = n;
      }
    }
    // channel: empty clears, otherwise enum.
    const chOnServer = patient.channelPreference ?? "";
    if (channel !== chOnServer) {
      body.channelPreference = channel === "" ? null : channel;
    }
    return { body, error: null };
  }

  function describeError(err: unknown): string {
    if (err instanceof ApiError) {
      // ConsoleValidationError surface
      const data = err.data as { error?: string; message?: string } | undefined;
      return data?.message ?? data?.error ?? "Couldn't save changes.";
    }
    return err instanceof Error ? err.message : "Couldn't save changes.";
  }

  async function onSave() {
    setError(null);
    setStatusMsg(null);
    const { body, error: validationError } = buildPatch();
    if (validationError) {
      setError(validationError);
      return;
    }
    if (Object.keys(body).length === 0) {
      setStatusMsg("No changes to save.");
      return;
    }
    // Optimistic-concurrency precondition. We echo the `updatedAt`
    // we last saw so the server can refuse to clobber a parallel
    // edit; on 409 we surface the conflict and trigger a refetch
    // (via onSaved()) so the admin sees the latest data and can
    // re-apply.
    body.expectedUpdatedAt = patient.updatedAt;
    try {
      const res = await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg(
        res.changed.length === 0
          ? "No fields changed."
          : `Saved ${res.changed.length} field${res.changed.length === 1 ? "" : "s"}.`,
      );
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          "This patient was changed by someone else since you opened it. Refreshing — please re-apply your edits.",
        );
        onSaved();
        return;
      }
      setError(describeError(err));
    }
  }

  async function onReset() {
    setError(null);
    setStatusMsg(null);
    const body: Record<string, string | number | null> = {};
    if (patient.insurancePayer != null) body.insurancePayer = null;
    if (patient.cadenceOverrideDays != null) body.cadenceOverrideDays = null;
    if (patient.channelPreference != null) body.channelPreference = null;
    if (Object.keys(body).length === 0) {
      setStatusMsg("Nothing to reset — already on defaults.");
      return;
    }
    body.expectedUpdatedAt = patient.updatedAt;
    try {
      await mutation.mutateAsync({ id: patient.id, data: body });
      setStatusMsg("Reset to defaults — eligibility engine will use rules.");
      onSaved();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError(
          "This patient was changed by someone else since you opened it. Refreshing — please re-apply your reset.",
        );
        onSaved();
        return;
      }
      setError(describeError(err));
    }
  }

  const hasOverride =
    patient.insurancePayer != null ||
    patient.cadenceOverrideDays != null ||
    patient.channelPreference != null;

  return (
    <Card>
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2
            className="text-sm uppercase tracking-wider font-semibold mb-1"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Reminder settings
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Per-patient overrides win over global rules and the prescription
            cadence. Leave a field blank to fall back to the rules engine.
          </p>
        </div>
        {hasOverride && <Badge variant="info">Custom override active</Badge>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div>
          <Label htmlFor="patient-insurance">Insurance payer</Label>
          <Input
            id="patient-insurance"
            value={insurancePayer}
            placeholder="e.g. Aetna"
            maxLength={120}
            onChange={(e) => setInsurancePayer(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Free-text — match key for rules.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-cadence">Cadence override (days)</Label>
          <Input
            id="patient-cadence"
            type="number"
            min={1}
            max={365}
            value={cadence}
            placeholder="—"
            onChange={(e) => setCadence(e.target.value)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Whole days, 1–365.
          </p>
        </div>
        <div>
          <Label htmlFor="patient-channel">Channel preference</Label>
          <Select
            id="patient-channel"
            value={channel}
            options={[
              { value: "sms", label: "SMS" },
              { value: "email", label: "Email" },
              { value: "voice", label: "Voice (manual)" },
            ]}
            emptyOptionLabel="Use default"
            onChange={(e) => setChannel(e.target.value as ChannelChoice)}
            disabled={isPending}
          />
          <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Voice is admin-initiated only.
          </p>
        </div>
      </div>

      {error && (
        <p className="mt-3 text-sm" style={{ color: "#b91c1c" }} role="alert">
          {error}
        </p>
      )}
      {statusMsg && !error && (
        <p
          className="mt-3 text-sm"
          style={{ color: "hsl(var(--ink-1))" }}
          role="status"
        >
          {statusMsg}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button onClick={() => void onSave()} isLoading={isPending}>
          Save changes
        </Button>
        <Button
          intent="secondary"
          onClick={() => void onReset()}
          disabled={isPending || !hasOverride}
        >
          Reset to default
        </Button>
      </div>
    </Card>
  );
}

// ----------------------
// Timeline tab
// ----------------------
//
// Renders the merged event feed from GET /patients/:id/timeline.
// Events are already sorted server-side (newest first) and include
// optional cross-references for deep-linking — currently we only
// link conversation events back into the conversation detail page.

function TimelineTab({
  patientId,
  onConversationClick,
}: {
  patientId: string;
  onConversationClick: (id: string) => void;
}) {
  const { data, isPending, isError, error, refetch } =
    useGetPatientTimeline(patientId);

  if (isError) {
    return (
      <ErrorPanel
        error={error}
        onRetry={() => void refetch()}
        title="Couldn't load timeline"
      />
    );
  }
  if (isPending || !data) {
    return <Spinner label="Loading timeline…" />;
  }
  if (data.events.length === 0) {
    return (
      <EmptyState
        title="Nothing has happened yet."
        hint="Timeline events appear once this patient has prescriptions, episodes, fulfillments, or conversations."
      />
    );
  }
  return (
    <ol className="space-y-3" role="list">
      {data.events.map((ev, i) => (
        <TimelineRow
          key={`${ev.kind}-${ev.at}-${i}`}
          event={ev}
          onConversationClick={onConversationClick}
        />
      ))}
    </ol>
  );
}

function timelineKindLabel(kind: PatientTimelineEvent["kind"]): {
  label: string;
  variant: Parameters<typeof Badge>[0]["variant"];
} {
  switch (kind) {
    case "patient_created":
      return { label: "Patient created", variant: "neutral" };
    case "prescription_created":
      return { label: "Prescription", variant: "info" };
    case "episode_created":
      return { label: "Episode", variant: "info" };
    case "message":
      return { label: "Message", variant: "neutral" };
    case "fulfillment_queued":
      return { label: "Fulfillment queued", variant: "muted" };
    case "fulfillment_submitted":
      return { label: "Fulfillment submitted", variant: "info" };
    case "fulfillment_shipped":
      return { label: "Fulfillment shipped", variant: "success" };
    case "fulfillment_delivered":
      return { label: "Fulfillment delivered", variant: "success" };
    default:
      return { label: humanizeStatus(kind), variant: "muted" };
  }
}

function TimelineRow({
  event,
  onConversationClick,
}: {
  event: PatientTimelineEvent;
  onConversationClick: (id: string) => void;
}) {
  const { label, variant } = timelineKindLabel(event.kind);
  const isLinkable = event.kind === "message" && event.conversationId != null;
  return (
    <li className="border-l-2 pl-3 py-1" style={{ borderColor: "#c9a24a" }}>
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge variant={variant}>{label}</Badge>
          <span
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {event.title}
          </span>
        </div>
        <span
          className="text-xs whitespace-nowrap"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {formatDateTime(event.at)}
        </span>
      </div>
      {event.detail && (
        <p
          className="mt-1 text-sm whitespace-pre-wrap"
          style={{ color: "hsl(var(--ink-2))" }}
        >
          {event.detail}
        </p>
      )}
      {isLinkable && event.conversationId && (
        <button
          type="button"
          onClick={() => onConversationClick(event.conversationId!)}
          className="mt-1 text-xs underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Open conversation →
        </button>
      )}
    </li>
  );
}

// ----------------------
// Patient action bar
// ----------------------
//
// Sits between the header card and the settings card. Two clusters
// of actions:
//
//   1. Outreach: send-now SMS/email/voice. Reuses the existing
//      send-reminder + place-call mutations and aims them at the
//      most-recent open episode (the dashboard shouldn't have to
//      pick which episode to reach the patient about — the engine
//      already picked one). Disabled when no usable episode exists
//      or when the patient is not active (paused/closed shouldn't
//      get reminders).
//
//   2. Lifecycle: pause / resume / close. Closing is destructive
//      enough that we confirm; pause/resume are one-click — the
//      eligibility scan already suppresses paused/closed patients,
//      so flipping the bit is the canonical knob.

function PatientActionBar({
  patient,
  onAfterAction,
}: {
  patient: PatientDetail;
  onAfterAction: () => void;
}) {
  const queryClient = useQueryClient();
  const sms = useSendSmsReminder();
  const email = useSendEmailReminder();
  const voice = usePlaceVoiceCall();
  const update = useUpdatePatient();
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  // Undo-close UI state. When the admin successfully closes a
  // patient we surface an inline "Undo" affordance with an
  // 8-second countdown. Clicking Undo reopens (status → active).
  // Letting the timer expire dismisses the affordance silently —
  // the close itself already took effect server-side at the moment
  // the PATCH succeeded; "Undo" is purely a follow-up reverse PATCH.
  const [closedAt, setClosedAt] = useState<number | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  useEffect(() => {
    if (closedAt === null) return;
    const tick = () => {
      const elapsed = Math.floor((Date.now() - closedAt) / 1000);
      const remaining = Math.max(0, 8 - elapsed);
      setSecondsLeft(remaining);
      if (remaining === 0) setClosedAt(null);
    };
    tick();
    const id = window.setInterval(tick, 250);
    return () => window.clearInterval(id);
  }, [closedAt]);

  // Pick the "current" episode for send-now actions. We prefer
  // anything in active outreach (outreach_pending / awaiting_response)
  // over confirmed/declined so reminders go to the patient's
  // currently-pending order, not the historic one. Falls back to the
  // newest episode otherwise so the buttons aren't dead when the
  // engine hasn't scheduled anything.
  const targetEpisode = useMemo(() => {
    const eps = patient.episodes;
    if (eps.length === 0) return null;
    const live = eps.find(
      (e) =>
        e.status === "outreach_pending" || e.status === "awaiting_response",
    );
    if (live) return live;
    // newest by createdAt
    return [...eps].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  }, [patient.episodes]);

  const isMutating =
    sms.isPending || email.isPending || voice.isPending || update.isPending;

  function describe(err: unknown): string {
    if (err instanceof ApiError) {
      const data = err.data as { error?: string; message?: string } | undefined;
      return data?.message ?? data?.error ?? "Request failed.";
    }
    return err instanceof Error ? err.message : "Request failed.";
  }

  function fire(label: string, p: Promise<unknown>) {
    setFeedback(null);
    p.then(() => {
      setFeedback({ kind: "success", text: `${label} sent.` });
      onAfterAction();
    }).catch((err: unknown) => {
      setFeedback({ kind: "error", text: `${label} failed: ${describe(err)}` });
    });
  }

  async function changeStatus(next: "active" | "paused" | "closed") {
    if (next === patient.status) return;
    if (next === "closed") {
      if (
        !window.confirm(
          "Close this patient? Closed patients are removed from outreach permanently. Proceed?",
        )
      ) {
        return;
      }
    }
    setFeedback(null);
    try {
      await update.mutateAsync({
        id: patient.id,
        data: { status: next, expectedUpdatedAt: patient.updatedAt },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetPatientQueryKey(patient.id),
      });
      onAfterAction();
      if (next === "closed") {
        // Surface the undo affordance INSTEAD of the regular feedback
        // banner. The undo banner replaces the success line so we
        // don't double-stack messages on top of each other.
        setClosedAt(Date.now());
      } else {
        setClosedAt(null);
        setFeedback({
          kind: "success",
          text:
            next === "active"
              ? "Patient resumed. Outreach scan will pick them up again."
              : "Patient paused. Outreach scan will skip them.",
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFeedback({
          kind: "error",
          text: "Patient was changed elsewhere — refreshing. Please re-apply the status change.",
        });
        await queryClient.invalidateQueries({
          queryKey: getGetPatientQueryKey(patient.id),
        });
        onAfterAction();
        return;
      }
      setFeedback({ kind: "error", text: describe(err) });
    }
  }

  async function undoClose() {
    setClosedAt(null);
    setFeedback(null);
    // Defense-in-depth: if another admin (or this admin from another
    // tab) mutated the patient's status during the 8-second undo
    // window, the client-side guard catches the obvious case
    // immediately. The server-side `expectedUpdatedAt` precondition
    // catches the race that survives this check.
    if (patient.status !== "closed") {
      setFeedback({
        kind: "error",
        text: "Patient was already updated elsewhere — undo skipped to avoid clobbering a newer change.",
      });
      return;
    }
    try {
      await update.mutateAsync({
        id: patient.id,
        data: { status: "active", expectedUpdatedAt: patient.updatedAt },
      });
      await queryClient.invalidateQueries({
        queryKey: getGetPatientQueryKey(patient.id),
      });
      onAfterAction();
      setFeedback({
        kind: "success",
        text: "Close undone — patient is active again.",
      });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setFeedback({
          kind: "error",
          text: "Patient was changed elsewhere during undo — refreshing.",
        });
        await queryClient.invalidateQueries({
          queryKey: getGetPatientQueryKey(patient.id),
        });
        onAfterAction();
        return;
      }
      setFeedback({ kind: "error", text: `Undo failed: ${describe(err)}` });
    }
  }

  const noEpisode = !targetEpisode;
  const isActive = patient.status === "active";
  const sendDisabled = !isActive || noEpisode;
  const sendDisabledHint = !isActive
    ? `Patient is ${humanizeStatus(patient.status).toLowerCase()} — resume to send reminders.`
    : noEpisode
      ? "No episode available — create a prescription first."
      : null;

  return (
    <Card
      title="Quick actions"
      subtitle="Every action writes to the audit log."
    >
      <div className="space-y-3">
        <div>
          <p
            className="text-xs uppercase tracking-wider font-semibold mb-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Reach the patient now
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              isLoading={sms.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !sms.isPending) ||
                !patient.hasPhone
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "SMS reminder",
                  sms.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Send SMS reminder
            </Button>
            <Button
              intent="secondary"
              isLoading={email.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !email.isPending) ||
                !patient.hasEmail
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "Email reminder",
                  email.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Send email reminder
            </Button>
            <Button
              intent="secondary"
              isLoading={voice.isPending}
              disabled={
                sendDisabled ||
                (isMutating && !voice.isPending) ||
                !patient.hasPhone
              }
              onClick={() =>
                targetEpisode &&
                fire(
                  "Voice call",
                  voice.mutateAsync({
                    data: {
                      patientId: patient.id,
                      episodeId: targetEpisode.id,
                    },
                  }),
                )
              }
            >
              Place voice call
            </Button>
          </div>
          {sendDisabledHint && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {sendDisabledHint}
            </p>
          )}
          {!sendDisabled && !patient.hasPhone && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              No phone on file — SMS / voice disabled.
            </p>
          )}
          {!sendDisabled && !patient.hasEmail && (
            <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              No email on file — email disabled.
            </p>
          )}
        </div>

        <div>
          <p
            className="text-xs uppercase tracking-wider font-semibold mb-2"
            style={{ color: "hsl(var(--penn-gold-deep))" }}
          >
            Lifecycle
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {patient.status === "paused" && (
              <Button
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("active")}
              >
                Resume patient
              </Button>
            )}
            {patient.status === "active" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("paused")}
              >
                Pause patient
              </Button>
            )}
            {patient.status !== "closed" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("closed")}
              >
                Close patient
              </Button>
            )}
            {patient.status === "closed" && (
              <Button
                intent="secondary"
                isLoading={update.isPending}
                disabled={isMutating && !update.isPending}
                onClick={() => void changeStatus("active")}
              >
                Reopen patient
              </Button>
            )}
          </div>
        </div>
      </div>

      {closedAt !== null && (
        <div
          className="mt-3 flex items-center justify-between gap-3 rounded border px-3 py-2"
          style={{ borderColor: "#c9a24a", backgroundColor: "#fff8e7" }}
          role="status"
        >
          <span className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
            Patient closed. Reopen?{" "}
            <span style={{ color: "hsl(var(--ink-3))" }}>({secondsLeft}s)</span>
          </span>
          <Button
            intent="secondary"
            isLoading={update.isPending}
            disabled={update.isPending}
            onClick={() => void undoClose()}
          >
            Undo
          </Button>
        </div>
      )}
      {feedback && (
        <p
          className="mt-3 text-sm"
          style={{ color: feedback.kind === "success" ? "#166534" : "#991b1b" }}
          role="status"
        >
          {feedback.text}
        </p>
      )}
    </Card>
  );
}

// ----------------------
// Notes tab
// ----------------------
//
// Append-only admin case-notes. Composer at the top, newest-first
// list below. The empty state nudges admins to leave a note for the
// next person picking up the patient — the goal is to make handoff
// context discoverable.

function NotesTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } =
    useListPatientNotes(patientId);
  const create = useCreatePatientNote();
  const [body, setBody] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Client-side filter. Notes are paginated to 50 server-side, so
  // an in-memory substring filter is more than fast enough for the
  // admin search-as-you-type use case. If we later add deeper
  // history, the filter input becomes the natural place to plumb a
  // server-side `?search=` query.
  const [filter, setFilter] = useState("");

  const trimmed = body.trim();
  const tooLong = trimmed.length > 4000;
  const canSubmit = trimmed.length > 0 && !tooLong && !create.isPending;

  const filterTrimmed = filter.trim().toLowerCase();
  const filteredItems =
    data && filterTrimmed
      ? data.items.filter((n) =>
          (n.body ?? "").toLowerCase().includes(filterTrimmed),
        )
      : (data?.items ?? []);

  async function onAdd() {
    if (!canSubmit) return;
    setSubmitError(null);
    try {
      await create.mutateAsync({ id: patientId, data: { body: trimmed } });
      setBody("");
      // Force the list to refetch — invalidating by query key is the
      // safest way to make sure we don't have a stale cached page.
      await queryClient.invalidateQueries({
        queryKey: getListPatientNotesQueryKey(patientId),
      });
      void refetch();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.data as { message?: string } | undefined)?.message ??
            "Couldn't save note.")
          : err instanceof Error
            ? err.message
            : "Couldn't save note.";
      setSubmitError(msg);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <Label htmlFor="note-body">Add a note</Label>
        <textarea
          id="note-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={3}
          maxLength={4100}
          placeholder="Patient is recovering from minor surgery; pause reminders for 2 weeks…"
          disabled={create.isPending}
          className="w-full rounded border px-3 py-2 text-sm font-sans resize-y"
          style={{
            borderColor: "hsl(var(--line-1))",
            color: "hsl(var(--ink-1))",
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span
            className="text-xs"
            style={{ color: tooLong ? "#b91c1c" : "#6b7280" }}
          >
            {trimmed.length} / 4000 · stored encrypted at rest
          </span>
          <Button
            onClick={() => void onAdd()}
            isLoading={create.isPending}
            disabled={!canSubmit}
          >
            Add note
          </Button>
        </div>
        {submitError && (
          <p className="mt-2 text-sm" style={{ color: "#b91c1c" }} role="alert">
            {submitError}
          </p>
        )}
      </div>

      {isError ? (
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load notes"
        />
      ) : isPending || !data ? (
        <Spinner label="Loading notes…" />
      ) : data.items.length === 0 ? (
        <EmptyState
          title="No notes yet."
          hint="Add the first one to leave context for the next admin."
        />
      ) : (
        <>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter notes…"
              className="flex-1 rounded border px-3 py-2 text-sm"
              style={{
                borderColor: "hsl(var(--line-1))",
                color: "hsl(var(--ink-1))",
              }}
              aria-label="Filter notes"
            />
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {filterTrimmed
                ? `${filteredItems.length} of ${data.items.length}`
                : `${data.items.length} ${data.items.length === 1 ? "note" : "notes"}`}
            </span>
          </div>
          {filteredItems.length === 0 ? (
            <EmptyState
              title="No notes match your filter."
              hint="Clear the filter to see all notes again."
            />
          ) : (
            <ol className="space-y-3">
              {filteredItems.map((n) => (
                <NoteRow key={n.id} note={n} />
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

function NoteRow({ note }: { note: PatientNote }) {
  return (
    <li
      className="rounded border px-3 py-2"
      style={{ borderColor: "hsl(var(--line-1))", backgroundColor: "#fafafa" }}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span
          className="text-xs font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          {note.authorEmail}
        </span>
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(note.createdAt)}
        </span>
      </div>
      <p
        className="text-sm whitespace-pre-wrap break-words"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {note.body}
      </p>
    </li>
  );
}

// ----------------------
// Add-prescription modal
// ----------------------
//
// Used by PrescriptionsTab. Mirrors NewCustomerModal's UX: dimmed
// backdrop, click-outside / Escape closes, single Save button. The
// optional clinical narrative fields (prescriber, NPI, diagnosis,
// notes) are bundled into the encrypted `details` JSON server-side
// — we just pass them through as plain fields on the request.

function AddPrescriptionModal({
  patientId,
  onClose,
  onCreated,
}: {
  patientId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const create = useCreatePrescription();
  const [itemSku, setItemSku] = useState("");
  const [cadenceDays, setCadenceDays] = useState("90");
  const [validFrom, setValidFrom] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [validUntil, setValidUntil] = useState("");
  const [prescriberName, setPrescriberName] = useState("");
  const [prescriberNpi, setPrescriberNpi] = useState("");
  const [diagnosis, setDiagnosis] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const isPending = create.isPending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isPending]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const sku = itemSku.trim();
    if (sku.length === 0) {
      setError("Item SKU is required.");
      return;
    }
    const cadence = Number(cadenceDays);
    if (!Number.isInteger(cadence) || cadence < 1 || cadence > 365) {
      setError("Cadence must be a whole number between 1 and 365.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) {
      setError("Valid-from must be a date.");
      return;
    }
    if (validUntil && !/^\d{4}-\d{2}-\d{2}$/.test(validUntil)) {
      setError("Valid-until must be a date.");
      return;
    }
    if (validUntil && validUntil < validFrom) {
      setError("Valid-until must be on or after valid-from.");
      return;
    }

    const body: {
      itemSku: string;
      cadenceDays: number;
      validFrom: string;
      validUntil?: string | null;
      prescriberName?: string | null;
      prescriberNpi?: string | null;
      diagnosis?: string | null;
      notes?: string | null;
    } = {
      itemSku: sku,
      cadenceDays: cadence,
      validFrom,
    };
    if (validUntil) body.validUntil = validUntil;
    if (prescriberName.trim()) body.prescriberName = prescriberName.trim();
    if (prescriberNpi.trim()) body.prescriberNpi = prescriberNpi.trim();
    if (diagnosis.trim()) body.diagnosis = diagnosis.trim();
    if (notes.trim()) body.notes = notes.trim();

    try {
      await create.mutateAsync({ id: patientId, data: body });
      onCreated();
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.data as { message?: string } | undefined)?.message ??
            "Couldn't create prescription.")
          : err instanceof Error
            ? err.message
            : "Couldn't create prescription.";
      setError(msg);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-rx-title"
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <h2
            id="add-rx-title"
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            New prescription
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Clinical fields are immutable after save. To "edit" later, add a new
            prescription and mark this one expired.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="rx-sku">Item SKU</Label>
              <Input
                id="rx-sku"
                value={itemSku}
                maxLength={64}
                onChange={(e) => setItemSku(e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rx-cadence">Cadence (days)</Label>
              <Input
                id="rx-cadence"
                type="number"
                min={1}
                max={365}
                value={cadenceDays}
                onChange={(e) => setCadenceDays(e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rx-from">Valid from</Label>
              <Input
                id="rx-from"
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rx-until">Valid until (optional)</Label>
              <Input
                id="rx-until"
                type="date"
                value={validUntil}
                onChange={(e) => setValidUntil(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="rx-prescriber">Prescriber name</Label>
              <Input
                id="rx-prescriber"
                value={prescriberName}
                maxLength={160}
                onChange={(e) => setPrescriberName(e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="rx-npi">Prescriber NPI</Label>
              <Input
                id="rx-npi"
                value={prescriberNpi}
                maxLength={20}
                onChange={(e) => setPrescriberNpi(e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="rx-diag">Diagnosis</Label>
              <textarea
                id="rx-diag"
                value={diagnosis}
                onChange={(e) => setDiagnosis(e.target.value)}
                maxLength={2000}
                rows={2}
                disabled={isPending}
                className="w-full rounded border px-3 py-2 text-sm font-sans resize-y"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-1))",
                }}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="rx-notes">Notes</Label>
              <textarea
                id="rx-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={2000}
                rows={2}
                disabled={isPending}
                className="w-full rounded border px-3 py-2 text-sm font-sans resize-y"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-1))",
                }}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              intent="secondary"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" isLoading={isPending} disabled={isPending}>
              Save prescription
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ----------------------
// Follow-ups tab (Phase 19)
// ----------------------
//
// Patient-side parity with the shop_customer_followups panel
// (Phase 17). Composer + open queue ascending by due_at; overdue
// rows render in rose for instant visual triage. Completed
// followups don't show — they live in the audit log.

const FOLLOWUP_MAX_BODY = 2000;

function FollowupsTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [dueLocal, setDueLocal] = useState(defaultFollowupDueLocal());
  const [submitError, setSubmitError] = useState<string | null>(null);

  const queryKey = ["admin", "patients", patientId, "followups"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => listAdminPatientFollowups(patientId),
  });

  const createMutation = useMutation({
    mutationFn: ({ body, dueAt }: { body: string; dueAt: Date }) =>
      createAdminPatientFollowup(patientId, body, dueAt),
    onSuccess: () => {
      setBody("");
      setDueLocal(defaultFollowupDueLocal());
      setSubmitError(null);
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      setSubmitError(
        err instanceof Error ? err.message : "Failed to schedule followup.",
      );
    },
  });

  const completeMutation = useMutation({
    mutationFn: (followupId: string) =>
      completeAdminPatientFollowup(patientId, followupId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const trimmed = body.trim();
  const tooLong = trimmed.length > FOLLOWUP_MAX_BODY;
  const dueAtParsed = parseFollowupDueLocal(dueLocal);
  const validDate = dueAtParsed !== null && !isNaN(dueAtParsed.getTime());
  const canSubmit =
    trimmed.length > 0 && !tooLong && validDate && !createMutation.isPending;

  const completingId = completeMutation.isPending
    ? ((completeMutation.variables as string | undefined) ?? null)
    : null;

  return (
    <div className="space-y-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!canSubmit || dueAtParsed === null) return;
          createMutation.mutate({ body: trimmed, dueAt: dueAtParsed });
        }}
        className="space-y-2"
        data-testid="patient-followups-form"
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What do you need to do (e.g. 'Call about Rx renewal')?"
          rows={2}
          maxLength={FOLLOWUP_MAX_BODY + 200}
          disabled={createMutation.isPending}
          className="w-full rounded border px-3 py-2 text-sm font-sans"
          style={{ borderColor: "hsl(var(--line-1))" }}
          data-testid="patient-followups-body"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="patient-followup-due">Due</Label>
          <input
            id="patient-followup-due"
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            disabled={createMutation.isPending}
            className="rounded border px-2 py-1 text-xs"
            style={{ borderColor: "hsl(var(--line-1))" }}
            data-testid="patient-followups-due"
          />
          <span
            className="ml-auto text-xs"
            style={{ color: tooLong ? "#b91c1c" : "hsl(var(--ink-3))" }}
          >
            {trimmed.length} / {FOLLOWUP_MAX_BODY}
          </span>
          <Button
            type="submit"
            size="sm"
            disabled={!canSubmit}
            isLoading={createMutation.isPending}
            data-testid="patient-followups-submit"
          >
            Schedule
          </Button>
        </div>
        {submitError && (
          <p className="text-xs" style={{ color: "#b91c1c" }} role="alert">
            {submitError}
          </p>
        )}
      </form>

      <FollowupsList
        isPending={isPending}
        isError={isError}
        error={error}
        followups={data?.followups ?? []}
        onComplete={(id) => completeMutation.mutate(id)}
        completingId={completingId}
      />
    </div>
  );
}

function FollowupsList({
  isPending,
  isError,
  error,
  followups,
  onComplete,
  completingId,
}: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  followups: AdminPatientFollowup[];
  onComplete: (id: string) => void;
  completingId: string | null;
}) {
  if (isPending) {
    return <Spinner label="Loading followups…" />;
  }
  if (isError) {
    if (error instanceof AdminPatientFollowupsNotFoundError) {
      return (
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Patient not found.
        </p>
      );
    }
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
        Failed to load followups.
      </p>
    );
  }
  if (followups.length === 0) {
    return (
      <EmptyState
        title="No open follow-ups."
        hint="Schedule one above to commit to a callback."
      />
    );
  }
  const now = Date.now();
  return (
    <ul className="space-y-2" data-testid="patient-followups-list">
      {followups.map((f) => {
        const due = new Date(f.dueAt).getTime();
        const overdue = due < now;
        return (
          <li
            key={f.id}
            className="rounded border p-3 flex gap-3 items-start"
            style={{
              borderColor: overdue ? "#fecaca" : "hsl(var(--line-1))",
              backgroundColor: overdue ? "#fef2f2" : "#ffffff",
            }}
          >
            <div className="flex-1 min-w-0">
              <div
                className="text-xs mb-1"
                style={{
                  color: overdue ? "#b91c1c" : "hsl(var(--ink-3))",
                  fontWeight: overdue ? 600 : 400,
                }}
              >
                {overdue ? "Overdue · " : "Due "}
                {formatDateTime(f.dueAt)} · {f.createdByEmail}
              </div>
              <div
                className="text-sm whitespace-pre-wrap break-words"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {f.body}
              </div>
            </div>
            <Button
              size="sm"
              intent="secondary"
              disabled={completingId !== null}
              onClick={() => onComplete(f.id)}
              data-testid={`patient-followups-complete-${f.id}`}
            >
              {completingId === f.id ? "Saving…" : "Done"}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

function defaultFollowupDueLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseFollowupDueLocal(s: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// ----------------------
// Onboarding tab (Phase F.3 — Phase B.1 follow-up)
// ----------------------
//
// First-90-day adherence-coaching enrollment + per-day status.
// Renders three modes:
//   * Loading      — initial fetch.
//   * Not enrolled — single "Enroll" button. Defaults startedAt
//                    to NOW so the day-1 nudge fires tomorrow.
//   * Enrolled     — status pill + per-day timestamps + a
//                    Pause/Resume toggle.

function OnboardingTab({ patientId }: { patientId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ["admin", "patients", patientId, "onboarding"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => fetchPatientOnboarding(patientId),
  });

  const enrollMut = useMutation({
    mutationFn: () => enrollPatientOnboarding(patientId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  const statusMut = useMutation({
    mutationFn: (status: "active" | "paused") =>
      setPatientOnboardingStatus(patientId, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });

  if (isPending) return <Spinner label="Loading onboarding…" />;
  if (isError) {
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }}>
        {error instanceof Error ? error.message : "Failed to load."}
      </p>
    );
  }

  if (!data.journey) {
    return (
      <div className="space-y-3">
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          This patient is not yet enrolled in the 90-day adherence program.
          Enrolling kicks off the day-1 / 7 / 30 / 90 SendGrid cadence; you can
          pause anytime.
        </p>
        {enrollMut.isError && (
          <p className="text-xs" style={{ color: "#b91c1c" }}>
            {enrollMut.error instanceof Error
              ? enrollMut.error.message
              : "Failed to enroll."}
          </p>
        )}
        <Button
          onClick={() => enrollMut.mutate()}
          isLoading={enrollMut.isPending}
          disabled={enrollMut.isPending}
          data-testid="patient-onboarding-enroll"
        >
          Enroll in 90-day program
        </Button>
      </div>
    );
  }

  const j = data.journey;
  return (
    <div className="space-y-4">
      <OnboardingJourneyView
        journey={j}
        onPauseToggle={(next) => statusMut.mutate(next)}
        toggling={statusMut.isPending}
        toggleError={
          statusMut.error instanceof Error ? statusMut.error.message : null
        }
      />
    </div>
  );
}

function OnboardingJourneyView({
  journey,
  onPauseToggle,
  toggling,
  toggleError,
}: {
  journey: PatientOnboardingJourney;
  onPauseToggle: (status: "active" | "paused") => void;
  toggling: boolean;
  toggleError: string | null;
}) {
  const isActive = journey.status === "active";
  const canToggle = journey.status !== "completed";
  const days: Array<{
    label: string;
    sentAt: string | null;
    offsetDays: number;
  }> = [
    { label: "Day 1", sentAt: journey.day1SentAt, offsetDays: 1 },
    { label: "Day 7", sentAt: journey.day7SentAt, offsetDays: 7 },
    { label: "Day 30", sentAt: journey.day30SentAt, offsetDays: 30 },
    { label: "Day 90", sentAt: journey.day90SentAt, offsetDays: 90 },
  ];
  const startedMs = new Date(journey.startedAt).getTime();
  const now = Date.now();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={
            journey.status === "completed"
              ? "success"
              : journey.status === "paused"
                ? "muted"
                : "info"
          }
        >
          {journey.status}
        </Badge>
        <span
          className="text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
          data-testid="patient-onboarding-started-at"
        >
          Started {formatDateTime(journey.startedAt)} · enrolled by{" "}
          {journey.enrolledByEmail}
        </span>
      </div>

      <ul className="space-y-2" data-testid="patient-onboarding-day-list">
        {days.map((d) => {
          const dueAt = startedMs + d.offsetDays * 24 * 60 * 60 * 1000;
          const sent = d.sentAt !== null;
          const due = !sent && now >= dueAt;
          return (
            <li
              key={d.label}
              className="rounded border p-3 flex items-center gap-3"
              style={{
                borderColor: sent
                  ? "#bbf7d0"
                  : due
                    ? "#fecaca"
                    : "hsl(var(--line-1))",
                backgroundColor: sent ? "#f0fdf4" : due ? "#fef2f2" : "#ffffff",
              }}
            >
              <Badge variant={sent ? "success" : due ? "danger" : "muted"}>
                {sent ? "sent" : due ? "due" : "scheduled"}
              </Badge>
              <span
                className="text-sm font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                {d.label}
              </span>
              <span
                className="text-xs ml-auto"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {sent
                  ? `sent ${formatDateTime(d.sentAt!)}`
                  : `${due ? "due" : "scheduled for"} ${formatDate(new Date(dueAt).toISOString())}`}
              </span>
            </li>
          );
        })}
      </ul>

      {canToggle && (
        <div className="flex items-center gap-2">
          <Button
            intent="secondary"
            size="sm"
            onClick={() => onPauseToggle(isActive ? "paused" : "active")}
            isLoading={toggling}
            disabled={toggling}
            data-testid="patient-onboarding-toggle-status"
          >
            {isActive ? "Pause cadence" : "Resume cadence"}
          </Button>
          {toggleError && (
            <span className="text-xs" style={{ color: "#b91c1c" }}>
              {toggleError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Fax-outreach tab (Phase G.6 SPA half).
//
// Two views in one card:
//   1. Compose form — physician name, fax (E.164), optional Rx
//      association, cover letter. POSTs to
//      /admin/physician-fax-outreach.
//   2. History list — most-recent-first table of past outreach,
//      with status pill + provider hint when set.
//
// CSR-side workflow: when a patient writes back "please just talk
// to my doctor", the CSR opens this tab, picks the active Rx from
// the dropdown, fills physician contact, hits Send. The row lands
// in `pending` until the deployer wires a fax vendor (Phase G.6
// scaffolds the data path; the dispatcher is a follow-up).
// ---------------------------------------------------------------------

function FaxOutreachTab({
  patientId,
  prescriptions,
}: {
  patientId: string;
  prescriptions: Prescription[];
}) {
  const [rows, setRows] = useState<PhysicianFaxOutreachRow[] | null>(null);
  const [providerConfigured, setProviderConfigured] = useState<boolean | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const r = await listPatientPhysicianFaxOutreach(patientId);
      setRows(r.outreach);
      setProviderConfigured(r.providerConfigured);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  // Compose form local state.
  const [physicianName, setPhysicianName] = useState("");
  const [physicianFax, setPhysicianFax] = useState("");
  const [coverLetter, setCoverLetter] = useState("");
  const [prescriptionId, setPrescriptionId] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function submit() {
    setSubmitError(null);
    setSubmitting(true);
    try {
      await createPhysicianFaxOutreach({
        patientId,
        prescriptionId: prescriptionId === "" ? null : prescriptionId,
        physicianName: physicianName.trim(),
        physicianFaxE164: physicianFax.trim(),
        coverLetterText: coverLetter,
      });
      setPhysicianName("");
      setPhysicianFax("");
      setCoverLetter("");
      setPrescriptionId("");
      await refresh();
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
          Send a fax-outreach
        </h3>
        <p className="text-xs text-muted-foreground mt-1">
          Asks the prescribing physician&apos;s office to renew the
          patient&apos;s CPAP prescription. The cover letter is faxed verbatim —
          keep it professional.
        </p>
        {!providerConfigured && (
          <p
            className="text-xs text-amber-700 mt-2"
            data-testid="fax-outreach-provider-warning"
          >
            No fax vendor is wired in this environment yet. Submitted requests
            will be queued (status &lsquo;pending&rsquo;) until a deployer sets{" "}
            <code>FAX_VENDOR / FAX_API_KEY / FAX_FROM_NUMBER</code>.
          </p>
        )}
      </div>

      <div className="space-y-3">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <Label htmlFor="fax-outreach-name">Physician name</Label>
            <Input
              id="fax-outreach-name"
              value={physicianName}
              onChange={(e) => setPhysicianName(e.target.value)}
              placeholder="Dr. Anna Stein"
              data-testid="fax-outreach-physician-name"
            />
          </div>
          <div>
            <Label htmlFor="fax-outreach-fax">Fax number (E.164)</Label>
            <Input
              id="fax-outreach-fax"
              value={physicianFax}
              onChange={(e) => setPhysicianFax(e.target.value)}
              placeholder="+12155551212"
              data-testid="fax-outreach-fax-number"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="fax-outreach-rx">Prescription (optional)</Label>
          <Select
            id="fax-outreach-rx"
            value={prescriptionId}
            onChange={(e) => setPrescriptionId(e.target.value)}
            emptyOptionLabel="—"
            options={prescriptions.map((p) => ({
              value: p.id,
              label: `${p.itemSku} (valid until ${p.validUntil ?? "no expiry"}) [${p.status}]`,
            }))}
            data-testid="fax-outreach-prescription"
          />
        </div>
        <div>
          <Label htmlFor="fax-outreach-cover">
            Cover letter (faxed verbatim)
          </Label>
          <textarea
            id="fax-outreach-cover"
            value={coverLetter}
            onChange={(e) => setCoverLetter(e.target.value)}
            rows={6}
            maxLength={8000}
            className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
            placeholder="Dear Dr. Stein, our patient is due for a CPAP supply renewal…"
            data-testid="fax-outreach-cover-letter"
          />
          <div className="text-[11px] text-muted-foreground mt-1">
            {coverLetter.length} / 8000 characters (minimum 20)
          </div>
        </div>
        <div className="flex justify-end gap-2 items-center">
          {submitError && (
            <span
              className="text-xs text-rose-700"
              role="alert"
              data-testid="fax-outreach-submit-error"
            >
              {submitError}
            </span>
          )}
          <Button
            disabled={
              submitting ||
              physicianName.trim().length === 0 ||
              physicianFax.trim().length === 0 ||
              coverLetter.trim().length < 20 ||
              coverLetter.length > 8000
            }
            onClick={() => void submit()}
            data-testid="fax-outreach-submit"
          >
            {submitting ? "Sending…" : "Send fax-outreach"}
          </Button>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
          History
        </h3>
        {loading && <Spinner label="Loading fax-outreach history…" />}
        {!loading && error && <ErrorPanel error={error} onRetry={refresh} />}
        {!loading && !error && (rows?.length ?? 0) === 0 && (
          <EmptyState
            title="No fax-outreach yet"
            hint="Use the form above to send the first one."
          />
        )}
        {!loading && !error && rows && rows.length > 0 && (
          <ul
            className="space-y-2 mt-2"
            data-testid="fax-outreach-history-list"
          >
            {rows.map((r) => (
              <FaxOutreachRow key={r.id} row={r} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FaxOutreachRow({ row }: { row: PhysicianFaxOutreachRow }) {
  const created = formatDateTime(row.createdAt);
  const sent = row.sentAt ? formatDateTime(row.sentAt) : null;
  const statusColor =
    row.status === "delivered"
      ? "#047857"
      : row.status === "failed"
        ? "#b91c1c"
        : row.status === "sent"
          ? "#0a1f44"
          : "#6b7280";
  return (
    <li
      className="rounded border border-border/40 p-3 text-sm"
      data-testid={`fax-outreach-row-${row.id}`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="font-medium text-[hsl(var(--penn-navy))]">
          {row.physicianName}
        </div>
        <span
          className="text-[11px] uppercase tracking-wide font-semibold"
          style={{ color: statusColor }}
        >
          {row.status}
        </span>
      </div>
      <div className="text-xs text-muted-foreground mt-1">
        Fax {row.physicianFaxE164} ·{" "}
        {sent ? `sent ${sent}` : `requested ${created}`}
        {row.createdByEmail ? ` by ${row.createdByEmail}` : ""}
      </div>
      {row.failureReason && (
        <div className="text-xs text-rose-700 mt-1">
          Failure: {row.failureReason}
        </div>
      )}
      {row.vendorRef && (
        <div className="text-[11px] text-muted-foreground mt-1">
          Vendor: {row.vendorName ?? "?"} · ref {row.vendorRef}
        </div>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Documents tab — patient-uploaded insurance cards, prescriptions, etc.
// ---------------------------------------------------------------------------

function formatDocBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function DocumentsTab({ patientId }: { patientId: string }) {
  const [docs, setDocs] = useState<AdminPatientDocument[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // noteOpenId: which doc has the note field expanded (for explicit mark-reviewed)
  const [noteOpenId, setNoteOpenId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState("");
  const [reviewingId, setReviewingId] = useState<string | null>(null);
  // markingAllReviewed: bulk action in flight
  const [markingAll, setMarkingAll] = useState(false);

  async function load() {
    setLoadError(null);
    try {
      const rows = await listPatientDocuments(patientId);
      setDocs(rows);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Couldn't load documents.");
    }
  }

  useEffect(() => {
    void load();
  }, [patientId]);

  function openNoteField(docId: string) {
    setNoteOpenId(docId);
    setNoteText("");
  }

  function closeNoteField() {
    setNoteOpenId(null);
    setNoteText("");
  }

  async function handleMarkReviewed(doc: AdminPatientDocument, note?: string) {
    if (doc.reviewedAt) return;
    setReviewingId(doc.id);
    try {
      await markPatientDocumentReviewed(patientId, doc.id, note || undefined);
      const now = new Date().toISOString();
      setDocs((prev) =>
        prev
          ? prev.map((d) =>
              d.id === doc.id
                ? { ...d, reviewedAt: now, reviewNote: note ?? null }
                : d,
            )
          : prev,
      );
      closeNoteField();
    } catch {
      // Non-fatal: badge stays, CSR can try again.
    } finally {
      setReviewingId(null);
    }
  }

  async function handleMarkAllReviewed() {
    if (!docs) return;
    const unreviewed = docs.filter((d) => !d.reviewedAt);
    if (unreviewed.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    for (const doc of unreviewed) {
      try {
        await markPatientDocumentReviewed(patientId, doc.id);
      } catch {
        // best-effort — carry on
      }
    }
    setDocs((prev) =>
      prev
        ? prev.map((d) => (!d.reviewedAt ? { ...d, reviewedAt: now } : d))
        : prev,
    );
    setMarkingAll(false);
  }

  async function handleDelete(doc: AdminPatientDocument) {
    if (
      !window.confirm(
        `Delete "${doc.filename ?? "this document"}"? This cannot be undone.`,
      )
    ) {
      return;
    }
    setDeletingId(doc.id);
    setDeleteError(null);
    try {
      await deletePatientDocument(patientId, doc.id);
      await load();
    } catch (err) {
      setDeleteError(
        err instanceof Error ? err.message : "Couldn't delete document.",
      );
    } finally {
      setDeletingId(null);
    }
  }

  if (loadError) {
    return (
      <ErrorPanel
        error={new Error(loadError)}
        onRetry={() => void load()}
        title="Couldn't load documents"
      />
    );
  }

  if (docs === null) {
    return <Spinner label="Loading documents…" />;
  }

  const unreviewedCount = docs.filter((d) => !d.reviewedAt).length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm">Patient-uploaded documents</h3>
          {unreviewedCount > 0 && (
            <span
              className="text-xs font-semibold rounded-full px-2 py-0.5"
              style={{ background: "#fef3c7", color: "#92400e" }}
              title={`${unreviewedCount} unreviewed`}
            >
              {unreviewedCount} new
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {unreviewedCount > 1 && (
            <button
              type="button"
              disabled={markingAll}
              onClick={() => void handleMarkAllReviewed()}
              className="text-xs underline disabled:opacity-40"
              style={{
                color: markingAll ? "#9ca3af" : "#047857",
                background: "none",
                border: "none",
                cursor: markingAll ? "not-allowed" : "pointer",
                font: "inherit",
              }}
            >
              {markingAll ? "Marking all…" : `Mark all ${unreviewedCount} reviewed`}
            </button>
          )}
          <span className="text-xs text-muted-foreground">
            {docs.length} document{docs.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      {deleteError && (
        <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
          {deleteError}
        </p>
      )}
      {docs.length === 0 ? (
        <EmptyState title="No documents uploaded yet." />
      ) : (
        <ul className="divide-y divide-border/40">
          {docs.map((doc) => {
            const isNew = !doc.reviewedAt;
            const isReviewing = reviewingId === doc.id;
            const isDeleting = deletingId === doc.id;
            const noteOpen = noteOpenId === doc.id;
            return (
              <li
                key={doc.id}
                className="py-3 space-y-2"
                style={isNew ? { background: "hsl(47 100% 97%)" } : undefined}
              >
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      {isNew && (
                        <span
                          className="text-xs font-bold rounded-full px-2 py-0.5 shrink-0"
                          style={{ background: "#fef3c7", color: "#92400e" }}
                        >
                          New
                        </span>
                      )}
                      <span
                        className="text-xs font-semibold rounded-full px-2 py-0.5"
                        style={{
                          background: "hsl(var(--ink-1)/0.08)",
                          color: "hsl(var(--ink-1))",
                        }}
                      >
                        {DOCUMENT_TYPE_LABELS[doc.documentType] ?? doc.documentType}
                      </span>
                      <a
                        href={patientDocumentDownloadUrl(patientId, doc.id)}
                        target="_blank"
                        rel="noopener"
                        download={doc.filename ?? undefined}
                        className="text-sm font-medium underline truncate"
                        style={{ color: "#1d4ed8" }}
                      >
                        {doc.filename ?? "Document"}
                      </a>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDocBytes(doc.sizeBytes)} ·{" "}
                      {new Date(doc.createdAt).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                      {doc.reviewedAt && (
                        <span>
                          {" "}
                          · Reviewed{" "}
                          {new Date(doc.reviewedAt).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })}
                        </span>
                      )}
                    </p>
                    {doc.reviewNote && (
                      <p
                        className="text-xs mt-1 italic"
                        style={{ color: "hsl(var(--ink-2))" }}
                      >
                        "{doc.reviewNote}"
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    {isNew && !noteOpen && (
                      <button
                        type="button"
                        disabled={isReviewing || isDeleting || markingAll}
                        onClick={() => openNoteField(doc.id)}
                        className="text-xs underline disabled:opacity-40"
                        style={{
                          color: "#047857",
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          font: "inherit",
                        }}
                      >
                        Mark reviewed
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={isDeleting || isReviewing || markingAll}
                      onClick={() => void handleDelete(doc)}
                      className="text-xs underline disabled:opacity-40"
                      style={{
                        color: isDeleting ? "#9ca3af" : "#b91c1c",
                        background: "none",
                        border: "none",
                        cursor: isDeleting ? "not-allowed" : "pointer",
                        font: "inherit",
                      }}
                    >
                      {isDeleting ? "Deleting…" : "Delete"}
                    </button>
                  </div>
                </div>

                {/* Inline note field — expands when "Mark reviewed" is clicked */}
                {noteOpen && (
                  <div className="pl-2 space-y-1.5">
                    <textarea
                      value={noteText}
                      onChange={(e) => setNoteText(e.target.value)}
                      placeholder="Optional note (e.g. &quot;Insurance card verified — expires 12/2026&quot;)"
                      maxLength={500}
                      rows={2}
                      disabled={isReviewing}
                      className="w-full rounded-md border border-border/60 bg-white px-3 py-1.5 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(var(--penn-navy)/0.3)] disabled:opacity-50"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={isReviewing}
                        onClick={() => void handleMarkReviewed(doc, noteText)}
                        className="text-xs font-semibold px-3 py-1 rounded-md disabled:opacity-40"
                        style={{
                          background: isReviewing ? "#d1d5db" : "#047857",
                          color: "#fff",
                          border: "none",
                          cursor: isReviewing ? "not-allowed" : "pointer",
                        }}
                      >
                        {isReviewing ? "Marking…" : "Confirm reviewed"}
                      </button>
                      <button
                        type="button"
                        disabled={isReviewing}
                        onClick={closeNoteField}
                        className="text-xs underline disabled:opacity-40"
                        style={{
                          background: "none",
                          border: "none",
                          cursor: "pointer",
                          color: "hsl(var(--ink-3))",
                          font: "inherit",
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
