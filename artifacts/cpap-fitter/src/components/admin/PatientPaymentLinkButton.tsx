// "Send payment link" — a quick-action button + modal that emails or
// texts a patient a hosted Stripe Checkout link to collect a payment
// (a copay, a cash-pay balance, or any amount not tracked as an
// insurance claim). The patient opens the link and pays by card; the
// existing Stripe webhook records it. Nothing is auto-charged.
//
// Mirrors FitterInviteButton: the server resolves the patient's
// email/phone from the chart (the CSR can override), and the response
// always includes the link so staff can copy/share it directly — useful
// when automatic delivery isn't configured in the current environment.

import { useEffect, useState } from "react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import {
  sendPatientPaymentLink,
  type PaymentLinkChannel,
  type SendPaymentLinkResponse,
} from "@/lib/admin/payment-links-api";

interface Props {
  patientId: string;
  /** Hints to disable / default a channel up front. */
  hasEmail?: boolean;
  hasPhone?: boolean;
  /** Called after a successful send so the parent can refresh. */
  onSent?: () => void;
}

export function PatientPaymentLinkButton({
  patientId,
  hasEmail = true,
  hasPhone = true,
  onSent,
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button intent="secondary" onClick={() => setOpen(true)}>
        Send payment link
      </Button>
      {open && (
        <PaymentLinkModal
          patientId={patientId}
          hasEmail={hasEmail}
          hasPhone={hasPhone}
          onClose={() => setOpen(false)}
          onSent={() => onSent?.()}
        />
      )}
    </>
  );
}

/** Parse a dollar string ("49.99", "$10", "1,200") into whole cents.
 *  Returns null when it isn't a valid positive amount. */
function dollarsToCents(raw: string): number | null {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const cents = Math.round(parseFloat(cleaned) * 100);
  return Number.isFinite(cents) && cents > 0 ? cents : null;
}

function PaymentLinkModal({
  patientId,
  hasEmail,
  hasPhone,
  onClose,
  onSent,
}: {
  patientId: string;
  hasEmail: boolean;
  hasPhone: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [channel, setChannel] = useState<PaymentLinkChannel>(
    hasEmail ? "email" : "sms",
  );
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SendPaymentLinkResponse | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !pending) onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pending]);

  function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/[^\d]/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    return null;
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const amountCents = dollarsToCents(amount);
    if (amountCents === null) {
      setError("Enter a valid amount, e.g. 49.99.");
      return;
    }
    if (amountCents < 50) {
      setError("Amount must be at least $0.50.");
      return;
    }

    const body: Parameters<typeof sendPatientPaymentLink>[1] = {
      channel,
      amountCents,
    };
    if (memo.trim()) body.memo = memo.trim();

    // Optional contact override when the chart has none on file.
    if (channel === "email" && email.trim()) {
      body.email = email.trim().toLowerCase();
    } else if (channel === "sms" && phone.trim()) {
      const e164 = normalizePhone(phone);
      if (!e164) {
        setError("Enter a valid US phone number.");
        return;
      }
      body.phoneE164 = e164;
    }

    setPending(true);
    try {
      const res = await sendPatientPaymentLink(patientId, body);
      setResult(res);
      onSent();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const channelMissingContact =
    (channel === "email" && !hasEmail && !email.trim()) ||
    (channel === "sms" && !hasPhone && !phone.trim());

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: "rgba(0,0,0,0.4)" }}
      onClick={() => {
        if (!pending) onClose();
      }}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h2
          className="text-lg font-semibold mb-1"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Send payment link
        </h2>
        <p className="text-sm mb-4" style={{ color: "hsl(var(--ink-3))" }}>
          Emails or texts the patient a secure Stripe link to pay by card.
          Nothing is charged until they complete the payment.
        </p>

        {result ? (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
              {result.delivered
                ? `Payment link sent by ${result.channel === "email" ? "email" : "text message"}.`
                : "Payment link created, but automatic delivery isn't configured. Share the link below directly."}
            </p>
            <div className="space-y-1">
              <Label htmlFor="payment-link">Payment link</Label>
              <div className="flex gap-2">
                <Input
                  id="payment-link"
                  readOnly
                  value={result.paymentUrl}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  intent="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(result.paymentUrl)
                      .then(() => {
                        setCopied(true);
                        window.setTimeout(() => setCopied(false), 1500);
                      });
                  }}
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="payment-amount">Amount (USD)</Label>
              <Input
                id="payment-amount"
                inputMode="decimal"
                placeholder="49.99"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="payment-channel">Send via</Label>
              <Select
                id="payment-channel"
                value={channel}
                onChange={(e) =>
                  setChannel(e.target.value as PaymentLinkChannel)
                }
                options={[
                  { value: "email", label: "Email" },
                  { value: "sms", label: "Text message (SMS)" },
                ]}
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="payment-memo">
                Memo{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>(optional)</span>
              </Label>
              <Input
                id="payment-memo"
                placeholder="What is this payment for?"
                maxLength={200}
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
              />
            </div>

            {channel === "email" && (
              <div className="space-y-1">
                <Label htmlFor="payment-email">
                  Email{" "}
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    (optional — overrides chart)
                  </span>
                </Label>
                <Input
                  id="payment-email"
                  type="email"
                  placeholder="patient@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
            )}

            {channel === "sms" && (
              <div className="space-y-1">
                <Label htmlFor="payment-phone">
                  Phone{" "}
                  <span style={{ color: "hsl(var(--ink-3))" }}>
                    (optional — overrides chart)
                  </span>
                </Label>
                <Input
                  id="payment-phone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            )}

            {channelMissingContact && (
              <p className="text-xs" style={{ color: "#991b1b" }}>
                No {channel === "email" ? "email" : "phone"} on file — enter one
                above or pick the other channel.
              </p>
            )}
            {error && (
              <p className="text-sm" style={{ color: "#991b1b" }} role="alert">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button
                type="button"
                intent="secondary"
                onClick={onClose}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" isLoading={pending} disabled={pending}>
                Send payment link
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Could not send the payment link.";
  }
  return err instanceof Error
    ? err.message
    : "Could not send the payment link.";
}
