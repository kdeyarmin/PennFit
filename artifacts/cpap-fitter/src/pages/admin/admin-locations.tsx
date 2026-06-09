// /admin/locations — business-location (branch) registry (mig 0235).
//
// Multi-location keeps billing identity shared at the org level, so a
// location here is an operational branch (address, contact, the team +
// patients it services) — NOT a billing entity and NOT a warehouse
// (inventory stays in PacWare). Patients are assigned to a branch from
// their detail page; this page manages the branch list itself.
//
// Mirrors the compliance-rules editor: list + create / edit / set-
// primary / deactivate, all invalidating the list query. There is no
// hard delete (the API only supports deactivation) so a branch with
// historical assignments is never orphaned.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Card } from "@/components/admin/Card";
import { Table, type Column } from "@/components/admin/Table";
import { Badge } from "@/components/admin/Badge";
import { Spinner } from "@/components/admin/Spinner";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import {
  LOCATIONS_QUERY_KEY,
  createLocation,
  describeLocationError,
  listLocations,
  updateLocation,
  type Location,
  type LocationCreate,
} from "@/lib/admin/locations-api";

interface FormState {
  name: string;
  code: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  phoneE164: string;
  npi: string;
  isPrimary: boolean;
  isActive: boolean;
}

const EMPTY_FORM: FormState = {
  name: "",
  code: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  state: "",
  postalCode: "",
  phoneE164: "",
  npi: "",
  isPrimary: false,
  isActive: true,
};

export function AdminLocationsPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: LOCATIONS_QUERY_KEY,
    queryFn: listLocations,
    staleTime: 30_000,
  });
  const [editing, setEditing] = useState<Location | null>(null);
  const [creating, setCreating] = useState(false);

  return (
    <div
      className="admin-root space-y-4 max-w-5xl p-6"
      data-testid="admin-locations-page"
    >
      <Header onCreate={() => setCreating(true)} />
      {isError ? (
        <ErrorPanel
          error={error}
          onRetry={() => void refetch()}
          title="Couldn't load locations"
        />
      ) : (
        <Card>
          {isPending ? (
            <Spinner label="Loading locations…" />
          ) : data.locations.length === 0 ? (
            <EmptyState
              title="No locations yet."
              hint="Add your branches here, then assign patients to a branch from their detail page."
            />
          ) : (
            <LocationsTable locations={data.locations} onEdit={setEditing} />
          )}
        </Card>
      )}
      {creating && (
        <LocationFormModal
          mode="create"
          onClose={() => setCreating(false)}
          onSaved={() => setCreating(false)}
        />
      )}
      {editing && (
        <LocationFormModal
          mode="edit"
          initial={editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function Header({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Locations
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
          Business branches that service patients. Billing identity stays
          shared at the org level — a branch is an operational anchor, not a
          separate billing entity.
        </p>
      </div>
      <Button onClick={onCreate}>+ New location</Button>
    </div>
  );
}

function cityLine(l: Location): string {
  const parts = [l.city, l.state].filter((p) => p && p.trim() !== "");
  const cs = parts.join(", ");
  return [cs, l.postalCode].filter((p) => p && p.trim() !== "").join(" ");
}

function LocationsTable({
  locations,
  onEdit,
}: {
  locations: Location[];
  onEdit: (l: Location) => void;
}) {
  const cols: Column<Location>[] = [
    {
      key: "name",
      header: "Name",
      render: (l) => (
        <div>
          <div className="font-semibold" style={{ color: "hsl(var(--ink-1))" }}>
            {l.name}
            {l.isPrimary && (
              <span className="ml-2">
                <Badge variant="info">Primary</Badge>
              </span>
            )}
          </div>
          {l.code && (
            <div className="text-xs font-mono" style={{ color: "#9ca3af" }}>
              {l.code}
            </div>
          )}
        </div>
      ),
    },
    {
      key: "address",
      header: "Address",
      render: (l) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-2))" }}>
          {l.addressLine1 ? `${l.addressLine1}, ` : ""}
          {cityLine(l) || "—"}
        </span>
      ),
    },
    {
      key: "phone",
      header: "Phone",
      render: (l) => (
        <span className="text-xs font-mono" style={{ color: "hsl(var(--ink-2))" }}>
          {l.phoneE164 ?? "—"}
        </span>
      ),
    },
    {
      key: "active",
      header: "Active",
      render: (l) => (
        <Badge variant={l.isActive ? "success" : "muted"}>
          {l.isActive ? "On" : "Off"}
        </Badge>
      ),
    },
    {
      key: "updated",
      header: "Updated",
      render: (l) => (
        <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          {formatDateTime(l.updatedAt)}
        </span>
      ),
    },
    {
      key: "actions",
      header: "",
      render: () => (
        <span
          className="text-xs underline"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Edit →
        </span>
      ),
    },
  ];

  return (
    <Table
      columns={cols}
      rows={locations}
      rowKey={(l) => l.id}
      onRowClick={(l) => onEdit(l)}
      emptyState={<EmptyState title="No locations." />}
    />
  );
}

function locationToForm(l: Location): FormState {
  return {
    name: l.name,
    code: l.code ?? "",
    addressLine1: l.addressLine1 ?? "",
    addressLine2: l.addressLine2 ?? "",
    city: l.city ?? "",
    state: l.state ?? "",
    postalCode: l.postalCode ?? "",
    phoneE164: l.phoneE164 ?? "",
    npi: l.npi ?? "",
    isPrimary: l.isPrimary,
    isActive: l.isActive,
  };
}

function LocationFormModal({
  mode,
  initial,
  onClose,
  onSaved,
}: {
  mode: "create" | "edit";
  initial?: Location;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(
    initial ? locationToForm(initial) : EMPTY_FORM,
  );
  const [error, setError] = useState<string | null>(null);

  const createMut = useMutation({
    mutationFn: (data: LocationCreate) => createLocation(data),
  });
  const updateMut = useMutation({
    mutationFn: (vars: { id: string; data: Partial<LocationCreate> & { isActive?: boolean } }) =>
      updateLocation(vars.id, vars.data),
  });
  const isPending = createMut.isPending || updateMut.isPending;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !isPending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, isPending]);

  function patch<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function buildBody(): {
    body: (LocationCreate & { isActive?: boolean }) | null;
    error: string | null;
  } {
    const name = form.name.trim();
    if (name === "") return { body: null, error: "Name is required." };
    if (name.length > 160) {
      return { body: null, error: "Name is too long (max 160 chars)." };
    }
    const orNull = (v: string) => (v.trim() === "" ? null : v.trim());
    return {
      body: {
        name,
        code: orNull(form.code),
        addressLine1: orNull(form.addressLine1),
        addressLine2: orNull(form.addressLine2),
        city: orNull(form.city),
        state: orNull(form.state),
        postalCode: orNull(form.postalCode),
        phoneE164: orNull(form.phoneE164),
        npi: orNull(form.npi),
        isPrimary: form.isPrimary,
        isActive: form.isActive,
      },
      error: null,
    };
  }

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: LOCATIONS_QUERY_KEY });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { body, error: validationError } = buildBody();
    if (!body) {
      setError(validationError);
      return;
    }
    try {
      if (mode === "create") {
        // isActive isn't a create-body field server-side (new rows
        // default active); strip it so the strict schema accepts it.
        const { isActive: _isActive, ...createBody } = body;
        void _isActive;
        await createMut.mutateAsync(createBody);
      } else if (initial) {
        await updateMut.mutateAsync({ id: initial.id, data: body });
      }
      await invalidate();
      onSaved();
    } catch (err) {
      setError(describeLocationError(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="location-form-title"
    >
      <div
        className="admin-root w-full max-w-2xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <form onSubmit={(e) => void onSubmit(e)} className="p-6 space-y-4">
          <h2
            id="location-form-title"
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {mode === "create" ? "New location" : "Edit location"}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label htmlFor="loc-name">Name</Label>
              <Input
                id="loc-name"
                value={form.name}
                maxLength={160}
                onChange={(e) => patch("name", e.target.value)}
                required
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="loc-code">Code (optional)</Label>
              <Input
                id="loc-code"
                value={form.code}
                maxLength={40}
                placeholder="e.g. PGH"
                onChange={(e) => patch("code", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="loc-phone">Phone (optional)</Label>
              <Input
                id="loc-phone"
                value={form.phoneE164}
                maxLength={20}
                placeholder="+1…"
                onChange={(e) => patch("phoneE164", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="loc-addr1">Address line 1</Label>
              <Input
                id="loc-addr1"
                value={form.addressLine1}
                maxLength={200}
                onChange={(e) => patch("addressLine1", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="loc-addr2">Address line 2</Label>
              <Input
                id="loc-addr2"
                value={form.addressLine2}
                maxLength={200}
                onChange={(e) => patch("addressLine2", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="loc-city">City</Label>
              <Input
                id="loc-city"
                value={form.city}
                maxLength={120}
                onChange={(e) => patch("city", e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label htmlFor="loc-state">State</Label>
                <Input
                  id="loc-state"
                  value={form.state}
                  maxLength={40}
                  onChange={(e) => patch("state", e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div>
                <Label htmlFor="loc-zip">ZIP</Label>
                <Input
                  id="loc-zip"
                  value={form.postalCode}
                  maxLength={20}
                  onChange={(e) => patch("postalCode", e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="loc-npi">NPI (optional)</Label>
              <Input
                id="loc-npi"
                value={form.npi}
                maxLength={20}
                onChange={(e) => patch("npi", e.target.value)}
                disabled={isPending}
              />
              <p className="mt-1 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Informational only — claims use the shared org NPI.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="loc-primary"
                type="checkbox"
                checked={form.isPrimary}
                onChange={(e) => patch("isPrimary", e.target.checked)}
                disabled={isPending}
              />
              <label
                htmlFor="loc-primary"
                className="text-sm"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Primary location
              </label>
            </div>
            <div className="flex items-center gap-2">
              <input
                id="loc-active"
                type="checkbox"
                checked={form.isActive}
                onChange={(e) => patch("isActive", e.target.checked)}
                disabled={isPending || mode === "create"}
              />
              <label
                htmlFor="loc-active"
                className="text-sm"
                style={{ color: "hsl(var(--ink-1))" }}
              >
                Active {mode === "create" && "(new locations start active)"}
              </label>
            </div>
          </div>

          {error && (
            <p className="text-sm" style={{ color: "#b91c1c" }} role="alert">
              {error}
            </p>
          )}

          <div
            className="flex items-center justify-end gap-2 pt-2 border-t"
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
              {mode === "create" ? "Create location" : "Save changes"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
