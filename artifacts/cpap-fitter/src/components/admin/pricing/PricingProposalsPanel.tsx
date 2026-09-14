import {
  formatPricingMoney,
  parsePricingMoney,
  pricingExpiry,
} from "@/lib/admin/pricing-input";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "../Button";
import { ErrorPanel } from "../ErrorPanel";
import {
  getPricingProposals,
  pricingKey,
  reviewPricingProposal,
  savePricingProposal,
  type PricingProposal,
  type PricingProposalInput,
} from "@/lib/admin/pricing-api";
import {
  PricingField,
  PricingNotice,
  PricingSection,
  PricingStatus,
  pricingControl,
} from "./PricingPrimitives";
const blank: PricingProposalInput = {
  name: "",
  manufacturer: "",
  model: "",
  size: "",
  packDescription: "",
  source: "",
  notes: "",
};
export function PricingProposalsPanel({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient(),
    [offset, setOffset] = useState(0),
    [form, setForm] = useState(blank),
    [selected, setSelected] = useState<PricingProposal | null>(null),
    [sku, setSku] = useState(""),
    [reviewNotes, setReviewNotes] = useState(""),
    [status, setStatus] = useState<"reviewing" | "resolved" | "rejected">(
      "reviewing",
    ),
    [notice, setNotice] = useState("");
  const [cost, setCost] = useState(""),
    [dropship, setDropship] = useState(""),
    [expires, setExpires] = useState(""),
    [terms, setTerms] = useState(""),
    [entryError, setEntryError] = useState("");
  const proposals = useQuery({
    queryKey: [...pricingKey, "proposals", offset],
    queryFn: () => getPricingProposals(offset),
  });
  const save = useMutation({
    mutationFn: savePricingProposal,
    onSuccess: () => {
      setForm(blank);
      setCost("");
      setDropship("");
      setExpires("");
      setTerms("");
      setNotice(
        "Item proposal submitted. A pricing manager will verify the item and supplier costs before quoting.",
      );
      void qc.invalidateQueries({ queryKey: [...pricingKey, "proposals"] });
    },
  });
  const review = useMutation({
    mutationFn: () =>
      reviewPricingProposal(selected!.id, {
        expectedRevision: selected!.revision,
        status,
        ...(sku.trim() ? { sku: sku.trim() } : {}),
        notes: reviewNotes.trim(),
      }),
    onSuccess: () => {
      setSelected(null);
      setNotice(
        "Proposal review saved. Resolved items can be used after supplier costs are verified.",
      );
      void qc.invalidateQueries({ queryKey: [...pricingKey, "proposals"] });
    },
  });
  return (
    <div className="space-y-5">
      {notice && <PricingNotice>{notice}</PricingNotice>}
      <PricingSection
        title="Propose a new item"
        description="Capture the exact model, size and sellable unit. The item must be matched to a canonical catalog SKU and verified supplier offer before it can become a firm quote."
      >
        <div className="grid gap-4 md:grid-cols-3">
          {(
            [
              ["name", "Item name"],
              ["manufacturer", "Manufacturer"],
              ["model", "Model / part number"],
              ["size", "Size / variant"],
              ["packDescription", "Pack and sellable unit"],
              ["source", "Supplier quote / evidence reference"],
            ] as const
          ).map(([key, label]) => (
            <PricingField key={key} label={label}>
              <input
                className={pricingControl}
                value={form[key]}
                onChange={(e) =>
                  setForm((old) => ({ ...old, [key]: e.target.value }))
                }
              />
            </PricingField>
          ))}
        </div>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <PricingField label="Proposed unit cost ($)">
            <input
              className={pricingControl}
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </PricingField>
          <PricingField label="Proposed dropship fee ($)">
            <input
              className={pricingControl}
              inputMode="decimal"
              value={dropship}
              onChange={(e) => setDropship(e.target.value)}
            />
          </PricingField>
          <PricingField label="Supplier evidence valid through (UTC)">
            <input
              className={pricingControl}
              type="date"
              value={expires}
              onChange={(e) => setExpires(e.target.value)}
            />
          </PricingField>
          <PricingField label="Supplier delivery and return terms">
            <textarea
              className={pricingControl}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
              rows={2}
            />
          </PricingField>
        </div>
        {entryError && (
          <p role="alert" className="mt-2 text-sm text-red-700">
            {entryError}
          </p>
        )}
        <PricingField label="Delivery terms, lead time and notes">
          <textarea
            className={pricingControl}
            rows={3}
            value={form.notes}
            onChange={(e) =>
              setForm((old) => ({ ...old, notes: e.target.value }))
            }
          />
        </PricingField>
        <Button
          className="mt-4"
          disabled={
            !form.name.trim() ||
            !form.packDescription.trim() ||
            !form.source.trim()
          }
          isLoading={save.isPending}
          onClick={() => {
            setEntryError("");
            if (
              (cost.trim() && parsePricingMoney(cost) === null) ||
              (dropship.trim() && parsePricingMoney(dropship) === null) ||
              (expires && !pricingExpiry(expires))
            ) {
              setEntryError(
                "Enter valid dollar amounts and an evidence expiry date.",
              );
              return;
            }
            save.mutate({
              ...form,
              estimatedUnitCostCents: parsePricingMoney(cost),
              estimatedDropshipFeeCents: parsePricingMoney(dropship),
              terms,
              expiresAt: expires ? pricingExpiry(expires) : null,
            });
          }}
        >
          Submit item proposal
        </Button>
        {save.error && (
          <ErrorPanel error={save.error} onRetry={() => save.reset()} />
        )}
      </PricingSection>
      <PricingSection
        title="Item sourcing queue"
        description="Resolve duplicates against the existing catalog; do not create a second SKU for the same item."
      >
        {proposals.isPending ? (
          <p role="status">Loading proposals…</p>
        ) : proposals.error ? (
          <ErrorPanel
            error={proposals.error}
            onRetry={() => void proposals.refetch()}
          />
        ) : (
          <div className="space-y-3">
            {proposals.data?.proposals.length === 0 && (
              <p className="text-sm text-slate-500">No new item proposals.</p>
            )}
            {proposals.data?.proposals.map((proposal) => (
              <article
                key={proposal.id}
                className="rounded-lg border border-slate-200 p-4"
              >
                <div className="flex flex-wrap justify-between gap-3">
                  <div>
                    <h3 className="font-medium">{proposal.name}</h3>
                    <p className="text-sm text-slate-600">
                      {[
                        proposal.manufacturer,
                        proposal.model,
                        proposal.size,
                        proposal.packDescription,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    <p className="mt-1 text-xs text-slate-500">
                      {proposal.source}
                    </p>
                  </div>
                  <PricingStatus state={proposal.status} />
                </div>
                <p className="mt-2 whitespace-pre-wrap text-sm text-slate-600">
                  {proposal.notes}
                </p>
                {proposal.sku && (
                  <p className="mt-2 text-sm">
                    Linked SKU: <strong>{proposal.sku}</strong>
                  </p>
                )}
                <p className="mt-2 text-xs text-slate-600">
                  Proposed unit cost{" "}
                  {formatPricingMoney(proposal.estimatedUnitCostCents)} ·
                  Dropship fee{" "}
                  {formatPricingMoney(proposal.estimatedDropshipFeeCents)}
                  {proposal.expiresAt
                    ? ` · Evidence expires ${proposal.expiresAt.slice(0, 10)}`
                    : ""}
                </p>
                {proposal.terms && (
                  <p className="mt-1 text-sm text-slate-600">
                    {proposal.terms}
                  </p>
                )}
                {proposal.reviewNotes && (
                  <p className="mt-2 text-sm">Review: {proposal.reviewNotes}</p>
                )}
                {canManage && (
                  <Button
                    className="mt-3"
                    intent="secondary"
                    size="sm"
                    onClick={() => {
                      setSelected(proposal);
                      setSku(proposal.sku ?? "");
                      setReviewNotes("");
                      setStatus("reviewing");
                    }}
                  >
                    Review proposal
                  </Button>
                )}
              </article>
            ))}
            <div className="flex justify-end gap-2">
              <Button
                intent="ghost"
                disabled={!offset || proposals.isFetching}
                onClick={() => setOffset((n) => n - 50)}
              >
                Previous proposals
              </Button>
              <Button
                intent="ghost"
                disabled={!proposals.data?.hasMore || proposals.isFetching}
                onClick={() => setOffset((n) => n + 50)}
              >
                Next proposals
              </Button>
            </div>
          </div>
        )}
      </PricingSection>
      {selected && canManage && (
        <PricingSection title={`Review: ${selected.name}`}>
          <div className="grid gap-4 md:grid-cols-2">
            <PricingField label="Proposal decision">
              <select
                className={pricingControl}
                value={status}
                onChange={(e) => setStatus(e.target.value as typeof status)}
              >
                <option value="reviewing">Reviewing evidence</option>
                <option value="resolved">Resolved and linked to catalog</option>
                <option value="rejected">Rejected / duplicate</option>
              </select>
            </PricingField>
            <PricingField label="Existing canonical SKU">
              <input
                className={pricingControl}
                value={sku}
                onChange={(e) => setSku(e.target.value)}
              />
            </PricingField>
            <PricingField label="Proposal review notes">
              <textarea
                className={pricingControl}
                value={reviewNotes}
                onChange={(e) => setReviewNotes(e.target.value)}
                rows={3}
              />
            </PricingField>
          </div>
          <div className="mt-4 flex gap-3">
            <Button
              disabled={
                !reviewNotes.trim() || (status === "resolved" && !sku.trim())
              }
              isLoading={review.isPending}
              onClick={() => review.mutate()}
            >
              Save proposal decision
            </Button>
            <Button intent="ghost" onClick={() => setSelected(null)}>
              Cancel review
            </Button>
          </div>
          {review.error && (
            <ErrorPanel
              error={review.error}
              onRetry={() => void proposals.refetch()}
            />
          )}
        </PricingSection>
      )}
    </div>
  );
}
