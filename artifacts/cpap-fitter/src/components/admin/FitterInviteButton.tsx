// "Invite to AI Fitter" — a quick-action button + modal that sends a
// patient (or, from the worklist, a prospect) a signed link to run the
// on-device AI mask fitter. On completion the measurements + answers +
// recommendation come back to PennPaps (see ../../pages/fitter-invite
// + the /shop/fitter-invite/* endpoints) and auto-attach to a matching
// chart.
//
// Two modes:
//   * patient mode (patientId set) — the server resolves the patient's
//     email/phone; the CSR just picks a channel. Used on the patient
//     detail action bar.
//   * prospect mode (no patientId) — the CSR types an email/phone +
//     name. Used on the Fitter Invites worklist for new prospects.
//
// Either mode can pick the "in office" channel (migration 0489), which
// sends nothing: the patient is at the counter, so the link is shown as
// a QR code they scan with their own phone. That needs no email or phone
// at all — a walk-in prospect often has neither on file yet — and the
// token expires with the visit rather than in a month.

import { useEffect, useState } from "react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { QrCode } from "@/components/QrCode";
import {
  createFitterInvite,
  type CreateFitterInviteBody,
  type FitterInviteChannel,
} from "@/lib/admin/fitter-invites-api";

interface Props {
  /** Current-patient mode. Omit for a prospect invite. */
  patientId?: string;
  /** Hints to disable a channel up front (patient mode). */
  hasEmail?: boolean;
  hasPhone?: boolean;
  /** Called after a successful send so the parent can refresh. */
  onSent?: () => void;
  /** Render as the worklist's prospect form instead of the action-bar
   *  button (collects contact fields). */
  prospectMode?: boolean;
  buttonLabel?: string;
}

export function FitterInviteButton({
  patientId,
  hasEmail = true,
  hasPhone = true,
  onSent,
  prospectMode = false,
  buttonLabel = "Invite to AI Fitter",
}: Props) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button intent="secondary" onClick={() => setOpen(true)}>
        {buttonLabel}
      </Button>
      {open && (
        <FitterInviteModal
          patientId={patientId}
          hasEmail={hasEmail}
          hasPhone={hasPhone}
          prospectMode={prospectMode || !patientId}
          onClose={() => setOpen(false)}
          onSent={() => {
            onSent?.();
          }}
        />
      )}
    </>
  );
}

function FitterInviteModal({
  patientId,
  hasEmail,
  hasPhone,
  prospectMode,
  onClose,
  onSent,
}: {
  patientId?: string;
  hasEmail: boolean;
  hasPhone: boolean;
  prospectMode: boolean;
  onClose: () => void;
  onSent: () => void;
}) {
  const [channel, setChannel] = useState<FitterInviteChannel>(
    hasEmail ? "email" : "sms",
  );
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    delivered: boolean;
    inviteLink: string;
    channel: FitterInviteChannel;
    expiresAt: string;
  } | null>(null);
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

    const body: CreateFitterInviteBody = { channel };
    if (patientId) body.patientId = patientId;

    // In-office needs no contact details at all — the handover is the
    // delivery. Any name typed is still worth keeping so the fitting is
    // identifiable in the worklist.
    if (channel === "in_office") {
      if (name.trim()) body.name = name.trim();
      if (email.trim()) body.email = email.trim().toLowerCase();
    } else if (prospectMode) {
      if (channel === "email") {
        const trimmed = email.trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
          setError("Enter a valid email address.");
          return;
        }
        body.email = trimmed;
      } else {
        const e164 = normalizePhone(phone);
        if (!e164) {
          setError("Enter a valid US phone number.");
          return;
        }
        body.phoneE164 = e164;
      }
      if (name.trim()) body.name = name.trim();
    } else if (channel === "email" && email.trim()) {
      // Optional override when a patient has no email on file.
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
      const res = await createFitterInvite(body);
      setResult({
        delivered: res.delivered,
        inviteLink: res.inviteLink,
        channel,
        expiresAt: res.expiresAt,
      });
      onSent();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const channelMissingContact =
    !prospectMode &&
    ((channel === "email" && !hasEmail && !email.trim()) ||
      (channel === "sms" && !hasPhone && !phone.trim()));

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
          Invite to AI Fitter
        </h2>
        <p className="text-sm mb-4" style={{ color: "hsl(var(--ink-3))" }}>
          Sends a link to run the on-device mask fitter. The measurements,
          questionnaire answers, and recommendation come back to us for
          follow-up.
        </p>

        {result ? (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: "hsl(var(--ink-1))" }}>
              {result.channel === "in_office"
                ? "Ready — have the patient scan this with their phone camera."
                : result.delivered
                  ? "Invite sent."
                  : "Invite created, but automatic delivery isn't configured. Share the link below directly."}
            </p>

            {result.channel === "in_office" && (
              <div className="flex flex-col items-center gap-2">
                {/* Rendered locally by the `qrcode` package — the link is
                    never sent anywhere to become an image. */}
                <QrCode
                  value={result.inviteLink}
                  size={200}
                  ariaLabel="QR code linking to the mask fitter"
                />
                <p
                  className="text-xs text-center"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Expires {formatExpiry(result.expiresAt)}. After that, create a
                  new invite or send one by email or text.
                </p>
              </div>
            )}

            <div className="space-y-1">
              <Label htmlFor="invite-link">
                {result.channel === "in_office"
                  ? "Or open on a shared device"
                  : "Invite link"}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="invite-link"
                  readOnly
                  value={result.inviteLink}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <Button
                  type="button"
                  intent="secondary"
                  onClick={() => {
                    void navigator.clipboard
                      ?.writeText(result.inviteLink)
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
              <Label htmlFor="invite-channel">Send via</Label>
              <Select
                id="invite-channel"
                value={channel}
                onChange={(e) =>
                  setChannel(e.target.value as FitterInviteChannel)
                }
                options={[
                  { value: "email", label: "Email" },
                  { value: "sms", label: "Text message (SMS)" },
                  { value: "in_office", label: "In office (QR code)" },
                ]}
              />
            </div>

            {channel === "in_office" && (
              <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
                Nothing is sent. You&apos;ll get a QR code to show the patient
                so they can scan it with their own phone and start right here.
              </p>
            )}

            {channel !== "in_office" &&
              (prospectMode || channel === "email") && (
                <div className="space-y-1">
                  <Label htmlFor="invite-email">
                    Email{" "}
                    {!prospectMode && (
                      <span style={{ color: "hsl(var(--ink-3))" }}>
                        (optional — overrides chart)
                      </span>
                    )}
                  </Label>
                  <Input
                    id="invite-email"
                    type="email"
                    placeholder="patient@example.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              )}

            {channel !== "in_office" && (prospectMode || channel === "sms") && (
              <div className="space-y-1">
                <Label htmlFor="invite-phone">
                  Phone{" "}
                  {!prospectMode && (
                    <span style={{ color: "hsl(var(--ink-3))" }}>
                      (optional — overrides chart)
                    </span>
                  )}
                </Label>
                <Input
                  id="invite-phone"
                  type="tel"
                  placeholder="(555) 123-4567"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
            )}

            {(prospectMode || channel === "in_office") && (
              <div className="space-y-1">
                <Label htmlFor="invite-name">
                  Name{" "}
                  <span style={{ color: "hsl(var(--ink-3))" }}>(optional)</span>
                </Label>
                <Input
                  id="invite-name"
                  placeholder="Jordan Lee"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>
            )}

            {channel !== "in_office" && channelMissingContact && (
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
                {channel === "in_office" ? "Show QR code" : "Send invite"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

/**
 * Human expiry for the QR panel. Same-day windows are the normal case for
 * an in-office invite, so a bare time reads better than a full date; the
 * date is only added when the window actually crosses midnight.
 */
function formatExpiry(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "soon";
  const sameDay = at.toDateString() === new Date().toDateString();
  const time = at.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
  return sameDay
    ? `at ${time}`
    : `${at.toLocaleDateString(undefined, { month: "short", day: "numeric" })} at ${time}`;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    const data = err.data as { error?: string; message?: string } | undefined;
    return data?.message ?? data?.error ?? "Could not send the invite.";
  }
  return err instanceof Error ? err.message : "Could not send the invite.";
}
