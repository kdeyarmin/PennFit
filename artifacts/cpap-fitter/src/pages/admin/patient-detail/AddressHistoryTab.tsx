// Patient-detail "Address" tab — extracted from patient-detail.tsx.
//
// Lists recorded address changes (with reason + timestamp) and hosts
// the "Record change" form. AddressHistoryForm is scoped to this file.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Spinner } from "@/components/admin/Spinner";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import {
  fetchPatientAddressHistory,
  postPatientAddressChange,
} from "@/lib/admin/patient-history-api";

export function AddressHistoryTab({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const queryKey = ["admin", "patients", patientId, "address-history"] as const;
  const { data, isPending, isError, error } = useQuery({
    queryKey,
    queryFn: () => fetchPatientAddressHistory(patientId),
  });
  const [showForm, setShowForm] = useState(false);

  if (isPending) return <Spinner label="Loading address history…" />;
  if (isError) {
    return (
      <p className="text-sm" style={{ color: "#b91c1c" }}>
        {error instanceof Error ? error.message : "Failed to load."}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">Address changes</h3>
        <Button intent="ghost" size="sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? "Cancel" : "Record change"}
        </Button>
      </div>
      {showForm && (
        <AddressHistoryForm
          patientId={patientId}
          onSaved={() => {
            setShowForm(false);
            void qc.invalidateQueries({ queryKey });
          }}
        />
      )}
      {data.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No address changes on file.
        </p>
      ) : (
        <ul className="space-y-2">
          {data.history.map((h) => (
            <li
              key={h.id}
              className="rounded border p-3 text-sm"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <div>
                {[h.line1, h.line2, h.city, h.state, h.postalCode, h.country]
                  .filter(Boolean)
                  .join(" · ") || "(cleared)"}
              </div>
              <div className="text-[10px] text-muted-foreground mt-1">
                {h.reason ?? "—"} · {formatDateTime(h.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddressHistoryForm({
  patientId,
  onSaved,
}: {
  patientId: string;
  onSaved: () => void;
}) {
  const [line1, setLine1] = useState("");
  const [line2, setLine2] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("US");
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () =>
      postPatientAddressChange(patientId, {
        line1: line1 || null,
        line2: line2 || null,
        city: city || null,
        state: state || null,
        postalCode: postalCode || null,
        country: country || null,
        reason: reason.trim(),
      }),
    onSuccess: onSaved,
  });
  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="grid sm:grid-cols-2 gap-2">
        <Input
          placeholder="Line 1"
          aria-label="Address line 1"
          value={line1}
          onChange={(e) => setLine1(e.target.value)}
        />
        <Input
          placeholder="Line 2"
          aria-label="Address line 2"
          value={line2}
          onChange={(e) => setLine2(e.target.value)}
        />
        <Input
          placeholder="City"
          aria-label="City"
          value={city}
          onChange={(e) => setCity(e.target.value)}
        />
        <Input
          placeholder="State"
          aria-label="State"
          value={state}
          onChange={(e) => setState(e.target.value)}
        />
        <Input
          placeholder="Postal code"
          aria-label="Postal code"
          value={postalCode}
          onChange={(e) => setPostalCode(e.target.value)}
        />
        <Input
          placeholder="Country (2-letter)"
          aria-label="Country"
          value={country}
          onChange={(e) => setCountry(e.target.value.toUpperCase())}
          maxLength={2}
        />
      </div>
      <Input
        placeholder="Reason (required)"
        aria-label="Reason for address change"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      {save.error instanceof Error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-2 text-xs text-rose-900">
          {save.error.message}
        </div>
      )}
      <Button
        disabled={!reason.trim() || save.isPending}
        isLoading={save.isPending}
        onClick={() => save.mutate()}
      >
        Save
      </Button>
    </div>
  );
}
