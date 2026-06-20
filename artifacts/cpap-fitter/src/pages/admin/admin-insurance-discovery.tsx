// /admin/billing/insurance-discovery — standalone insurance discovery.
//
// The sibling of /admin/billing/verify. Verify answers "is THIS coverage
// active?" (you know the payer + member id). Discovery answers "what
// insurance does this person have?" — you type only demographics and Office
// Ally searches its payer network for active coverage. Reach for it when a
// patient's insurance is unknown, or a coverage on file came back inactive
// and you need to find what's actually in force.
//
// Two things happen on this page:
//   * Run a search from typed-in demographics — nothing is persisted.
//   * Optionally attach the search to a patient on file, so a discovered
//     coverage can be saved straight to their chart with one click.
//
// Insurance discovery is a paid add-on; when it's not enabled the API
// returns 403 and the page renders the upgrade reason inline.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Search } from "lucide-react";

import {
  listPatients,
  type PatientListItem,
} from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  runInsuranceDiscovery,
  type DiscoveredCoverage,
  type InsuranceDiscoveryResult,
} from "@/lib/admin/billing-api";
import { createInsuranceCoverage } from "@/lib/admin/clinical-tabs-api";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { formatAppDate, todayAppDateIso } from "@/lib/utils";

/** Prefer the structured server reason ({ message }) over ApiError's
 *  "HTTP 4xx …" prefix; fall back to the Error message. */
function apiErrorMessage(err: unknown, fallback: string): string {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  const message = (data as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return err instanceof Error ? err.message : fallback;
}

const SSN_RE = /^\d{9}$/;
const ZIP_RE = /^\d{5}(-?\d{4})?$/;

export function AdminInsuranceDiscoveryPage() {
  useDocumentTitle("Insurance discovery");

  // ── Optional patient to attach found coverage to ───────────────────
  const [patient, setPatient] = useState<PatientListItem | null>(null);

  // ── Demographics ────────────────────────────────────────────────────
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState<"U" | "M" | "F">("U");
  const [ssn, setSsn] = useState("");
  const [memberId, setMemberId] = useState("");
  const [zip, setZip] = useState("");

  const [result, setResult] = useState<InsuranceDiscoveryResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ssnDigits = ssn.replace(/\D/g, "");
  const ssnValid = ssnDigits === "" || SSN_RE.test(ssnDigits);
  const zipTrimmed = zip.trim();
  const zipValid = zipTrimmed === "" || ZIP_RE.test(zipTrimmed);
  const formComplete =
    firstName.trim() !== "" &&
    lastName.trim() !== "" &&
    dob !== "" &&
    ssnValid &&
    zipValid;
  const today = todayAppDateIso();

  const search = useMutation({
    mutationFn: () =>
      runInsuranceDiscovery({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        dateOfBirth: dob,
        ...(sex !== "U" ? { gender: sex } : {}),
        ...(ssnDigits ? { ssn: ssnDigits } : {}),
        ...(memberId.trim() ? { memberId: memberId.trim() } : {}),
        ...(zipTrimmed ? { postalCode: zipTrimmed } : {}),
      }),
    onSuccess: (r) => {
      setError(null);
      setResult(r);
    },
    onError: (err) => {
      setResult(null);
      setError(apiErrorMessage(err, "Insurance discovery failed."));
    },
  });

  function attachPatient(p: PatientListItem) {
    setPatient(p);
    // Pre-fill the name from the chart; DOB still comes from the operator.
    setFirstName((prev) => prev || p.firstName);
    setLastName((prev) => prev || p.lastName);
  }

  return (
    <div
      className="admin-root space-y-6 max-w-4xl"
      data-testid="admin-insurance-discovery"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Insurance discovery
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Search the payer network for active coverage when a patient&apos;s
          insurance is unknown — or a coverage on file came back inactive.
          Nothing is saved unless you add a found coverage to a chart. To check
          a coverage you already know, use{" "}
          <Link href="/admin/billing/verify" className="underline font-medium">
            Verify insurance
          </Link>
          .
        </p>
      </header>

      <PatientAttach
        patient={patient}
        onAttach={attachPatient}
        onClear={() => setPatient(null)}
      />

      <Card
        title="Who are we searching for?"
        subtitle="Searched across payers by demographics — the person does not need to be in CareMetric Breathe."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="disc-first-name">First name</Label>
            <Input
              id="disc-first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="As it appears on file"
              data-testid="disc-first-name"
            />
          </div>
          <div>
            <Label htmlFor="disc-last-name">Last name</Label>
            <Input
              id="disc-last-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              data-testid="disc-last-name"
            />
          </div>
          <div>
            <Label htmlFor="disc-dob">Date of birth</Label>
            <Input
              id="disc-dob"
              type="date"
              value={dob}
              max={today}
              onChange={(e) => setDob(e.target.value)}
              data-testid="disc-dob"
            />
          </div>
          <div>
            <Label htmlFor="disc-sex">Sex (optional)</Label>
            <select
              id="disc-sex"
              value={sex}
              onChange={(e) => setSex(e.target.value as "U" | "M" | "F")}
              className="w-full rounded-md border px-2 py-1.5 text-sm"
              data-testid="disc-sex"
            >
              <option value="U">Unknown</option>
              <option value="F">Female</option>
              <option value="M">Male</option>
            </select>
          </div>
          <div>
            <Label htmlFor="disc-ssn">SSN (optional)</Label>
            <Input
              id="disc-ssn"
              value={ssn}
              onChange={(e) => setSsn(e.target.value)}
              placeholder="Improves match rate"
              inputMode="numeric"
              autoComplete="off"
              data-testid="disc-ssn"
            />
            {!ssnValid && (
              <p className="mt-1 text-[11px]" style={{ color: "#991b1b" }}>
                SSN must be 9 digits.
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="disc-zip">ZIP (optional)</Label>
            <Input
              id="disc-zip"
              value={zip}
              onChange={(e) => setZip(e.target.value)}
              placeholder="Narrows the search"
              inputMode="numeric"
              data-testid="disc-zip"
            />
            {!zipValid && (
              <p className="mt-1 text-[11px]" style={{ color: "#991b1b" }}>
                ZIP must be 5 or 9 digits.
              </p>
            )}
          </div>
          <div className="sm:col-span-2 max-w-sm">
            <Label htmlFor="disc-member-id">Member ID hint (optional)</Label>
            <Input
              id="disc-member-id"
              value={memberId}
              onChange={(e) => setMemberId(e.target.value)}
              placeholder="From a stale card, if you have it"
              data-testid="disc-member-id"
            />
          </div>
        </div>

        <div className="mt-4">
          <Button
            isLoading={search.isPending}
            disabled={search.isPending || !formComplete}
            onClick={() => {
              setResult(null);
              setError(null);
              search.mutate();
            }}
            data-testid="disc-run"
          >
            <Search className="h-4 w-4 mr-1.5" aria-hidden="true" />
            {search.isPending ? "Searching…" : "Search for coverage"}
          </Button>
        </div>

        {error && (
          <p
            className="mt-3 text-sm"
            style={{ color: "#991b1b" }}
            role="status"
            data-testid="disc-error"
          >
            {error}
          </p>
        )}
      </Card>

      {result && (
        <ResultSection
          result={result}
          patient={patient}
          latencyMs={result.latencyMs}
        />
      )}
    </div>
  );
}

// ── Optional patient attachment ──────────────────────────────────────

function PatientAttach({
  patient,
  onAttach,
  onClear,
}: {
  patient: PatientListItem | null;
  onAttach: (p: PatientListItem) => void;
  onClear: () => void;
}) {
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const matches = useQuery({
    queryKey: ["discovery-patient-search", debounced],
    queryFn: () => listPatients({ search: debounced, limit: 10 }),
    enabled: debounced.length >= 2 && !patient,
    staleTime: 30_000,
  });

  if (patient) {
    return (
      <Card title="Attached patient">
        <div className="flex flex-wrap items-center gap-3">
          <span
            className="text-sm font-medium"
            data-testid="disc-patient-selected"
          >
            {patient.firstName} {patient.lastName}
          </span>
          <Link
            href={`/admin/patients/${patient.id}`}
            className="text-xs underline"
            style={{ color: "hsl(var(--penn-navy))" }}
          >
            Open chart
          </Link>
          <Button intent="secondary" onClick={onClear}>
            Detach
          </Button>
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Found coverage can be added straight to this chart.
          </span>
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Attach a patient (optional)"
      subtitle="Attach a chart to save any coverage you find with one click. Skip it to search without saving."
    >
      <div className="space-y-3">
        <div className="max-w-sm">
          <Label htmlFor="disc-patient-search">
            Search by name or PacWare ID
          </Label>
          <Input
            id="disc-patient-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="e.g. Smith"
            data-testid="disc-patient-search"
          />
        </div>
        {matches.isFetching && <Spinner label="Searching…" />}
        {matches.isError && (
          <ErrorPanel
            error={matches.error}
            onRetry={() => void matches.refetch()}
          />
        )}
        {debounced.length >= 2 &&
          matches.data &&
          (matches.data.items.length === 0 ? (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              No patients match “{debounced}”.
            </p>
          ) : (
            <ul
              className="divide-y rounded-md border"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {matches.data.items.map((p) => (
                <li key={p.id}>
                  <button
                    type="button"
                    onClick={() => onAttach(p)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-[hsl(var(--surface-2))]"
                    data-testid={`disc-patient-option-${p.id}`}
                  >
                    <span className="font-medium">
                      {p.firstName} {p.lastName}
                    </span>
                    <span
                      className="ml-2 text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      {p.pacwareId ? `PacWare ${p.pacwareId} · ` : ""}
                      {p.status}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ))}
      </div>
    </Card>
  );
}

// ── Results ──────────────────────────────────────────────────────────

function ResultSection({
  result,
  patient,
  latencyMs,
}: {
  result: InsuranceDiscoveryResult;
  patient: PatientListItem | null;
  latencyMs: number;
}) {
  const secs = (latencyMs / 1000).toFixed(1);
  // Active coverages first. Computed unconditionally (Rules of Hooks); the
  // "none" branch below ignores it.
  const sorted = useMemo(
    () =>
      result.status === "found"
        ? [...result.coverages].sort(
            (a, b) => Number(b.isActive) - Number(a.isActive),
          )
        : [],
    [result],
  );

  if (result.status === "none") {
    return (
      <Card title="Result" subtitle={`Searched in ${secs}s`}>
        <p
          className="text-sm"
          style={{ color: "hsl(var(--ink-2))" }}
          data-testid="disc-none"
        >
          No coverage matched these details. Double-check the spelling and date
          of birth, add an SSN if you have one, and try again.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="Discovered coverage"
      subtitle={`${result.activeCount} active · ${result.coverages.length} found · searched in ${secs}s`}
    >
      <ul className="space-y-3" data-testid="disc-result">
        {sorted.map((c, i) => (
          <CoverageRow
            key={`${c.payerName}-${c.memberId ?? i}`}
            coverage={c}
            patient={patient}
          />
        ))}
      </ul>
      <p className="mt-4 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
        Discovery is a search, not a verification. Add a coverage to the chart
        and run{" "}
        <Link href="/admin/billing/verify" className="underline font-medium">
          Verify insurance
        </Link>{" "}
        to confirm benefits before billing.
      </p>
    </Card>
  );
}

function CoverageRow({
  coverage,
  patient,
}: {
  coverage: DiscoveredCoverage;
  patient: PatientListItem | null;
}) {
  const qc = useQueryClient();
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      if (!patient) throw new Error("No patient attached.");
      return createInsuranceCoverage(patient.id, {
        rank: "primary",
        payerName: coverage.payerName,
        memberId: coverage.memberId ?? "UNKNOWN",
        planName: coverage.planName,
        effectiveDate: coverage.coverageStart,
        terminationDate: coverage.coverageEnd,
      });
    },
    onSuccess: () => {
      setSaved(true);
      setSaveError(null);
      if (patient) {
        void qc.invalidateQueries({
          queryKey: ["patient-coverages", patient.id],
        });
      }
    },
    onError: (err) => {
      setSaveError(err instanceof Error ? err.message : "Could not save.");
    },
  });

  return (
    <li
      className="rounded-md border px-3 py-2.5"
      style={{ borderColor: "hsl(var(--line-1))" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p
            className="text-sm font-semibold"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {coverage.payerName}
            <span
              className="ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
              style={
                coverage.isActive
                  ? {
                      color: "#15803d",
                      backgroundColor: "rgba(21,128,61,0.12)",
                    }
                  : {
                      color: "#b91c1c",
                      backgroundColor: "rgba(185,28,28,0.12)",
                    }
              }
            >
              {coverage.isActive ? "active" : "inactive"}
            </span>
          </p>
          <p className="text-xs mt-0.5" style={{ color: "hsl(var(--ink-3))" }}>
            {coverage.memberId ? `Member ${coverage.memberId}` : "Member —"}
            {coverage.planName ? ` · ${coverage.planName}` : ""}
            {coverage.coverageStart
              ? ` · from ${formatAppDate(coverage.coverageStart)}`
              : ""}
            {coverage.coverageEnd
              ? ` · to ${formatAppDate(coverage.coverageEnd)}`
              : ""}
          </p>
        </div>
        {patient && (
          <div className="text-right">
            {saved ? (
              <span
                className="text-xs font-medium"
                style={{ color: "#15803d" }}
              >
                Added to chart
              </span>
            ) : (
              <Button
                intent="secondary"
                isLoading={save.isPending}
                disabled={save.isPending}
                onClick={() => save.mutate()}
                data-testid="disc-save-coverage"
              >
                Add to chart
              </Button>
            )}
          </div>
        )}
      </div>
      {saveError && (
        <p className="mt-2 text-[11px]" style={{ color: "#991b1b" }}>
          {saveError}
        </p>
      )}
    </li>
  );
}
