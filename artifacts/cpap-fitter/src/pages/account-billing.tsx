// /account/billing — patient-facing billing portal.
//
// Mirrors what Brightree's Patient Hub, Bonafide's My Account, and
// CollaborateMD's payment portal expose to patients: open balances
// (per claim), past statements (with PDF download), and payment
// history. Read-only in this revision — initiating a card payment
// goes through Stripe Elements which is its own follow-up; the page
// surfaces a "Contact billing" CTA when there's an open balance so
// patients have a path RIGHT NOW instead of waiting for the widget.
//
// Auth: gated by <SignedIn>. The /api/me/* endpoints 401 without a
// shop-customer cookie, which the global error boundary catches.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import {
  ArrowLeft,
  CheckCircle2,
  CreditCard,
  Download,
  FileText,
  Wallet,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SignedIn } from "@/lib/identity";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  createPaymentCheckoutSession,
  fetchBillingBalance,
  fetchPatientPayments,
  fetchPatientStatements,
  formatMoneyCents,
  statementPdfUrl,
  type PatientPayment,
} from "@/lib/me-billing-api";

function paymentTone(status: PatientPayment["status"]): {
  color: string;
  bg: string;
  label: string;
} {
  switch (status) {
    case "succeeded":
      return {
        color: "#15803d",
        bg: "rgba(21, 128, 61, 0.12)",
        label: "paid",
      };
    case "pending":
    case "requires_action":
      return {
        color: "#b45309",
        bg: "rgba(180, 83, 9, 0.12)",
        label: status === "pending" ? "processing" : "needs verification",
      };
    case "failed":
    case "cancelled":
      return {
        color: "#b91c1c",
        bg: "rgba(185, 28, 28, 0.12)",
        label: status,
      };
    case "refunded":
      return {
        color: "#1d4ed8",
        bg: "rgba(29, 78, 216, 0.12)",
        label: "refunded",
      };
  }
}

export function AccountBillingPage() {
  useDocumentTitle(
    "Billing — PennPaps",
    "Your open balances, statements, and past payments.",
  );

  return (
    <SignedIn>
      <AccountBillingInner />
    </SignedIn>
  );
}

function AccountBillingInner() {
  const qc = useQueryClient();
  const [location, setLocation] = useLocation();
  const params = new URLSearchParams(
    location.includes("?") ? location.split("?")[1] : "",
  );
  const justPaid = params.get("paid") === "1";
  const cancelled = params.get("cancelled") === "1";

  const balance = useQuery({
    queryKey: ["me-billing-balance"],
    queryFn: fetchBillingBalance,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const statements = useQuery({
    queryKey: ["me-billing-statements"],
    queryFn: fetchPatientStatements,
    staleTime: 30_000,
  });
  const payments = useQuery({
    queryKey: ["me-billing-payments"],
    queryFn: fetchPatientPayments,
    staleTime: 30_000,
  });

  // After a Stripe-hosted success redirect the webhook fires async;
  // give it ~3s to land before the user reads stale balance. We
  // refetch on focus too — the page is the typical landing spot.
  useEffect(() => {
    if (!justPaid) return;
    const t = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["me-billing-balance"] });
      void qc.invalidateQueries({ queryKey: ["me-billing-payments"] });
    }, 3000);
    return () => clearTimeout(t);
  }, [justPaid, qc]);

  const [payError, setPayError] = useState<string | null>(null);
  const startCheckout = useMutation({
    mutationFn: async (): Promise<void> => {
      const claims = balance.data?.claims ?? [];
      if (claims.length === 0) {
        throw new Error("No open balance to pay.");
      }
      // Pay every open claim in full. A future iteration could add
      // per-claim checkboxes, but for v1 "pay everything" is the
      // overwhelmingly common case and mirrors the statement format.
      const allocations = claims.map((c) => ({
        claimId: c.id,
        amountAppliedCents: c.patientResponsibilityCents,
      }));
      const session = await createPaymentCheckoutSession({ allocations });
      // Hosted Checkout — full-window redirect. Don't open in a new
      // tab; Stripe blocks the page back-button → return-URL handoff
      // otherwise.
      window.location.href = session.url;
    },
    onMutate: () => setPayError(null),
    onSuccess: () => setPayError(null),
    onError: (err) => {
      setPayError(err instanceof Error ? err.message : "Couldn't start checkout.");
    },
  });

  const totalOpen = balance.data?.totalOpenCents ?? 0;
  const claimCount = balance.data?.claimCount ?? 0;
  const showPayBanner = totalOpen > 0;
  // Use `setLocation` to dismiss the success/cancel banner — strips
  // the query string without a full reload.
  function dismissBanner() {
    setLocation("/account/billing", { replace: true });
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 space-y-8">
      <header className="space-y-2">
        <Link
          href="/account"
          className="inline-flex items-center gap-1.5 text-sm text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to account
        </Link>
        <h1 className="text-3xl font-bold tracking-tight">Billing</h1>
        <p className="text-slate-600">
          Your open balance with PennPaps after insurance, plus past
          statements and payments. Statements are also emailed when
          generated; this page is the always-current view.
        </p>
      </header>

      {justPaid && (
        <div
          className="rounded-lg border bg-emerald-50 border-emerald-200 p-4 flex items-start gap-3"
          data-testid="payment-success-banner"
        >
          <CheckCircle2 className="h-5 w-5 text-emerald-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-900">
              Payment received
            </p>
            <p className="text-xs text-emerald-800 mt-0.5">
              Thanks — your payment is processing. The balance below
              updates within a few seconds.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            className="text-xs underline text-emerald-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {cancelled && (
        <div
          className="rounded-lg border bg-amber-50 border-amber-200 p-4 flex items-start gap-3"
          data-testid="payment-cancelled-banner"
        >
          <XCircle className="h-5 w-5 text-amber-700 mt-0.5 shrink-0" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              Payment cancelled
            </p>
            <p className="text-xs text-amber-800 mt-0.5">
              No charge was made. You can retry below whenever you're
              ready.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissBanner}
            className="text-xs underline text-amber-700"
          >
            Dismiss
          </button>
        </div>
      )}

      <section
        className="rounded-2xl border bg-white p-6 shadow-sm"
        data-testid="billing-open-balance"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 inline-flex items-center gap-1.5">
              <Wallet className="h-3.5 w-3.5" />
              Open balance
            </p>
            <p className="mt-1 text-4xl font-bold tabular-nums text-slate-900">
              {balance.isPending || balance.isError ? "—" : formatMoneyCents(totalOpen)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {balance.isPending
                ? "Loading…"
                : balance.isError
                  ? (balance.error instanceof Error ? balance.error.message : "Failed to load balance.")
                  : claimCount === 0
                  ? "No outstanding balance."
                  : `${claimCount} claim${claimCount === 1 ? "" : "s"} with patient responsibility after insurance.`}
            </p>
            {balance.isError && (
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => void balance.refetch()}
                disabled={balance.isFetching}
                data-testid="billing-balance-retry"
              >
                {balance.isFetching ? "Retrying…" : "Retry"}
              </Button>
            )}
          </div>
          {showPayBanner && (
            <div className="shrink-0 flex flex-col items-end gap-1">
              <Button
                onClick={() => startCheckout.mutate()}
                disabled={startCheckout.isPending}
                data-testid="pay-balance-button"
              >
                <CreditCard className="mr-1.5 h-4 w-4" />
                {startCheckout.isPending
                  ? "Redirecting…"
                  : `Pay ${formatMoneyCents(totalOpen)} by card`}
              </Button>
              <p className="text-[11px] text-slate-500 text-right">
                Hosted by Stripe — your card never touches our servers
              </p>
              {payError && (
                <p
                  className="text-[11px] text-red-600 text-right max-w-[220px]"
                  data-testid="pay-balance-error"
                >
                  {payError}
                </p>
              )}
            </div>
          )}
        </div>

        {totalOpen > 0 && (balance.data?.claims.length ?? 0) > 0 && (
          <div className="mt-5 border-t pt-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-slate-500 mb-2">
              Per-claim breakdown
            </p>
            <ul className="divide-y">
              {(balance.data?.claims ?? []).map((c) => (
                <li
                  key={c.id}
                  className="flex items-center justify-between py-2 text-sm"
                >
                  <div>
                    <p className="font-medium text-slate-900">
                      {c.payerName}
                    </p>
                    <p className="text-xs text-slate-500">
                      Date of service:{" "}
                      {c.dateOfService
                        ? new Date(c.dateOfService).toLocaleDateString()
                        : "—"}
                    </p>
                  </div>
                  <span className="font-semibold tabular-nums text-slate-900">
                    {formatMoneyCents(c.patientResponsibilityCents)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section
        className="rounded-2xl border bg-white p-6 shadow-sm"
        data-testid="billing-statements"
      >
        <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Past statements
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          PennPaps statements covering your claims with patient
          responsibility. Click to view the PDF.
        </p>

        {statements.isPending ? (
          <p className="mt-4 text-sm text-slate-500">Loading…</p>
        ) : statements.isError ? (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <p className="text-sm text-red-600">
              {statements.error instanceof Error ? statements.error.message : "Failed to load statements."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void statements.refetch()}
              disabled={statements.isFetching}
              data-testid="billing-statements-retry"
            >
              {statements.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : (statements.data?.statements.length ?? 0) === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No statements yet. We email one whenever there's a new
            patient-responsibility balance to settle.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {(statements.data?.statements ?? []).map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between py-3 text-sm gap-3"
              >
                <div>
                  <p className="font-medium text-slate-900 tabular-nums">
                    {formatMoneyCents(s.totalPatientResponsibilityCents)}
                  </p>
                  <p className="text-xs text-slate-500">
                    {new Date(s.createdAt).toLocaleDateString()} ·{" "}
                    {s.lineItemCount} claim
                    {s.lineItemCount === 1 ? "" : "s"}
                    {s.deliveryMethod ? ` · sent via ${s.deliveryMethod}` : ""}
                  </p>
                </div>
                <a
                  href={statementPdfUrl(s.id)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 underline hover:text-slate-900 shrink-0"
                  data-testid={`statement-pdf-link-${s.id}`}
                >
                  <Download className="h-3.5 w-3.5" />
                  View PDF
                </a>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section
        className="rounded-2xl border bg-white p-6 shadow-sm"
        data-testid="billing-payments"
      >
        <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
          <CreditCard className="h-4 w-4" />
          Payment history
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          Card payments you've made toward your PennPaps balance.
        </p>

        {payments.isPending ? (
          <p className="mt-4 text-sm text-slate-500">Loading…</p>
        ) : payments.isError ? (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <p className="text-sm text-red-600">
              {payments.error instanceof Error ? payments.error.message : "Failed to load payments."}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void payments.refetch()}
              disabled={payments.isFetching}
              data-testid="billing-payments-retry"
            >
              {payments.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        ) : (payments.data?.payments.length ?? 0) === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No payments on file yet.
          </p>
        ) : (
          <ul className="mt-4 divide-y">
            {(payments.data?.payments ?? []).map((p) => {
              const tone = paymentTone(p.status);
              const when = p.succeeded_at ?? p.created_at;
              return (
                <li
                  key={p.id}
                  className="flex items-center justify-between py-3 text-sm gap-3"
                >
                  <div>
                    <p className="font-medium text-slate-900 tabular-nums">
                      {formatMoneyCents(p.amount_cents)}
                    </p>
                    <p className="text-xs text-slate-500">
                      {new Date(when).toLocaleDateString()}
                      {p.note ? ` · ${p.note}` : ""}
                      {p.failure_reason ? ` · ${p.failure_reason}` : ""}
                    </p>
                  </div>
                  <span
                    className="inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider shrink-0"
                    style={{ color: tone.color, backgroundColor: tone.bg }}
                  >
                    {tone.label}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
