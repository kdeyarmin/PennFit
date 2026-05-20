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

import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeft,
  CreditCard,
  Download,
  FileText,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SignedIn } from "@/lib/identity";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
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

  const totalOpen = balance.data?.totalOpenCents ?? 0;
  const claimCount = balance.data?.claimCount ?? 0;

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
              {balance.isPending ? "—" : formatMoneyCents(totalOpen)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {balance.isPending
                ? "Loading…"
                : claimCount === 0
                  ? "No outstanding balance."
                  : `${claimCount} claim${claimCount === 1 ? "" : "s"} with patient responsibility after insurance.`}
            </p>
          </div>
          {totalOpen > 0 && (
            <div className="shrink-0">
              <a
                href="mailto:billing@pennpaps.com?subject=Pay%20my%20balance"
                className="inline-flex"
              >
                <Button>
                  <CreditCard className="mr-1.5 h-4 w-4" />
                  Pay by card
                </Button>
              </a>
              <p className="mt-1 text-[11px] text-slate-500 text-right">
                Email billing to pay now
              </p>
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
