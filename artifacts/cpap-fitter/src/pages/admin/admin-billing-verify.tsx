// /admin/billing/verify — standalone on-demand insurance verification.
//
// The "run a verification right now" tool the front desk reaches for
// when a patient is on the phone: search any patient by name (or
// PacWare id), pick the coverage, and fire a 270/271 — the real-time
// answer renders inline, and the patient's recent checks show below.
//
// This page runs CHECKS; the QUEUES stay where they were —
// /admin/billing/eligibility is the system-wide worklist and
// /admin/billing/eligibility-recheck is the re-verification list. The
// same one-click check also lives on the patient chart (Quick actions →
// Verify insurance, and the Billing tab).

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ShieldCheck } from "lucide-react";

import {
  listPatients,
  type PatientListItem,
} from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input, Label } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import {
  listEligibilityChecks,
  listInsuranceCoverages,
  verifyEligibility,
  type EligibilityCheck,
  type InsuranceCoverage,
} from "@/lib/admin/clinical-tabs-api";
import { useDocumentTitle } from "@/hooks/use-document-title";

const HCPCS_RE = /^[A-Z]\d{4}$/;

function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return "—";
  return (cents / 100).toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
  });
}

export function AdminBillingVerifyPage() {
  useDocumentTitle("Verify insurance");
  const qc = useQueryClient();

  // ── Step 1: find the patient ────────────────────────────────────────
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [patient, setPatient] = useState<PatientListItem | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search.trim()), 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const matches = useQuery({
    queryKey: ["billing-verify-patient-search", debounced],
    queryFn: () => listPatients({ search: debounced, limit: 10 }),
    enabled: debounced.length >= 2 && !patient,
    staleTime: 30_000,
  });

  // ── Step 2: pick the coverage ───────────────────────────────────────
  const [coverageId, setCoverageId] = useState<string | null>(null);
  const [hcpcs, setHcpcs] = useState("");

  const coverages = useQuery({
    queryKey: ["patient-coverages", patient?.id],
    queryFn: () => listInsuranceCoverages(patient!.id),
    enabled: !!patient,
    staleTime: 60_000,
  });

  // Default to the primary (or first) coverage once the list lands.
  const coverageList = useMemo(
    () => coverages.data?.coverages ?? [],
    [coverages.data],
  );
  useEffect(() => {
    if (!patient || coverageList.length === 0) {
      setCoverageId(null);
      return;
    }
    setCoverageId(
      (prev) =>
        (prev && coverageList.some((c) => c.id === prev) && prev) ||
        (coverageList.find((c) => c.rank === "primary") ?? coverageList[0]!).id,
    );
  }, [patient, coverageList]);

  const recentChecks = useQuery({
    queryKey: ["patient-eligibility", patient?.id],
    queryFn: () => listEligibilityChecks(patient!.id),
    enabled: !!patient,
    staleTime: 30_000,
  });

  // ── Step 3: run it ──────────────────────────────────────────────────
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hcpcsTrimmed = hcpcs.trim().toUpperCase();
  const hcpcsValid = hcpcsTrimmed === "" || HCPCS_RE.test(hcpcsTrimmed);

  const verify = useMutation({
    mutationFn: async () => {
      if (!patient || !coverageId) {
        throw new Error("Pick a patient and a coverage first.");
      }
      return verifyEligibility(
        patient.id,
        coverageId,
        hcpcsTrimmed ? { hcpcsCode: hcpcsTrimmed } : undefined,
      );
    },
    onSuccess: (r) => {
      setError(null);
      if (r.realtime && r.status === "parsed") {
        const secs =
          typeof r.latencyMs === "number"
            ? ` (${(r.latencyMs / 1000).toFixed(1)}s)`
            : "";
        setMessage(`Verified in real time${secs} — result below.`);
      } else if (r.status === "submitted") {
        setMessage(
          "270 submitted — the 271 lands shortly; refresh in a minute.",
        );
      } else {
        setMessage(r.errorMessage ?? "Submitted.");
      }
      void qc.invalidateQueries({
        queryKey: ["patient-eligibility", patient?.id],
      });
    },
    onError: (err) => {
      setMessage(null);
      setError(
        err instanceof Error ? err.message : "Eligibility check failed.",
      );
    },
  });

  function selectPatient(p: PatientListItem) {
    setPatient(p);
    setMessage(null);
    setError(null);
    setHcpcs("");
  }

  function clearPatient() {
    setPatient(null);
    setCoverageId(null);
    setMessage(null);
    setError(null);
    setSearch("");
    setDebounced("");
  }

  return (
    <div
      className="admin-root space-y-6 max-w-4xl"
      data-testid="admin-billing-verify"
    >
      <header>
        <h1
          className="text-2xl font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Verify insurance
        </h1>
        <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
          Run an on-demand eligibility check (270/271) for any patient — search,
          pick the coverage, verify. For the cross-patient queue see the{" "}
          <Link
            href="/admin/billing/eligibility"
            className="underline font-medium"
          >
            Eligibility worklist
          </Link>
          .
        </p>
      </header>

      <Card title="1 — Patient">
        {!patient ? (
          <div className="space-y-3">
            <div className="max-w-sm">
              <Label htmlFor="verify-patient-search">
                Search by name or PacWare ID
              </Label>
              <Input
                id="verify-patient-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="e.g. Smith"
                autoFocus
                data-testid="verify-patient-search"
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
                        onClick={() => selectPatient(p)}
                        className="w-full px-3 py-2 text-left text-sm hover:bg-[hsl(var(--surface-2))]"
                        data-testid={`verify-patient-option-${p.id}`}
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
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <span
              className="text-sm font-medium"
              data-testid="verify-patient-selected"
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
            <Button intent="secondary" onClick={clearPatient}>
              Change patient
            </Button>
          </div>
        )}
      </Card>

      {patient && (
        <Card title="2 — Coverage">
          {coverages.isPending ? (
            <Spinner label="Loading coverages…" />
          ) : coverages.isError ? (
            <ErrorPanel
              error={coverages.error}
              onRetry={() => void coverages.refetch()}
            />
          ) : coverageList.length === 0 ? (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              No insurance coverage on file for this patient. Add one from their{" "}
              <Link
                href={`/admin/patients/${patient.id}`}
                className="underline font-medium"
              >
                chart
              </Link>{" "}
              first.
            </p>
          ) : (
            <div className="space-y-2">
              {coverageList.map((c: InsuranceCoverage) => (
                <label
                  key={c.id}
                  className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer"
                  style={{
                    borderColor:
                      coverageId === c.id
                        ? "hsl(var(--penn-gold))"
                        : "hsl(var(--line-1))",
                  }}
                >
                  <input
                    type="radio"
                    name="verify-coverage"
                    checked={coverageId === c.id}
                    onChange={() => setCoverageId(c.id)}
                    className="mt-1"
                    data-testid={`verify-coverage-${c.id}`}
                  />
                  <span>
                    <span className="font-medium">{c.payerName}</span>
                    <span
                      className="ml-2 text-xs uppercase tracking-wide"
                      style={{ color: "hsl(var(--penn-gold-deep))" }}
                    >
                      {c.rank}
                    </span>
                    <span
                      className="block text-xs"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
                      Member {c.memberId}
                      {c.planName ? ` · ${c.planName}` : ""}
                      {c.verifiedAt
                        ? ` · last verified ${new Date(c.verifiedAt).toLocaleDateString()}`
                        : " · never verified"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Card>
      )}

      {patient && coverageList.length > 0 && (
        <Card title="3 — Run the check">
          <div className="flex flex-wrap items-end gap-3">
            <div className="max-w-[10rem]">
              <Label htmlFor="verify-hcpcs">HCPCS (optional)</Label>
              <Input
                id="verify-hcpcs"
                value={hcpcs}
                onChange={(e) => setHcpcs(e.target.value.toUpperCase())}
                placeholder="E0601"
                maxLength={5}
                data-testid="verify-hcpcs"
              />
            </div>
            <Button
              isLoading={verify.isPending}
              disabled={verify.isPending || !coverageId || !hcpcsValid}
              onClick={() => {
                setMessage(null);
                setError(null);
                verify.mutate();
              }}
              data-testid="verify-run"
            >
              <ShieldCheck className="h-4 w-4 mr-1.5" aria-hidden="true" />
              {verify.isPending ? "Verifying…" : "Run verification"}
            </Button>
          </div>
          {!hcpcsValid && (
            <p className="mt-2 text-xs" style={{ color: "#991b1b" }}>
              HCPCS must be a letter followed by four digits (e.g. E0601).
            </p>
          )}
          {message && (
            <p
              className="mt-3 text-sm"
              style={{ color: "#166534" }}
              role="status"
              data-testid="verify-result"
            >
              {message}
            </p>
          )}
          {error && (
            <p
              className="mt-3 text-sm"
              style={{ color: "#991b1b" }}
              role="status"
              data-testid="verify-error"
            >
              {error}
            </p>
          )}
        </Card>
      )}

      {patient && (
        <Card
          title="Recent checks"
          subtitle="Most recent eligibility round-trips for this patient."
        >
          {recentChecks.isPending ? (
            <Spinner label="Loading checks…" />
          ) : recentChecks.isError ? (
            <ErrorPanel
              error={recentChecks.error}
              onRetry={() => void recentChecks.refetch()}
            />
          ) : (recentChecks.data?.checks.length ?? 0) === 0 ? (
            <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
              No eligibility checks on file yet.
            </p>
          ) : (
            <ul
              className="divide-y -mt-1 -mb-1"
              style={{ borderColor: "hsl(var(--line-1))" }}
            >
              {(recentChecks.data?.checks ?? [])
                .slice(0, 8)
                .map((c: EligibilityCheck) => (
                  <li key={c.id} className="py-2 text-sm">
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-2">
                        <StatusBadge status={c.status} />
                        {c.service_hcpcs && (
                          <span
                            className="font-mono text-[11px]"
                            style={{ color: "hsl(var(--ink-2))" }}
                          >
                            {c.service_hcpcs}
                          </span>
                        )}
                      </span>
                      <span
                        className="text-[11px]"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {new Date(c.requested_at).toLocaleString()}
                      </span>
                    </div>
                    {c.is_active != null && (
                      <p
                        className="text-[11px] mt-0.5"
                        style={{ color: "hsl(var(--ink-3))" }}
                      >
                        {c.is_active ? (
                          <span style={{ color: "#15803d" }}>
                            active
                            {c.in_network === true ? " · in-network" : ""}
                            {c.in_network === false ? " · out-of-network" : ""}
                          </span>
                        ) : (
                          <span style={{ color: "#b91c1c" }}>inactive</span>
                        )}
                        {c.requires_prior_auth === true && (
                          <span style={{ color: "#b45309" }}>
                            {" "}
                            · PA required
                          </span>
                        )}
                        {c.deductible_cents != null && (
                          <> · ded {formatMoney(c.deductible_cents)}</>
                        )}
                        {c.oop_max_cents != null && (
                          <> · OOP max {formatMoney(c.oop_max_cents)}</>
                        )}
                      </p>
                    )}
                    {c.error_message && (
                      <p
                        className="text-[11px] mt-0.5"
                        style={{ color: "#b91c1c" }}
                      >
                        {c.error_message}
                      </p>
                    )}
                  </li>
                ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "parsed"
      ? { color: "#15803d", bg: "rgba(21, 128, 61, 0.12)" }
      : status === "rejected" || status === "transport_failed"
        ? { color: "#b91c1c", bg: "rgba(185, 28, 28, 0.12)" }
        : { color: "#1d4ed8", bg: "rgba(29, 78, 216, 0.12)" };
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ color: tone.color, backgroundColor: tone.bg }}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
