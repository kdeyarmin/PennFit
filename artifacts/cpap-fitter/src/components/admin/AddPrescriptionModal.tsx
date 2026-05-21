// Patient-detail "New prescription" modal.
//
// Triggered from the Prescriptions tab. Renders as a centered
// overlay; click-outside dismisses (unless a save is in flight),
// Esc dismisses, the form posts to useCreatePrescription on submit.
//
// Clinical fields (HCPCS, prescriber NPI, diagnosis) are immutable
// post-save — this is the patient's medical record. To "edit" a
// past prescription, an admin adds a new one and marks the old one
// expired in the row-level Prescriptions UI.

import { useEffect, useState } from "react";

import {
  ApiError,
  useCreatePrescription,
} from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";

export function AddPrescriptionModal({
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
      className="admin-root fixed inset-0 z-50 flex items-center justify-center p-4"
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
