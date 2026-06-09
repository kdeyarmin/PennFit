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

import { useEffect, useState } from "react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
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

    if (prospectMode) {
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
      setResult({ delivered: res.delivered, inviteLink: res.inviteLink });
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
              {result.delivered
                ? "Invite sent."
                : "Invite created, but automatic delivery isn't configured. Share the link below directly."}
            </p>
            <div className="space-y-1">
              <Label htmlFor="invite-link">Invite link</Label>
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
                ]}
              />
            </div>

            {(prospectMode || channel === "email") && (
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

            {(prospectMode || channel === "sms") && (
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

            {prospectMode && (
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
                Send invite
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
    return data?.message ?? data?.error ?? "Could not send the invite.";
  }
  return err instanceof Error ? err.message : "Could not send the invite.";
}
