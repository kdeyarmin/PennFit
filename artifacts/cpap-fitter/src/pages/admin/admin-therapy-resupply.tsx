// /admin/therapy-resupply — resupply opportunities from device data.
//
// Reads the vendor `supplies[]` roster the therapy-cloud snapshots
// already cache and surfaces the items whose nextEligibleDate has
// arrived (or is due within a horizon) as a fleet "resupply due" queue.
// High-leak patients whose mask interface is due are flagged as
// combined re-fit + resupply opportunities. Each row links to the
// patient so a CSR can place the order. Exportable to CSV.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ClipboardList,
  Download,
  PackageCheck,
  PackagePlus,
  Send,
  Wind,
  X,
} from "lucide-react";

import { Card, KpiCard } from "@/components/admin/Card";
import { Badge, humanizeStatus } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import {
  approveResupplyDraft,
  createResupplyDrafts,
  dismissResupplyDraft,
  getResupplySummary,
  getResupplyOpportunities,
  listResupplyDrafts,
  resupplyOpportunitiesCsvUrl,
  type ApproveDraftInput,
  type ResupplyDraft,
  type ResupplyOpportunity,
  type SupplyCategory,
} from "@/lib/admin/therapy-resupply-api";

// Selection / dedup key — mirrors the server's
// (patient, category, next-eligible-date) draft key.
const oppKey = (o: ResupplyOpportunity): string =>
  `${o.patientId}|${o.category}|${o.nextEligibleDate ?? ""}`;

// Horizon options: 0 = eligible now / overdue; the rest add a "due
// soon" lookahead so a CSR can batch upcoming orders.
const HORIZON_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: "Due now / overdue" },
  { value: 14, label: "Due within 14 days" },
  { value: 30, label: "Due within 30 days" },
  { value: 60, label: "Due within 60 days" },
];

const CATEGORY_FILTERS: Array<{
  value: SupplyCategory | "all";
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "mask", label: "Masks" },
  { value: "cushion", label: "Cushions" },
  { value: "headgear", label: "Headgear" },
  { value: "tubing", label: "Tubing" },
  { value: "filter", label: "Filters" },
  { value: "humidifier_chamber", label: "Humidifier" },
];

const SOURCE_LABELS: Record<string, string> = {
  resmed_airview: "ResMed AirView",
  philips_care: "Philips Care",
  react_health: "React Health",
};

const inputCls = "w-full rounded-md border px-2 py-1.5 text-sm";

const SUPPLY_NAMES: Record<string, string> = {
  mask: "Mask",
  cushion: "Cushion",
  headgear: "Headgear",
  tubing: "Tubing",
  filter: "Filter",
  humidifier_chamber: "Humidifier chamber",
  other: "Other",
};

export function AdminTherapyResupplyPage() {
  const [dueWithinDays, setDueWithinDays] = useState<number>(0);
  const [category, setCategory] = useState<SupplyCategory | "all">("all");

  const summaryQ = useQuery({
    queryKey: ["admin", "therapy-resupply", "summary", dueWithinDays],
    queryFn: () => getResupplySummary(dueWithinDays),
    refetchOnWindowFocus: false,
  });
  const listQ = useQuery({
    queryKey: ["admin", "therapy-resupply", "list", dueWithinDays, category],
    queryFn: () =>
      getResupplyOpportunities({
        dueWithinDays,
        limit: 200,
        category: category === "all" ? undefined : category,
      }),
    refetchOnWindowFocus: false,
  });

  const s = summaryQ.data?.summary;

  const queryClient = useQueryClient();
  // Selected opportunities (by dedup key) to stage as drafts.
  const [selected, setSelected] = useState<Map<string, ResupplyOpportunity>>(
    new Map(),
  );
  const toggle = (o: ResupplyOpportunity) =>
    setSelected((prev) => {
      const next = new Map(prev);
      const k = oppKey(o);
      if (next.has(k)) next.delete(k);
      else next.set(k, o);
      return next;
    });

  const draftsQ = useQuery({
    queryKey: ["admin", "therapy-resupply", "drafts", "proposed"],
    queryFn: () => listResupplyDrafts("proposed", 200),
    refetchOnWindowFocus: false,
  });

  const createDrafts = useMutation({
    mutationFn: () =>
      createResupplyDrafts(
        Array.from(selected.values()).map((o) => ({
          patientId: o.patientId,
          category: o.category,
          source: o.source,
          sourceDescription: o.description,
          nextEligibleDate: o.nextEligibleDate,
        })),
      ),
    onSuccess: () => {
      setSelected(new Map());
      void queryClient.invalidateQueries({
        queryKey: ["admin", "therapy-resupply", "drafts"],
      });
    },
  });

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <PackageCheck className="h-6 w-6" /> Resupply opportunities
          </h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Supplies the manufacturer device data reports as eligible for
            replacement — across ResMed AirView, Philips Care Orchestrator, and
            React Health. High-leak patients whose mask is due are flagged for a
            combined re-fit + resupply.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={dueWithinDays}
            onChange={(e) => setDueWithinDays(Number(e.target.value))}
            aria-label="Show supplies due within"
            className="rounded-md border px-2 py-1.5 text-sm"
            style={{
              borderColor: "hsl(var(--line-1))",
              backgroundColor: "hsl(var(--surface-1))",
            }}
          >
            {HORIZON_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <a
            href={resupplyOpportunitiesCsvUrl({
              dueWithinDays,
              limit: 200,
              category: category === "all" ? undefined : category,
            })}
            download
          >
            <Button intent="secondary" size="sm">
              <Download className="h-4 w-4" /> Export
            </Button>
          </a>
        </div>
      </header>

      {/* ── KPI tiles ─────────────────────────────────────────────── */}
      {summaryQ.isError ? (
        <ErrorPanel
          error={summaryQ.error}
          onRetry={() => void summaryQ.refetch()}
        />
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <KpiCard
            label="Patients w/ items due"
            value={s?.patientsWithDue ?? 0}
            isLoading={summaryQ.isPending}
            hint={`${s?.itemsDue ?? 0} items total`}
          />
          <KpiCard
            label="Overdue items"
            value={s?.itemsOverdue ?? 0}
            isLoading={summaryQ.isPending}
            hint="Past eligible date"
          />
          <KpiCard
            label="Re-fit + resupply"
            value={s?.highLeakRefit ?? 0}
            tone="gold"
            isLoading={summaryQ.isPending}
            hint="High leak + mask/cushion due"
          />
          <KpiCard
            label="Masks due"
            value={s?.byCategory?.mask ?? 0}
            isLoading={summaryQ.isPending}
            hint={`${s?.byCategory?.cushion ?? 0} cushions · ${
              s?.byCategory?.filter ?? 0
            } filters`}
          />
        </div>
      )}

      {/* ── Opportunities list ────────────────────────────────────── */}
      <Card
        title="Items eligible for replacement"
        subtitle="Most-overdue first; high-leak mask interfaces float to the top. Click a patient to place the order."
      >
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <div className="flex flex-wrap gap-2">
            {CATEGORY_FILTERS.map((c) => (
              <button
                key={c.value}
                type="button"
                onClick={() => setCategory(c.value)}
                className="px-2.5 py-1 rounded-full text-xs font-medium border transition-colors"
                style={{
                  backgroundColor:
                    category === c.value
                      ? "hsl(var(--penn-navy))"
                      : "hsl(var(--surface-1))",
                  color: category === c.value ? "white" : "hsl(var(--ink-2))",
                  borderColor:
                    category === c.value
                      ? "hsl(var(--penn-navy))"
                      : "hsl(var(--line-1))",
                }}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {createDrafts.isError ? (
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Couldn’t stage drafts — try again.
              </span>
            ) : createDrafts.data ? (
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Staged {createDrafts.data.staged}
                {createDrafts.data.skipped > 0
                  ? ` · ${createDrafts.data.skipped} already pending`
                  : ""}
              </span>
            ) : null}
            <Button
              intent="primary"
              size="sm"
              disabled={selected.size === 0 || createDrafts.isPending}
              onClick={() => createDrafts.mutate()}
            >
              <PackagePlus className="h-4 w-4" /> Create drafts
              {selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>

        {listQ.isPending ? (
          <Spinner />
        ) : listQ.isError ? (
          <ErrorPanel
            error={listQ.error}
            onRetry={() => void listQ.refetch()}
          />
        ) : listQ.data.opportunities.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            No supplies are due in this window. Device-reported rosters are up
            to date.
          </p>
        ) : (
          <OpportunitiesTable
            opportunities={listQ.data.opportunities}
            selected={selected}
            onToggle={toggle}
          />
        )}
      </Card>

      {/* ── Draft review queue ────────────────────────────────────── */}
      <DraftsReviewCard
        drafts={draftsQ.data?.drafts ?? []}
        isPending={draftsQ.isPending}
        isError={draftsQ.isError}
        error={draftsQ.error}
        onRetry={() => void draftsQ.refetch()}
      />
    </div>
  );
}

function OpportunitiesTable({
  opportunities,
  selected,
  onToggle,
}: {
  opportunities: ResupplyOpportunity[];
  selected: Map<string, ResupplyOpportunity>;
  onToggle: (o: ResupplyOpportunity) => void;
}) {
  const allSelected =
    opportunities.length > 0 &&
    opportunities.every((o) => selected.has(oppKey(o)));
  const toggleAll = () => {
    for (const o of opportunities) {
      const isSel = selected.has(oppKey(o));
      if (allSelected ? isSel : !isSel) onToggle(o);
    }
  };
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th scope="col" className="py-2 w-8">
              <input
                type="checkbox"
                aria-label="Select all listed opportunities"
                checked={allSelected}
                onChange={toggleAll}
              />
            </th>
            <th scope="col" className="py-2 font-semibold">
              Patient
            </th>
            <th scope="col" className="py-2 font-semibold">
              Item
            </th>
            <th scope="col" className="py-2 font-semibold">
              Source
            </th>
            <th scope="col" className="py-2 font-semibold">
              Last replaced
            </th>
            <th scope="col" className="py-2 font-semibold text-right">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {opportunities.map((o, i) => (
            <tr
              key={`${o.patientId}-${o.source}-${o.category}-${i}`}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2">
                <input
                  type="checkbox"
                  aria-label={`Select ${o.patientName || o.patientId}`}
                  checked={selected.has(oppKey(o))}
                  onChange={() => onToggle(o)}
                />
              </td>
              <td className="py-2">
                <Link
                  href={`/admin/patients/${o.patientId}`}
                  className="font-medium hover:underline"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  {o.patientName || o.patientId.slice(0, 8)}
                </Link>
                {o.highLeak && (
                  <span className="ml-2 inline-flex">
                    <Badge variant="warning">
                      <Wind className="h-3 w-3 mr-1" /> High leak
                    </Badge>
                  </span>
                )}
              </td>
              <td className="py-2">
                <span className="font-medium">
                  {SUPPLY_NAMES[o.category] ?? humanizeStatus(o.category)}
                </span>
                {o.description && (
                  <span
                    className="block text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {o.description}
                  </span>
                )}
              </td>
              <td className="py-2 text-xs">
                {SOURCE_LABELS[o.source] ?? o.source}
              </td>
              <td className="py-2 text-xs">{o.lastReplacedDate ?? "—"}</td>
              <td className="py-2 text-right">
                <DueBadge
                  days={o.daysUntilEligible}
                  date={o.nextEligibleDate}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DueBadge({
  days,
  date,
}: {
  days: number | null;
  date: string | null;
}) {
  if (days === null) {
    return <Badge variant="muted">{date ?? "—"}</Badge>;
  }
  if (days < 0) {
    return <Badge variant="danger">{Math.abs(days)}d overdue</Badge>;
  }
  if (days === 0) {
    return <Badge variant="warning">Due today</Badge>;
  }
  return <Badge variant="info">In {days}d</Badge>;
}

function DraftsReviewCard({
  drafts,
  isPending,
  isError,
  error,
  onRetry,
}: {
  drafts: ResupplyDraft[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<ResupplyDraft | null>(null);
  const invalidate = () =>
    void queryClient.invalidateQueries({
      queryKey: ["admin", "therapy-resupply", "drafts"],
    });

  const dismiss = useMutation({
    mutationFn: (id: string) => dismissResupplyDraft(id),
    onSuccess: invalidate,
  });

  return (
    <Card
      title="Draft review queue"
      subtitle="Proposals staged from opportunities (manually or by the daily auto-draft job). Review, then approve into a signature link the patient reviews and e-signs — the order is billed to their insurance, not charged on a card."
    >
      {isPending ? (
        <Spinner />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={onRetry} />
      ) : drafts.length === 0 ? (
        <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
          No drafts waiting. Select opportunities above and choose “Create
          drafts”, or enable the daily auto-draft job in System Configuration.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr
                className="text-left border-b"
                style={{ borderColor: "hsl(var(--line-1))" }}
              >
                <th scope="col" className="py-2 font-semibold">
                  Patient
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Item
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Eligible
                </th>
                <th scope="col" className="py-2 font-semibold">
                  Origin
                </th>
                <th scope="col" className="py-2 font-semibold text-right">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {drafts.map((d) => (
                <tr
                  key={d.id}
                  className="border-b"
                  style={{ borderColor: "hsl(var(--line-2))" }}
                >
                  <td className="py-2">
                    <Link
                      href={`/admin/patients/${d.patientId}`}
                      className="font-medium hover:underline"
                      style={{ color: "hsl(var(--penn-navy))" }}
                    >
                      {d.patientName || d.patientId.slice(0, 8)}
                    </Link>
                  </td>
                  <td className="py-2">
                    <span className="font-medium">
                      {SUPPLY_NAMES[d.category] ?? humanizeStatus(d.category)}
                    </span>
                    {d.sourceDescription && (
                      <span
                        className="block text-xs"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {d.sourceDescription}
                      </span>
                    )}
                  </td>
                  <td className="py-2 text-xs">{d.nextEligibleDate ?? "—"}</td>
                  <td className="py-2">
                    <Badge variant={d.origin === "auto" ? "info" : "muted"}>
                      {d.origin === "auto" ? "Auto" : "Manual"}
                    </Badge>
                  </td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        intent="primary"
                        size="sm"
                        onClick={() => setApproving(d)}
                      >
                        <Send className="h-4 w-4" /> Approve & send
                      </Button>
                      <Button
                        intent="secondary"
                        size="sm"
                        disabled={dismiss.isPending}
                        onClick={() => dismiss.mutate(d.id)}
                      >
                        <X className="h-4 w-4" /> Dismiss
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {approving && (
        <ApproveDraftModal
          draft={approving}
          onClose={() => setApproving(null)}
          onDone={() => {
            setApproving(null);
            invalidate();
          }}
        />
      )}
    </Card>
  );
}

function ApproveDraftModal({
  draft,
  onClose,
  onDone,
}: {
  draft: ResupplyDraft;
  onClose: () => void;
  onDone: () => void;
}) {
  const defaultDescription =
    draft.sourceDescription ||
    SUPPLY_NAMES[draft.category] ||
    humanizeStatus(draft.category);
  const [customerName, setCustomerName] = useState(draft.patientName ?? "");
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [description, setDescription] = useState(defaultDescription);
  const [quantity, setQuantity] = useState(1);
  const [priceDollars, setPriceDollars] = useState("");
  const [note, setNote] = useState("");

  const approve = useMutation({
    mutationFn: () => {
      const unitAmountCents = Math.round(Number(priceDollars) * 100);
      const body: ApproveDraftInput = {
        customerName: customerName.trim(),
        customerEmail: customerEmail.trim() || null,
        customerPhone: customerPhone.trim() || null,
        items: [{ description: description.trim(), quantity, unitAmountCents }],
        noteToCustomer: note.trim() || null,
        deliver: true,
      };
      return approveResupplyDraft(draft.id, body);
    },
  });

  // Mirror the server's $0.50 billed-amount floor on the TOTAL (unit × qty)
  // so the modal can't submit a blank/zero estimate the API rejects with
  // amount_below_minimum (insurance-billed, not card checkout).
  const totalCents = Math.round(Number(priceDollars) * 100) * quantity;
  const totalValid = Number.isFinite(totalCents) && totalCents >= 50;
  const recipientValid =
    customerEmail.trim().length > 0 || customerPhone.trim().length > 0;
  const canSubmit =
    customerName.trim().length >= 2 &&
    description.trim().length > 0 &&
    totalValid &&
    recipientValid &&
    !approve.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.45)" }}
      role="dialog"
      aria-modal="true"
      aria-label="Approve resupply draft"
    >
      <div
        className="w-full max-w-md rounded-xl p-5 space-y-3"
        style={{
          backgroundColor: "hsl(var(--surface-1))",
          border: "1px solid hsl(var(--line-1))",
        }}
      >
        <div className="flex items-start justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <ClipboardList className="h-5 w-5" /> Approve & send signature link
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {approve.data ? (
          <div className="space-y-3">
            <p className="text-sm">
              Order <strong>{approve.data.orderReference}</strong> created and
              the signature link was {approve.data.emailSent ? "emailed" : ""}
              {approve.data.emailSent && approve.data.smsSent ? " and " : ""}
              {approve.data.smsSent ? "texted" : ""}
              {!approve.data.emailSent && !approve.data.smsSent
                ? "generated"
                : ""}{" "}
              to the patient.
            </p>
            <p
              className="text-xs break-all"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {approve.data.link}
            </p>
            <div className="flex justify-end">
              <Button intent="primary" size="sm" onClick={onDone}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              Confirm the line item and where to send the signature link. The
              patient e-signs paperwork; the order is billed to their insurance.
            </p>
            <Field label="Customer name">
              <input
                className={inputCls}
                value={customerName}
                onChange={(e) => setCustomerName(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Email">
                <input
                  className={inputCls}
                  type="email"
                  value={customerEmail}
                  onChange={(e) => setCustomerEmail(e.target.value)}
                />
              </Field>
              <Field label="Phone">
                <input
                  className={inputCls}
                  value={customerPhone}
                  onChange={(e) => setCustomerPhone(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Item">
              <input
                className={inputCls}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Quantity">
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  max={99}
                  value={quantity}
                  onChange={(e) =>
                    setQuantity(Math.max(1, Number(e.target.value) || 1))
                  }
                />
              </Field>
              <Field label="Estimated billed amount (USD per unit)">
                <input
                  className={inputCls}
                  type="number"
                  min="0"
                  step="0.01"
                  value={priceDollars}
                  onChange={(e) => setPriceDollars(e.target.value)}
                />
              </Field>
            </div>
            <Field label="Note (optional)">
              <input
                className={inputCls}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>
            {!recipientValid && (
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Enter an email or phone to send the link.
              </p>
            )}
            {priceDollars.trim() !== "" && !totalValid && (
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Enter a billed amount (minimum $0.50 catches blank entries).
              </p>
            )}
            {approve.isError && (
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Couldn’t create the order — check the details and try again.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button intent="secondary" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                intent="primary"
                size="sm"
                disabled={!canSubmit}
                onClick={() => approve.mutate()}
              >
                <Send className="h-4 w-4" /> Approve & send
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span
        className="block text-xs mb-1 font-medium"
        style={{ color: "hsl(var(--ink-2))" }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
