// /admin/email-settings — a tenant's own outbound email From identity.
//
// A DME tenant can send patient email from its OWN From address; otherwise
// mail uses the platform default. Backed by organizations.from_email /
// from_name (migration 0360). Surfaces a live SendGrid domain-auth status
// so an unauthenticated (spam-bound) sender is caught before it's used.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, HelpCircle, Mail } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import {
  fetchEmailSettings,
  updateEmailSettings,
  type DomainAuth,
} from "@/lib/admin/email-settings-api";

const INPUT_STYLE: React.CSSProperties = {
  background: "hsl(var(--surface-1))",
  borderColor: "hsl(var(--line-1))",
  color: "hsl(var(--ink-1))",
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_QUERY_KEY = ["admin", "email-settings"] as const;

export function AdminEmailSettingsPage() {
  const queryClient = useQueryClient();
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: EMAIL_QUERY_KEY,
    queryFn: fetchEmailSettings,
  });

  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");

  useEffect(() => {
    if (data) {
      setFromEmail(data.fromEmail ?? "");
      setFromName(data.fromName ?? "");
    }
  }, [data]);

  async function invalidate() {
    await queryClient.invalidateQueries({ queryKey: EMAIL_QUERY_KEY });
  }

  const save = useMutation({
    mutationFn: () =>
      updateEmailSettings({
        fromEmail: fromEmail.trim() || null,
        fromName: fromName.trim() || null,
      }),
    onSuccess: invalidate,
  });

  const clear = useMutation({
    mutationFn: () => updateEmailSettings({ fromEmail: null, fromName: null }),
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

  const emailValid = fromEmail.trim() === "" || EMAIL_RE.test(fromEmail.trim());
  const anyPending = save.isPending || clear.isPending;
  const dirty =
    fromEmail.trim() !== (data.fromEmail ?? "") ||
    fromName.trim() !== (data.fromName ?? "");

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
        <h1 className="text-2xl font-semibold">Email From address</h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Send patient email (receipts, reminders, review requests) from your
          own address instead of the platform default. Internal and account
          emails (password resets, operator alerts) always use the platform
          address.
        </p>
      </header>

      <Card title="Current sender">
        {data.fromEmail ? (
          <div className="space-y-2">
            <p className="text-base font-semibold">
              {data.fromName ? `${data.fromName} ` : ""}
              &lt;{data.fromEmail}&gt;
            </p>
            <DomainAuthBanner auth={data.domainAuth} />
          </div>
        ) : (
          <p className="text-sm" style={{ color: "hsl(var(--ink-3))" }}>
            Using the platform default:{" "}
            <span className="font-semibold">
              {data.platformDefaultName} &lt;{data.platformDefaultEmail}&gt;
            </span>
            . Set your own address below to brand outbound patient email.
          </p>
        )}
      </Card>

      <Card title="Set your From address">
        <div className="space-y-3">
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>From address</span>
            <input
              className="mt-1 w-full max-w-md rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={fromEmail}
              placeholder="info@yourcompany.com"
              onChange={(e) => setFromEmail(e.target.value)}
            />
          </label>
          {!emailValid && (
            <p className="text-sm" style={{ color: "#b45309" }}>
              Enter a valid email address.
            </p>
          )}
          <label className="block text-sm">
            <span style={{ color: "hsl(var(--ink-2))" }}>
              From name (display name)
            </span>
            <input
              className="mt-1 w-full max-w-md rounded-md border px-2.5 py-1.5 text-sm"
              style={INPUT_STYLE}
              value={fromName}
              placeholder="Your Company Name"
              onChange={(e) => setFromName(e.target.value)}
            />
          </label>
          <p className="text-xs" style={{ color: "hsl(var(--ink-3))" }}>
            A display name alone has no effect — your custom sender only takes
            over once a From address is set. Authenticate your sending domain
            (SPF/DKIM) in SendGrid first, or mail will land in spam.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
              style={{ background: "hsl(var(--penn-navy))" }}
              disabled={anyPending || !emailValid || !dirty}
              onClick={() => save.mutate()}
            >
              <Mail className="h-4 w-4" />
              {save.isPending ? "Saving…" : "Save sender"}
            </button>
            {data.fromEmail && (
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-md border px-4 py-2 text-sm font-semibold disabled:opacity-50"
                style={{
                  borderColor: "hsl(var(--line-1))",
                  color: "hsl(var(--ink-1))",
                }}
                disabled={anyPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Reset to the platform default From address? Patient email will no longer be branded to your address.",
                    )
                  ) {
                    clear.mutate();
                  }
                }}
              >
                {clear.isPending ? "Resetting…" : "Reset to default"}
              </button>
            )}
          </div>
          {(mutationError(save) || mutationError(clear)) && (
            <p className="text-sm" style={{ color: "#dc2626" }}>
              {mutationError(save) ?? mutationError(clear)}
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}

function DomainAuthBanner({ auth }: { auth: DomainAuth }) {
  const tone =
    auth.status === "authenticated"
      ? { bg: "#ecfdf5", border: "#a7f3d0", fg: "#065f46", Icon: CheckCircle2 }
      : auth.status === "unauthenticated"
        ? {
            bg: "#fffbeb",
            border: "#fde68a",
            fg: "#92400e",
            Icon: AlertTriangle,
          }
        : { bg: "#f8fafc", border: "#e2e8f0", fg: "#475569", Icon: HelpCircle };
  const { Icon } = tone;
  return (
    <div
      className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
      style={{ background: tone.bg, borderColor: tone.border, color: tone.fg }}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0" aria-hidden />
      <span>{auth.detail}</span>
    </div>
  );
}
