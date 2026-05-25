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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Search } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
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

const queryKey = (q: string) => ["admin", "providers", q] as const;

export function AdminProvidersPage() {
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const qc = useQueryClient();

  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: queryKey(search),
    queryFn: () => listProviders(search),
  });

  return (
    <div className="p-6 space-y-6 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Providers</h1>
          <p
            className="text-sm mt-1"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            Central registry of prescribing physicians. Search by NPI
            (10 digits) or by name. Adds an NPI by looking it up in the
            public NPPES registry.
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
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.providers.length === 0 ? (
          <p
            className="text-sm py-3"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {search ? "No matches." : "No providers in the registry yet."}
          </p>
        ) : (
          <ProvidersTable rows={data.providers} />
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
  const [caseloadFor, setCaseloadFor] = useState<ProviderListItem | null>(
    null,
  );
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
                <Button
                  intent="ghost"
                  onClick={() => setCaseloadFor(r)}
                >
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
              <p
                className="text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
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
            <p
              className="text-sm py-3"
              style={{ color: "hsl(var(--ink-3))" }}
            >
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
            <td
              className="py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {r.email ?? "—"}
            </td>
            <td className="py-2 font-mono text-xs">{r.phoneE164 ?? "—"}</td>
            <td className="py-2 text-xs">{r.prescriptionStatus ?? "—"}</td>
            <td
              className="py-2 text-xs"
              style={{ color: "hsl(var(--ink-3))" }}
            >
              {r.validUntil ?? "open-ended"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [autofilled, setAutofilled] =
    useState<NppesProviderProjection | null>(null);
  const [legalName, setLegalName] = useState("");
  const [phone, setPhone] = useState("");
  const [fax, setFax] = useState("");
  const [error, setError] = useState<string | null>(null);

  const lookup = useMutation({
    mutationFn: () => lookupNppes(npi.trim()),
    onSuccess: (r) => {
      setAutofilled(r.provider);
      setLegalName(r.provider.legalName);
      setPhone(r.provider.phoneE164 ?? "");
      setFax(r.provider.faxE164 ?? "");
      setError(null);
    },
    onError: (e: Error) => {
      setError(
        e.message.includes("npi_not_found")
          ? "No provider with that NPI in NPPES — fill out the form manually."
          : `NPPES lookup failed: ${e.message}`,
      );
      setAutofilled(null);
    },
  });

  const create = useMutation({
    mutationFn: () =>
      createProvider({
        npi: npi.trim(),
        legalName: legalName.trim(),
        taxonomyCode: autofilled?.taxonomyCode ?? null,
        phoneE164: phone.trim() || null,
        faxE164: fax.trim() || null,
        practiceName: autofilled?.practiceName ?? null,
        practiceAddress: autofilled?.practiceAddress ?? null,
        source: autofilled ? "nppes" : "csr_entry",
      }),
    onSuccess: () => onCreated(),
    onError: (e: Error) => setError(e.message),
  });

  const npiValid = /^\d{10}$/.test(npi.trim());

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
            Type the NPI and click Look up. We&apos;ll pull the provider&apos;s
            name, taxonomy, and contact info from the public NPPES registry
            for you to confirm.
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
                onChange={(e) => setNpi(e.target.value)}
                placeholder="1234567893"
                aria-label="NPI (10 digits)"
                maxLength={10}
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
                <label
                  className="text-xs font-semibold block mb-1"
                  style={{ color: "hsl(var(--penn-navy))" }}
                >
                  Legal name
                </label>
                <Input
                  value={legalName}
                  onChange={(e) => setLegalName(e.target.value)}
                  aria-label="Legal name"
                  maxLength={200}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    className="text-xs font-semibold block mb-1"
                    style={{ color: "hsl(var(--penn-navy))" }}
                  >
                    Phone (E.164)
                  </label>
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+12155551234"
                    aria-label="Phone (E.164)"
                  />
                </div>
                <div>
                  <label
                    className="text-xs font-semibold block mb-1"
                    style={{ color: "hsl(var(--penn-navy))" }}
                  >
                    Fax (E.164)
                  </label>
                  <Input
                    value={fax}
                    onChange={(e) => setFax(e.target.value)}
                    placeholder="+12155551235"
                    aria-label="Fax (E.164)"
                  />
                </div>
              </div>
              {autofilled && (
                <p
                  className="text-xs"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Will save as <strong>NPPES verified</strong>. Edits to
                  the autofilled values are kept.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-3 border-t border-border/40">
            <Button intent="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              disabled={
                !npiValid || legalName.trim().length === 0 || create.isPending
              }
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
