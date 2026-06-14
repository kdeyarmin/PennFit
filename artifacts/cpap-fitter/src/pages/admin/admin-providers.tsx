// /admin/providers — central physician/NP registry.
//
// Page surface
// ------------
// * Search bar (by name fragment OR exact 10-digit NPI).
// * Table of providers with NPI, name, specialty taxonomy, fax,
//   source, verified-at indicator.
// * "Add provider" button opening a 2-step modal:
//     Step 1: type a 10-digit NPI, click Look up. The form proxies
//             to NPPES; on hit, the response autofills name,
//             taxonomy, phone, fax, address.
//     Step 2: review/edit and Save. POST returns the provider ID;
//             a 200 with `created:false` means the NPI was already
//             on file and the form just navigates back to the list.
//
// The `source` badge tells CSRs at a glance whether to trust the
// row: `nppes` = verified against the public registry, `csr_entry`
// = manual, `backfill` = synthesized from old jsonb data and needs
// confirmation.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { Pagination } from "@/components/admin/Pagination";
import {
  createProvider,
  listProviderCaseload,
  listProviders,
  lookupNppes,
  type NppesProviderProjection,
  type ProviderCaseloadEntry,
  type ProviderListItem,
  type ProviderSource,
} from "@/lib/admin/providers-api";

const PAGE_SIZE = 50;
const queryKey = (q: string, offset: number) =>
  ["admin", "providers", q, offset] as const;

export function AdminProvidersPage() {
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKey(search, offset),
    queryFn: () => listProviders(search, { limit: PAGE_SIZE, offset }),
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Providers</h1>
          <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
            Central registry of prescribing physicians. Search by NPI (10
            digits) or by name. Adds an NPI by looking it up in the public NPPES
            registry.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="h-4 w-4 mr-1.5" />
          Add provider
        </Button>
      </header>

      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or NPI"
            aria-label="Search by name or NPI"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              // New search → back to the first page so the result window
              // isn't stranded past the end of a smaller result set.
              setOffset(0);
            }}
          />
        </div>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.providers.length === 0 ? (
          <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
            {search ? "No matches." : "No providers in the registry yet."}
          </p>
        ) : (
          <>
            <ProvidersTable rows={data.providers} />
            <Pagination
              total={data.total}
              limit={data.limit}
              offset={data.offset}
              onChange={setOffset}
              isLoading={isPending}
            />
          </>
        )}
      </Card>

      {showAdd && (
        <AddProviderModal
          onClose={() => setShowAdd(false)}
          onCreated={() => {
            setShowAdd(false);
            void qc.invalidateQueries({ queryKey: ["admin", "providers"] });
          }}
        />
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<ProviderSource, string> = {
  nppes: "NPPES verified",
  csr_entry: "CSR entry",
  backfill: "Backfill — review",
};

const SOURCE_COLOR: Record<ProviderSource, string> = {
  nppes: "bg-emerald-100 text-emerald-900",
  csr_entry: "bg-blue-100 text-blue-900",
  backfill: "bg-amber-100 text-amber-900",
};

function ProvidersTable({ rows }: { rows: ProviderListItem[] }) {
  const [caseloadFor, setCaseloadFor] = useState<ProviderListItem | null>(null);
  return (
    <>
      <table className="w-full text-sm">
        <thead>
          <tr
            className="text-left border-b"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <th className="py-2 font-semibold">NPI</th>
            <th className="py-2 font-semibold">Name</th>
            <th className="py-2 font-semibold">Taxonomy</th>
            <th className="py-2 font-semibold">Fax</th>
            <th className="py-2 font-semibold">Source</th>
            <th className="py-2 font-semibold" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.id}
              className="border-b"
              style={{ borderColor: "hsl(var(--line-2))" }}
            >
              <td className="py-2 font-mono text-xs">{r.npi}</td>
              <td className="py-2">
                <div>{r.legalName}</div>
                {r.practiceName && (
                  <div
                    className="text-xs"
                    style={{ color: "hsl(var(--ink-3))" }}
                  >
                    {r.practiceName}
                  </div>
                )}
              </td>
              <td
                className="py-2 text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {r.taxonomyCode ?? "—"}
              </td>
              <td className="py-2 font-mono text-xs">{r.faxE164 ?? "—"}</td>
              <td className="py-2">
                <span
                  className={`inline-block px-1.5 py-0.5 rounded text-[10px] uppercase font-semibold tracking-wider ${SOURCE_COLOR[r.source]}`}
                >
                  {SOURCE_LABEL[r.source]}
                </span>
              </td>
              <td className="py-2 text-right">
                <Button intent="ghost" onClick={() => setCaseloadFor(r)}>
                  Caseload
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {caseloadFor && (
        <CaseloadModal
          provider={caseloadFor}
          onClose={() => setCaseloadFor(null)}
        />
      )}
    </>
  );
}

function CaseloadModal({
  provider,
  onClose,
}: {
  provider: ProviderListItem;
  onClose: () => void;
}) {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: ["admin", "providers", provider.id, "caseload"] as const,
    queryFn: () => listProviderCaseload(provider.id),
  });
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-3xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-3">
          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-semibold">
                Caseload — {provider.legalName}
              </h2>
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Patients with a prescription written by NPI{" "}
                <span className="font-mono">{provider.npi}</span>. Up to 200,
                most recent first.
              </p>
            </div>
            <Button intent="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
          {isPending ? (
            <Spinner />
          ) : isError ? (
            <ErrorPanel error={error} onRetry={() => void refetch()} />
          ) : data.patients.length === 0 ? (
            <p className="text-sm py-3" style={{ color: "hsl(var(--ink-3))" }}>
              No patients currently on this provider&apos;s caseload.
            </p>
          ) : (
            <CaseloadTable rows={data.patients} />
          )}
        </div>
      </div>
    </div>
  );
}

function CaseloadTable({ rows }: { rows: ProviderCaseloadEntry[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr
          className="text-left border-b"
          style={{ borderColor: "hsl(var(--line-1))" }}
        >
          <th className="py-2 font-semibold">Patient</th>
          <th className="py-2 font-semibold">Email</th>
          <th className="py-2 font-semibold">Phone</th>
          <th className="py-2 font-semibold">Rx status</th>
          <th className="py-2 font-semibold">Valid until</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr
            key={r.prescriptionId}
            className="border-b"
            style={{ borderColor: "hsl(var(--line-2))" }}
          >
            <td className="py-2">
              <a
                className="underline"
                href={`/admin/patients/${r.patientId}`}
                style={{ color: "hsl(var(--penn-blue))" }}
              >
                {[r.legalFirstName, r.legalLastName]
                  .filter(Boolean)
                  .join(" ") || r.patientId.slice(0, 8)}
              </a>
              {r.patientStatus && r.patientStatus !== "active" && (
                <span
                  className="ml-2 inline-block px-1 py-0.5 rounded text-[10px] uppercase"
                  style={{ backgroundColor: "hsl(var(--line-2))" }}
                >
                  {r.patientStatus}
                </span>
              )}
            </td>
            <td className="py-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {r.email ?? "—"}
            </td>
            <td className="py-2 font-mono text-xs">{r.phoneE164 ?? "—"}</td>
            <td className="py-2 text-xs">{r.prescriptionStatus ?? "—"}</td>
            <td className="py-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              {r.validUntil ?? "open-ended"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <label
      className="text-xs font-semibold block mb-1"
      style={{ color: "hsl(var(--penn-navy))" }}
    >
      {children}
    </label>
  );
}

function AddProviderModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [npi, setNpi] = useState("");
  const [autofilled, setAutofilled] = useState<NppesProviderProjection | null>(
    null,
  );
  const [legalName, setLegalName] = useState("");
  const [taxonomyCode, setTaxonomyCode] = useState("");
  const [practiceName, setPracticeName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [fax, setFax] = useState("");
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [city, setCity] = useState("");
  const [stateRegion, setStateRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [country, setCountry] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: () => lookupNppes(npi.trim()),
    onSuccess: (r) => {
      const p = r.provider;
      setAutofilled(p);
      setLegalName(p.legalName);
      setTaxonomyCode(p.taxonomyCode ?? "");
      setPracticeName(p.practiceName ?? "");
      setPhone(p.phoneE164 ?? "");
      setFax(p.faxE164 ?? "");
      setAddrLine1(p.practiceAddress?.line1 ?? "");
      setAddrLine2(p.practiceAddress?.line2 ?? "");
      setCity(p.practiceAddress?.city ?? "");
      setStateRegion(p.practiceAddress?.state ?? "");
      setPostalCode(p.practiceAddress?.postalCode ?? "");
      setCountry(p.practiceAddress?.country ?? "");
      setError(null);
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && e.status === 404) {
        setError(
          "No provider with that NPI in NPPES — fill out the form manually.",
        );
      } else {
        // The 502 body carries an operator-facing `message` with the
        // upstream failure detail (e.g. "rejected the request (HTTP
        // 403)"); prefer it over the raw "HTTP 502 Bad Gateway" line.
        const serverMessage =
          e instanceof ApiError &&
          e.data &&
          typeof e.data === "object" &&
          "message" in e.data &&
          typeof e.data.message === "string"
            ? e.data.message
            : null;
        setError(`NPPES lookup failed: ${serverMessage ?? e.message}`);
      }
      setAutofilled(null);
    },
  });

  const create = useMutation({
    mutationFn: () => {
      const addr = {
        line1: addrLine1.trim() || undefined,
        line2: addrLine2.trim() || undefined,
        city: city.trim() || undefined,
        state: stateRegion.trim() || undefined,
        postalCode: postalCode.trim() || undefined,
        country: country.trim() || undefined,
      };
      const hasAddress = Object.values(addr).some(Boolean);
      return createProvider({
        npi: npi.trim(),
        legalName: legalName.trim(),
        taxonomyCode: taxonomyCode.trim() || null,
        phoneE164: phone.trim() || null,
        faxE164: fax.trim() || null,
        email: email.trim() || null,
        practiceName: practiceName.trim() || null,
        practiceAddress: hasAddress ? addr : null,
        notes: notes.trim() || null,
        source: autofilled ? "nppes" : "csr_entry",
      });
    },
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const npiValid = /^\d{10}$/.test(npi.trim());
  // Mirror the backend Zod formats so the operator gets immediate feedback
  // instead of a 400 round-trip. Optional fields only validate when filled.
  const phoneValid = phone.trim() === "" || /^\+\d{8,15}$/.test(phone.trim());
  const faxValid = fax.trim() === "" || /^\+\d{8,15}$/.test(fax.trim());
  const emailValid =
    email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const formatError = !phoneValid
    ? "Phone must be E.164 format, e.g. +12155551234."
    : !faxValid
      ? "Fax must be E.164 format, e.g. +12155551234."
      : !emailValid
        ? "Enter a valid email address."
        : null;
  const canSave =
    npiValid &&
    legalName.trim().length > 0 &&
    formatError === null &&
    !create.isPending;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(10,31,68,0.45)" }}
      onClick={() => !lookup.isPending && !create.isPending && onClose()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-provider-title"
    >
      <div
        className="w-full max-w-xl rounded-lg shadow-lg max-h-[92vh] overflow-y-auto"
        style={{ backgroundColor: "#ffffff" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6 space-y-4">
          <h2
            id="add-provider-title"
            className="text-lg font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Add provider
          </h2>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Type the NPI and click Look up to pull the provider&apos;s name,
            taxonomy, and contact info from the public NPPES registry. If the
            lookup misses or the registry is down, fill out the whole record by
            hand — every field below is editable.
          </p>

          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label
                className="text-xs font-semibold block mb-1"
                style={{ color: "hsl(var(--penn-navy))" }}
              >
                NPI (10 digits)
              </label>
              <Input
                value={npi}
                // Strip formatting as the user types/pastes: NPIs copied
                // from an EHR or PDF often carry dashes, spaces, or an
                // "NPI:" prefix. With a bare maxLength the separators
                // consumed the 10-char budget and silently truncated the
                // digits, leaving the Look up button disabled with no
                // explanation.
                onChange={(e) =>
                  setNpi(e.target.value.replace(/\D/g, "").slice(0, 10))
                }
                placeholder="1234567893"
                aria-label="NPI (10 digits)"
                inputMode="numeric"
              />
            </div>
            <Button
              intent="secondary"
              disabled={!npiValid || lookup.isPending}
              onClick={() => lookup.mutate()}
            >
              {lookup.isPending ? "Looking up…" : "Look up"}
            </Button>
          </div>

          {(autofilled || npi.trim().length > 0) && (
            <div className="space-y-3 pt-3 border-t border-border/40">
              <div>
                <FieldLabel>Legal name *</FieldLabel>
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  aria-label="Legal name"
                  maxLength={200}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel>Taxonomy code</FieldLabel>
                  <Input
                    value={taxonomyCode}
                    onChange={(e) => setTaxonomyCode(e.target.value)}
                    placeholder="332B00000X"
                    aria-label="Taxonomy code"
                    maxLength={16}
                  />
                </div>
                <div>
                  <FieldLabel>Practice name</FieldLabel>
                  <Input
                    value={practiceName}
                    onChange={(e) => setPracticeName(e.target.value)}
                    placeholder="Sleep Health Associates"
                    aria-label="Practice name"
                    maxLength={200}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <FieldLabel>Phone (E.164)</FieldLabel>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+12155551234"
                    aria-label="Phone (E.164)"
                  />
                </div>
                <div>
                  <FieldLabel>Fax (E.164)</FieldLabel>
                  <Input
                    value={fax}
                    onChange={(e) => setFax(e.target.value)}
                    placeholder="+12155551235"
                    aria-label="Fax (E.164)"
                  />
                </div>
              </div>
              <div>
                <FieldLabel>Email</FieldLabel>
                <Input
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="office@example.com"
                  aria-label="Email"
                  type="email"
                  maxLength={200}
                />
              </div>

              <div className="pt-1">
                <p
                  className="text-xs font-semibold mb-2"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  Practice address
                </p>
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>Address line 1</FieldLabel>
                      <Input
                        value={addrLine1}
                        onChange={(e) => setAddrLine1(e.target.value)}
                        aria-label="Address line 1"
                      />
                    </div>
                    <div>
                      <FieldLabel>Address line 2</FieldLabel>
                      <Input
                        value={addrLine2}
                        onChange={(e) => setAddrLine2(e.target.value)}
                        aria-label="Address line 2"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-4 gap-3">
                    <div className="col-span-2">
                      <FieldLabel>City</FieldLabel>
                      <Input
                        value={city}
                        onChange={(e) => setCity(e.target.value)}
                        aria-label="City"
                      />
                    </div>
                    <div>
                      <FieldLabel>State</FieldLabel>
                      <Input
                        value={stateRegion}
                        onChange={(e) => setStateRegion(e.target.value)}
                        placeholder="PA"
                        aria-label="State"
                      />
                    </div>
                    <div>
                      <FieldLabel>ZIP</FieldLabel>
                      <Input
                        value={postalCode}
                        onChange={(e) => setPostalCode(e.target.value)}
                        placeholder="19103"
                        aria-label="ZIP / postal code"
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel>Country</FieldLabel>
                      <Input
                        value={country}
                        onChange={(e) => setCountry(e.target.value)}
                        placeholder="US"
                        aria-label="Country"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <div>
                <FieldLabel>Notes</FieldLabel>
                <Input
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  aria-label="Notes"
                  maxLength={2000}
                />
              </div>

              {autofilled && (
                <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                  Will save as <strong>NPPES verified</strong>. Edits to the
                  autofilled values are kept.
                </p>
              )}
            </div>
          )}

          {(error || formatError) && (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error ?? formatError}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
            <Button intent="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={!canSave}
              onClick={() => create.mutate()}
              isLoading={create.isPending}
            >
              Save provider
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
