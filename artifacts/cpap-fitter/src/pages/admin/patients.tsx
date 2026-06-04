import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import Papa from "papaparse";
import {
  ApiError,
  getListPatientsQueryKey,
  ListPatientsStatus,
  useBulkUpdatePatientStatus,
  useCreatePatient,
  useImportPatientsCsv,
  useListPatients,
} from "@workspace/api-client-react/admin";
import type {
  BulkPatientStatusRequestStatus,
  CreatePatientRequest,
  ImportPatientRow,
  ImportPatientRowError,
  ListPatientsParams,
} from "@workspace/api-client-react/admin";
import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import {
  Badge,
  humanizeStatus,
  patientStatusVariant,
} from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Pagination } from "@/components/admin/Pagination";
import { Input, Label, Select } from "@/components/admin/Input";
import { Button } from "@/components/admin/Button";
import { BulkActionBar } from "@/components/admin/BulkActionBar";
import {
  HeaderSelectionCheckbox,
  RowSelectionCheckbox,
} from "@/components/admin/SelectionCheckbox";
import { useBulkSelection } from "@/hooks/use-bulk-selection";
import { useFilteredList } from "@/hooks/use-filtered-list";
import { fullName, formatDateTime } from "@/lib/admin/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListPatientsStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

/**
 * Seed the patients filter state from the URL query string. `?search=`
 * pre-fills the search box; `?status=` pre-selects a status (validated
 * against the known statuses so a junk value is ignored). Read once at
 * mount — the filters become local state thereafter.
 */
function initialPatientFilters(): { status: string; search: string } {
  if (typeof window === "undefined") return { status: "", search: "" };
  const params = new URLSearchParams(window.location.search);
  const statusRaw = params.get("status") ?? "";
  const validStatuses = Object.values(ListPatientsStatus) as string[];
  return {
    status: validStatuses.includes(statusRaw) ? statusRaw : "",
    search: params.get("search") ?? "",
  };
}

type PatientRow = {
  id: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  status: string;
  hasPhone: boolean;
  hasEmail: boolean;
  updatedAt: string;
  // Patient-scoped latest-message projection. Refreshed in-line on
  // every inbound/outbound message write, so the list can show "last
  // contacted" without a per-row scan of the messages table. Each
  // field is independently nullable; in practice they're either all
  // populated (the patient has at least one message) or all null
  // (brand-new patient who has never been contacted).
  lastMessageAt?: string | null;
  lastMessageDirection?: "inbound" | "outbound" | null;
  lastMessagePreview?: string | null;
};

/**
 * Render the Patients administration page with list, filtering, bulk actions, CSV import/export, and create patient modal.
 *
 * The component manages filter and pagination state, debounced search input, row selection for bulk operations,
 * CSV export/import flows, and displays modals for creating a new patient and importing CSVs. It also renders
 * a confirmation dialog element used by bulk actions.
 *
 * @returns The Patients administration page as a React element.
 */
export function PatientsPage() {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();

  // Filter + offset state. useFilteredList owns the "reset offset to
  // 0 on any filter change" invariant — pagination state still lives
  // here, but the page can never forget to reset it. The initial
  // filters are seeded from the URL query string so a deep link
  // (the dashboard KPI tiles, or the "Find this person in Patients"
  // jump from a customer record) lands pre-filtered.
  const { filters, setFilter, clearFilters, offset, setOffset, pageSize } =
    useFilteredList(initialPatientFilters(), { pageSize: PAGE_SIZE });
  const { status: statusFilter, search } = filters;
  // Search-input is debounced into filters.search so we don't hammer
  // the API while the admin is mid-type. The input value is pure UI
  // state; the committed string is what drives the query params.
  // Seed from the URL too: the debounced effect below mirrors
  // searchInput into filters.search, so an empty input here would
  // immediately wipe the URL-seeded filter on mount.
  const [searchInput, setSearchInput] = useState<string>(
    () => initialPatientFilters().search,
  );
  const [creating, setCreating] = useState<boolean>(false);
  const [importing, setImporting] = useState<boolean>(false);
  const [bulkFeedback, setBulkFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [bulkExporting, setBulkExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const bulkMut = useBulkUpdatePatientStatus();

  useEffect(() => {
    const trimmed = searchInput.trim();
    const t = setTimeout(() => {
      setFilter("search", trimmed);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput, setFilter]);

  const params: ListPatientsParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListPatientsStatus }
        : {}),
      ...(search ? { search } : {}),
      limit: pageSize,
      offset,
    }),
    [statusFilter, search, offset, pageSize],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListPatients(params, {
      query: {
        queryKey: getListPatientsQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  // Bulk-action selection. Selection intentionally does NOT persist
  // across pagination — the action bar always shows "N selected"
  // reflecting only what's currently visible-and-checked. The hook
  // owns the auto-prune on visible-set change so a "Pause 12" click
  // after pagination targets the 12 visible rows, not ghosts.
  const visibleItems = useMemo(() => data?.items ?? [], [data]);
  const {
    selectedIds,
    allVisibleSelected,
    someVisibleSelected,
    toggleOne,
    toggleAllVisible,
    clear: clearSelection,
    set: setSelection,
  } = useBulkSelection<PatientRow>({
    visibleItems,
    itemId: (r) => r.id,
  });

  async function runBulk(
    targetStatus: BulkPatientStatusRequestStatus,
  ): Promise<void> {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    const verb =
      targetStatus === "active"
        ? "Resume"
        : targetStatus === "paused"
          ? "Pause"
          : "Close";
    const isClosing = targetStatus === "closed";
    if (
      !(await confirm({
        title: isClosing
          ? `Close ${ids.length} patient${ids.length === 1 ? "" : "s"}?`
          : `${verb} ${ids.length} patient${ids.length === 1 ? "" : "s"}?`,
        description: isClosing
          ? "Closed patients are removed from outreach permanently."
          : undefined,
        confirmLabel: verb,
        destructive: isClosing,
      }))
    )
      return;
    setBulkFeedback(null);
    try {
      const res = await bulkMut.mutateAsync({
        data: { ids, status: targetStatus },
      });
      const updatedCount = res.updated.length;
      const failedCount = res.failed.length;
      // Group failures by reason for the toast — currently the only
      // reason the server emits is "not_found", but the breakdown is
      // forward-compatible with future codes (stale, forbidden, …).
      const reasonCounts = new Map<string, number>();
      for (const f of res.failed) {
        reasonCounts.set(f.error, (reasonCounts.get(f.error) ?? 0) + 1);
      }
      const reasonStr = Array.from(reasonCounts.entries())
        .map(([reason, n]) => `${n} ${reason.replace("_", " ")}`)
        .join(", ");
      const text =
        failedCount === 0
          ? `Updated ${updatedCount} patient${updatedCount === 1 ? "" : "s"}.`
          : `Updated ${updatedCount}, ${failedCount} failed (${reasonStr}).`;
      setBulkFeedback({
        kind: failedCount === 0 ? "success" : "error",
        text,
      });
      // Refresh the page so updated rows show their new status badge.
      await queryClient.invalidateQueries({
        queryKey: getListPatientsQueryKey(params),
      });
      // Clear selection only on full success — partial failures
      // leave the failed ids checked so the admin can see what
      // didn't go through.
      if (failedCount === 0) clearSelection();
      else {
        const failedSet = new Set(res.failed.map((f) => f.id));
        setSelection(failedSet);
      }
    } catch (err) {
      const msg =
        err instanceof ApiError
          ? ((err.data as { message?: string; error?: string } | undefined)
              ?.message ??
            (err.data as { error?: string } | undefined)?.error ??
            err.message)
          : err instanceof Error
            ? err.message
            : "Bulk action failed.";
      setBulkFeedback({ kind: "error", text: msg });
    }
  }

  // Export CSV. The dashboard talks to the API over the
  // `pf_session` cookie (set by /resupply-api/auth/sign-in), which
  // the browser sends automatically on same-origin requests — so a
  // plain `fetch` with default credentials carries auth. We use
  // fetch + blob (instead of a plain anchor) so we can surface a
  // friendly error message on 401/5xx instead of a downloaded
  // error page.
  async function downloadCsv(): Promise<void> {
    setExportError(null);
    setBulkExporting(true);
    try {
      const url = new URL(
        "/resupply-api/patients/export.csv",
        window.location.origin,
      );
      if (statusFilter) url.searchParams.set("status", statusFilter);
      if (search) url.searchParams.set("search", search);

      const headers: Record<string, string> = { Accept: "text/csv" };

      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? "Your session expired. Please refresh and try again."
            : `Export failed (${res.status}).`,
        );
      }
      const truncated = res.headers.get("X-Truncated") === "true";
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `patients-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Revoke the object URL after a short delay — some browsers
      // require it to live until the download initiates. 1s is
      // safely past click-handler completion.
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
      if (truncated) {
        setBulkFeedback({
          kind: "error",
          text: "Export was capped at 5,000 rows. Narrow your filters to export the rest.",
        });
      }
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setBulkExporting(false);
    }
  }

  const columns: Column<PatientRow>[] = [
    {
      key: "select",
      header: (
        <HeaderSelectionCheckbox
          allSelected={allVisibleSelected}
          someSelected={someVisibleSelected}
          onToggle={toggleAllVisible}
        />
      ),
      className: "w-10",
      render: (r) => (
        <RowSelectionCheckbox
          ariaLabel={`Select ${r.pacwareId}`}
          checked={selectedIds.has(r.id)}
          onToggle={() => toggleOne(r.id)}
        />
      ),
    },
    {
      key: "name",
      header: "Patient",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {fullName(r.firstName, r.lastName)}
          </div>
          <div className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            PAC #{r.pacwareId}
          </div>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (r) => (
        <Badge variant={patientStatusVariant(r.status)}>
          {humanizeStatus(r.status)}
        </Badge>
      ),
    },
    {
      key: "channels",
      header: "Channels",
      render: (r) => (
        <div className="flex gap-1.5">
          {r.hasPhone && <Badge variant="info">SMS / Voice</Badge>}
          {r.hasEmail && <Badge variant="neutral">Email</Badge>}
          {!r.hasPhone && !r.hasEmail && <Badge variant="muted">None</Badge>}
        </div>
      ),
    },
    {
      // Last-contacted column. The triplet (timestamp + direction +
      // 80-char preview) lets an admin scan the page and immediately
      // spot patients waiting on a reply. We render the timestamp on
      // top in the existing muted style, then a one-line clamped
      // preview underneath prefixed with the direction so an admin
      // can tell at a glance whether the last touch was outbound
      // ("we wrote them; awaiting reply") or inbound ("they wrote;
      // awaiting us"). Patients with no messages yet show a single
      // dash to keep row heights uniform.
      key: "lastMessage",
      header: "Last message",
      render: (r) => {
        if (!r.lastMessageAt) {
          return (
            <span className="text-xs" style={{ color: "#9ca3af" }}>
              —
            </span>
          );
        }
        const isInbound = r.lastMessageDirection === "inbound";
        return (
          <div className="flex flex-col gap-0.5" style={{ maxWidth: "22rem" }}>
            <div className="flex items-center gap-1.5">
              <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                {formatDateTime(r.lastMessageAt)}
              </span>
              <Badge variant={isInbound ? "warning" : "neutral"}>
                {isInbound ? "Inbound" : "Outbound"}
              </Badge>
            </div>
            {r.lastMessagePreview ? (
              <div
                className="text-xs"
                style={{
                  color: "hsl(var(--ink-2))",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={r.lastMessagePreview}
              >
                {r.lastMessagePreview}
              </div>
            ) : null}
          </div>
        );
      },
    },
    {
      key: "updatedAt",
      header: "Updated",
      render: (r) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(r.updatedAt)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1
            className="text-2xl font-semibold mb-1"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Patients
          </h1>
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            Search and review the patient roster. Names decrypted server-side;
            phone and email are only shown as channel availability.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            intent="secondary"
            onClick={() => void downloadCsv()}
            isLoading={bulkExporting}
          >
            Export CSV
          </Button>
          <Button intent="secondary" onClick={() => setImporting(true)}>
            Import CSV
          </Button>
          <Button onClick={() => setCreating(true)}>+ New customer</Button>
        </div>
      </header>

      {exportError && (
        <ErrorPanel
          error={new Error(exportError)}
          onRetry={() => void downloadCsv()}
        />
      )}

      <Card>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <Label htmlFor="patients-search">Search</Label>
            <Input
              id="patients-search"
              type="search"
              placeholder="Name or PACware ID"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="patients-status">Status</Label>
            <Select
              id="patients-status"
              value={statusFilter}
              emptyOptionLabel="All statuses"
              options={STATUS_OPTIONS}
              onChange={(e) => setFilter("status", e.target.value)}
            />
          </div>
          <div className="flex items-end">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                // Reset the un-debounced input ref alongside the
                // hook-managed filters so the visible input clears
                // immediately too.
                setSearchInput("");
                clearFilters();
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

      <BulkActionBar
        selectedCount={selectedIds.size}
        onClear={clearSelection}
        feedback={bulkFeedback}
        onDismissFeedback={() => setBulkFeedback(null)}
        ariaLabel="Bulk patient actions"
        actions={[
          {
            key: "resume",
            label: `Resume ${selectedIds.size}`,
            onClick: () => void runBulk("active"),
            isPending: bulkMut.isPending,
          },
          {
            key: "pause",
            label: `Pause ${selectedIds.size}`,
            onClick: () => void runBulk("paused"),
            isPending: bulkMut.isPending,
          },
          {
            key: "close",
            label: `Close ${selectedIds.size}`,
            onClick: () => void runBulk("closed"),
            isPending: bulkMut.isPending,
          },
        ]}
      />

      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading patients…" />
          ) : (
            <>
              <Table
                columns={columns}
                rows={data.items}
                rowKey={(r) => r.id}
                onRowClick={(r) => setLocation(`/admin/patients/${r.id}`)}
                emptyState={
                  <EmptyState
                    title="No patients match this view."
                    hint="Adjust filters or clear them to see the full roster."
                  />
                }
              />
              <Pagination
                total={data.total}
                limit={data.limit}
                offset={data.offset}
                onChange={setOffset}
                isLoading={isFetching}
              />
            </>
          )}
        </Card>
      )}

      {creating && (
        <NewCustomerModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setLocation(`/admin/patients/${id}`);
          }}
        />
      )}

      {importing && (
        <ImportCsvModal
          onClose={() => setImporting(false)}
          onComplete={() => {
            // Don't auto-close — admin should see the summary first.
            void refetch();
          }}
        />
      )}
      {ConfirmDialogEl}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New customer modal
// ---------------------------------------------------------------------------
//
// Mirrors the shape of CreatePatientRequest in the OpenAPI spec.
// PHI is sent over TLS as plaintext JSON; the server pgcrypto-
// encrypts at the SQL site. We never persist PHI in localStorage,
// never log it, and never echo it back in the success response.
//
// Field ordering matches a paper intake form (identity → DOB →
// contact → address → outreach plan) so the admin can fill it
// in linearly without skipping back and forth.

type NewCustomerForm = {
  pacwareId: string;
  legalFirstName: string;
  legalLastName: string;
  dateOfBirth: string;
  phoneE164: string;
  email: string;
  // Address fields are flattened in the UI for layout simplicity;
  // we recompose them into the nested address object on submit.
  addressLine1: string;
  addressLine2: string;
  addressCity: string;
  addressState: string;
  addressPostalCode: string;
  addressCountry: string;
  status: "active" | "paused" | "closed";
  insurancePayer: string;
  cadenceOverrideDays: string;
  channelPreference: "" | "sms" | "email" | "voice";
};

const EMPTY_NEW_CUSTOMER_FORM: NewCustomerForm = {
  pacwareId: "",
  legalFirstName: "",
  legalLastName: "",
  dateOfBirth: "",
  phoneE164: "",
  email: "",
  addressLine1: "",
  addressLine2: "",
  addressCity: "",
  addressState: "",
  addressPostalCode: "",
  // Default to US since this is an in-network DME outreach tool;
  // pre-filling avoids the most common single-character fix.
  addressCountry: "US",
  status: "active",
  insurancePayer: "",
  cadenceOverrideDays: "",
  channelPreference: "",
};

const E164_RE = /^\+[1-9]\d{7,14}$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function buildCreatePatientBody(form: NewCustomerForm): {
  body: CreatePatientRequest | null;
  error: string | null;
} {
  const pacwareId = form.pacwareId.trim();
  const legalFirstName = form.legalFirstName.trim();
  const legalLastName = form.legalLastName.trim();
  const dateOfBirth = form.dateOfBirth.trim();
  const phoneE164 = form.phoneE164.trim();
  const email = form.email.trim();
  const insurancePayer = form.insurancePayer.trim();
  const cadenceRaw = form.cadenceOverrideDays.trim();

  if (pacwareId === "") return { body: null, error: "Pacware ID is required." };
  if (pacwareId.length > 64) {
    return { body: null, error: "Pacware ID is too long (max 64 chars)." };
  }
  if (legalFirstName === "")
    return { body: null, error: "First name is required." };
  if (legalLastName === "")
    return { body: null, error: "Last name is required." };
  if (!ISO_DATE_RE.test(dateOfBirth)) {
    return { body: null, error: "Date of birth must be in YYYY-MM-DD format." };
  }
  if (phoneE164 !== "" && !E164_RE.test(phoneE164)) {
    return {
      body: null,
      error: "Phone must be E.164 format like +14155551212.",
    };
  }
  if (email !== "" && !EMAIL_RE.test(email)) {
    return { body: null, error: "Email is not valid." };
  }

  // Address: either provide a complete one or leave it entirely
  // blank. A half-filled address is almost certainly a mistake and
  // the API rejects it on shape anyway.
  const addressFields = [
    form.addressLine1,
    form.addressCity,
    form.addressState,
    form.addressPostalCode,
    form.addressCountry,
  ].map((s) => s.trim());
  const anyAddress =
    addressFields.some((s) => s !== "") || form.addressLine2.trim() !== "";
  const allRequiredAddress = addressFields.every((s) => s !== "");
  if (anyAddress && !allRequiredAddress) {
    return {
      body: null,
      error:
        "Address needs line 1, city, state, postal code, and country — or leave the whole address blank.",
    };
  }

  let cadenceOverrideDays: number | null = null;
  if (cadenceRaw !== "") {
    const n = Number(cadenceRaw);
    if (!Number.isInteger(n) || n < 1 || n > 365) {
      return {
        body: null,
        error: "Cadence override must be a whole number from 1 to 365 days.",
      };
    }
    cadenceOverrideDays = n;
  }

  const body: CreatePatientRequest = {
    pacwareId,
    legalFirstName,
    legalLastName,
    dateOfBirth,
    phoneE164: phoneE164 === "" ? null : phoneE164,
    email: email === "" ? null : email,
    address: anyAddress
      ? {
          line1: form.addressLine1.trim(),
          ...(form.addressLine2.trim() !== ""
            ? { line2: form.addressLine2.trim() }
            : {}),
          city: form.addressCity.trim(),
          state: form.addressState.trim(),
          postalCode: form.addressPostalCode.trim(),
          country: form.addressCountry.trim(),
        }
      : null,
    status: form.status,
    insurancePayer: insurancePayer === "" ? null : insurancePayer,
    cadenceOverrideDays,
    channelPreference:
      form.channelPreference === "" ? null : form.channelPreference,
  };
  return { body, error: null };
}

function describeCreateError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Couldn't create the customer.";
  }
  return err instanceof Error ? err.message : "Couldn't create the customer.";
}

function NewCustomerModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<NewCustomerForm>(EMPTY_NEW_CUSTOMER_FORM);
  const [error, setError] = useState<string | null>(null);

  const createMut = useCreatePatient();
  const isPending = createMut.isPending;

  // Esc closes the modal — same a11y pattern as RuleFormModal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isPending]);

  function patch<K extends keyof NewCustomerForm>(
    key: K,
    value: NewCustomerForm[K],
  ) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { body, error: validationError } = buildCreatePatientBody(form);
    if (!body) {
      setError(validationError);
      return;
    }
    try {
      const res = await createMut.mutateAsync({ data: body });
      // Invalidate every list-patients query (across filters / pages)
      // so the new row shows up regardless of which view the admin
      // returns to.
      await queryClient.invalidateQueries({
        queryKey: getListPatientsQueryKey(),
      });
      onCreated(res.id);
    } catch (err) {
      setError(describeCreateError(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-customer-title"
    >
      <div
        className="w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <h2
            id="new-customer-title"
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            New customer
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            All PHI fields are encrypted at rest. The Pacware ID must be unique
            — duplicates are rejected.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="np-pacware">Pacware ID</Label>
              <Input
                id="np-pacware"
                value={form.pacwareId}
                maxLength={64}
                onChange={(e) => patch("pacwareId", e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="np-status">Status</Label>
              <Select
                id="np-status"
                value={form.status}
                options={[
                  { value: "active", label: "Active" },
                  { value: "paused", label: "Paused" },
                  { value: "closed", label: "Closed" },
                ]}
                onChange={(e) =>
                  patch("status", e.target.value as NewCustomerForm["status"])
                }
                disabled={isPending}
              />
            </div>

            <div>
              <Label htmlFor="np-first">Legal first name</Label>
              <Input
                id="np-first"
                value={form.legalFirstName}
                maxLength={80}
                onChange={(e) => patch("legalFirstName", e.target.value)}
                required
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="np-last">Legal last name</Label>
              <Input
                id="np-last"
                value={form.legalLastName}
                maxLength={80}
                onChange={(e) => patch("legalLastName", e.target.value)}
                required
                disabled={isPending}
                autoComplete="off"
              />
            </div>

            <div>
              <Label htmlFor="np-dob">Date of birth</Label>
              <Input
                id="np-dob"
                type="date"
                value={form.dateOfBirth}
                onChange={(e) => patch("dateOfBirth", e.target.value)}
                required
                disabled={isPending}
              />
              <p
                className="mt-1 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Stored as YYYY-MM-DD; no timezone applied.
              </p>
            </div>
            <div>
              <Label htmlFor="np-phone">Phone (E.164)</Label>
              <Input
                id="np-phone"
                type="tel"
                placeholder="+14155551212"
                value={form.phoneE164}
                onChange={(e) => patch("phoneE164", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="np-email">Email</Label>
              <Input
                id="np-email"
                type="email"
                value={form.email}
                maxLength={254}
                onChange={(e) => patch("email", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>

            <div className="md:col-span-2 pt-2">
              <h3
                className="text-sm font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Mailing address (optional)
              </h3>
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Provide the full address or leave it blank. Required for shipped
                supplies; optional if the patient is e-fulfillment only.
              </p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="np-line1">Address line 1</Label>
              <Input
                id="np-line1"
                value={form.addressLine1}
                maxLength={120}
                onChange={(e) => patch("addressLine1", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="np-line2">Address line 2 (optional)</Label>
              <Input
                id="np-line2"
                value={form.addressLine2}
                maxLength={120}
                onChange={(e) => patch("addressLine2", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="np-city">City</Label>
              <Input
                id="np-city"
                value={form.addressCity}
                maxLength={80}
                onChange={(e) => patch("addressCity", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="np-state">State / region</Label>
              <Input
                id="np-state"
                value={form.addressState}
                maxLength={40}
                onChange={(e) => patch("addressState", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="np-postal">Postal code</Label>
              <Input
                id="np-postal"
                value={form.addressPostalCode}
                maxLength={20}
                onChange={(e) => patch("addressPostalCode", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>
            <div>
              <Label htmlFor="np-country">Country</Label>
              <Input
                id="np-country"
                value={form.addressCountry}
                maxLength={40}
                onChange={(e) => patch("addressCountry", e.target.value)}
                disabled={isPending}
                autoComplete="off"
              />
            </div>

            <div className="md:col-span-2 pt-2">
              <h3
                className="text-sm font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Outreach overrides (optional)
              </h3>
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Leave blank to fall back to the matching frequency rule.
              </p>
            </div>
            <div>
              <Label htmlFor="np-payer">Insurance payer</Label>
              <Input
                id="np-payer"
                value={form.insurancePayer}
                maxLength={120}
                placeholder="e.g. Aetna"
                onChange={(e) => patch("insurancePayer", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="np-cadence">Cadence override (days)</Label>
              <Input
                id="np-cadence"
                type="number"
                min={1}
                max={365}
                value={form.cadenceOverrideDays}
                onChange={(e) => patch("cadenceOverrideDays", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="np-channel">Channel preference</Label>
              <Select
                id="np-channel"
                value={form.channelPreference}
                emptyOptionLabel="Use SMS-then-email fallback"
                options={[
                  { value: "sms", label: "SMS" },
                  { value: "email", label: "Email" },
                  { value: "voice", label: "Voice" },
                ]}
                onChange={(e) =>
                  patch(
                    "channelPreference",
                    e.target.value as NewCustomerForm["channelPreference"],
                  )
                }
                disabled={isPending}
              />
            </div>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
              {error}
            </p>
          )}

          <div
            className="flex justify-end gap-2 pt-2 border-t"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <Button
              intent="secondary"
              type="button"
              onClick={onClose}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" isLoading={isPending}>
              Create customer
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CSV import modal
// ---------------------------------------------------------------------------
//
// Two-stage flow:
//
//   1. File picked → parse client-side with papaparse, normalize the
//      headers, validate every row. The preview table shows the first
//      handful of rows AND every row with a validation error so the
//      admin can fix the source file before sending PHI over the wire.
//
//   2. Submit → chunk into batches of 250 (server caps at 500 per
//      request, but smaller batches keep the per-request audit row
//      readable and let the progress counter advance more often) and
//      call the import hook once per batch. We aggregate `created`,
//      `skippedDuplicates`, and `errors[]` across batches; on error
//      rows we offer a downloadable error CSV so the admin can patch
//      and re-import only the failed rows.
//
// We deliberately do NOT auto-close on success — the admin needs to
// see the summary, especially the duplicate / error counts.

const CSV_BATCH_SIZE = 250;
const CSV_PREVIEW_ROWS = 8;

// Loose mapping: papaparse normalizes header strings exactly as
// they appear in the CSV; we lower-case + strip non-alphanumerics so
// `Pacware ID`, `pacware_id`, `pacwareId` all map to the same field.
const HEADER_ALIASES: Record<string, keyof ImportPatientRow> = {
  pacwareid: "pacwareId",
  legalfirstname: "legalFirstName",
  firstname: "legalFirstName",
  legallastname: "legalLastName",
  lastname: "legalLastName",
  dateofbirth: "dateOfBirth",
  dob: "dateOfBirth",
  phone: "phoneE164",
  phonee164: "phoneE164",
  email: "email",
  addressline1: "addressLine1",
  address1: "addressLine1",
  addressline2: "addressLine2",
  address2: "addressLine2",
  city: "city",
  state: "state",
  postalcode: "postalCode",
  zip: "postalCode",
  country: "country",
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, "");
}

type ParsedRow = {
  rowIndex: number; // 1-based for display ("Row 1" = the first data row)
  raw: Record<string, string>;
  parsed: ImportPatientRow | null;
  error: string | null;
};

function buildRowFromCsv(raw: Record<string, string>): {
  row: ImportPatientRow | null;
  error: string | null;
} {
  const trimmed: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    trimmed[k] = (v ?? "").trim();
  }

  const pacwareId = trimmed.pacwareId;
  const legalFirstName = trimmed.legalFirstName;
  const legalLastName = trimmed.legalLastName;
  const dateOfBirth = trimmed.dateOfBirth;

  if (!pacwareId) return { row: null, error: "Pacware ID is required." };
  if (!legalFirstName)
    return { row: null, error: "Legal first name is required." };
  if (!legalLastName)
    return { row: null, error: "Legal last name is required." };
  if (!dateOfBirth) return { row: null, error: "Date of birth is required." };

  // Server enforces YYYY-MM-DD; we surface a friendly error early so
  // the admin doesn't blast 500 rows of MM/DD/YYYY at us.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
    return {
      row: null,
      error: `Date of birth must be YYYY-MM-DD (got "${dateOfBirth}").`,
    };
  }

  const row: ImportPatientRow = {
    pacwareId,
    legalFirstName,
    legalLastName,
    dateOfBirth,
  };
  if (trimmed.phoneE164) row.phoneE164 = trimmed.phoneE164;
  if (trimmed.email) row.email = trimmed.email;
  if (trimmed.addressLine1) row.addressLine1 = trimmed.addressLine1;
  if (trimmed.addressLine2) row.addressLine2 = trimmed.addressLine2;
  if (trimmed.city) row.city = trimmed.city;
  if (trimmed.state) row.state = trimmed.state;
  if (trimmed.postalCode) row.postalCode = trimmed.postalCode;
  if (trimmed.country) row.country = trimmed.country;
  return { row, error: null };
}

type ImportSummary = {
  created: number;
  skippedDuplicates: number;
  serverErrors: ImportPatientRowError[];
};

function ImportCsvModal({
  onClose,
  onComplete,
}: {
  onClose: () => void;
  onComplete: () => void;
}) {
  const importMut = useImportPatientsCsv();
  const [parsing, setParsing] = useState(false);
  const [rows, setRows] = useState<ParsedRow[]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{
    sentBatches: number;
    totalBatches: number;
  } | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Block closing while a batch is in flight — bailing mid-import
  // would leave a half-finished bulk_create audit trail.
  const lockClose = parsing || submitting;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !lockClose) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, lockClose]);

  function reset() {
    setRows([]);
    setParseError(null);
    setSummary(null);
    setSubmitError(null);
    setProgress(null);
  }

  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    reset();
    setParsing(true);

    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      // Re-key parsed rows from the CSV's header → our canonical
      // ImportPatientRow field name. Unknown headers are dropped.
      transformHeader: (h) => {
        const norm = normalizeHeader(h);
        return HEADER_ALIASES[norm] ?? "";
      },
      complete: (results) => {
        setParsing(false);
        if (results.errors.length > 0) {
          setParseError(
            `CSV parse error on line ${results.errors[0].row ?? "?"}: ${results.errors[0].message}`,
          );
          return;
        }
        const data = results.data.filter(
          (r) => r && Object.values(r).some((v) => (v ?? "").trim() !== ""),
        );
        if (data.length === 0) {
          setParseError("CSV had no data rows.");
          return;
        }
        const parsed: ParsedRow[] = data.map((raw, i) => {
          const { row, error } = buildRowFromCsv(raw);
          return { rowIndex: i + 1, raw, parsed: row, error };
        });
        setRows(parsed);
      },
      error: (err) => {
        setParsing(false);
        setParseError(err.message);
      },
    });

    // Allow re-selecting the same file after a reset.
    e.target.value = "";
  }

  const validRows = rows.filter((r) => r.parsed !== null);
  const invalidRows = rows.filter((r) => r.error !== null);

  async function onSubmit() {
    if (validRows.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);
    setSummary(null);

    const batches: ImportPatientRow[][] = [];
    for (let i = 0; i < validRows.length; i += CSV_BATCH_SIZE) {
      batches.push(
        validRows.slice(i, i + CSV_BATCH_SIZE).map((r) => r.parsed!),
      );
    }

    const agg: ImportSummary = {
      created: 0,
      skippedDuplicates: 0,
      serverErrors: [],
    };
    setProgress({ sentBatches: 0, totalBatches: batches.length });

    for (let i = 0; i < batches.length; i += 1) {
      try {
        const res = await importMut.mutateAsync({
          data: { rows: batches[i] },
        });
        agg.created += res.created;
        agg.skippedDuplicates += res.skippedDuplicates;
        // Re-base server's row indexes to the original CSV row number
        // so the admin can find the offending row in their source file.
        const offset = i * CSV_BATCH_SIZE;
        for (const e of res.errors) {
          agg.serverErrors.push({ ...e, rowIndex: e.rowIndex + offset });
        }
      } catch (err) {
        const msg =
          err instanceof ApiError
            ? ((err.data as { message?: string } | undefined)?.message ??
              "Batch failed.")
            : err instanceof Error
              ? err.message
              : "Batch failed.";
        setSubmitError(`Batch ${i + 1} of ${batches.length} failed: ${msg}`);
        // Stop on first batch failure — partial imports are confusing
        // for the admin and we already have a summary of what
        // succeeded so far.
        setProgress({ sentBatches: i, totalBatches: batches.length });
        setSummary(agg);
        setSubmitting(false);
        onComplete();
        return;
      }
      setProgress({ sentBatches: i + 1, totalBatches: batches.length });
    }

    setSummary(agg);
    setSubmitting(false);
    onComplete();
  }

  function downloadErrorsCsv() {
    if (!summary) return;
    // Combine client-side validation failures with server-reported
    // errors. Both share the same shape: rowIndex + message.
    const lines: string[] = ["rowIndex,field,message"];
    for (const r of invalidRows) {
      lines.push(`${r.rowIndex},,"${(r.error ?? "").replace(/"/g, '""')}"`);
    }
    for (const e of summary.serverErrors) {
      lines.push(
        `${e.rowIndex + 1},${e.field ?? ""},"${e.message.replace(/"/g, '""')}"`,
      );
    }
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-errors.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !lockClose && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-csv-title"
    >
      <div
        className="w-full max-w-4xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2
                id="import-csv-title"
                className="text-lg font-semibold"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Import patients from CSV
              </h2>
              <p
                className="text-xs mt-1"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                Required columns: <code>pacwareId</code>,{" "}
                <code>legalFirstName</code>, <code>legalLastName</code>,{" "}
                <code>dateOfBirth</code> (YYYY-MM-DD). Optional:{" "}
                <code>phoneE164</code>, <code>email</code>, address fields.
                Duplicates by Pacware ID are skipped — they don't fail the
                import.
              </p>
            </div>
            <Button
              intent="ghost"
              size="sm"
              onClick={onClose}
              disabled={lockClose}
            >
              Close
            </Button>
          </div>

          {!summary && (
            <div>
              <Label htmlFor="csv-file">CSV file</Label>
              <input
                id="csv-file"
                type="file"
                accept=".csv,text/csv"
                onChange={onFile}
                disabled={parsing || submitting}
                className="block w-full text-sm"
              />
            </div>
          )}

          {parsing && <Spinner label="Parsing CSV…" />}

          {parseError && (
            <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
              {parseError}
            </p>
          )}

          {rows.length > 0 && !summary && (
            <div className="space-y-3">
              <div
                className="rounded border px-3 py-2 text-sm"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  backgroundColor: "#fafafa",
                  color: "hsl(var(--ink-2))",
                }}
              >
                <strong>{validRows.length}</strong> valid row
                {validRows.length === 1 ? "" : "s"} ready to import,{" "}
                <strong
                  style={{
                    color: invalidRows.length > 0 ? "#b91c1c" : "#374151",
                  }}
                >
                  {invalidRows.length}
                </strong>{" "}
                with validation errors.
              </div>

              {invalidRows.length > 0 && (
                <div>
                  <p
                    className="text-xs uppercase tracking-wider font-semibold mb-1"
                    style={{ color: "#b91c1c" }}
                  >
                    Validation errors
                  </p>
                  <ul
                    className="text-xs space-y-1"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {invalidRows.slice(0, 10).map((r) => (
                      <li key={r.rowIndex}>
                        <strong>Row {r.rowIndex}</strong>: {r.error}
                      </li>
                    ))}
                    {invalidRows.length > 10 && (
                      <li style={{ color: "hsl(var(--ink-3))" }}>
                        …and {invalidRows.length - 10} more.
                      </li>
                    )}
                  </ul>
                </div>
              )}

              <div>
                <p
                  className="text-xs uppercase tracking-wider font-semibold mb-1"
                  style={{ color: "hsl(var(--penn-gold-deep))" }}
                >
                  Preview (first {Math.min(CSV_PREVIEW_ROWS, validRows.length)}{" "}
                  rows)
                </p>
                <div
                  className="overflow-x-auto rounded border"
                  style={{ borderColor: "hsl(var(--line-1))" }}
                >
                  <table className="w-full text-xs">
                    <thead style={{ backgroundColor: "#f3f4f6" }}>
                      <tr>
                        <th className="text-left px-2 py-1">#</th>
                        <th className="text-left px-2 py-1">Pacware</th>
                        <th className="text-left px-2 py-1">Name</th>
                        <th className="text-left px-2 py-1">DOB</th>
                        <th className="text-left px-2 py-1">Phone</th>
                        <th className="text-left px-2 py-1">Email</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.slice(0, CSV_PREVIEW_ROWS).map((r) => (
                        <tr key={r.rowIndex}>
                          <td
                            className="px-2 py-1"
                            style={{ color: "hsl(var(--ink-3))" }}
                          >
                            {r.rowIndex}
                          </td>
                          <td className="px-2 py-1">{r.parsed!.pacwareId}</td>
                          <td className="px-2 py-1">
                            {r.parsed!.legalFirstName} {r.parsed!.legalLastName}
                          </td>
                          <td className="px-2 py-1">{r.parsed!.dateOfBirth}</td>
                          <td className="px-2 py-1">
                            {r.parsed!.phoneE164 ?? "—"}
                          </td>
                          <td className="px-2 py-1">
                            {r.parsed!.email ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {progress && (
                <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                  Sending batch {progress.sentBatches} of{" "}
                  {progress.totalBatches}…
                </p>
              )}

              {submitError && (
                <p
                  className="text-sm"
                  style={{ color: "#b91c1c" }}
                  role="alert"
                >
                  {submitError}
                </p>
              )}

              <div className="flex justify-end gap-2">
                <Button intent="ghost" onClick={reset} disabled={submitting}>
                  Pick a different file
                </Button>
                <Button
                  isLoading={submitting}
                  disabled={submitting || validRows.length === 0}
                  onClick={() => void onSubmit()}
                >
                  Import {validRows.length} patient
                  {validRows.length === 1 ? "" : "s"}
                </Button>
              </div>
            </div>
          )}

          {summary && (
            <div className="space-y-3">
              <div
                className="rounded border px-4 py-3"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  backgroundColor: "#fafafa",
                  color: "hsl(var(--ink-2))",
                }}
              >
                <p className="text-sm">
                  <strong style={{ color: "#166534" }}>
                    {summary.created}
                  </strong>{" "}
                  created · <strong>{summary.skippedDuplicates}</strong>{" "}
                  duplicate
                  {summary.skippedDuplicates === 1 ? "" : "s"} skipped ·{" "}
                  <strong
                    style={{
                      color:
                        summary.serverErrors.length + invalidRows.length > 0
                          ? "#b91c1c"
                          : "#374151",
                    }}
                  >
                    {summary.serverErrors.length + invalidRows.length}
                  </strong>{" "}
                  error
                  {summary.serverErrors.length + invalidRows.length === 1
                    ? ""
                    : "s"}
                </p>
              </div>

              {summary.serverErrors.length > 0 && (
                <div>
                  <p
                    className="text-xs uppercase tracking-wider font-semibold mb-1"
                    style={{ color: "#b91c1c" }}
                  >
                    Server-reported errors
                  </p>
                  <ul
                    className="text-xs space-y-1"
                    style={{ color: "hsl(var(--ink-2))" }}
                  >
                    {summary.serverErrors.slice(0, 10).map((e, i) => (
                      <li key={`${e.rowIndex}-${i}`}>
                        <strong>Row {e.rowIndex + 1}</strong>
                        {e.field ? ` (${e.field})` : ""}: {e.message}
                      </li>
                    ))}
                    {summary.serverErrors.length > 10 && (
                      <li style={{ color: "hsl(var(--ink-3))" }}>
                        …and {summary.serverErrors.length - 10} more.
                      </li>
                    )}
                  </ul>
                </div>
              )}

              <div className="flex justify-end gap-2">
                {(summary.serverErrors.length > 0 ||
                  invalidRows.length > 0) && (
                  <Button intent="secondary" onClick={downloadErrorsCsv}>
                    Download errors CSV
                  </Button>
                )}
                <Button onClick={onClose}>Done</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
