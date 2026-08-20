// /admin/message-previews — what the patient actually receives.
//
// The outbound copy is spread across ~66 send paths, so before this page
// the only way to see a patient's-eye view was to trigger a real event
// against a real patient. This renders every scenario from the shared
// server-side catalog, with THIS tenant's brand and a fictional sample
// patient, and lets staff send one to their own phone or inbox.
//
// Two rendering notes that matter:
//
//  * The email body goes into a SANDBOXED IFRAME, not into the page. Email
//    HTML is a full document with its own <body> styling; dropping it
//    inline would leak its CSS across the admin console (and the console's
//    across it), so neither would look like the real thing. The iframe also
//    means nothing in a template can script the console.
//  * SMS shows carrier segment math, because one curly quote or em dash
//    silently flips a message to UCS-2 and cuts the segment from 160
//    characters to 70 — tripling what a fleet-wide send costs.

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { EmptyState } from "@/components/admin/EmptyState";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input, Label } from "@/components/admin/Input";
import { PageHeader } from "@/components/admin/PageHeader";
import { Spinner } from "@/components/admin/Spinner";
import {
  fetchMessagePreviews,
  sendMessagePreview,
  GROUP_LABELS,
  GROUP_ORDER,
  type MessagePreview,
  type PreviewGroup,
  type SendTestResult,
  type SendingReadiness,
} from "@/lib/admin/message-previews-api";

const QUERY_KEY = ["admin", "message-previews"] as const;

/** Carrier segment math, shown next to every SMS body. */
function SmsMeter({ sms }: { sms: NonNullable<MessagePreview["sms"]> }) {
  const costly = sms.encoding === "UCS-2" || sms.segments > 1;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Badge variant={sms.encoding === "GSM-7" ? "success" : "danger"}>
        {sms.encoding}
      </Badge>
      <Badge variant={sms.segments > 1 ? "danger" : "muted"}>
        {sms.segments} segment{sms.segments === 1 ? "" : "s"}
      </Badge>
      <span className="text-slate-500">
        {sms.characters} chars · {sms.units} billable units
      </span>
      {costly ? (
        <span className="text-amber-700">
          {sms.encoding === "UCS-2"
            ? "A non-GSM-7 character (curly quote, em dash, emoji) forced UCS-2 — 70 chars per segment instead of 160."
            : "Over one segment: this costs multiple messages to send."}
        </span>
      ) : null}
    </div>
  );
}

/** A phone-ish frame so the SMS reads the way it will on a handset. */
function PhoneMock({ body }: { body: string }) {
  return (
    <div className="rounded-2xl border border-slate-300 bg-slate-100 p-3">
      <div className="mx-auto max-w-[19rem]">
        <div className="rounded-2xl rounded-bl-sm bg-white px-3 py-2 text-sm leading-snug text-slate-900 shadow-sm">
          {body}
        </div>
        <p className="mt-1 pl-1 text-[11px] text-slate-500">Delivered · now</p>
      </div>
    </div>
  );
}

/**
 * Email HTML rendered in an isolated document. `sandbox` with no
 * allow-scripts: templates are ours, but an email body has no business
 * running script in the admin console, and the isolation is also what
 * keeps its CSS from leaking into the page.
 */
function EmailMock({
  subject,
  html,
  from,
}: {
  subject: string;
  html: string;
  from: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-300">
      <div className="border-b border-slate-200 bg-slate-50 px-3 py-2">
        <p className="text-sm font-semibold text-slate-900">{subject}</p>
        <p className="text-xs text-slate-500">From: {from}</p>
      </div>
      <iframe
        title={`Email preview: ${subject}`}
        sandbox=""
        srcDoc={html}
        className="h-96 w-full bg-white"
      />
    </div>
  );
}

/** The send-a-test form for one scenario + channel. */
function SendTest({
  previewId,
  channel,
  readiness,
}: {
  previewId: string;
  channel: "email" | "sms";
  readiness: SendingReadiness;
}) {
  const channelReady = readiness[channel];
  const [to, setTo] = useState("");
  const [result, setResult] = useState<SendTestResult | null>(null);

  const send = useMutation({
    mutationFn: () => sendMessagePreview(previewId, channel, to.trim()),
    onSuccess: (r) => setResult(r),
    onError: () =>
      setResult({
        ok: false,
        channel,
        code: "upstream_error",
        message: "The request failed. Check your permissions and try again.",
      }),
  });

  const placeholder = channel === "email" ? "you@example.com" : "+12155550123";
  const valid =
    channel === "email"
      ? /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to.trim())
      : /^\+[1-9]\d{7,14}$/.test(to.trim());

  if (!channelReady.configured) {
    // Say so before they type an address and wait for a failure.
    return (
      <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 p-3">
        <p className="text-sm font-medium text-amber-900">
          {channel === "email" ? "Email" : "SMS"} sending isn&apos;t set up yet
        </p>
        <p className="mt-1 text-xs text-amber-800">
          Add your {channel === "email" ? "SendGrid" : "Twilio"} credentials
          under Global integrations, then come back and you can send this to
          yourself. Until then you can still read the message above.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-3 rounded-md border border-slate-200 bg-slate-50 p-3">
      <Label htmlFor={`${previewId}-${channel}-to`}>
        Send this {channel === "email" ? "email" : "text"} to yourself
      </Label>
      <div className="mt-1 flex flex-wrap items-start gap-2">
        <Input
          id={`${previewId}-${channel}-to`}
          value={to}
          onChange={(e) => {
            setTo(e.target.value);
            setResult(null);
          }}
          placeholder={placeholder}
          className="w-64"
          autoComplete="off"
        />
        <Button
          intent="secondary"
          disabled={!valid || send.isPending}
          onClick={() => send.mutate()}
        >
          {send.isPending ? "Sending…" : "Send test"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Sends the real message
        {channelReady.from ? (
          <>
            {" "}
            from <strong>{channelReady.from}</strong>
          </>
        ) : null}{" "}
        — the same identity a patient sees. The body is the sample above; you
        can&apos;t send custom text from here.
      </p>
      {result ? (
        <p
          className={`mt-2 text-xs ${result.ok ? "text-emerald-700" : "text-red-700"}`}
        >
          {result.ok ? sentMessage(result, channel) : result.message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What to say after a successful send. For SMS, "sent" and "arrived" are
 * different things — the provider accepting a message says nothing about a
 * handset receiving it — so report the confirmed state rather than implying
 * delivery we haven't seen.
 */
function sentMessage(
  result: Extract<SendTestResult, { ok: true }>,
  channel: "email" | "sms",
): string {
  if (channel === "email") return "Sent. Check your inbox.";
  const segs = result.segments
    ? ` (${result.segments} segment${result.segments === 1 ? "" : "s"})`
    : "";
  if (result.delivered) return `Delivered to your phone${segs}.`;
  return `Sent${segs}. The carrier hasn't confirmed delivery yet — it's probably still in flight.`;
}

function FidelityBadge({ preview }: { preview: MessagePreview }) {
  const tip =
    preview.fidelity === "exact"
      ? `Rendered by ${preview.source} — byte-for-byte what the patient gets.`
      : `Copy mirrored from ${preview.source}; a drift test keeps them in step.`;
  return (
    <span title={tip}>
      <Badge variant={preview.fidelity === "exact" ? "success" : "muted"}>
        {preview.fidelity === "exact" ? "Exact" : "Mirrored"}
      </Badge>
    </span>
  );
}

function PreviewCard({
  preview,
  fromEmail,
  readiness,
}: {
  preview: MessagePreview;
  fromEmail: string;
  readiness: SendingReadiness;
}) {
  const [tab, setTab] = useState<"email" | "sms">(
    preview.email ? "email" : "sms",
  );
  const [showText, setShowText] = useState(false);
  const both = Boolean(preview.email && preview.sms);

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {preview.label}
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            {preview.description}
          </p>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            <span className="font-medium">Fires when:</span> {preview.trigger}
          </p>
        </div>
        <FidelityBadge preview={preview} />
      </div>

      {both ? (
        <div className="mt-3 flex gap-2">
          <Button
            intent={tab === "email" ? "primary" : "secondary"}
            onClick={() => setTab("email")}
            aria-pressed={tab === "email"}
          >
            Email
          </Button>
          <Button
            intent={tab === "sms" ? "primary" : "secondary"}
            onClick={() => setTab("sms")}
            aria-pressed={tab === "sms"}
          >
            Text
          </Button>
        </div>
      ) : null}

      {tab === "email" && preview.email ? (
        <div className="mt-3 space-y-2">
          <EmailMock
            subject={preview.email.subject}
            html={preview.email.html}
            from={fromEmail}
          />
          <Button intent="secondary" onClick={() => setShowText((v) => !v)}>
            {showText ? "Hide plain-text version" : "Show plain-text version"}
          </Button>
          {showText ? (
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-800">
              {preview.email.text}
            </pre>
          ) : null}
          <SendTest
            previewId={preview.id}
            channel="email"
            readiness={readiness}
          />
        </div>
      ) : null}

      {tab === "sms" && preview.sms ? (
        <div className="mt-3 space-y-2">
          <PhoneMock body={preview.sms.body} />
          <SmsMeter sms={preview.sms} />
          <SendTest
            previewId={preview.id}
            channel="sms"
            readiness={readiness}
          />
        </div>
      ) : null}
    </Card>
  );
}

export function AdminMessagePreviewsPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: fetchMessagePreviews,
  });

  const [group, setGroup] = useState<PreviewGroup | "all">("all");

  const grouped = useMemo(() => {
    const previews = data?.previews ?? [];
    return GROUP_ORDER.map((g) => ({
      group: g,
      items: previews.filter((p) => p.group === g),
    })).filter((s) => s.items.length > 0);
  }, [data]);

  const visible =
    group === "all" ? grouped : grouped.filter((s) => s.group === group);

  return (
    <div className="admin-root space-y-6" data-testid="admin-message-previews">
      <PageHeader
        title="Patient message previews"
        description={
          <>
            Every text and email a patient can receive, rendered with your brand
            and a fictional sample patient. Send one to your own phone or inbox
            to see exactly how it lands.
          </>
        }
      />

      {isPending ? <Spinner label="Rendering messages…" /> : null}
      {isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : null}

      {data ? (
        <>
          <Card>
            <p className="text-sm text-slate-700">
              Rendering as <strong>{data.brand.name}</strong> ·{" "}
              {data.brand.supportPhoneDisplay} · links point at{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                {data.brand.baseUrl}
              </code>
            </p>
            <p className="mt-1 text-xs text-slate-500">
              A scenario marked <strong>Exact</strong> is rendered by the same
              code that sends the real message, so what you see is byte-for-byte
              what the patient gets. <strong>Mirrored</strong> means the copy is
              duplicated from a send path that can&apos;t be rendered directly;
              a drift test fails the build if the two ever disagree.
            </p>
          </Card>

          <div className="flex flex-wrap gap-2">
            <Button
              intent={group === "all" ? "primary" : "secondary"}
              onClick={() => setGroup("all")}
              aria-pressed={group === "all"}
            >
              All
            </Button>
            {GROUP_ORDER.map((g) => (
              <Button
                key={g}
                intent={group === g ? "primary" : "secondary"}
                onClick={() => setGroup(g)}
                aria-pressed={group === g}
              >
                {GROUP_LABELS[g]}
              </Button>
            ))}
          </div>

          {visible.length === 0 ? (
            <EmptyState
              title="No messages in this group"
              hint="Nothing is seeded for this group yet."
            />
          ) : null}

          {visible.map((section) => (
            <section key={section.group} className="space-y-4">
              <h2 className="text-lg font-semibold text-slate-900">
                {GROUP_LABELS[section.group]}
              </h2>
              {section.items.map((preview) => (
                <PreviewCard
                  key={preview.id}
                  preview={preview}
                  readiness={data.sending}
                  fromEmail={`${data.brand.name} <${data.sending.email.from ?? `noreply@${new URL(data.brand.baseUrl).hostname}`}>`}
                />
              ))}
            </section>
          ))}
        </>
      ) : null}
    </div>
  );
}

export default AdminMessagePreviewsPage;
