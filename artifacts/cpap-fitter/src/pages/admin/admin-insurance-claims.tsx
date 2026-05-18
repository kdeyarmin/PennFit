// /admin/patients/:patientId/insurance-claims — payer claim & EOB
// workbench for the billing team.
//
// Scope of this page
// ------------------
// One patient at a time (URL-scoped). Shows every claim ever filed
// for them with totals, status, and a per-claim drawer that opens
// the full HCPCS line items + the append-only event history. From
// the drawer the biller can:
//
//   * Add a HCPCS line (capture the dispense).
//   * Mark a line accepted / denied / paid with amounts.
//   * Move the claim through its state machine
//     (draft → submitted → accepted → paid; or denied → appealed → ...).
//   * Append a free-form note or EOB receipt as a history event.
//
// We deliberately do NOT try to be a full 837P claim editor here.
// That belongs to Tier-3 once clearinghouse integration lands. The
// surface this page provides is what billing teams have asked for
// most loudly: durable history they can grep through, structured
// per-line accounting, and a single-place audit trail.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  ArrowLeft,
  ChevronRight,
  ClipboardList,
  Plus,
  Send,
} from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  createInsuranceClaim,
  createInsuranceClaimEvent,
  createInsuranceClaimLine,
  getInsuranceClaim,
  listInsuranceClaims,
  patchInsuranceClaim,
  type CreateInsuranceClaimEventRequest,
  type CreateInsuranceClaimLineRequest,
  type CreateInsuranceClaimRequest,
  type InsuranceClaim,
  type InsuranceClaimEvent,
  type InsuranceClaimEventType,
  type InsuranceClaimLineItem,
  type InsuranceClaimStatus,
  type PatchInsuranceClaimRequest,
} from "@/lib/admin/clinical-tabs-api";

function formatMoneyCents(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

const STATUS_LABEL: Record<InsuranceClaimStatus, string> = {
  draft: "Draft",
  submitted: "Submitted",
  accepted: "Accepted",
  denied: "Denied",
  paid: "Paid",
  appealed: "Appealed",
  closed: "Closed",
};

// Color-tone hint for the status badge. Stays in line with the
// design tokens used by the rest of the admin console.
const STATUS_TONE: Record<InsuranceClaimStatus, string> = {
  draft: "var(--surface-2)",
  submitted: "var(--accent-blue, #c7d8ff)",
  accepted: "var(--accent-teal, #c6efe9)",
  denied: "var(--accent-rose, #ffd5d5)",
  paid: "var(--accent-green, #c8efc8)",
  appealed: "var(--accent-amber, #ffe2b8)",
  closed: "var(--surface-2)",
};

const VALID_TRANSITIONS: Record<
  InsuranceClaimStatus,
  readonly InsuranceClaimStatus[]
> = {
  draft: ["submitted"],
  submitted: ["accepted", "denied"],
  accepted: ["paid", "denied"],
  denied: ["appealed", "closed"],
  appealed: ["accepted", "denied"],
  paid: ["closed"],
  closed: [],
};

export function AdminInsuranceClaimsPage({
  patientId,
}: {
  patientId: string;
}) {
  const [, setLocation] = useLocation();
  const [showCreate, setShowCreate] = useState(false);
  const [openClaimId, setOpenClaimId] = useState<string | null>(null);

  const {
    data,
    isPending,
    isError,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "insurance-claims", patientId],
    queryFn: () => listInsuranceClaims(patientId),
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <button
            type="button"
            onClick={() => setLocation(`/admin/patients/${patientId}`)}
            className="text-xs inline-flex items-center gap-1 mb-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <ArrowLeft className="h-3 w-3" /> Back to patient
          </button>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <ClipboardList className="h-6 w-6" />
            Insurance claims
          </h1>
          <p
            className="text-sm mt-1 max-w-2xl"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Every payer claim filed for this patient, with totals, EOB
            history, and per-HCPCS line accounting. Open a row to
            review line items or post an EOB receipt.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          New claim
        </Button>
      </header>

      <Card>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.insuranceClaims.length === 0 ? (
          <p
            className="text-sm py-3"
            style={{ color: "hsl(var(--ink-3))" }}
            data-testid="insurance-claims-empty"
          >
            No claims on file. Start a draft above when you dispense
            equipment that will be billed to insurance.
          </p>
        ) : (
          <ul className="space-y-3">
            {data.insuranceClaims.map((c) => (
              <ClaimRow
                key={c.id}
                claim={c}
                onOpen={() => setOpenClaimId(c.id)}
              />
            ))}
          </ul>
        )}
      </Card>

      {showCreate && (
        <CreateClaimDialog
          patientId={patientId}
          onClose={() => setShowCreate(false)}
        />
      )}
      {openClaimId && (
        <ClaimDrawer
          patientId={patientId}
          claimId={openClaimId}
          onClose={() => setOpenClaimId(null)}
        />
      )}
    </div>
  );
}

function ClaimRow({
  claim,
  onOpen,
}: {
  claim: InsuranceClaim;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="w-full text-left rounded-lg border p-4 hover:bg-[hsl(var(--surface-2))] transition-colors"
        style={{ borderColor: "hsl(var(--surface-3))" }}
        data-testid={`insurance-claim-row-${claim.id}`}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="font-medium">{claim.payerName}</span>
              <span
                className="inline-block text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                style={{
                  backgroundColor: `hsl(${STATUS_TONE[claim.status]})`,
                }}
              >
                {STATUS_LABEL[claim.status]}
              </span>
            </div>
            <p
              className="text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              DOS {claim.dateOfService}
              {claim.claimNumber ? ` · #${claim.claimNumber}` : ""}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm font-semibold tabular-nums">
              {formatMoneyCents(claim.totalBilledCents)}
            </p>
            <p
              className="text-xs tabular-nums"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              Paid {formatMoneyCents(claim.totalPaidCents)}
            </p>
          </div>
          <ChevronRight
            className="h-4 w-4"
            style={{ color: "hsl(var(--ink-3))" }}
          />
        </div>
      </button>
    </li>
  );
}

function CreateClaimDialog({
  patientId,
  onClose,
}: {
  patientId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [payerName, setPayerName] = useState("");
  const [dateOfService, setDateOfService] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [claimNumber, setClaimNumber] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: (body: CreateInsuranceClaimRequest) =>
      createInsuranceClaim(patientId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "insurance-claims", patientId],
      });
      onClose();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "Couldn't create claim.");
    },
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div
        role="dialog"
        aria-labelledby="create-claim-title"
        className="bg-[hsl(var(--surface-1))] rounded-xl max-w-lg w-full p-6 space-y-4"
      >
        <h2 id="create-claim-title" className="text-lg font-semibold">
          New insurance claim
        </h2>
        <p
          className="text-sm"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Capture the payer + date of service. The claim opens in draft
          state; add HCPCS line items and transition to submitted from
          the row.
        </p>
        <div className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              Payer name
            </span>
            <Input
              value={payerName}
              onChange={(e) => setPayerName(e.target.value)}
              placeholder="e.g. Aetna, Medicare Part B"
              maxLength={120}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              Date of service
            </span>
            <Input
              type="date"
              value={dateOfService}
              onChange={(e) => setDateOfService(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              Payer claim number (optional)
            </span>
            <Input
              value={claimNumber}
              onChange={(e) => setClaimNumber(e.target.value)}
              placeholder="Often assigned only after submission"
              maxLength={64}
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium block mb-1">
              Internal notes (optional)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              className="w-full px-3 py-2 rounded-md border text-sm"
              style={{
                borderColor: "hsl(var(--surface-3))",
                backgroundColor: "hsl(var(--surface-2))",
              }}
              maxLength={2000}
            />
          </label>
        </div>
        {error && (
          <p className="text-sm text-rose-600">{error}</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button intent="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!payerName.trim() || mut.isPending}
            onClick={() => {
              setError(null);
              mut.mutate({
                payerName: payerName.trim(),
                dateOfService,
                claimNumber: claimNumber.trim() || null,
                notes: notes.trim() || null,
              });
            }}
          >
            {mut.isPending ? "Creating…" : "Create draft"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function ClaimDrawer({
  patientId,
  claimId,
  onClose,
}: {
  patientId: string;
  claimId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "insurance-claim", patientId, claimId],
    queryFn: () => getInsuranceClaim(patientId, claimId),
  });

  function invalidate() {
    void queryClient.invalidateQueries({
      queryKey: ["admin", "insurance-claim", patientId, claimId],
    });
    void queryClient.invalidateQueries({
      queryKey: ["admin", "insurance-claims", patientId],
    });
  }

  const transitionMut = useMutation({
    mutationFn: (body: PatchInsuranceClaimRequest) =>
      patchInsuranceClaim(patientId, claimId, body),
    onSuccess: invalidate,
  });

  const addLineMut = useMutation({
    mutationFn: (body: CreateInsuranceClaimLineRequest) =>
      createInsuranceClaimLine(patientId, claimId, body),
    onSuccess: invalidate,
  });

  const addEventMut = useMutation({
    mutationFn: (body: CreateInsuranceClaimEventRequest) =>
      createInsuranceClaimEvent(patientId, claimId, body),
    onSuccess: invalidate,
  });

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-stretch justify-end">
      <div
        role="dialog"
        aria-label="Insurance claim detail"
        className="bg-[hsl(var(--surface-1))] w-full max-w-2xl h-full overflow-y-auto p-6 space-y-6"
      >
        <header className="flex items-center justify-between">
          <button
            type="button"
            onClick={onClose}
            className="text-sm inline-flex items-center gap-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            <ArrowLeft className="h-4 w-4" /> Close
          </button>
        </header>

        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : (
          <ClaimDrawerContent
            claim={data.claim}
            lineItems={data.lineItems}
            events={data.events}
            onTransition={(to, denialReason) =>
              transitionMut.mutate({
                status: to,
                denialReason: denialReason ?? undefined,
              })
            }
            onAddLine={(body) => addLineMut.mutate(body)}
            onAddEvent={(body) => addEventMut.mutate(body)}
          />
        )}
      </div>
    </div>
  );
}

function ClaimDrawerContent({
  claim,
  lineItems,
  events,
  onTransition,
  onAddLine,
  onAddEvent,
}: {
  claim: InsuranceClaim;
  lineItems: InsuranceClaimLineItem[];
  events: InsuranceClaimEvent[];
  onTransition: (
    to: InsuranceClaimStatus,
    denialReason: string | null,
  ) => void;
  onAddLine: (body: CreateInsuranceClaimLineRequest) => void;
  onAddEvent: (body: CreateInsuranceClaimEventRequest) => void;
}) {
  const allowed = VALID_TRANSITIONS[claim.status] ?? [];
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="text-lg font-semibold">{claim.payerName}</h2>
        <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          DOS {claim.dateOfService}
          {claim.claimNumber ? ` · Claim #${claim.claimNumber}` : ""}
        </p>
        <div className="flex flex-wrap gap-2 text-xs">
          <span
            className="px-2 py-0.5 rounded font-medium"
            style={{
              backgroundColor: `hsl(${STATUS_TONE[claim.status]})`,
            }}
          >
            {STATUS_LABEL[claim.status]}
          </span>
          <span>Billed {formatMoneyCents(claim.totalBilledCents)}</span>
          <span>Allowed {formatMoneyCents(claim.totalAllowedCents)}</span>
          <span>Paid {formatMoneyCents(claim.totalPaidCents)}</span>
          <span>
            Patient responsibility{" "}
            {formatMoneyCents(claim.patientResponsibilityCents)}
          </span>
        </div>
        {claim.denialReason && (
          <p className="text-xs text-rose-700">
            Denial reason: {claim.denialReason}
          </p>
        )}
      </section>

      {allowed.length > 0 && (
        <section className="space-y-2">
          <h3 className="text-sm font-semibold">Move state</h3>
          <div className="flex flex-wrap gap-2">
            {allowed.map((to) => (
              <TransitionButton
                key={to}
                from={claim.status}
                to={to}
                onConfirm={(denialReason) => onTransition(to, denialReason)}
              />
            ))}
          </div>
        </section>
      )}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">HCPCS line items</h3>
        </div>
        {lineItems.length === 0 ? (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            No lines yet. Add the first HCPCS line below.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {lineItems.map((l) => (
              <li
                key={l.id}
                className="rounded border p-3"
                style={{ borderColor: "hsl(var(--surface-3))" }}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium font-mono">
                    {l.hcpcsCode}
                    {l.modifier ? ` ${l.modifier}` : ""}
                    {l.quantity > 1 ? ` ×${l.quantity}` : ""}
                  </span>
                  <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                    {l.status}
                  </span>
                </div>
                {l.description && (
                  <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                    {l.description}
                  </p>
                )}
                <p className="text-xs mt-1 tabular-nums">
                  Billed {formatMoneyCents(l.billedCents)} · Allowed{" "}
                  {formatMoneyCents(l.allowedCents)} · Paid{" "}
                  {formatMoneyCents(l.paidCents)}
                </p>
              </li>
            ))}
          </ul>
        )}
        <AddLineForm onAdd={onAddLine} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">History</h3>
        {events.length === 0 ? (
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            No events yet.
          </p>
        ) : (
          <ul className="space-y-2 text-sm">
            {events.map((e) => (
              <li
                key={e.id}
                className="rounded border p-3"
                style={{ borderColor: "hsl(var(--surface-3))" }}
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-medium uppercase tracking-wide">
                    {e.eventType.replace("_", " ")}
                  </span>
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    {new Date(e.occurredAt).toLocaleString()}
                  </span>
                </div>
                {e.amountCents != null && (
                  <p className="text-xs tabular-nums">
                    {formatMoneyCents(e.amountCents)}
                  </p>
                )}
                {e.payerRef && (
                  <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                    Payer ref: {e.payerRef}
                  </p>
                )}
                {e.note && <p className="text-xs mt-1">{e.note}</p>}
                <p
                  className="text-[10px] mt-1"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {e.actorEmail}
                </p>
              </li>
            ))}
          </ul>
        )}
        <AddEventForm onAdd={onAddEvent} />
      </section>
    </div>
  );
}

function TransitionButton({
  from,
  to,
  onConfirm,
}: {
  from: InsuranceClaimStatus;
  to: InsuranceClaimStatus;
  onConfirm: (denialReason: string | null) => void;
}) {
  const needsReason = to === "denied";
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!needsReason) {
    return (
      <Button
        intent="secondary"
        onClick={() => onConfirm(null)}
        data-testid={`transition-${from}-to-${to}`}
      >
        Mark {STATUS_LABEL[to].toLowerCase()}
      </Button>
    );
  }
  return open ? (
    <div className="flex items-center gap-2">
      <Input
        placeholder="Denial reason (required)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        className="w-64"
      />
      <Button
        disabled={!reason.trim()}
        onClick={() => onConfirm(reason.trim())}
      >
        Save
      </Button>
      <Button intent="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </div>
  ) : (
    <Button intent="secondary" onClick={() => setOpen(true)}>
      Mark denied…
    </Button>
  );
}

function AddLineForm({
  onAdd,
}: {
  onAdd: (body: CreateInsuranceClaimLineRequest) => void;
}) {
  const [hcpcsCode, setHcpcsCode] = useState("");
  const [modifier, setModifier] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [billed, setBilled] = useState("");

  function reset() {
    setHcpcsCode("");
    setModifier("");
    setDescription("");
    setQuantity("1");
    setBilled("");
  }

  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--surface-3))" }}
    >
      <p className="text-xs font-medium">Add line item</p>
      <div className="grid grid-cols-2 gap-2">
        <Input
          placeholder="HCPCS (e.g. E0601)"
          value={hcpcsCode}
          onChange={(e) => setHcpcsCode(e.target.value.toUpperCase())}
          maxLength={12}
        />
        <Input
          placeholder="Modifier(s) (e.g. RR,KX)"
          value={modifier}
          onChange={(e) => setModifier(e.target.value.toUpperCase())}
          maxLength={32}
        />
        <Input
          placeholder="Description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={240}
          className="col-span-2"
        />
        <Input
          type="number"
          min={1}
          max={9999}
          placeholder="Quantity"
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
        <Input
          type="number"
          min={0}
          step={1}
          placeholder="Billed (cents)"
          value={billed}
          onChange={(e) => setBilled(e.target.value)}
        />
      </div>
      <div className="flex justify-end">
        <Button
          disabled={
            !/^[A-Z]\d{4}/.test(hcpcsCode) ||
            !billed ||
            Number.isNaN(Number(billed))
          }
          onClick={() => {
            onAdd({
              hcpcsCode,
              modifier: modifier.trim() || null,
              description: description.trim() || null,
              quantity: Math.max(1, Number(quantity) || 1),
              billedCents: Math.max(0, Number(billed) || 0),
            });
            reset();
          }}
        >
          <Plus className="h-4 w-4 mr-1.5" />
          Add line
        </Button>
      </div>
    </div>
  );
}

const EVENT_TYPES: { value: InsuranceClaimEventType; label: string }[] = [
  { value: "submitted", label: "Submitted to payer" },
  { value: "accepted", label: "Accepted" },
  { value: "denied", label: "Denied" },
  { value: "partial_pay", label: "Partial pay" },
  { value: "paid", label: "Paid in full" },
  { value: "appealed", label: "Appeal filed" },
  { value: "closed", label: "Closed" },
  { value: "note", label: "Note" },
];

function AddEventForm({
  onAdd,
}: {
  onAdd: (body: CreateInsuranceClaimEventRequest) => void;
}) {
  const [eventType, setEventType] = useState<InsuranceClaimEventType>("note");
  const [amount, setAmount] = useState("");
  const [payerRef, setPayerRef] = useState("");
  const [note, setNote] = useState("");

  function reset() {
    setEventType("note");
    setAmount("");
    setPayerRef("");
    setNote("");
  }

  return (
    <div
      className="rounded border p-3 space-y-2"
      style={{ borderColor: "hsl(var(--surface-3))" }}
    >
      <p className="text-xs font-medium">Append history event</p>
      <div className="grid grid-cols-2 gap-2">
        <select
          value={eventType}
          onChange={(e) =>
            setEventType(e.target.value as InsuranceClaimEventType)
          }
          className="px-3 py-2 rounded-md border text-sm"
          style={{
            borderColor: "hsl(var(--surface-3))",
            backgroundColor: "hsl(var(--surface-2))",
          }}
        >
          {EVENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <Input
          type="number"
          min={0}
          step={1}
          placeholder="Amount (cents, optional)"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          placeholder="Payer reference (EOB id, check #)"
          value={payerRef}
          onChange={(e) => setPayerRef(e.target.value)}
          maxLength={120}
          className="col-span-2"
        />
        <textarea
          placeholder="Note (optional)"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={4000}
          className="col-span-2 px-3 py-2 rounded-md border text-sm"
          style={{
            borderColor: "hsl(var(--surface-3))",
            backgroundColor: "hsl(var(--surface-2))",
          }}
        />
      </div>
      <div className="flex justify-end">
        <Button
          onClick={() => {
            onAdd({
              eventType,
              amountCents: amount ? Number(amount) : null,
              payerRef: payerRef.trim() || null,
              note: note.trim() || null,
            });
            reset();
          }}
        >
          <Send className="h-4 w-4 mr-1.5" />
          Append event
        </Button>
      </div>
    </div>
  );
}
