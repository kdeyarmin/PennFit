// /admin/phone-settings — a tenant's own voice + SMS numbers.
//
// Each DME tenant gets its OWN voice + SMS number so inbound calls/texts
// route to them and outbound send from their caller ID. Numbers are
// auto-provisioned through Twilio or set manually for a ported /
// pre-existing number. Backed by organizations.voice_from_number /
// sms_from_number / twilio_messaging_service_sid (migration 0364).

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PhoneCall } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchPhoneSettings,
  provisionPhoneNumber,
  updatePhoneSettings,
  type PhoneSlot,
} from "@/lib/admin/phone-settings-api";

const INPUT_STYLE: React.CSSProperties = {
  background: "hsl(var(--surface-1))",
  borderColor: "hsl(var(--line-1))",
  color: "hsl(var(--ink-1))",
};

const E164_RE = /^\+[1-9]\d{6,14}$/;
const AREA_CODE_RE = /^\d{3}$/;
const MSID_RE = /^MG[0-9a-fA-F]{32}$/;

const PHONE_QUERY_KEY = ["admin", "phone-settings"] as const;

export function AdminPhoneSettingsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: PHONE_QUERY_KEY,
    queryFn: fetchPhoneSettings,
  });

  const [areaCode, setAreaCode] = useState("");
  const [assignVoice, setAssignVoice] = useState(true);
  const [assignSms, setAssignSms] = useState(true);
  const [voiceNumber, setVoiceNumber] = useState("");
  const [smsNumber, setSmsNumber] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");

  useEffect(() => {
    if (data) {
      setVoiceNumber(data.voiceNumber ?? "");
      setSmsNumber(data.smsNumber ?? "");
      setMessagingServiceSid(data.messagingServiceSid ?? "");
    }
  }, [data]);

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: PHONE_QUERY_KEY });
  }

  const provision = useMutation({
    mutationFn: () => {
      const assign: PhoneSlot[] = [];
      if (assignVoice) assign.push("voice");
      if (assignSms) assign.push("sms");
      return provisionPhoneNumber({
        areaCode: areaCode.trim() || undefined,
        assign,
      });
    },
    onSuccess: invalidate,
  });

  const saveManual = useMutation({
    mutationFn: () =>
      updatePhoneSettings({
        voiceNumber: voiceNumber.trim() || null,
        smsNumber: smsNumber.trim() || null,
        messagingServiceSid: messagingServiceSid.trim() || null,
      }),
    onSuccess: invalidate,
  });

  if (isPending) {
    return (
      <div className="admin-root p-6">
        <Spinner />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="admin-root p-6">
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      </div>
    );
  }

  const areaCodeValid =
    areaCode.trim() === "" || AREA_CODE_RE.test(areaCode.trim());
  const voiceValid =
    voiceNumber.trim() === "" || E164_RE.test(voiceNumber.trim());
  const smsValid = smsNumber.trim() === "" || E164_RE.test(smsNumber.trim());
  const msidValid =
    messagingServiceSid.trim() === "" ||
    MSID_RE.test(messagingServiceSid.trim());
  const manualValid = voiceValid && smsValid && msidValid;
  const anyPending = provision.isPending || saveManual.isPending;
  const hasAnyNumber = Boolean(
    data.voiceNumber || data.smsNumber || data.messagingServiceSid,
  );

  function mutationError(m: {
    isError: boolean;
    error: unknown;
  }): string | null {
    if (!m.isError) return null;
    return m.error instanceof Error ? m.error.message : "Request failed";
  }

  return (
    <div className="admin-root p-6 space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold">Phone &amp; SMS numbers</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Your practice&apos;s own numbers for the automated voice agent and
          resupply texting. Inbound calls and texts route to you, and outbound
          send from your caller ID. Numbers are provisioned through Twilio.
        </p>
      </header>

      <Card title="Current numbers">
        {hasAnyNumber ? (
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <NumberStat label="Voice" value={data.voiceNumber} />
            <NumberStat label="SMS" value={data.smsNumber} />
            {data.messagingServiceSid && (
              <NumberStat
                label="Messaging Service"
                value={data.messagingServiceSid}
              />
            )}
          </dl>
        ) : (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            No numbers yet. Provision one below, or enter a number you already
            own.
          </p>
        )}
      </Card>

      <Card title="Provision a new number">
        {data.canProvision ? (
          <div className="space-y-3">
            <label className="block text-sm">
              <span style={{ color: "hsl(var(--ink-2))" }}>
                Preferred area code (optional)
              </span>
              <input
                className="mt-1 w-40 rounded-md border px-2.5 py-1.5 text-sm"
                style={INPUT_STYLE}
                value={areaCode}
                inputMode="numeric"
                maxLength={3}
                placeholder="e.g. 215"
                onChange={(e) => setAreaCode(e.target.value)}
              />
            </label>
            {!areaCodeValid && (
              <p className="text-sm" style={{ color: "#b45309" }}>
                Area code must be 3 digits.
              </p>
            )}
            <fieldset className="space-y-1.5">
              <legend
                className="text-sm"
                style={{ color: "hsl(var(--ink-2))" }}
              >
                Use this number for
              </legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={assignVoice}
                  onChange={(e) => setAssignVoice(e.target.checked)}
                />
                Voice calls
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={assignSms}
                  onChange={(e) => setAssignSms(e.target.checked)}
                />
                SMS texts
              </label>
            </fieldset>
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={
                anyPending || !areaCodeValid || (!assignVoice && !assignSms)
              }
              onClick={() => provision.mutate()}
            >
              <PhoneCall className="h-4 w-4" />
              {provision.isPending ? "Provisioning…" : "Provision number"}
            </button>
            <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Buys a real phone number from Twilio and points its inbound
              webhooks at the app. This may incur a monthly charge.
            </p>
            {mutationError(provision) && (
              <p className="text-sm" style={{ color: "#dc2626" }}>
                {mutationError(provision)}
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            Automatic provisioning isn&apos;t available — the platform&apos;s
            Twilio credentials aren&apos;t configured. Enter a number you
            already own below, or contact your platform administrator.
          </p>
        )}
      </Card>

      <Card title="Use numbers you already own">
        <div className="space-y-4">
          <ManualField
            label="Voice number (E.164)"
            placeholder="+12155551212"
            value={voiceNumber}
            valid={voiceValid}
            onChange={setVoiceNumber}
          />
          <ManualField
            label="SMS number (E.164)"
            placeholder="+12155551212"
            value={smsNumber}
            valid={smsValid}
            onChange={setSmsNumber}
          />
          <ManualField
            label="Twilio Messaging Service SID (optional)"
            placeholder="MG0123456789abcdef0123456789abcdef"
            value={messagingServiceSid}
            valid={msidValid}
            onChange={setMessagingServiceSid}
            help="If you send SMS through a Twilio Messaging Service, paste its SID instead of an SMS number."
          />
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={anyPending || !manualValid}
              onClick={() => saveManual.mutate()}
            >
              {saveManual.isPending ? "Saving…" : "Save numbers"}
            </button>
            <span className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
              Clear a field and save to fall back to the platform default.
            </span>
          </div>
          {mutationError(saveManual) && (
            <p className="text-sm" style={{ color: "#dc2626" }}>
              {mutationError(saveManual)}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function NumberStat({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt
        className="text-xs uppercase tracking-wide"
        style={{ color: "hsl(var(--ink-3))" }}
      >
        {label}
      </dt>
      <dd className="text-base font-semibold tabular-nums">
        {value ?? <span style={{ color: "hsl(var(--ink-3))" }}>—</span>}
      </dd>
    </div>
  );
}

function ManualField({
  label,
  placeholder,
  value,
  valid,
  onChange,
  help,
}: {
  label: string;
  placeholder: string;
  value: string;
  valid: boolean;
  onChange: (v: string) => void;
  help?: string;
}) {
  return (
    <label className="block text-sm">
      <span style={{ color: "hsl(var(--ink-2))" }}>{label}</span>
      <input
        className="mt-1 w-full max-w-md rounded-md border px-2.5 py-1.5 text-sm tabular-nums"
        style={INPUT_STYLE}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      {!valid && (
        <span className="mt-1 block text-sm" style={{ color: "#b45309" }}>
          Invalid format.
        </span>
      )}
      {help && (
        <span
          className="mt-1 block text-xs"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          {help}
        </span>
      )}
    </label>
  );
}
