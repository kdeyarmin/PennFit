import { useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  getListPatientsQueryKey,
  ListPatientsStatus,
  useCreatePatient,
  useListPatients,
} from "@workspace/resupply-api-client";
import type {
  CreatePatientRequest,
  ListPatientsParams,
} from "@workspace/resupply-api-client";
import { Card } from "../components/Card";
import { Table, type Column } from "../components/Table";
import { Badge, humanizeStatus, patientStatusVariant } from "../components/Badge";
import { Spinner } from "../components/Spinner";
import { EmptyState } from "../components/EmptyState";
import { ErrorPanel } from "../components/ErrorPanel";
import { Pagination } from "../components/Pagination";
import { Input, Label, Select } from "../components/Input";
import { Button } from "../components/Button";
import { fullName, formatDateTime } from "../lib/format";

const PAGE_SIZE = 25;

const STATUS_OPTIONS = Object.values(ListPatientsStatus).map((v) => ({
  value: v,
  label: humanizeStatus(v),
}));

type PatientRow = {
  id: string;
  pacwareId: string;
  firstName: string;
  lastName: string;
  status: string;
  hasPhone: boolean;
  hasEmail: boolean;
  updatedAt: string;
};

export function PatientsPage() {
  const [, setLocation] = useLocation();

  const [statusFilter, setStatusFilter] = useState<string>("");
  const [searchInput, setSearchInput] = useState<string>("");
  // Debounce the search input so we don't hammer the API while the
  // admin is mid-type. The committed string is what drives the
  // query params; the input value is purely UI state.
  const [search, setSearch] = useState<string>("");
  const [offset, setOffset] = useState<number>(0);
  const [creating, setCreating] = useState<boolean>(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setSearch(searchInput.trim());
      setOffset(0);
    }, 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const params: ListPatientsParams = useMemo(
    () => ({
      ...(statusFilter
        ? { status: statusFilter as keyof typeof ListPatientsStatus }
        : {}),
      ...(search ? { search } : {}),
      limit: PAGE_SIZE,
      offset,
    }),
    [statusFilter, search, offset],
  );

  const { data, isPending, isError, error, isFetching, refetch } =
    useListPatients(params, {
      query: {
        queryKey: getListPatientsQueryKey(params),
        placeholderData: keepPreviousData,
      },
    });

  const columns: Column<PatientRow>[] = [
    {
      key: "name",
      header: "Patient",
      render: (r) => (
        <div>
          <div className="font-semibold" style={{ color: "#0a1f44" }}>
            {fullName(r.firstName, r.lastName)}
          </div>
          <div className="text-xs" style={{ color: "#6b7280" }}>
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
      key: "updatedAt",
      header: "Updated",
      render: (r) => (
        <span className="text-xs" style={{ color: "#6b7280" }}>
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
            style={{ color: "#0a1f44" }}
          >
            Patients
          </h1>
          <p className="text-sm" style={{ color: "#374151" }}>
            Search and review the patient roster. Names decrypted server-side;
            phone and email are only shown as channel availability.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>+ New customer</Button>
      </header>

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
              onChange={(e) => {
                setStatusFilter(e.target.value);
                setOffset(0);
              }}
            />
          </div>
          <div className="flex items-end">
            <Button
              intent="ghost"
              size="sm"
              onClick={() => {
                setStatusFilter("");
                setSearchInput("");
                setSearch("");
                setOffset(0);
              }}
            >
              Clear filters
            </Button>
          </div>
        </div>
      </Card>

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
                onRowClick={(r) => setLocation(`/patients/${r.id}`)}
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
            setLocation(`/patients/${id}`);
          }}
        />
      )}
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
  if (legalFirstName === "") return { body: null, error: "First name is required." };
  if (legalLastName === "") return { body: null, error: "Last name is required." };
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
  const anyAddress = addressFields.some((s) => s !== "") || form.addressLine2.trim() !== "";
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
    const data = err.data as
      | { error?: string; message?: string }
      | undefined;
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
            style={{ color: "#0a1f44" }}
          >
            New customer
          </h2>
          <p className="text-xs" style={{ color: "#6b7280" }}>
            All PHI fields are encrypted at rest. The Pacware ID must be
            unique — duplicates are rejected.
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
                  patch(
                    "status",
                    e.target.value as NewCustomerForm["status"],
                  )
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
              <p className="mt-1 text-xs" style={{ color: "#6b7280" }}>
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
                style={{ color: "#0a1f44" }}
              >
                Mailing address (optional)
              </h3>
              <p className="text-xs" style={{ color: "#6b7280" }}>
                Provide the full address or leave it blank. Required for
                shipped supplies; optional if the patient is e-fulfillment only.
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
                style={{ color: "#0a1f44" }}
              >
                Outreach overrides (optional)
              </h3>
              <p className="text-xs" style={{ color: "#6b7280" }}>
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
                onChange={(e) =>
                  patch("cadenceOverrideDays", e.target.value)
                }
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
            <p
              className="text-sm"
              style={{ color: "#b91c1c" }}
              role="alert"
            >
              {error}
            </p>
          )}

          <div
            className="flex justify-end gap-2 pt-2 border-t"
            style={{ borderColor: "#e5e7eb" }}
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
