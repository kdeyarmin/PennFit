// /admin/billing/manual-claim — hand-keyed claim entry (Biller #32).
//
// The exception path: a corrected (7), void/replacement (8), or
// paper-backup original (1) claim, keyed by a biller for a patient. It
// creates a `draft` that feeds the same scrub→submit pipeline; on
// success we deep-link to the patient's claim workbench to add lines +
// submit. Frequency 7/8 requires the original payer claim number (the
// server enforces this too).
//
// patients.update-gated server-side; nav gated to match.

import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { FilePlus2 } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createManualClaim,
  type ClaimFrequencyCode,
} from "@/lib/admin/manual-claim-api";

const FREQUENCIES: ReadonlyArray<{ value: ClaimFrequencyCode; label: string }> =
  [
    {
      value: "1",
      label: "1 — Original (paper backup / not from a fulfillment)",
    },
    { value: "7", label: "7 — Replacement of a prior claim (correction)" },
    { value: "8", label: "8 — Void / cancel a prior claim" },
  ];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function AdminBillingManualClaimPage() {
  const [, navigate] = useLocation();
  const [patientId, setPatientId] = useState("");
  const [payerName, setPayerName] = useState("");
  const [dateOfService, setDateOfService] = useState("");
  const [frequency, setFrequency] = useState<ClaimFrequencyCode>("1");
  const [originalClaimNumber, setOriginalClaimNumber] = useState("");
  const [claimNumber, setClaimNumber] = useState("");
  const [notes, setNotes] = useState("");

  const isAdjustment = frequency === "7" || frequency === "8";

  const valid =
    patientId.trim() !== "" &&
    payerName.trim() !== "" &&
    ISO_DATE.test(dateOfService.trim()) &&
    (!isAdjustment || originalClaimNumber.trim() !== "");

  const create = useMutation({
    mutationFn: () =>
      createManualClaim(patientId.trim(), {
        payerName: payerName.trim(),
        dateOfService: dateOfService.trim(),
        claimFrequencyCode: frequency,
        originalClaimNumber: isAdjustment ? originalClaimNumber.trim() : null,
        claimNumber: claimNumber.trim() || null,
        notes: notes.trim() || null,
      }),
    onSuccess: (res) => {
      // Jump to the patient's billing workbench to add lines + submit.
      navigate(`/admin/patients/${patientId.trim()}?claim=${res.id}`);
    },
  });

  return (
    <div
      className="admin-root p-6 space-y-6 max-w-2xl"
      data-testid="admin-manual-claim-page"
    >
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FilePlus2 className="h-6 w-6" />
          Manual claim entry
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Key a corrected, void/replacement, or paper-backup claim by hand. It
          starts as a draft in the normal scrub → submit pipeline; you&apos;ll
          land on the patient&apos;s claim workbench to add line items and
          submit.
        </p>
      </header>

      <Card title="New claim">
        <div className="space-y-3">
          <Field label="Patient ID" required>
            <Input
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              placeholder="patient uuid"
              aria-label="Patient ID"
              className="font-mono"
            />
          </Field>
          <Field label="Payer name" required>
            <Input
              value={payerName}
              onChange={(e) => setPayerName(e.target.value)}
              placeholder="Aetna"
              aria-label="Payer name"
            />
          </Field>
          <Field label="Date of service" required>
            <Input
              type="date"
              value={dateOfService}
              onChange={(e) => setDateOfService(e.target.value)}
              aria-label="Date of service"
            />
          </Field>
          <Field label="Claim type">
            <select
              value={frequency}
              onChange={(e) =>
                setFrequency(e.target.value as ClaimFrequencyCode)
              }
              className="w-full rounded border border-slate-300 px-2 py-2 text-sm"
              aria-label="Claim frequency"
            >
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          {isAdjustment && (
            <Field label="Original payer claim # (ICN/DCN)" required>
              <Input
                value={originalClaimNumber}
                onChange={(e) => setOriginalClaimNumber(e.target.value)}
                placeholder="payer control number being corrected/voided"
                aria-label="Original claim number"
                className="font-mono"
              />
            </Field>
          )}
          <Field label="Our claim # (optional)">
            <Input
              value={claimNumber}
              onChange={(e) => setClaimNumber(e.target.value)}
              aria-label="Claim number"
            />
          </Field>
          <Field label="Notes (optional)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm"
              aria-label="Notes"
            />
          </Field>

          <div className="flex items-center gap-3 pt-1">
            <Button
              disabled={!valid || create.isPending}
              isLoading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create draft claim
            </Button>
            {isAdjustment && originalClaimNumber.trim() === "" && (
              <span className="text-xs" style={{ color: "#b45309" }}>
                A correction/void needs the original payer claim #.
              </span>
            )}
          </div>
          {create.error instanceof Error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-2 text-sm text-rose-900">
              {create.error.message}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
        {label}
        {required && <span className="text-rose-600"> *</span>}
      </span>
      {children}
    </label>
  );
}
