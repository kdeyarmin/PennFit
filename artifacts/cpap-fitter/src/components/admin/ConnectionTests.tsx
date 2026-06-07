// Connection tests — super-admin "send a test" panel.
//
// Rendered inside /admin/system/configuration so an operator can verify
// a credential they just entered actually works: send a real test
// email / SMS, place a real test call, or ping the active LLM provider.
// Each test runs against the EFFECTIVE config server-side (saved values
// + environment), so a key entered above can be verified before the
// next deploy.
//
// A failed test is a NORMAL outcome (the backend returns 200 with
// `ok:false`); we render it red/amber without treating it as an error.
// Only auth / malformed-input failures surface as a thrown ApiError.

import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  Bot,
  Check,
  Mail,
  MessageSquare,
  Phone,
  Plug,
  Send,
  X,
} from "lucide-react";

import { Badge } from "@/components/admin/Badge";
import { Button } from "@/components/admin/Button";
import { Card } from "@/components/admin/Card";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Input } from "@/components/admin/Input";
import { Spinner } from "@/components/admin/Spinner";
import {
  type ConnectionTestResult,
  type ConnectionTestStatus,
  getConnectionTestStatus,
  runChatConnectionTest,
  sendTestEmail,
  sendTestSms,
  sendTestVoice,
} from "@/lib/admin/connection-tests-api";

const statusKey = ["admin", "connection-tests", "status"] as const;

export function ConnectionTests() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: getConnectionTestStatus,
    // The configured flags can change when a key is saved above; pick
    // up the new state when the operator returns to the tab.
    refetchOnWindowFocus: true,
  });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Plug className="h-4 w-4" /> Connection tests
        </span>
      }
      subtitle="Send a real test through each channel to confirm the credentials above actually work. Runs against saved values even before the next deploy."
    >
      {isPending ? (
        <Spinner label="Checking what's configured…" />
      ) : isError ? (
        <ErrorPanel error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="space-y-3">
          <ChannelTest
            icon={<Mail className="h-4 w-4" />}
            title="Email (SendGrid)"
            description="Sends a test email to the address you enter."
            configured={data.email.configured}
            field={{ kind: "email", placeholder: "you@example.com" }}
            run={(to) => sendTestEmail(to)}
          />
          <ChannelTest
            icon={<MessageSquare className="h-4 w-4" />}
            title="SMS (Twilio)"
            description="Sends a test text to the number you enter."
            configured={data.sms.configured}
            field={{ kind: "tel", placeholder: "+12155551212" }}
            run={(to) => sendTestSms(to)}
          />
          <ChannelTest
            icon={<Phone className="h-4 w-4" />}
            title="Voice (Twilio)"
            description="Places a short call that speaks a confirmation message, then hangs up."
            configured={data.voice.configured}
            field={{ kind: "tel", placeholder: "+12155551212" }}
            run={(to) => sendTestVoice(to)}
          />
          <ChannelTest
            icon={<Bot className="h-4 w-4" />}
            title="Chat / AI"
            description={chatDescription(data.chat)}
            configured={data.chat.configured}
            field={null}
            run={() => runChatConnectionTest()}
          />
        </div>
      )}
    </Card>
  );
}

function chatDescription(chat: ConnectionTestStatus["chat"]): string {
  if (chat.provider === "offline") {
    return "Pings the active AI provider. None is configured yet.";
  }
  const name = chat.provider === "anthropic" ? "Claude (Anthropic)" : "OpenAI";
  return `Pings the active AI provider (${name}) with a trivial prompt.`;
}

interface FieldSpec {
  kind: "email" | "tel";
  placeholder: string;
}

function ChannelTest({
  icon,
  title,
  description,
  configured,
  field,
  run,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  configured: boolean;
  /** Recipient input spec, or null for a no-input test (chat). */
  field: FieldSpec | null;
  run: (to: string) => Promise<ConnectionTestResult>;
}) {
  const [value, setValue] = useState("");
  const mutation = useMutation<ConnectionTestResult, Error, void>({
    mutationFn: () => run(value.trim()),
  });

  const needsInput = field !== null;
  const inputReady = !needsInput || value.trim().length > 0;
  const canRun = inputReady && !mutation.isPending;

  return (
    <div
      className="rounded-lg border p-3.5 space-y-2.5"
      style={{ borderColor: "hsl(var(--line-2))" }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5 min-w-0">
          <div
            className="flex items-center gap-2 font-medium"
            style={{ color: "hsl(var(--ink-1))" }}
          >
            {icon}
            {title}
          </div>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            {description}
          </p>
        </div>
        {configured ? (
          <Badge variant="success">Configured</Badge>
        ) : (
          <Badge variant="warning">Not configured</Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {needsInput && (
          <div className="flex-1 min-w-[200px]">
            <Input
              type={field.kind === "email" ? "email" : "tel"}
              inputMode={field.kind === "tel" ? "tel" : "email"}
              autoComplete="off"
              spellCheck={false}
              placeholder={field.placeholder}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              aria-label={`Test recipient for ${title}`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canRun) mutation.mutate();
              }}
            />
          </div>
        )}
        <Button
          intent="secondary"
          size="sm"
          disabled={!canRun}
          isLoading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          <Send className="h-3.5 w-3.5" />
          {needsInput ? "Send test" : "Run test"}
        </Button>
      </div>

      {mutation.isError && (
        <ResultLine ok={false}>{errorMessage(mutation.error)}</ResultLine>
      )}
      {mutation.data && <TestResult result={mutation.data} />}
    </div>
  );
}

function TestResult({ result }: { result: ConnectionTestResult }) {
  if (result.ok) {
    return (
      <ResultLine ok>
        <span className="font-medium">Success.</span>{" "}
        {formatDetail(result.detail)}
      </ResultLine>
    );
  }
  return (
    <ResultLine ok={false}>
      <span className="font-medium">{labelForCode(result.code)}.</span>{" "}
      {result.message}
      {result.upstream?.status != null && (
        <span style={{ color: "hsl(var(--ink-3))" }}>
          {" "}
          (status {result.upstream.status})
        </span>
      )}
    </ResultLine>
  );
}

function ResultLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <p
      className="flex items-start gap-1.5 text-xs rounded-md px-2.5 py-2"
      role={ok ? "status" : "alert"}
      style={{
        backgroundColor: ok
          ? "hsl(152 70% 24% / 0.08)"
          : "hsl(354 75% 38% / 0.07)",
        color: ok ? "hsl(152 70% 22%)" : "hsl(354 70% 36%)",
      }}
    >
      {ok ? (
        <Check className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      ) : (
        <X className="h-3.5 w-3.5 shrink-0 mt-0.5" />
      )}
      <span className="min-w-0">{children}</span>
    </p>
  );
}

function formatDetail(detail: Record<string, string | number | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === null || v === "") continue;
    parts.push(`${prettyKey(k)}: ${v}`);
  }
  return parts.join(" · ");
}

function prettyKey(k: string): string {
  switch (k) {
    case "messageId":
      return "Message ID";
    case "messageSid":
      return "Message SID";
    case "callSid":
      return "Call SID";
    case "latencyMs":
      return "Latency (ms)";
    default:
      return k.charAt(0).toUpperCase() + k.slice(1);
  }
}

function labelForCode(code: string): string {
  switch (code) {
    case "not_configured":
      return "Not configured";
    case "upstream_error":
      return "Vendor rejected the request";
    case "config_error":
      return "Configuration error";
    default:
      return "Test failed";
  }
}

function errorMessage(err: unknown): string {
  // Prefer a server-supplied validation message (e.g. "Enter a valid
  // phone number…") over the raw "HTTP 400: invalid_body" that ApiError
  // builds from the error code — the structured issue is what's useful
  // to the operator. ApiError exposes the parsed body on `.data`.
  const validation = firstValidationMessage(err);
  if (validation) return validation;
  if (err && typeof err === "object" && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string" && m.length > 0) return m;
  }
  return "Something went wrong. Try again.";
}

/** Pull the first Zod issue message out of an ApiError's parsed body. */
function firstValidationMessage(err: unknown): string | null {
  const data =
    err && typeof err === "object" ? (err as { data?: unknown }).data : null;
  if (!data || typeof data !== "object") return null;
  const issues = (data as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  for (const issue of issues) {
    const m =
      issue && typeof issue === "object"
        ? (issue as { message?: unknown }).message
        : null;
    if (typeof m === "string" && m.trim().length > 0) return m.trim();
  }
  return null;
}
