// Patient-detail "Fax outreach" tab (Phase G.6 SPA half) — extracted
// from patient-detail.tsx.
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

import { useEffect, useState } from "react";
import { type PatientPrescription } from "@workspace/api-client-react/admin";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import {
  createPhysicianFaxOutreach,
  listPatientPhysicianFaxOutreach,
  type PhysicianFaxOutreachRow,
} from "@/lib/admin/physician-fax-outreach-api";

// Single-source the prescription row shape from the generated
// OpenAPI client so the dropdown cannot drift from the contract.
type Prescription = PatientPrescription;

export function FaxOutreachTab({
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
    // Cancellation guard: if patientId changes (or the tab unmounts) while
    // a load is in flight, a slow earlier response must not overwrite the
    // newer patient's data. Mirrors the house pattern in shop.tsx /
    // account.tsx. (The manual refresh() above is used by submit(), where
    // the patientId can't change mid-flight, so it needs no guard.)
    let cancelled = false;
    setLoading(true);
    setError(null);
    listPatientPhysicianFaxOutreach(patientId)
      .then((r) => {
        if (cancelled) return;
        setRows(r.outreach);
        setProviderConfigured(r.providerConfigured);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
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
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-semibold text-[hsl(var(--penn-navy))]">
            Send a fax-outreach
          </h3>
          <a
            href={`/admin/patients/${encodeURIComponent(patientId)}/prescription-requests`}
            className="text-xs font-semibold text-[hsl(var(--penn-navy))] hover:underline whitespace-nowrap"
            title="Send a pre-populated Rx the physician can sign as-is"
          >
            Rx packets (sign-and-return) →
          </a>
        </div>
        <p className="text-xs text-muted-foreground mt-1">
          Asks the prescribing physician&apos;s office to renew the
          patient&apos;s CPAP prescription. The cover letter is faxed verbatim —
          keep it professional. For a fully pre-populated, fillable prescription
          the physician can sign as-is and fax back, use{" "}
          <strong>Rx packets</strong> instead.
        </p>
        {!providerConfigured && (
          <p
            className="text-xs text-amber-700 mt-2"
            data-testid="fax-outreach-provider-warning"
          >
            No fax vendor is wired in this environment yet. Submitted requests
            will be queued (status &lsquo;pending&rsquo;) until a deployer sets{" "}
            <code>
              TELNYX_API_KEY / TELNYX_FAX_CONNECTION_ID / TELNYX_FAX_FROM_NUMBER
            </code>
            .
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
