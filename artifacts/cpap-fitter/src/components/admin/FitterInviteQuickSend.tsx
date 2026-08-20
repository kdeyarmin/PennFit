// "Send a mask-fitting link" — the one-line invite sender that lives on
// the admin Home page.
//
// The full-featured sender is <FitterInviteButton/> (modal, patient
// mode, channel picker); this is the same POST /admin/fitter-invites
// endpoint reduced to the fastest possible path for the thing staff do
// most: get a fitting link to somebody who is on the phone right now.
// Type their mobile number or email into one box and press send — the
// channel is inferred from what was typed (see parseInviteContact), so
// there is no channel decision to make first and no page to navigate to.
//
// The in-office QR handover is one click away as a secondary action; it
// needs no contact details at all (migration 0489), because the patient
// is standing at the counter.

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { ScanFace } from "lucide-react";

import { ApiError } from "@workspace/api-client-react/admin";

import { Button } from "@/components/admin/Button";
import { Input, Label } from "@/components/admin/Input";
import { QrCode } from "@/components/QrCode";
import {
  createFitterInvite,
  type CreateFitterInviteBody,
  type FitterInviteChannel,
} from "@/lib/admin/fitter-invites-api";
import { parseInviteContact } from "@/lib/admin/invite-contact";

/** Matches the worklist page's key so a send from Home refreshes it. */
const INVITE_QUERY_KEY = ["admin", "fitter-invites"] as const;

interface SentInvite {
  channel: FitterInviteChannel;
  delivered: boolean;
  inviteLink: string;
  expiresAt: string;
  /** Human-readable recipient, for the confirmation line. Null in office. */
  sentTo: string | null;
}

export function FitterInviteQuickSend() {
  const qc = useQueryClient();
  const [contact, setContact] = useState("");
  const [name, setName] = useState("");
  const [pending, setPending] = useState<null | FitterInviteChannel>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentInvite | null>(null);
  const [copied, setCopied] = useState(false);

  const parsed = useMemo(() => parseInviteContact(contact), [contact]);

  async function send(channel: FitterInviteChannel) {
    if (pending) return;
    setError(null);

    const body: CreateFitterInviteBody = { channel };
    if (name.trim()) body.name = name.trim();

    // In office sends nothing, so anything typed is optional — but keep
    // it when it's there: a stored email/phone is what lets the finished
    // fitting auto-attach to a chart instead of landing in the holding
    // area for someone to resolve by hand.
    if (parsed.kind === "email") body.email = parsed.email;
    else if (parsed.kind === "phone") body.phoneE164 = parsed.phoneE164;
    else if (channel !== "in_office") {
      setError(
        parsed.kind === "invalid"
          ? parsed.reason
          : "Enter a mobile number or an email address to send to.",
      );
      return;
    }

    setPending(channel);
    try {
      const res = await createFitterInvite(body);
      setSent({
        channel,
        delivered: res.delivered,
        inviteLink: res.inviteLink,
        expiresAt: res.expiresAt,
        sentTo: channel === "in_office" ? null : contactDisplay(parsed),
      });
      // The worklist (and its holding-area count) is now stale.
      void qc.invalidateQueries({ queryKey: INVITE_QUERY_KEY });
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(null);
    }
  }

  function reset() {
    setSent(null);
    setContact("");
    setName("");
    setError(null);
    setCopied(false);
  }

  return (
    <section
      className="bg-white border rounded-lg p-5"
      style={{ borderColor: "hsl(var(--line-1))" }}
      data-testid="dashboard-fitter-quick-send"
    >
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex-1 min-w-[18rem]">
          <h2
            className="text-base font-semibold mb-1 flex items-center gap-2"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            <ScanFace className="h-5 w-5" aria-hidden="true" />
            Send a mask-fitting link
          </h2>
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            Text or email anyone a link to the AI mask fitter. It takes about
            two minutes on their own phone, and their measurements and
            recommended mask come straight back here.
          </p>
        </div>
        <Link
          href="/admin/fitter-invites"
          className="text-xs font-semibold text-blue-700 underline whitespace-nowrap"
        >
          All invites &amp; results →
        </Link>
      </div>

      {sent ? (
        <SentPanel
          sent={sent}
          copied={copied}
          onCopy={() => {
            void navigator.clipboard?.writeText(sent.inviteLink).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          onReset={reset}
        />
      ) : (
        <form
          className="mt-4"
          onSubmit={(e) => {
            e.preventDefault();
            // Enter in either field sends over the inferred channel.
            void send(parsed.kind === "email" ? "email" : "sms");
          }}
        >
          <div className="flex flex-col sm:flex-row sm:items-end gap-3">
            <div className="flex-1 min-w-0">
              <Label htmlFor="quick-invite-contact">
                Mobile number or email
              </Label>
              <Input
                id="quick-invite-contact"
                value={contact}
                autoComplete="off"
                placeholder="(555) 123-4567  or  patient@example.com"
                aria-describedby="quick-invite-hint"
                onChange={(e) => {
                  setContact(e.target.value);
                  setError(null);
                }}
              />
            </div>
            <div className="sm:w-44">
              <Label htmlFor="quick-invite-name">
                First name{" "}
                <span style={{ color: "hsl(var(--ink-3))" }}>(optional)</span>
              </Label>
              <Input
                id="quick-invite-name"
                value={name}
                autoComplete="off"
                placeholder="Jordan"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <Button
              type="submit"
              isLoading={pending === "email" || pending === "sms"}
              disabled={pending !== null}
            >
              {parsed.kind === "phone"
                ? "Send text"
                : parsed.kind === "email"
                  ? "Send email"
                  : "Send invite"}
            </Button>
          </div>

          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
            {/* One line, two jobs: normally the live channel read-back,
                and on a failed send the reason. They're mutually
                exclusive — showing both put the same sentence on screen
                twice for a mistyped address. Whichever renders keeps the
                id so the input's aria-describedby always resolves. */}
            {error ? (
              <p
                id="quick-invite-hint"
                className="text-sm"
                style={{ color: "#991b1b" }}
                role="alert"
              >
                {error}
              </p>
            ) : (
              <p
                id="quick-invite-hint"
                className="text-xs"
                style={{ color: "hsl(var(--ink-3))" }}
              >
                {hintFor(parsed)}
              </p>
            )}
            <button
              type="button"
              className="text-xs font-semibold text-blue-700 underline disabled:opacity-50"
              disabled={pending !== null}
              onClick={() => void send("in_office")}
            >
              {pending === "in_office"
                ? "Creating QR code…"
                : "Patient is here — show a QR code instead"}
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

function SentPanel({
  sent,
  copied,
  onCopy,
  onReset,
}: {
  sent: SentInvite;
  copied: boolean;
  onCopy: () => void;
  onReset: () => void;
}) {
  return (
    <div className="mt-4 space-y-3" data-testid="dashboard-fitter-quick-sent">
      <p
        className="text-sm font-semibold"
        style={{ color: sent.delivered ? "hsl(var(--ink-1))" : "#92400e" }}
        role="status"
      >
        {confirmationLine(sent)}
      </p>

      {sent.channel === "in_office" && (
        <div className="flex flex-col items-center gap-2">
          {/* Rendered locally by the `qrcode` package — the link is never
              sent anywhere to become an image. */}
          <QrCode
            value={sent.inviteLink}
            size={180}
            ariaLabel="QR code linking to the mask fitter"
          />
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Expires {formatExpiry(sent.expiresAt)}.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          readOnly
          value={sent.inviteLink}
          aria-label="Invite link"
          className="flex-1 min-w-[16rem]"
          onFocus={(e) => e.currentTarget.select()}
        />
        <Button type="button" intent="secondary" onClick={onCopy}>
          {copied ? "Copied" : "Copy link"}
        </Button>
        <Button type="button" onClick={onReset}>
          Send another
        </Button>
      </div>
    </div>
  );
}

/** What the confirmation line says. Delivery can fail softly — the API
 *  still returns a usable link when SendGrid/Twilio isn't configured —
 *  so say which of the two happened rather than a blanket "Sent". */
function confirmationLine(sent: SentInvite): string {
  if (sent.channel === "in_office") {
    return "Ready — have the patient scan this with their phone camera.";
  }
  if (!sent.delivered) {
    return "Invite created, but we couldn't send it automatically. Share the link below instead.";
  }
  const verb = sent.channel === "sms" ? "Texted" : "Emailed";
  return `${verb} the fitting link to ${sent.sentTo ?? "the patient"}.`;
}

function contactDisplay(
  parsed: ReturnType<typeof parseInviteContact>,
): string | null {
  if (parsed.kind === "email" || parsed.kind === "phone") return parsed.display;
  return null;
}

/** Live channel read-back under the input, so the operator can see which
 *  channel their typing selected before they commit to sending. */
function hintFor(parsed: ReturnType<typeof parseInviteContact>): string {
  switch (parsed.kind) {
    case "phone":
      return `Will text ${parsed.display}.`;
    case "email":
      return `Will email ${parsed.display}.`;
    case "invalid":
      return parsed.reason;
    default:
      return "We'll text it or email it — whichever you type.";
  }
}

/** Same wording as the invite modal: an in-office window is normally
 *  same-day, so a bare time reads better than a full date. */
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
