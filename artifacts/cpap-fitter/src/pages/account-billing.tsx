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

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  FileText,
  Mail,
  Wallet,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { SignedIn } from "@/lib/identity";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { useCompanyContact } from "@/lib/contact";
import { BrandName } from "@/components/company-contact";
import {
  fetchBillingBalance,
  fetchClaimDetail,
  fetchClaims,
  fetchPatientStatements,
  fetchStatementPreference,
  formatMoneyCents,
  statementPdfUrl,
  updateStatementPreference,
  type StatementDeliveryMethod,
} from "@/lib/me-billing-api";
import { formatAppDate, formatDateOnly } from "@/lib/utils";

export function AccountBillingPage() {
  const company = useCompanyContact();
  useDocumentTitle(
    `Billing — ${company.name}`,
    "Your open balances, statements, and claim history.",
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
          Your open balance with <BrandName /> after insurance, plus past
          statements and payments. Choose below whether you&apos;d like your
          bills emailed or mailed; either way, this page is always current.
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
              {balance.isPending || balance.isError
                ? "—"
                : formatMoneyCents(totalOpen)}
            </p>
            <p className="mt-1 text-sm text-slate-600">
              {balance.isPending
                ? "Loading…"
                : balance.isError
                  ? balance.error instanceof Error
                    ? balance.error.message
                    : "Failed to load balance."
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
        </div>

        {totalOpen > 0 && (balance.data?.claims?.length ?? 0) > 0 && (
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
                    <p className="font-medium text-slate-900">{c.payerName}</p>
                    <p className="text-xs text-slate-500">
                      Date of service:{" "}
                      {c.dateOfService ? formatDateOnly(c.dateOfService) : "—"}
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

      <StatementDeliverySection />
      <ClaimsSection />

      <section
        className="rounded-2xl border bg-white p-6 shadow-sm"
        data-testid="billing-statements"
      >
        <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
          <FileText className="h-4 w-4" />
          Past statements
        </h2>
        <p className="text-sm text-slate-600 mt-1">
          <BrandName /> statements covering your claims with patient
          responsibility. Click to view the PDF.
        </p>

        {statements.isPending ? (
          <p className="mt-4 text-sm text-slate-500">Loading…</p>
        ) : statements.isError ? (
          <div className="mt-4 flex items-center gap-3 flex-wrap">
            <p className="text-sm text-red-600">
              {statements.error instanceof Error
                ? statements.error.message
                : "Failed to load statements."}
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
        ) : (statements.data?.statements?.length ?? 0) === 0 ? (
          <p className="mt-4 text-sm text-slate-500">
            No statements yet. One is generated whenever there's a new
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
                    {formatAppDate(s.createdAt)} · {s.lineItemCount} claim
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
    </main>
  );
}

// ─── Claims, charges & credits ─────────────────────────────────────────
function ClaimsSection() {
  const claims = useQuery({
    queryKey: ["me-claims"],
    queryFn: fetchClaims,
    staleTime: 30_000,
  });
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <section
      className="rounded-2xl border bg-white p-6 shadow-sm"
      data-testid="billing-claims"
    >
      <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
        <FileText className="h-4 w-4" />
        Claims, charges &amp; credits
      </h2>
      <p className="text-sm text-slate-600 mt-1">
        Every claim we filed for your equipment — what was charged, what
        insurance and payments covered, and what's left. Open a claim for the
        line-item detail.
      </p>

      {claims.isPending ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : claims.isError ? (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <p className="text-sm text-red-600">
            {claims.error instanceof Error
              ? claims.error.message
              : "Failed to load claims."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void claims.refetch()}
            disabled={claims.isFetching}
          >
            {claims.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : (claims.data?.claims?.length ?? 0) === 0 ? (
        <p className="mt-4 text-sm text-slate-500">No claims on file yet.</p>
      ) : (
        <ul className="mt-4 divide-y">
          {(claims.data?.claims ?? []).map((c) => {
            const open = expandedId === c.id;
            return (
              <li key={c.id} className="py-3">
                <button
                  type="button"
                  onClick={() => setExpandedId(open ? null : c.id)}
                  className="w-full flex items-center justify-between gap-3 text-left"
                  aria-expanded={open}
                  data-testid={`claim-row-${c.id}`}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    {open ? (
                      <ChevronDown className="h-4 w-4 text-slate-400 shrink-0" />
                    ) : (
                      <ChevronRight className="h-4 w-4 text-slate-400 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">
                        {c.payerName ?? "Claim"}
                      </p>
                      <p className="text-xs text-slate-500">
                        {c.dateOfService
                          ? formatDateOnly(c.dateOfService)
                          : "—"}{" "}
                        · <span className="capitalize">{c.status}</span>
                      </p>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold tabular-nums text-slate-900">
                      {formatMoneyCents(c.patientResponsibilityCents)}
                    </p>
                    <p className="text-[11px] text-slate-500">your balance</p>
                  </div>
                </button>
                {open && <ClaimDetailView claimId={c.id} />}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Lets the patient choose emailed vs mailed bills. Tolerant: hides on
// load error, and explains when the account isn't yet linked to a
// billing record (the preference has nowhere to apply until then).
function StatementDeliverySection() {
  const qc = useQueryClient();
  const pref = useQuery({
    queryKey: ["me-statement-preference"],
    queryFn: fetchStatementPreference,
    staleTime: 30_000,
  });
  const update = useMutation({
    mutationFn: (method: StatementDeliveryMethod) =>
      updateStatementPreference(method),
    onSuccess: (data) => qc.setQueryData(["me-statement-preference"], data),
  });

  if (pref.isPending || pref.isError || !pref.data) return null;
  const { statementDeliveryMethod, email, linked } = pref.data;
  const current = update.isPending
    ? (update.variables as StatementDeliveryMethod)
    : statementDeliveryMethod;

  const options: Array<{
    value: StatementDeliveryMethod;
    label: string;
    hint: string;
  }> = [
    {
      value: "email",
      label: "Email",
      hint: email ? `Sent to ${email}` : "Sent to your account email",
    },
    { value: "mail", label: "Mail", hint: "Paper statement by post" },
  ];

  return (
    <section
      className="rounded-2xl border bg-white p-6 shadow-sm"
      data-testid="billing-delivery-preference"
    >
      <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
        <Mail className="h-4 w-4" />
        How you get your bills
      </h2>
      <p className="text-sm text-slate-600 mt-1">
        Choose how you&apos;d like to receive new statements and bills. You can
        always view and download every statement here regardless.
      </p>

      {linked === false && (
        <p className="mt-3 text-xs text-amber-700">
          We&apos;ll apply this once your billing record is set up.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
        {options.map((opt) => {
          const active = current === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={update.isPending || linked === false}
              onClick={() => {
                if (opt.value !== statementDeliveryMethod) {
                  update.mutate(opt.value);
                }
              }}
              data-testid={`billing-delivery-${opt.value}`}
              className={`text-left rounded-xl border p-4 transition-colors disabled:opacity-60 ${
                active
                  ? "border-[hsl(var(--penn-navy))] bg-[hsl(var(--penn-navy))]/5"
                  : "border-slate-200 hover:border-slate-300"
              }`}
            >
              <span className="flex items-center gap-2">
                <span
                  className={`inline-flex h-4 w-4 items-center justify-center rounded-full border ${
                    active
                      ? "border-[hsl(var(--penn-navy))]"
                      : "border-slate-400"
                  }`}
                >
                  {active && (
                    <span className="h-2 w-2 rounded-full bg-[hsl(var(--penn-navy))]" />
                  )}
                </span>
                <span className="font-semibold text-slate-900">
                  {opt.label}
                </span>
              </span>
              <span className="block mt-1 text-xs text-slate-500 pl-6">
                {opt.hint}
              </span>
            </button>
          );
        })}
      </div>

      {update.isError && (
        <p className="mt-2 text-xs text-red-600" role="alert">
          Couldn&apos;t save your preference. Please try again.
        </p>
      )}
    </section>
  );
}

function ClaimDetailView({ claimId }: { claimId: string }) {
  const detail = useQuery({
    queryKey: ["me-claim", claimId],
    queryFn: () => fetchClaimDetail(claimId),
    staleTime: 30_000,
  });
  if (detail.isPending) {
    return <p className="mt-3 ml-6 text-xs text-slate-500">Loading detail…</p>;
  }
  if (detail.isError) {
    return (
      <p className="mt-3 ml-6 text-xs text-red-600">
        {detail.error instanceof Error
          ? detail.error.message
          : "Failed to load claim detail."}
      </p>
    );
  }
  const d = detail.data;
  if (!d) return null;
  return (
    <div
      className="mt-3 ml-6 space-y-4"
      data-testid={`claim-detail-${claimId}`}
    >
      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
          Charges
        </p>
        {d.lineItems.length === 0 ? (
          <p className="text-xs text-slate-500">No line items recorded.</p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {d.lineItems.map((l, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 px-3 py-2 text-xs"
              >
                <div className="min-w-0">
                  <p className="font-medium text-slate-800 truncate">
                    {l.description ?? l.hcpcsCode ?? "Item"}
                  </p>
                  <p className="text-slate-500">
                    {l.hcpcsCode}
                    {l.modifier ? `-${l.modifier}` : ""} · qty {l.quantity}
                  </p>
                </div>
                <span className="font-semibold tabular-nums text-slate-900">
                  {formatMoneyCents(l.billedCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1">
          Insurance &amp; payments (credits)
        </p>
        {d.events.length === 0 ? (
          <p className="text-xs text-slate-500">No activity yet.</p>
        ) : (
          <ul className="space-y-1">
            {d.events.map((e, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <span className="text-slate-600">
                  {formatAppDate(e.occurredAt)} ·{" "}
                  <span className="capitalize">
                    {e.eventType.replace(/_/g, " ")}
                  </span>
                  {e.note ? ` — ${e.note}` : ""}
                </span>
                {e.amountCents != null && (
                  <span className="tabular-nums text-slate-700">
                    {formatMoneyCents(e.amountCents)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex items-center justify-between border-t pt-2 text-xs gap-3">
        <span className="text-slate-500">
          Billed {formatMoneyCents(d.claim.totalBilledCents)} · Paid{" "}
          {formatMoneyCents(d.claim.totalPaidCents)}
        </span>
        <span className="font-semibold text-slate-900">
          Your balance {formatMoneyCents(d.claim.patientResponsibilityCents)}
        </span>
      </div>
    </div>
  );
}
