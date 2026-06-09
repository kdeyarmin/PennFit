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
  ChevronDown,
  ChevronRight,
  CreditCard,
  Download,
  FileText,
  Plus,
  ShieldCheck,
  Trash2,
  Mail,
  Wallet,
  XCircle,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SignedIn } from "@/lib/identity";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  createAutopaySetupSession,
  createPaymentCheckoutSession,
  fetchBillingBalance,
  fetchClaimDetail,
  fetchClaims,
  fetchPatientPayments,
  fetchPatientStatements,
  fetchPaymentMethods,
  fetchStatementPreference,
  formatMoneyCents,
  removePaymentMethod,
  setAutopayEnabled,
  statementPdfUrl,
  updateStatementPreference,
  type PatientPayment,
  type StatementDeliveryMethod,
} from "@/lib/me-billing-api";
import { formatDateOnly } from "@/lib/utils";

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
  const [, setLocation] = useLocation();
  // wouter's useLocation() returns the pathname ONLY — the query string is
  // excluded — so the Stripe Hosted Checkout return params (?paid=1 /
  // ?cancelled=1, set by routes/storefront/me-payments.ts) must be read off
  // window.location.search. Capture once at mount (a useState initialiser,
  // matching reminders-manage) so a later in-app navigation can't flip the
  // banner state; dismissal is tracked separately (and also strips the
  // query — see dismissBanner).
  const [justPaidDismissed, setJustPaidDismissed] = useState(false);
  const [cancelledDismissed, setCancelledDismissed] = useState(false);
  const [{ justPaid, cancelled, cardAdded }] = useState(() => {
    const params = new URLSearchParams(
      typeof window === "undefined" ? "" : window.location.search,
    );
    return {
      justPaid: params.get("paid") === "1",
      cancelled: params.get("cancelled") === "1",
      // Set by the Stripe setup return URL (me-payment-methods.ts).
      cardAdded: params.get("card_added") === "1",
    };
  });

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
      setPayError(
        err instanceof Error ? err.message : "Couldn't start checkout.",
      );
    },
  });

  const totalOpen = balance.data?.totalOpenCents ?? 0;
  const claimCount = balance.data?.claimCount ?? 0;
  const showPayBanner = totalOpen > 0;
  // Dismiss the success/cancel banner: hide it for this view AND strip the
  // query string (so a refresh/bookmark won't re-show it), without a full
  // reload.
  function dismissJustPaid() {
    setJustPaidDismissed(true);
    setLocation("/account/billing", { replace: true });
  }

  function dismissCancelled() {
    setCancelledDismissed(true);
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
          Your open balance with PennPaps after insurance, plus past statements
          and payments. Choose below whether you&apos;d like your bills emailed
          or mailed; either way, this page is always current.
        </p>
      </header>

      {justPaid && !justPaidDismissed && (
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
              Thanks — your payment is processing. The balance below updates
              within a few seconds.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissJustPaid}
            className="text-xs underline text-emerald-700"
          >
            Dismiss
          </button>
        </div>
      )}

      {cancelled && !cancelledDismissed && (
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
              No charge was made. You can retry below whenever you're ready.
            </p>
          </div>
          <button
            type="button"
            onClick={dismissCancelled}
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

      <PaymentMethodsSection cardAdded={cardAdded} />
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
          PennPaps statements covering your claims with patient responsibility.
          Click to view the PDF.
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
        ) : (statements.data?.statements.length ?? 0) === 0 ? (
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
              {payments.error instanceof Error
                ? payments.error.message
                : "Failed to load payments."}
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

function titleCase(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

// ─── Payment method + autopay ──────────────────────────────────────────
function PaymentMethodsSection({ cardAdded }: { cardAdded: boolean }) {
  const qc = useQueryClient();
  const pm = useQuery({
    queryKey: ["me-payment-methods"],
    queryFn: fetchPaymentMethods,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const [enableOnAdd, setEnableOnAdd] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // The setup webhook lands async after the Stripe redirect — give it a
  // few seconds, then refetch so the saved card shows.
  useEffect(() => {
    if (!cardAdded) return;
    const t = setTimeout(() => {
      void qc.invalidateQueries({ queryKey: ["me-payment-methods"] });
    }, 3000);
    return () => clearTimeout(t);
  }, [cardAdded, qc]);

  const addCard = useMutation({
    mutationFn: async (): Promise<void> => {
      const { url } = await createAutopaySetupSession({
        enableAutopay: enableOnAdd,
      });
      // Hosted by Stripe — full-window redirect (same as the pay flow).
      window.location.href = url;
    },
    onMutate: () => setErr(null),
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Couldn't start card setup."),
  });

  const toggleAutopay = useMutation({
    mutationFn: (enabled: boolean) => setAutopayEnabled(enabled),
    onMutate: () => setErr(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me-payment-methods"] });
    },
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Couldn't update autopay."),
  });

  const removeCard = useMutation({
    mutationFn: () => removePaymentMethod(),
    onMutate: () => setErr(null),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me-payment-methods"] });
    },
    onError: (e) =>
      setErr(e instanceof Error ? e.message : "Couldn't remove the card."),
  });

  const status = pm.data;
  return (
    <section
      className="rounded-2xl border bg-white p-6 shadow-sm"
      data-testid="billing-payment-methods"
    >
      <h2 className="text-lg font-semibold text-slate-900 inline-flex items-center gap-2">
        <CreditCard className="h-4 w-4" />
        Payment method &amp; autopay
      </h2>
      <p className="text-sm text-slate-600 mt-1">
        Save a card on file to check out faster — and, if you choose, let
        PennPaps automatically pay new balances after insurance so you never
        miss one. Your card is stored by Stripe; it never touches our servers.
      </p>

      {cardAdded && (
        <div
          className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800"
          data-testid="card-added-note"
        >
          Card saved — it appears below within a few seconds.
        </div>
      )}

      {pm.isPending ? (
        <p className="mt-4 text-sm text-slate-500">Loading…</p>
      ) : pm.isError ? (
        <div className="mt-4 flex items-center gap-3 flex-wrap">
          <p className="text-sm text-red-600">
            {pm.error instanceof Error
              ? pm.error.message
              : "Failed to load payment method."}
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void pm.refetch()}
            disabled={pm.isFetching}
          >
            {pm.isFetching ? "Retrying…" : "Retry"}
          </Button>
        </div>
      ) : status?.hasCard ? (
        <div className="mt-4 space-y-4">
          <div className="flex items-center justify-between gap-3 rounded-xl border bg-slate-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-slate-500" />
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {status.card?.brand ? titleCase(status.card.brand) : "Card"}{" "}
                  •••• {status.card?.last4 ?? "????"}
                </p>
                <p className="text-xs text-slate-500">
                  {status.card?.expMonth && status.card?.expYear
                    ? `Expires ${String(status.card.expMonth).padStart(2, "0")}/${status.card.expYear}`
                    : "On file"}
                </p>
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => removeCard.mutate()}
              disabled={removeCard.isPending}
              data-testid="remove-card-button"
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {removeCard.isPending ? "Removing…" : "Remove"}
            </Button>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="h-5 w-5 text-slate-500 mt-0.5 shrink-0" />
              <div>
                <p className="text-sm font-medium text-slate-900">
                  Automatic payments
                </p>
                <p className="text-xs text-slate-500 max-w-sm">
                  When on, we charge this card for new patient-responsibility
                  balances after insurance. Turn it off any time.
                </p>
              </div>
            </div>
            <Switch
              checked={status.autopayEnabled}
              onCheckedChange={(v) => toggleAutopay.mutate(v)}
              disabled={toggleAutopay.isPending}
              aria-label="Toggle automatic payments"
              data-testid="autopay-toggle"
            />
          </div>
          <p className="text-xs text-slate-500" data-testid="autopay-status">
            {status.autopayEnabled
              ? "Autopay is ON — new balances are paid automatically."
              : "Autopay is OFF — you'll pay each balance yourself."}
          </p>
        </div>
      ) : (
        <div className="mt-4 space-y-3">
          <div className="rounded-xl border border-dashed px-4 py-6 text-center">
            <p className="text-sm text-slate-600">No card on file yet.</p>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={enableOnAdd}
              onChange={(e) => setEnableOnAdd(e.target.checked)}
              data-testid="enable-autopay-on-add"
            />
            Also turn on automatic payments for future balances
          </label>
          <Button
            onClick={() => addCard.mutate()}
            disabled={addCard.isPending}
            data-testid="add-card-button"
          >
            <Plus className="mr-1.5 h-4 w-4" />
            {addCard.isPending ? "Redirecting…" : "Add a card"}
          </Button>
          <p className="text-[11px] text-slate-500">
            Hosted by Stripe — your card never touches our servers.
          </p>
        </div>
      )}
      {err && (
        <p
          className="mt-3 text-xs text-red-600"
          data-testid="payment-method-error"
        >
          {err}
        </p>
      )}
    </section>
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
      ) : (claims.data?.claims.length ?? 0) === 0 ? (
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
                  {new Date(e.occurredAt).toLocaleDateString()} ·{" "}
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
