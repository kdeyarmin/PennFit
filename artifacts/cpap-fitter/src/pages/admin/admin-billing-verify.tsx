// /admin/billing/verify — standalone on-demand insurance verification.
//
// The "run a verification right now" tool the front desk reaches for
// when a patient is on the phone. Two modes:
//
//   * Existing patient — search any patient by name (or PacWare id),
//     pick the coverage, and fire a 270/271; the real-time answer
//     renders inline and the patient's recent checks show below.
//   * Quick check (no patient record) — type the subscriber's name /
//     DOB / member id and pick a payer; the parsed 271 renders inline
//     and NOTHING is persisted (no patient, no coverage, no
//     eligibility_checks row). For prospects / phone-shoppers who
//     aren't in the system yet.
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
  quickCheckEligibility,
  type QuickCheckResult,
} from "@/lib/admin/billing-api";
import { fetchPayerProfiles } from "@/lib/admin/billing-config-api";
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

/** Prefer the structured server reason ({ message }) over ApiError's
 *  "HTTP 409 Conflict: …" prefix; fall back to the Error message. */
function apiErrorMessage(err: unknown): string {
  const data = (err as { data?: unknown } | null | undefined)?.data;
  const message = (data as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.length > 0) return message;
  return err instanceof Error ? err.message : "Quick check failed.";
}

export function AdminBillingVerifyPage() {
  useDocumentTitle("Verify insurance");
  const qc = useQueryClient();

  // ── Mode: existing patient vs quick check (no record) ──────────────
  const [mode, setMode] = useState<"patient" | "quick">("patient");

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
          Run an on-demand eligibility check (270/271) — for a patient on file,
          or as a quick check for someone who isn&apos;t in the system. For the
          cross-patient queue see the{" "}
          <Link
            href="/admin/billing/eligibility"
            className="underline font-medium"
          >
            Eligibility worklist
          </Link>
          .
        </p>
      </header>

      <div
        className="inline-flex rounded-md border overflow-hidden text-sm"
        role="group"
        aria-label="Verification mode"
      >
        <button
          type="button"
          onClick={() => setMode("patient")}
          className={`px-3 py-1.5 font-semibold ${
            mode === "patient"
              ? "bg-[hsl(var(--penn-navy))] text-white"
              : "bg-white"
          }`}
          data-testid="verify-mode-patient"
        >
          Existing patient
        </button>
        <button
          type="button"
          onClick={() => setMode("quick")}
          className={`px-3 py-1.5 font-semibold ${
            mode === "quick"
              ? "bg-[hsl(var(--penn-navy))] text-white"
              : "bg-white"
          }`}
          data-testid="verify-mode-quick"
        >
          Quick check — no patient record
        </button>
      </div>

      {mode === "quick" && <QuickCheckSection />}

      {mode === "patient" && (
        <>
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
                    <p
                      className="text-sm"
                      style={{ color: "hsl(var(--ink-3))" }}
                    >
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
                  No insurance coverage on file for this patient. Add one from
                  their{" "}
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
                                {c.in_network === false
                                  ? " · out-of-network"
                                  : ""}
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
        </>
      )}
    </div>
  );
}

// ── Quick check (no patient record) ──────────────────────────────────
//
// Type the subscriber in, pick a payer, fire the real-time 270/271.
// The server persists nothing; the parsed answer below is all there is.

function QuickCheckSection() {
  const payers = useQuery({
    queryKey: ["billing-verify-payers"],
    queryFn: () => fetchPayerProfiles({ active: "true" }),
    staleTime: 5 * 60_000,
  });
  // Only payers we can actually query electronically.
  const electronicPayers = useMemo(
    () =>
      (payers.data?.payerProfiles ?? []).filter(
        (p) => p.officeAllyPayerId && !p.paperOnly,
      ),
    [payers.data],
  );

  const [payerProfileId, setPayerProfileId] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [memberId, setMemberId] = useState("");
  const [dob, setDob] = useState("");
  const [sex, setSex] = useState<"U" | "M" | "F">("U");
  const [hcpcs, setHcpcs] = useState("");
  const [result, setResult] = useState<QuickCheckResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hcpcsTrimmed = hcpcs.trim().toUpperCase();
  const hcpcsValid = hcpcsTrimmed === "" || HCPCS_RE.test(hcpcsTrimmed);
  const formComplete =
    payerProfileId !== "" &&
    firstName.trim() !== "" &&
    lastName.trim() !== "" &&
    memberId.trim() !== "" &&
    dob !== "" &&
    hcpcsValid;

  const selectedPayer = electronicPayers.find((p) => p.id === payerProfileId);
  const today = new Date().toISOString().slice(0, 10);

  const check = useMutation({
    mutationFn: () =>
      quickCheckEligibility({
        payerProfileId,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        memberId: memberId.trim(),
        dateOfBirth: dob,
        ...(sex !== "U" ? { gender: sex } : {}),
        ...(hcpcsTrimmed ? { hcpcsCode: hcpcsTrimmed } : {}),
      }),
    onSuccess: (r) => {
      setError(null);
      setResult(r);
    },
    onError: (err) => {
      setResult(null);
      setError(apiErrorMessage(err));
    },
  });

  return (
    <>
      <Card
        title="Who are we checking?"
        subtitle="Checked directly against the payer — the person does not need to be in PennFit, and nothing is saved."
      >
        {payers.isPending ? (
          <Spinner label="Loading payers…" />
        ) : payers.isError ? (
          <ErrorPanel
            error={payers.error}
            onRetry={() => void payers.refetch()}
          />
        ) : electronicPayers.length === 0 ? (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No active payers accept electronic eligibility yet. Add an Office
            Ally payer ID under{" "}
            <Link
              href="/admin/billing/config/payers"
              className="underline font-medium"
            >
              Payers
            </Link>
            .
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2 max-w-sm">
              <Label htmlFor="quick-payer">Payer</Label>
              <select
                id="quick-payer"
                value={payerProfileId}
                onChange={(e) => setPayerProfileId(e.target.value)}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                data-testid="quick-payer"
              >
                <option value="">Select a payer…</option>
                {electronicPayers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="quick-member-id">Member ID</Label>
              <Input
                id="quick-member-id"
                value={memberId}
                onChange={(e) => setMemberId(e.target.value)}
                placeholder="From the insurance card"
                data-testid="quick-member-id"
              />
              {selectedPayer?.memberIdFormatHint && (
                <p
                  className="mt-1 text-[11px]"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  {selectedPayer.memberIdFormatHint}
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="quick-dob">Date of birth</Label>
              <Input
                id="quick-dob"
                type="date"
                value={dob}
                max={today}
                onChange={(e) => setDob(e.target.value)}
                data-testid="quick-dob"
              />
            </div>
            <div>
              <Label htmlFor="quick-first-name">First name</Label>
              <Input
                id="quick-first-name"
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                placeholder="As it appears on the card"
                data-testid="quick-first-name"
              />
            </div>
            <div>
              <Label htmlFor="quick-last-name">Last name</Label>
              <Input
                id="quick-last-name"
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                data-testid="quick-last-name"
              />
            </div>
            <div>
              <Label htmlFor="quick-sex">Sex (optional)</Label>
              <select
                id="quick-sex"
                value={sex}
                onChange={(e) => setSex(e.target.value as "U" | "M" | "F")}
                className="w-full rounded-md border px-2 py-1.5 text-sm"
                data-testid="quick-sex"
              >
                <option value="U">Unknown</option>
                <option value="F">Female</option>
                <option value="M">Male</option>
              </select>
            </div>
            <div className="max-w-[10rem]">
              <Label htmlFor="quick-hcpcs">HCPCS (optional)</Label>
              <Input
                id="quick-hcpcs"
                value={hcpcs}
                onChange={(e) => setHcpcs(e.target.value.toUpperCase())}
                placeholder="E0601"
                maxLength={5}
                data-testid="quick-hcpcs"
              />
            </div>
          </div>
        )}

        {!hcpcsValid && (
          <p className="mt-2 text-xs" style={{ color: "#991b1b" }}>
            HCPCS must be a letter followed by four digits (e.g. E0601).
          </p>
        )}

        {electronicPayers.length > 0 && (
          <div className="mt-4">
            <Button
              isLoading={check.isPending}
              disabled={check.isPending || !formComplete}
              onClick={() => {
                setResult(null);
                setError(null);
                check.mutate();
              }}
              data-testid="quick-run"
            >
              <ShieldCheck className="h-4 w-4 mr-1.5" aria-hidden="true" />
              {check.isPending ? "Checking…" : "Run quick check"}
            </Button>
          </div>
        )}

        {error && (
          <p
            className="mt-3 text-sm"
            style={{ color: "#991b1b" }}
            role="status"
            data-testid="quick-check-error"
          >
            {error}
          </p>
        )}
      </Card>

      {result && (
        <Card
          title="Result"
          subtitle={`${result.payerName} · answered in ${(result.latencyMs / 1000).toFixed(1)}s`}
        >
          <div className="space-y-4" data-testid="quick-check-result">
            <p
              className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-semibold"
              style={
                result.benefits.isActive
                  ? {
                      color: "#15803d",
                      backgroundColor: "rgba(21, 128, 61, 0.12)",
                    }
                  : {
                      color: "#b91c1c",
                      backgroundColor: "rgba(185, 28, 28, 0.12)",
                    }
              }
              role="status"
            >
              {result.benefits.isActive
                ? "Active coverage"
                : "Coverage inactive"}
              {result.benefits.inNetwork === true ? " · in-network" : ""}
              {result.benefits.inNetwork === false ? " · out-of-network" : ""}
              {result.benefits.requiresPriorAuth
                ? " · prior auth required"
                : ""}
            </p>

            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-3 text-sm">
              <BenefitItem
                label="Deductible"
                value={formatMoney(result.benefits.deductibleCents)}
                detail={
                  result.benefits.deductibleMetCents != null
                    ? `met ${formatMoney(result.benefits.deductibleMetCents)}`
                    : result.benefits.deductibleRemainingCents != null
                      ? `remaining ${formatMoney(result.benefits.deductibleRemainingCents)}`
                      : null
                }
              />
              <BenefitItem
                label="Out-of-pocket max"
                value={formatMoney(result.benefits.oopMaxCents)}
                detail={
                  result.benefits.oopMetCents != null
                    ? `met ${formatMoney(result.benefits.oopMetCents)}`
                    : result.benefits.oopRemainingCents != null
                      ? `remaining ${formatMoney(result.benefits.oopRemainingCents)}`
                      : null
                }
              />
              <BenefitItem
                label="Copay"
                value={formatMoney(result.benefits.copayCents)}
              />
              <BenefitItem
                label="Coinsurance"
                value={
                  result.benefits.coinsurancePct == null
                    ? "—"
                    : `${result.benefits.coinsurancePct}%`
                }
              />
              <BenefitItem
                label="Prior auth"
                value={
                  result.benefits.requiresPriorAuth ? "Required" : "Not flagged"
                }
              />
            </dl>

            {result.benefits.messages.length > 0 && (
              <div>
                <p
                  className="text-[10px] uppercase tracking-[0.2em] font-semibold mb-1"
                  style={{ color: "hsl(var(--penn-gold-deep))" }}
                >
                  Payer messages
                </p>
                <ul
                  className="list-disc pl-5 text-xs space-y-0.5"
                  style={{ color: "hsl(var(--ink-2))" }}
                >
                  {result.benefits.messages.map((m, i) => (
                    <li key={i}>{m}</li>
                  ))}
                </ul>
              </div>
            )}

            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Nothing was saved — quick checks aren&apos;t attached to a patient
              record. To keep a verification on file, add the patient and verify
              from their chart.
            </p>
          </div>
        </Card>
      )}
    </>
  );
}

function BenefitItem({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string | null;
}) {
  return (
    <div>
      <dt
        className="text-[10px] uppercase tracking-[0.2em] font-semibold"
        style={{ color: "hsl(var(--penn-gold-deep))" }}
      >
        {label}
      </dt>
      <dd
        className="tabular-nums font-medium"
        style={{ color: "hsl(var(--ink-1))" }}
      >
        {value}
        {detail && (
          <span
            className="block text-[11px] font-normal"
            style={{ color: "hsl(var(--ink-3))" }}
          >
            {detail}
          </span>
        )}
      </dd>
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
