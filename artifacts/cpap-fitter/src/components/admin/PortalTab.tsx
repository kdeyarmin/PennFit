// Patient-detail "Portal" tab — CSR-driven patient portal invite +
// onboarding info form.
//
// States:
//   not_invited — show invite form (email + required onboarding fields)
//   pending     — show invite status + resend / revoke buttons
//   active      — show "account active" + revoke button

import { useState } from "react";

import type { PatientDetail } from "@workspace/api-client-react/admin";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Input, Label, Select } from "@/components/admin/Input";
import { formatDateTime } from "@/lib/admin/format";
import {
  resendPortalInvite,
  revokePortalInvite,
  sendPortalInvite,
  type Address,
  type PortalStatus,
} from "@/lib/admin/patient-portal-invite-api";

function portalStatusBadge(status: PortalStatus) {
  if (status === "active") return <Badge variant="success">Active</Badge>;
  if (status === "pending") return <Badge variant="warning">Invite pending</Badge>;
  return <Badge variant="muted">Not invited</Badge>;
}

export function PortalTab({
  patient,
  onChanged,
}: {
  patient: PatientDetail;
  onChanged: () => void;
}) {
  const [portalStatus, setPortalStatus] = useState<PortalStatus>(
    patient.portalStatus,
  );
  const [feedback, setFeedback] = useState<{
    kind: "success" | "error";
    text: string;
  } | null>(null);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Invite form state
  const [email, setEmail] = useState(patient.hasEmail ? "" : "");
  const [phone, setPhone] = useState("");
  const [insurancePayer, setInsurancePayer] = useState(
    patient.insurancePayer ?? "",
  );
  const [channelPref, setChannelPref] = useState<
    "sms" | "email" | "voice" | ""
  >((patient.channelPreference as "sms" | "email" | "voice" | null) ?? "");

  // Address sub-fields
  const [addrLine1, setAddrLine1] = useState("");
  const [addrLine2, setAddrLine2] = useState("");
  const [addrCity, setAddrCity] = useState("");
  const [addrState, setAddrState] = useState("");
  const [addrZip, setAddrZip] = useState("");

  async function handleSendInvite(e: React.FormEvent) {
    e.preventDefault();
    setFeedback(null);
    setInviteLink(null);
    setBusy(true);

    const body: Parameters<typeof sendPortalInvite>[1] = {};
    if (email.trim()) body.email = email.trim().toLowerCase();
    if (phone.trim()) body.phoneE164 = phone.trim();
    if (insurancePayer.trim()) body.insurancePayer = insurancePayer.trim();
    if (channelPref) body.channelPreference = channelPref;

    const hasAddress =
      addrLine1.trim() || addrCity.trim() || addrState.trim() || addrZip.trim();
    if (hasAddress) {
      const addr: Address = {
        line1: addrLine1.trim(),
        city: addrCity.trim(),
        state: addrState.trim(),
        postalCode: addrZip.trim(),
        country: "US",
      };
      if (addrLine2.trim()) addr.line2 = addrLine2.trim();
      body.address = addr;
    }

    try {
      const result = await sendPortalInvite(patient.id, body);
      setPortalStatus(result.portalStatus);
      setInviteLink(result.inviteLink);
      setFeedback({
        kind: "success",
        text: result.emailSent
          ? "Invite email sent successfully."
          : "Invite created. Email could not be sent — copy the link below to share manually.",
      });
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Invite failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleResend() {
    setFeedback(null);
    setInviteLink(null);
    setBusy(true);
    try {
      const result = await resendPortalInvite(patient.id);
      setInviteLink(result.inviteLink);
      setFeedback({
        kind: "success",
        text: result.emailSent
          ? "Invite email resent."
          : "Token reissued. Email could not be sent — copy the link below to share manually.",
      });
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Resend failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke() {
    if (
      !window.confirm(
        "Revoke this patient's portal access? They will be signed out immediately and cannot log in until re-invited.",
      )
    )
      return;
    setFeedback(null);
    setBusy(true);
    try {
      await revokePortalInvite(patient.id);
      setPortalStatus("not_invited");
      setInviteLink(null);
      setFeedback({ kind: "success", text: "Portal access revoked." });
      onChanged();
    } catch (err) {
      setFeedback({
        kind: "error",
        text: err instanceof Error ? err.message : "Revoke failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h3
          className="text-base font-semibold"
          style={{ color: "hsl(var(--ink-1))" }}
        >
          Patient portal
        </h3>
        {portalStatusBadge(portalStatus)}
        {patient.portalInvitedAt && (
          <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            Last invited {formatDateTime(patient.portalInvitedAt)}
          </span>
        )}
      </div>

      {feedback && (
        <div
          className="text-sm px-3 py-2 rounded"
          style={{
            background:
              feedback.kind === "success"
                ? "hsl(var(--success-bg, 220 60% 97%))"
                : "hsl(var(--error-bg, 0 80% 97%))",
            color:
              feedback.kind === "success"
                ? "hsl(var(--success-fg, 220 60% 30%))"
                : "hsl(var(--error-fg, 0 60% 40%))",
            border: `1px solid ${feedback.kind === "success" ? "hsl(var(--success-line, 220 40% 85%))" : "hsl(var(--error-line, 0 60% 85%))"}`,
          }}
        >
          {feedback.text}
        </div>
      )}

      {inviteLink && (
        <div
          className="text-xs px-3 py-2 rounded font-mono break-all"
          style={{
            background: "hsl(var(--surface-2, 220 15% 97%))",
            border: "1px solid hsl(var(--line-1))",
            color: "hsl(var(--ink-2))",
          }}
        >
          <span
            className="block mb-1 font-sans font-semibold not-italic"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            Invite link (share out-of-band):
          </span>
          {inviteLink}
        </div>
      )}

      {/* Active account — just show status + revoke */}
      {portalStatus === "active" && (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            This patient has an active portal account. They can log in to view
            orders, manage supplies, and upload documents.
          </p>
          <button
            type="button"
            disabled={busy}
            onClick={() => void handleRevoke()}
            className="text-sm underline disabled:opacity-40"
            style={{
              color: "#b91c1c",
              background: "none",
              border: "none",
              cursor: busy ? "not-allowed" : "pointer",
              font: "inherit",
            }}
          >
            {busy ? "Revoking…" : "Revoke portal access"}
          </button>
        </div>
      )}

      {/* Pending invite — show resend + revoke */}
      {portalStatus === "pending" && (
        <div className="space-y-3">
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            An invite has been sent. The patient needs to click the link in
            their email to set a password and activate their account.
          </p>
          <div className="flex items-center gap-4">
            <Button
              intent="primary"
              size="sm"
              disabled={busy}
              onClick={() => void handleResend()}
            >
              {busy ? "Resending…" : "Resend invite"}
            </Button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleRevoke()}
              className="text-sm underline disabled:opacity-40"
              style={{
                color: "#b91c1c",
                background: "none",
                border: "none",
                cursor: busy ? "not-allowed" : "pointer",
                font: "inherit",
              }}
            >
              {busy ? "Revoking…" : "Revoke invite"}
            </button>
          </div>
        </div>
      )}

      {/* Not invited — show full invite + onboarding form */}
      {portalStatus === "not_invited" && (
        <form onSubmit={(e) => void handleSendInvite(e)} className="space-y-5">
          <p className="text-sm" style={{ color: "hsl(var(--ink-2))" }}>
            Send this patient a portal invite so they can self-serve orders,
            upload insurance documents, and manage their CPAP supplies.
            Fill in any missing onboarding fields before sending — the
            patient will see this information when they log in.
          </p>

          <fieldset className="space-y-4">
            <legend
              className="text-xs uppercase tracking-wider font-semibold mb-3"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Portal login
            </legend>

            <div>
              <Label htmlFor="portal-email">
                Email address
                {!patient.hasEmail && (
                  <span className="ml-1 text-red-600">*</span>
                )}
              </Label>
              <Input
                id="portal-email"
                type="email"
                placeholder={
                  patient.hasEmail
                    ? "Leave blank to use email on file"
                    : "Required — patient has no email on file"
                }
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required={!patient.hasEmail}
              />
              {patient.hasEmail && (
                <p
                  className="text-xs mt-1"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Patient already has an email on file. Enter a different one
                  only if you need to change it.
                </p>
              )}
            </div>
          </fieldset>

          <fieldset className="space-y-4">
            <legend
              className="text-xs uppercase tracking-wider font-semibold mb-3"
              style={{ color: "hsl(var(--penn-gold-deep))" }}
            >
              Onboarding information
            </legend>

            <div>
              <Label htmlFor="portal-phone">Phone number (E.164)</Label>
              <Input
                id="portal-phone"
                type="tel"
                placeholder="+12155551234"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              {patient.hasPhone && (
                <p
                  className="text-xs mt-1"
                  style={{ color: "hsl(var(--ink-3))" }}
                >
                  Patient already has a phone on file. Leave blank to keep it.
                </p>
              )}
            </div>

            <div>
              <Label htmlFor="portal-insurance">Insurance payer</Label>
              <Input
                id="portal-insurance"
                type="text"
                placeholder={
                  patient.insurancePayer ?? "e.g. Aetna, Medicare, BCBS-PA"
                }
                value={insurancePayer}
                onChange={(e) => setInsurancePayer(e.target.value)}
              />
            </div>

            <div>
              <Label htmlFor="portal-channel">Preferred contact channel</Label>
              <Select
                id="portal-channel"
                value={channelPref}
                onChange={(e) =>
                  setChannelPref(
                    e.target.value as "sms" | "email" | "voice" | "",
                  )
                }
                options={[
                  { value: "sms", label: "SMS" },
                  { value: "email", label: "Email" },
                  { value: "voice", label: "Voice call" },
                ]}
                emptyOptionLabel="No preference (use rule default)"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="portal-addr-line1">Mailing address</Label>
              <Input
                id="portal-addr-line1"
                type="text"
                placeholder="Street address"
                value={addrLine1}
                onChange={(e) => setAddrLine1(e.target.value)}
              />
              <Input
                id="portal-addr-line2"
                type="text"
                placeholder="Apt, suite, unit (optional)"
                value={addrLine2}
                onChange={(e) => setAddrLine2(e.target.value)}
              />
              <div className="grid grid-cols-3 gap-2">
                <Input
                  id="portal-addr-city"
                  type="text"
                  placeholder="City"
                  value={addrCity}
                  onChange={(e) => setAddrCity(e.target.value)}
                  className="col-span-1"
                />
                <Input
                  id="portal-addr-state"
                  type="text"
                  placeholder="State"
                  value={addrState}
                  onChange={(e) => setAddrState(e.target.value)}
                  className="col-span-1"
                  maxLength={2}
                />
                <Input
                  id="portal-addr-zip"
                  type="text"
                  placeholder="ZIP"
                  value={addrZip}
                  onChange={(e) => setAddrZip(e.target.value)}
                  className="col-span-1"
                  maxLength={10}
                />
              </div>
            </div>
          </fieldset>

          <div className="flex items-center gap-3 pt-1">
            <Button type="submit" intent="primary" disabled={busy}>
              {busy ? "Sending invite…" : "Send portal invite"}
            </Button>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              The patient will receive a "Set up your portal" email with a
              7-day link to create their password.
            </p>
          </div>
        </form>
      )}
    </div>
  );
}
