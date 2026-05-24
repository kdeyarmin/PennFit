// Patient-detail "Prescriptions" tab — the patient's clinical
// orders + attachment management surface.
//
// Renders the prescription table (status badges + attachment
// cell + SWO PDF generator + mark-expired / revoke actions),
// plus the AddPrescriptionModal launched by the "+ Add
// prescription" button.
//
// Helpers MAX_ATTACHMENT_BYTES / ATTACHMENT_ACCEPT / formatBytes
// + GenerateSwoButton + PrescriptionAttachmentCell are scoped to
// this file -- they're not used anywhere else.

import { useEffect, useState } from "react";

import {
  ApiError,
  useCreatePrescription,
  useUpdatePrescriptionStatus,
  type PatientPrescription,
} from "@workspace/api-client-react/admin";

import { Badge, humanizeStatus } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { EmptyState } from "@/components/admin/EmptyState";
import { Input, Label } from "@/components/admin/Input";
import { Table, type Column } from "@/components/admin/Table";
import { openPdfInNewTab, summarizePdfError } from "@/lib/admin/pdf-download";
import { formatDate } from "@/lib/admin/format";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  prescriptionAttachmentDownloadUrl,
  removePrescriptionAttachment,
  uploadPrescriptionAttachment,
} from "@/lib/admin/prescription-attachment";
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

/**
 * Render the prescriptions management tab including a table of prescriptions, attachment upload/remove controls, status change actions, SWO generation, and an "Add prescription" modal.
 *
 * The component shows per-row busy state for status and attachment operations, displays action-level errors, and uses a confirm dialog for destructive actions.
 *
 * @param patientId - ID of the patient whose prescriptions are shown
 * @param prescriptions - List of prescriptions to display in the table
 * @param onChanged - Callback invoked after a successful change (create, status update, attachment add/remove) to refresh data
 * @returns The React element for the prescriptions management tab
 */
export function PrescriptionsTab({
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
  const [confirm, ConfirmDialogEl] = useConfirmDialog();

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
      !(await confirm({
        title: "Remove attached document?",
        description:
          "The patient's record will no longer link to it.",
        confirmLabel: "Remove",
        destructive: true,
      }))
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
      !(await confirm({
        title: `${verb.charAt(0).toUpperCase() + verb.slice(1)} prescription?`,
        description: `Are you sure you want to ${verb} this prescription?`,
        confirmLabel: verb,
        destructive: nextStatus === "revoked",
      }))
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
      key: "hcpcs",
      header: "HCPCS",
      render: (r) => r.hcpcsCode ?? "—",
    },
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
        r.status === "active" || r.status === "expired" ? (
          <div className="flex gap-2 justify-end flex-wrap">
            {r.status === "active" && (
              <GenerateSwoButton
                patientId={patientId}
                rx={r}
                onError={(msg) => setActionError(msg)}
              />
            )}
            {r.status === "active" && (
              <>
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
              </>
            )}
          </div>
        ) : null,
    },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          Clinical fields are immutable after creation — to edit, add a new
          one and mark the old one expired.
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
      {ConfirmDialogEl}
    </div>
  );
}

// Inline button for the prescription row actions column. Pre-flights
// the SWO endpoint (which returns 422 on incomplete inputs — missing
// HCPCS code or unlinked provider) and either opens the PDF in a new
// tab or surfaces the issue list inline on the prescriptions table.
function GenerateSwoButton({
  patientId,
  rx,
  onError,
}: {
  patientId: string;
  rx: Prescription;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const result = await openPdfInNewTab(
        `/resupply-api/admin/patients/${encodeURIComponent(
          patientId,
        )}/prescriptions/${encodeURIComponent(rx.id)}/swo`,
      );
      if (!result.ok) {
        onError(`SWO: ${summarizePdfError(result.error)}`);
      }
    } finally {
      setBusy(false);
    }
  }

  // Disable when we already know the row is missing a required field.
  // The route still validates server-side; the UI gate is purely to
  // save the click-and-toast cycle.
  const missingHcpcs = !rx.hcpcsCode;
  const missingProvider = !rx.providerId;
  const disabledTitle = missingHcpcs
    ? "Add an HCPCS code on this prescription first"
    : missingProvider
      ? "Link a provider in the registry first"
      : undefined;

  return (
    <Button
      intent="secondary"
      isLoading={busy}
      disabled={busy || missingHcpcs || missingProvider}
      onClick={() => void handleClick()}
      title={disabledTitle}
    >
      Generate SWO
    </Button>
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
        role="button"
        tabIndex={isBusy || isDisabled ? -1 : 0}
        aria-disabled={isBusy || isDisabled}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && !isBusy && !isDisabled) {
            e.preventDefault();
            document.getElementById(inputId)?.click();
          }
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

// "New prescription" modal launched by the "+ Add prescription"
// button on the tab header. Centered overlay; click-outside
// dismisses (unless a save is in flight), Esc dismisses, the form
// posts to useCreatePrescription on submit. Clinical fields
// (HCPCS, prescriber NPI, diagnosis) are immutable post-save.
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
  const [hcpcsCode, setHcpcsCode] = useState("");
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
    const hcpcs = hcpcsCode.trim().toUpperCase();
    if (hcpcs && !/^[A-Z]\d{4}(-[A-Z0-9]{2}){0,4}$/.test(hcpcs)) {
      setError(
        "HCPCS must be a code like E0601, optionally with modifiers (e.g. A7030-KX).",
      );
      return;
    }

    const body: {
      itemSku: string;
      cadenceDays: number;
      validFrom: string;
      validUntil?: string | null;
      hcpcsCode?: string | null;
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
    if (hcpcs) body.hcpcsCode = hcpcs;
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
              <Label htmlFor="rx-hcpcs">HCPCS code (optional)</Label>
              <Input
                id="rx-hcpcs"
                value={hcpcsCode}
                maxLength={12}
                placeholder="e.g. E0601 or A7030-KX"
                onChange={(e) => setHcpcsCode(e.target.value)}
                disabled={isPending}
                autoComplete="off"
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
