// Toggleable loss-claim panel for a single shop order. Same
// pattern as OrderNotesPanel — used inside the per-order row in
// the admin customer detail view.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  type LossClaim,
  type LossClaimStatus,
  listLossClaims,
  openLossClaim,
  patchLossClaim,
} from "@/lib/admin/loss-claims-api";

const STATUS_LABELS: Record<LossClaimStatus, string> = {
  open: "Open",
  carrier_filed: "Carrier filed",
  resolved_refunded: "Refunded",
  resolved_reshipped: "Reshipped",
  closed_unresolved: "Closed (unresolved)",
};

const TRANSITION_TARGETS: Record<LossClaimStatus, LossClaimStatus[]> = {
  open: [
    "carrier_filed",
    "resolved_refunded",
    "resolved_reshipped",
    "closed_unresolved",
  ],
  carrier_filed: [
    "resolved_refunded",
    "resolved_reshipped",
    "closed_unresolved",
  ],
  resolved_refunded: [],
  resolved_reshipped: [],
  closed_unresolved: [],
};

export function LossClaimsPanel({ orderId }: { orderId: string }) {
  const qc = useQueryClient();
  const { data, isPending, isError, error } = useQuery({
    queryKey: ["admin", "loss-claims", orderId] as const,
    queryFn: () => listLossClaims(orderId),
  });
  const create = useMutation({
    mutationFn: (note: string) => openLossClaim(orderId, note),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["admin", "loss-claims", orderId],
      });
    },
  });
  const [newNote, setNewNote] = useState("");
  if (isPending) {
    return (
      <div style={{ padding: "8px 0", fontSize: 12, color: "#475569" }}>
        Loading lost-shipment claims…
      </div>
    );
  }
  if (isError) {
    return (
      <div
        style={{ padding: "8px 0", fontSize: 12, color: "#b91c1c" }}
      >
        {(error as Error).message}
      </div>
    );
  }
  return (
    <div
      style={{
        marginTop: 8,
        padding: "8px 10px",
        border: "1px solid #e2e8f0",
        borderRadius: 6,
        background: "#f8fafc",
      }}
    >
      <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        Lost-shipment claims
      </div>
      {data.claims.length === 0 && (
        <p style={{ fontSize: 12, color: "#64748b", margin: "4px 0" }}>
          No claims on this order.
        </p>
      )}
      <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
        {data.claims.map((c) => (
          <ClaimRow key={c.id} claim={c} orderId={orderId} />
        ))}
      </ul>
      <div
        style={{
          display: "flex",
          gap: 6,
          marginTop: 8,
          alignItems: "center",
        }}
      >
        <input
          value={newNote}
          onChange={(e) => setNewNote(e.target.value)}
          placeholder="Optional note"
          aria-label="Optional note"
          style={{
            flex: 1,
            padding: "4px 8px",
            border: "1px solid #cbd5e1",
            borderRadius: 4,
            fontSize: 12,
          }}
        />
        <button
          type="button"
          onClick={() => {
            create.mutate(newNote.trim());
            setNewNote("");
          }}
          disabled={create.isPending}
          style={{
            background: "#0f172a",
            color: "#fff",
            padding: "4px 10px",
            borderRadius: 4,
            fontSize: 12,
            border: 0,
            cursor: "pointer",
          }}
        >
          {create.isPending ? "Opening…" : "Open new claim"}
        </button>
      </div>
    </div>
  );
}

function ClaimRow({
  claim,
  orderId,
}: {
  claim: LossClaim;
  orderId: string;
}) {
  const qc = useQueryClient();
  const patch = useMutation({
    mutationFn: (status: LossClaimStatus) =>
      patchLossClaim(claim.id, { status }),
    onSuccess: () => {
      void qc.invalidateQueries({
        queryKey: ["admin", "loss-claims", orderId],
      });
    },
  });
  const targets = TRANSITION_TARGETS[claim.status];
  return (
    <li
      style={{
        padding: "6px 0",
        borderBottom: "1px solid #e2e8f0",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span>
          <strong>{STATUS_LABELS[claim.status]}</strong>
          {claim.carrierClaimNumber && (
            <span style={{ marginLeft: 8, color: "#475569" }}>
              #{claim.carrierClaimNumber}
            </span>
          )}
        </span>
        <span style={{ color: "#64748b" }}>
          {new Date(claim.openedAt).toLocaleDateString()}
        </span>
      </div>
      {claim.resolutionNote && (
        <p
          style={{
            margin: "2px 0",
            color: "#475569",
            fontSize: 11,
          }}
        >
          {claim.resolutionNote}
        </p>
      )}
      {targets.length > 0 && (
        <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
          {targets.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => patch.mutate(t)}
              disabled={patch.isPending}
              style={{
                fontSize: 11,
                padding: "2px 8px",
                border: "1px solid #cbd5e1",
                background: "#fff",
                borderRadius: 4,
                cursor: "pointer",
              }}
            >
              → {STATUS_LABELS[t]}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
