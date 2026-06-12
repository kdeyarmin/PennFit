// Public "review, sign & pay" page for CSR-created orders.
//
// The customer arrives via a signed HMAC link (/order-pay?token=...)
// sent by a CSR from the admin Orders page. Three steps on one page:
//   1. Review the order (line items + total + note from the team).
//   2. Read + acknowledge each paperwork document, then e-sign
//      (typed or drawn — same UX as the patient-packet signing page).
//   3. Pay through Stripe Hosted Checkout (server-gated on the
//      signature; the button only appears after signing).
//
// Stripe redirects back here with &checkout=success — the page then
// polls the view endpoint until the webhook flips the mirrored
// shop_orders row to paid.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  FileSignature,
  Lock,
  Receipt,
  ScrollText,
  ShieldOff,
} from "lucide-react";

import {
  useViewCsrOrder,
  useSignCsrOrder,
  useCsrOrderCheckout,
  type PublicCsrOrderDocument,
  type PacketDocumentSection,
  ApiError,
} from "@workspace/api-client-react/storefront";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  SignaturePad,
  type SignaturePadHandle,
} from "@/components/signature-pad";
import {
  SIGNATURE_STYLES,
  renderTypedSignatureDataUrl,
} from "@/lib/typed-signature";
import { cn } from "@/lib/utils";
import { useDocumentTitle } from "@/hooks/use-document-title";

const PAGE_TITLE = "Review & pay for your order";

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function PageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative z-10 container max-w-3xl mx-auto px-4 py-10 sm:py-14">
      {children}
    </div>
  );
}

function SectionView({ section }: { section: PacketDocumentSection }) {
  return (
    <div className="space-y-2">
      {section.heading && (
        <h4 className="text-sm font-semibold text-slate-900">
          {section.heading}
        </h4>
      )}
      {(section.paragraphs ?? []).map((p, i) => (
        <p key={i} className="text-sm leading-relaxed text-slate-600">
          {p}
        </p>
      ))}
      {section.bullets && section.bullets.length > 0 && (
        <ul className="ml-1 space-y-1.5">
          {section.bullets.map((b, i) => (
            <li
              key={i}
              className="flex gap-2 text-sm leading-relaxed text-slate-600"
            >
              <span className="mt-2 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
              <span>{b}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DocumentCard({
  doc,
  index,
  total,
  acknowledged,
  onAcknowledge,
}: {
  doc: PublicCsrOrderDocument;
  index: number;
  total: number;
  acknowledged: boolean;
  onAcknowledge: (checked: boolean) => void;
}) {
  return (
    <Card
      className={
        "border transition-colors " +
        (acknowledged
          ? "border-emerald-300 bg-emerald-50/30"
          : "border-slate-200")
      }
    >
      <CardHeader className="space-y-2">
        <Badge variant="secondary" className="text-xs font-medium">
          Document {index + 1} of {total}
        </Badge>
        <CardTitle className="flex items-start gap-2 text-lg text-slate-900">
          <ScrollText className="mt-0.5 h-5 w-5 flex-shrink-0 text-slate-400" />
          {doc.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="max-h-72 space-y-4 overflow-y-auto rounded-lg border border-slate-100 bg-white p-4">
          {doc.sections.map((section, i) => (
            <SectionView key={i} section={section} />
          ))}
        </div>
        <label className="flex cursor-pointer items-start gap-3 rounded-lg bg-slate-50 p-3">
          <Checkbox
            checked={acknowledged}
            onCheckedChange={(c) => onAcknowledge(c === true)}
            className="mt-0.5"
            aria-label={`Acknowledge ${doc.title}`}
          />
          <span className="text-sm text-slate-700">
            I have read and{" "}
            {doc.requiresSignature ? "agree to" : "acknowledge receipt of"}{" "}
            <span className="font-medium text-slate-900">{doc.title}</span>.
          </span>
        </label>
      </CardContent>
    </Card>
  );
}

export function OrderPay() {
  useDocumentTitle(PAGE_TITLE);

  // Read the token + checkout-return flag once. The token stays
  // available in state for the sign/checkout calls; we strip it from
  // the URL so the personalized link doesn't linger in history.
  const [token] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("token") ?? "";
  });
  const [returnedFromCheckout] = useState(() => {
    if (typeof window === "undefined") return false;
    return (
      new URLSearchParams(window.location.search).get("checkout") === "success"
    );
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const params = new URLSearchParams(window.location.search);
      if (!params.has("token") && !params.has("checkout")) return;
      params.delete("token");
      params.delete("checkout");
      const qs = params.toString();
      const next =
        window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash;
      window.history.replaceState(null, "", next);
    } catch {
      // History API unavailable: no-op.
    }
  }, []);

  const { data, isLoading, error, refetch } = useViewCsrOrder(token, {
    query: {
      // After the Stripe redirect, poll until the webhook lands.
      refetchInterval: (query) => {
        if (!returnedFromCheckout) return false;
        const status = query.state.data?.payment.status;
        return status === "paid" || status === "refunded" ? false : 3000;
      },
    },
  });
  const sign = useSignCsrOrder();
  const checkout = useCsrOrderCheckout();

  const [acked, setAcked] = useState<Record<string, boolean>>({});
  const [signerName, setSignerName] = useState("");
  const [consent, setConsent] = useState(false);
  const [sigMode, setSigMode] = useState<"type" | "draw">("type");
  const [styleIndex, setStyleIndex] = useState(0);
  const [drawnEmpty, setDrawnEmpty] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [justSigned, setJustSigned] = useState(false);
  const sigRef = useRef<SignaturePadHandle | null>(null);

  const documents = data?.documents ?? [];
  const ackedCount = documents.filter((d) => acked[d.key]).length;
  const allAcked = ackedCount === documents.length;
  const signed = Boolean(data?.signed) || justSigned;
  const paid = data?.payment.status === "paid";

  const canSign =
    !signed &&
    allAcked &&
    signerName.trim().length >= 2 &&
    consent &&
    (sigMode !== "draw" || !drawnEmpty);

  // Pre-fill the signer's name from the order recipient.
  const prefilledName = useRef(false);
  useEffect(() => {
    if (!prefilledName.current && data?.customerName && !signerName) {
      setSignerName(data.customerName);
      prefilledName.current = true;
    }
  }, [data?.customerName, signerName]);

  const total = useMemo(
    () => formatUsd(data?.amountTotalCents ?? 0),
    [data?.amountTotalCents],
  );

  // ── Missing token ──
  if (!token) {
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-slate-100">
              <ShieldOff className="h-6 w-6 text-slate-500" />
            </div>
            <CardTitle>Order link missing</CardTitle>
            <CardDescription>
              Please open the secure link we sent you to review and pay for your
              order.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild variant="outline">
              <Link href="/">Return home</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  // ── Loading ──
  if (isLoading) {
    return (
      <PageShell>
        <div className="space-y-4">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      </PageShell>
    );
  }

  // ── Error / expired / canceled ──
  if (error) {
    const code =
      error instanceof ApiError
        ? ((error.data as { error?: string } | null)?.error ?? "error")
        : "error";
    const messages: Record<string, { title: string; body: string }> = {
      expired: {
        title: "This link has expired",
        body: "For your security, order links expire after a period of time. Contact us and we'll send you a fresh link.",
      },
      canceled: {
        title: "This order was withdrawn",
        body: "This order is no longer active. Please contact us if you believe this is a mistake.",
      },
      invalid: {
        title: "This link is no longer valid",
        body: "A newer link may have been sent to you. Please use the most recent message, or contact us for help.",
      },
      not_found: {
        title: "We couldn't find this order",
        body: "Please use the secure link from your most recent message, or contact us for help.",
      },
      error: {
        title: "Something went wrong",
        body: "We couldn't load your order right now. Please try again in a few minutes.",
      },
    };
    const m = messages[code] ?? messages.error;
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-100">
              <AlertTriangle className="h-6 w-6 text-amber-600" />
            </div>
            <CardTitle>{m.title}</CardTitle>
            <CardDescription>{m.body}</CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    );
  }

  const company = data?.company;

  // ── Paid — terminal confirmation ──
  if (paid) {
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-100">
              <CheckCircle2 className="h-8 w-8 text-emerald-600" />
            </div>
            <CardTitle className="text-2xl">
              Payment received — you're all set
            </CardTitle>
            <CardDescription className="text-base">
              Thanks! Your payment of {total} for order {data?.orderReference}{" "}
              is confirmed
              {documents.length > 0 ? " and your paperwork is signed" : ""}.
              We'll take it from here.
            </CardDescription>
          </CardHeader>
          <CardContent className="text-center">
            <Button asChild>
              <Link href="/">Return home</Link>
            </Button>
          </CardContent>
        </Card>
      </PageShell>
    );
  }

  // ── Returned from Stripe, webhook not landed yet ──
  if (returnedFromCheckout) {
    return (
      <PageShell>
        <Card className="border-0 shadow-sm">
          <CardHeader className="space-y-3 text-center">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-sky-100">
              <CreditCard className="h-8 w-8 text-sky-600" />
            </div>
            <CardTitle className="text-2xl">Confirming your payment…</CardTitle>
            <CardDescription className="text-base">
              Thanks! We're confirming your payment with our payment provider.
              This usually takes just a few seconds.
            </CardDescription>
          </CardHeader>
        </Card>
      </PageShell>
    );
  }

  const handleSign = async () => {
    setSubmitError(null);
    if (!canSign) return;
    const signatureImage =
      sigMode === "draw"
        ? (sigRef.current?.toDataURL() ?? null)
        : renderTypedSignatureDataUrl(
            signerName.trim(),
            SIGNATURE_STYLES[styleIndex].fontStack,
          );
    try {
      await sign.mutateAsync({
        token,
        signerName: signerName.trim(),
        signatureImage,
        consentEsign: true,
        acknowledgedDocumentKeys: documents
          .filter((d) => acked[d.key])
          .map((d) => d.key),
      });
      setJustSigned(true);
      void refetch();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      setSubmitError(friendlyError(err, "sign"));
    }
  };

  const handlePay = async () => {
    setSubmitError(null);
    try {
      const res = await checkout.mutateAsync({ token });
      window.location.assign(res.url);
    } catch (err) {
      setSubmitError(friendlyError(err, "pay"));
    }
  };

  return (
    <PageShell>
      {/* Header */}
      <div className="mb-6 space-y-3">
        {company && (
          <p className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {company.legalName}
          </p>
        )}
        <h1 className="flex items-center gap-3 text-3xl font-bold tracking-tight text-slate-900">
          <Receipt className="h-7 w-7 text-slate-700" />
          Your order {data?.orderReference}
        </h1>
        <p className="text-slate-600">
          {data?.customerName ? `Hi ${data.customerName.split(" ")[0]}, ` : ""}
          {documents.length > 0
            ? "please review your order, sign the paperwork below, then complete your payment."
            : "please review your order, add your signature, then complete your payment."}
        </p>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Lock className="h-3.5 w-3.5" />
          Secure &amp; encrypted — payment is handled by Stripe; your signature
          is legally binding under the federal ESIGN Act.
        </div>
      </div>

      {/* Order summary */}
      <Card className="mb-6 border-slate-200">
        <CardHeader>
          <CardTitle className="text-xl">Order summary</CardTitle>
          {data?.note && (
            <CardDescription className="whitespace-pre-wrap">
              {data.note}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <tbody>
              {(data?.items ?? []).map((it, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-2.5 pr-3 text-slate-700">
                    {it.description}
                    {it.quantity > 1 && (
                      <span className="text-slate-400"> × {it.quantity}</span>
                    )}
                  </td>
                  <td className="py-2.5 text-right font-medium text-slate-900 whitespace-nowrap">
                    {formatUsd(it.unitAmountCents * it.quantity)}
                  </td>
                </tr>
              ))}
              <tr>
                <td className="pt-3 font-semibold text-slate-900">Total due</td>
                <td className="pt-3 text-right text-lg font-bold text-slate-900 whitespace-nowrap">
                  {total}
                </td>
              </tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      {signed ? (
        /* ── Signed — payment step ── */
        <Card className="border-emerald-200">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-xl">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              {documents.length > 0 ? "Paperwork signed" : "Order confirmed"}
            </CardTitle>
            <CardDescription>
              {documents.length > 0
                ? "Thank you — your documents are signed. "
                : ""}
              One last step: complete your payment of {total} on our secure
              Stripe checkout page.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {submitError && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertTitle>Couldn't start payment</AlertTitle>
                <AlertDescription>{submitError}</AlertDescription>
              </Alert>
            )}
            <Button
              size="lg"
              className="w-full"
              disabled={checkout.isPending}
              onClick={handlePay}
            >
              <CreditCard className="mr-2 h-5 w-5" />
              {checkout.isPending ? "Opening secure checkout…" : `Pay ${total}`}
            </Button>
            <p className="text-center text-xs text-slate-400">
              You'll be redirected to Stripe to enter your payment details — we
              never see your card number.
            </p>
          </CardContent>
        </Card>
      ) : (
        /* ── Documents + signature step ── */
        <>
          {documents.length > 0 && (
            <div className="mb-6 space-y-5">
              {documents.map((doc, i) => (
                <DocumentCard
                  key={doc.key}
                  doc={doc}
                  index={i}
                  total={documents.length}
                  acknowledged={Boolean(acked[doc.key])}
                  onAcknowledge={(checked) =>
                    setAcked((prev) => ({ ...prev, [doc.key]: checked }))
                  }
                />
              ))}
            </div>
          )}

          <Card className="border-slate-200">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-xl">
                <FileSignature className="h-5 w-5 text-slate-700" />
                Your signature
              </CardTitle>
              <CardDescription>
                By signing, you{" "}
                {documents.length > 0
                  ? "adopt this as your legal electronic signature on the documents above and "
                  : ""}
                authorize this order for the total shown.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-1.5">
                <Label htmlFor="signerName">Full legal name</Label>
                <Input
                  id="signerName"
                  value={signerName}
                  onChange={(e) => setSignerName(e.target.value)}
                  placeholder="e.g. Jordan A. Smith"
                  autoComplete="name"
                />
              </div>

              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>Signature</Label>
                  <div className="inline-flex rounded-lg border border-slate-200 bg-slate-100 p-0.5 text-sm">
                    <button
                      type="button"
                      onClick={() => setSigMode("type")}
                      className={cn(
                        "rounded-md px-3 py-1 font-medium transition-colors",
                        sigMode === "type"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500",
                      )}
                    >
                      Type
                    </button>
                    <button
                      type="button"
                      onClick={() => setSigMode("draw")}
                      className={cn(
                        "rounded-md px-3 py-1 font-medium transition-colors",
                        sigMode === "draw"
                          ? "bg-white text-slate-900 shadow-sm"
                          : "text-slate-500",
                      )}
                    >
                      Draw
                    </button>
                  </div>
                </div>

                {sigMode === "type" ? (
                  <div className="space-y-3">
                    <div className="flex h-32 items-center justify-center overflow-hidden rounded-xl border-2 border-slate-200 bg-white px-4">
                      {signerName.trim() ? (
                        <span
                          className="truncate text-slate-900"
                          style={{
                            fontFamily: SIGNATURE_STYLES[styleIndex].fontStack,
                            fontStyle: "italic",
                            fontSize: "44px",
                            lineHeight: 1.1,
                          }}
                        >
                          {signerName.trim()}
                        </span>
                      ) : (
                        <span className="text-sm text-slate-400">
                          Type your full legal name above to create your
                          signature
                        </span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {SIGNATURE_STYLES.map((s, i) => (
                        <button
                          key={s.label}
                          type="button"
                          onClick={() => setStyleIndex(i)}
                          className={cn(
                            "rounded-lg border px-3 py-1.5 text-sm transition-colors",
                            i === styleIndex
                              ? "border-slate-900 bg-slate-900 text-white"
                              : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
                          )}
                        >
                          <span
                            style={{
                              fontFamily: s.fontStack,
                              fontStyle: "italic",
                            }}
                          >
                            {s.label}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    <SignaturePad
                      ref={sigRef}
                      onChange={setDrawnEmpty}
                      ariaLabel="Draw your signature"
                    />
                    {drawnEmpty && (
                      <p className="text-xs text-slate-400">
                        Draw your signature above, or switch to “Type” for the
                        easiest option.
                      </p>
                    )}
                  </div>
                )}
              </div>

              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <Checkbox
                  checked={consent}
                  onCheckedChange={(c) => setConsent(c === true)}
                  className="mt-0.5"
                  aria-label="Consent to sign electronically"
                />
                <span className="text-sm text-slate-700">
                  I agree to use an electronic signature and to conduct this
                  transaction electronically. I understand my electronic
                  signature is legally binding and has the same effect as a
                  handwritten signature.
                </span>
              </label>

              {!allAcked && documents.length > 0 && (
                <Alert>
                  <ScrollText className="h-4 w-4" />
                  <AlertTitle>Review remaining documents</AlertTitle>
                  <AlertDescription>
                    Please confirm you've read all {documents.length} document
                    {documents.length === 1 ? "" : "s"} above before signing.
                  </AlertDescription>
                </Alert>
              )}

              {submitError && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertTitle>Couldn't submit</AlertTitle>
                  <AlertDescription>{submitError}</AlertDescription>
                </Alert>
              )}

              <Button
                size="lg"
                className="w-full"
                disabled={!canSign || sign.isPending}
                onClick={handleSign}
              >
                {sign.isPending ? "Submitting…" : "Sign & continue to payment"}
              </Button>
              <p className="text-center text-xs text-slate-400">
                {company?.phone
                  ? `Questions? Call us at ${company.phone}.`
                  : "Questions? Contact our team."}
              </p>
            </CardContent>
          </Card>
        </>
      )}
    </PageShell>
  );
}

function friendlyError(err: unknown, step: "sign" | "pay"): string {
  const raw =
    err instanceof ApiError
      ? ((err.data as { error?: string; message?: string } | null)?.message ??
        (err.data as { error?: string } | null)?.error ??
        err.message)
      : err instanceof Error
        ? err.message
        : "";
  if (/documents_not_acknowledged/.test(raw))
    return "Please confirm you've read every document before signing.";
  if (/already_signed/.test(raw))
    return "This order has already been signed — you can continue to payment.";
  if (/signature_required/.test(raw))
    return "Please sign the paperwork above before paying.";
  if (/already_paid/.test(raw)) return "This order has already been paid.";
  if (/shop_unavailable|stripe/.test(raw))
    return "Our payment provider is temporarily unavailable. Please try again in a few minutes.";
  if (/expired|canceled|invalid|not_found/.test(raw))
    return "This order link is no longer valid. Please contact us for a new one.";
  return (
    raw ||
    (step === "sign"
      ? "We couldn't submit your signature. Please try again."
      : "We couldn't start your payment. Please try again.")
  );
}

export default OrderPay;
