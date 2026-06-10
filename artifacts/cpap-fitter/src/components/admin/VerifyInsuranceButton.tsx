// "Verify insurance" — one-click on-demand eligibility check (270/271)
// from the patient Quick-actions card, so a CSR can confirm coverage
// without hunting for the chart's Billing tab. Runs against the
// patient's primary coverage (or the first on file) and surfaces the
// real-time result inline. The full result history (financials,
// per-check detail) stays on the Billing tab; the standalone
// cross-patient runner lives at /admin/billing/verify.
//
// Shares the ["patient-coverages", patientId] and
// ["patient-eligibility", patientId] query keys with PatientBillingTab
// so the two surfaces never show different coverage states.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/admin/Button";
import {
  listInsuranceCoverages,
  verifyEligibility,
} from "@/lib/admin/clinical-tabs-api";

export function VerifyInsuranceButton({ patientId }: { patientId: string }) {
  const qc = useQueryClient();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const coverages = useQuery({
    queryKey: ["patient-coverages", patientId],
    queryFn: () => listInsuranceCoverages(patientId),
    staleTime: 60_000,
  });

  // Same one-click rule as the Billing tab: primary, else first on file.
  const billableCoverage = useMemo(() => {
    const list = coverages.data?.coverages ?? [];
    return list.find((c) => c.rank === "primary") ?? list[0] ?? null;
  }, [coverages.data]);

  const verify = useMutation({
    mutationFn: async () => {
      if (!billableCoverage) {
        throw new Error("Add an insurance coverage first.");
      }
      return verifyEligibility(patientId, billableCoverage.id);
    },
    onSuccess: (r) => {
      setError(null);
      if (r.realtime && r.status === "parsed") {
        const secs =
          typeof r.latencyMs === "number"
            ? ` (${(r.latencyMs / 1000).toFixed(1)}s)`
            : "";
        setMessage(
          `Verified in real time${secs} — full result on the Billing tab.`,
        );
      } else if (r.status === "submitted") {
        setMessage(
          "270 submitted — the 271 lands shortly; see the Billing tab.",
        );
      } else {
        setMessage(r.errorMessage ?? "Submitted.");
      }
      void qc.invalidateQueries({
        queryKey: ["patient-eligibility", patientId],
      });
    },
    onError: (err) => {
      setMessage(null);
      setError(
        err instanceof Error ? err.message : "Eligibility check failed.",
      );
    },
  });

  const noCoverage = !coverages.isPending && !billableCoverage;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          intent="secondary"
          isLoading={verify.isPending}
          disabled={verify.isPending || !billableCoverage}
          onClick={() => {
            setMessage(null);
            setError(null);
            verify.mutate();
          }}
          data-testid="patient-verify-insurance"
        >
          {verify.isPending ? "Verifying…" : "Verify insurance"}
        </Button>
        {billableCoverage && (
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {billableCoverage.payerName} · {billableCoverage.rank}
          </span>
        )}
      </div>
      {noCoverage && (
        <p className="mt-2 text-xs" style={{ color: "hsl(var(--ink-3))" }}>
          No insurance coverage on file — add one from the Billing tab first.
        </p>
      )}
      {message && (
        <p
          className="mt-2 text-sm"
          style={{ color: "#166534" }}
          role="status"
          data-testid="patient-verify-insurance-result"
        >
          {message}
        </p>
      )}
      {error && (
        <p className="mt-2 text-sm" style={{ color: "#991b1b" }} role="status">
          {error}
        </p>
      )}
    </div>
  );
}
