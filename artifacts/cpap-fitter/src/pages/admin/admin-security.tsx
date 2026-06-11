// /admin/security — per-admin account security settings.
//
// Phase A surface: TOTP enrollment + status + disable. The sign-in
// handler is NOT yet gated on enrollment (that's Phase B); the page
// makes that explicit so an admin doesn't enroll expecting an
// immediate enforcement change.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  KeyRound,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";

import { QrCode } from "@/components/QrCode";
import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import { useConfirmDialog } from "@/hooks/use-confirm-dialog";
import {
  beginEnrollMfa,
  disableMfa,
  disableMfaDevice,
  getMfaStatus,
  regenerateRecoveryCodes,
  verifyEnrollMfa,
  type BeginEnrollResponse,
  type MfaDevice,
  type MfaStatus,
} from "@/lib/admin/mfa-api";
const statusKey = ["admin", "mfa", "status"] as const;

export function AdminSecurityPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: getMfaStatus,
  });

  return (
    <div className="admin-root p-6 space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" />
          Account security
        </h1>
        <p className="text-sm mt-1" style={{ color: "hsl(var(--ink-3))" }}>
          Authenticator-app multi-factor for your admin account. Phase A:
          enrollment is optional and the sign-in flow is not yet gated on it.
          Enrolling now puts the secret in place so the team can switch on
          enforcement when ready.
        </p>
      </header>

      <Card
        title={
          <span className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Multi-factor authentication
          </span>
        }
      >
        {isPending ? (
          <Spinner />
        ) : isError ? (
          <ErrorPanel error={error} onRetry={() => void refetch()} />
        ) : data.enrolled ? (
          <EnrolledPanel data={data} />
        ) : (
          <UnenrolledPanel inProgress={data.inProgressEnrollment} />
        )}
      </Card>
    </div>
  );
}

/**
 * Render the enrolled-MFA management panel for an admin account.
 *
 * Displays enrollment metadata (enrolled date, last used, recovery codes remaining), the list of enrolled devices, warnings when recovery codes are low or absent, and controls to regenerate recovery codes, disable MFA, or add another device. Handles inline display of newly regenerated one-time recovery codes and delegates destructive confirmations to the provided confirm dialog hook.
 *
 * @param data - The current MFA status used to populate device lists, timestamps, and recovery code counts
 * @returns The React element representing the enrolled MFA management UI
 */
function EnrolledPanel({ data }: { data: MfaStatus }) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // After regenerate succeeds we render the one-time codes panel
  // inline, then dismissal returns to the normal Enrolled view.
  const [regeneratedCodes, setRegeneratedCodes] = useState<string[] | null>(
    null,
  );
  // Multi-device — when the admin wants to add another authenticator,
  // we route into the same enrollment flow the UnenrolledPanel uses.
  const [addingDevice, setAddingDevice] = useState(false);
  const disable = useMutation({
    mutationFn: () => disableMfa(code.trim()),
    onSuccess: () => {
      setCode("");
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => setError(e.message),
  });
  const regenerate = useMutation({
    mutationFn: () => regenerateRecoveryCodes(code.trim()),
    onSuccess: (r) => {
      setCode("");
      setError(null);
      setRegeneratedCodes(r.recoveryCodes);
      // status query refetched after dismissal — keep the
      // "10 of 10" badge accurate.
    },
    onError: (e: Error) => setError(e.message),
  });

  if (regeneratedCodes) {
    return (
      <RecoveryCodesPanel
        codes={regeneratedCodes}
        onDone={() => {
          setRegeneratedCodes(null);
          void qc.invalidateQueries({ queryKey: statusKey });
        }}
      />
    );
  }

  if (addingDevice) {
    // Reuse the unenrolled flow — it talks to the same /enroll/begin
    // and /enroll/verify endpoints, which after migration 0091 happily
    // stack another verified row onto the admin's account.
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => setAddingDevice(false)}
          className="text-xs text-muted-foreground hover:underline"
        >
          ← Back to enrolled devices
        </button>
        <UnenrolledPanel inProgress={data.inProgressEnrollment} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-700" />
        <span className="font-medium text-emerald-900">MFA active</span>
      </div>
      <dl className="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Enrolled on</dt>
        <dd>
          {data.verifiedAt ? new Date(data.verifiedAt).toLocaleString() : "—"}
        </dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {data.lastUsedAt ? new Date(data.lastUsedAt).toLocaleString() : "—"}
        </dd>
        <dt className="text-muted-foreground">Recovery codes left</dt>
        <dd>{data.recoveryCodesRemaining} of 10</dd>
      </dl>

      <DeviceList devices={data.devices} code={code} />

      {data.recoveryCodesRemaining === 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            You have no recovery codes left. Regenerate a fresh batch below
            (you&apos;ll need a current authenticator code).
          </div>
        </div>
      )}
      {data.recoveryCodesRemaining > 0 && data.recoveryCodesRemaining <= 3 && (
        <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            Only {data.recoveryCodesRemaining} recovery code
            {data.recoveryCodesRemaining === 1 ? "" : "s"} remaining. Regenerate
            a fresh batch below to keep your fallback intact.
          </div>
        </div>
      )}

      <div
        className="rounded border p-4 space-y-3"
        style={{ borderColor: "hsl(var(--line-2))" }}
      >
        <p className="text-sm">
          Enter a current 6-digit code from your authenticator app, then choose
          an action. The code requirement prevents a compromised session from
          quietly disabling MFA or rotating your recovery codes.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, "").slice(0, 6));
              setError(null);
            }}
            placeholder="123456"
            maxLength={6}
            inputMode="numeric"
            autoComplete="one-time-code"
            aria-label="Authenticator code"
            style={{ width: "8rem", fontFamily: "monospace" }}
          />
          <Button
            intent="ghost"
            disabled={
              code.length !== 6 || regenerate.isPending || disable.isPending
            }
            isLoading={regenerate.isPending}
            onClick={async () => {
              if (
                !(await confirm({
                  title: "Regenerate recovery codes?",
                  description:
                    "Generate a fresh batch of 10 recovery codes? Your existing codes will stop working.",
                  confirmLabel: "Regenerate",
                  destructive: true,
                }))
              )
                return;
              regenerate.mutate();
            }}
          >
            Regenerate recovery codes
          </Button>
          <Button
            intent="ghost"
            disabled={
              code.length !== 6 || regenerate.isPending || disable.isPending
            }
            isLoading={disable.isPending}
            onClick={() => disable.mutate()}
          >
            Disable MFA
          </Button>
        </div>
        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            {error}
          </div>
        )}
      </div>

      <div>
        <Button intent="ghost" onClick={() => setAddingDevice(true)}>
          + Add another device
        </Button>
      </div>
      {ConfirmDialogEl}
    </div>
  );
}

function UnenrolledPanel({ inProgress }: { inProgress: boolean }) {
  const qc = useQueryClient();
  const [enrollState, setEnrollState] = useState<BeginEnrollResponse | null>(
    null,
  );
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Lives outside the panel's mount: once we've shown the codes,
  // the status query refetches enrolled=true and the UnenrolledPanel
  // unmounts — by then the user has the strip in front of them and
  // we DON'T want to keep the plaintext in memory longer than we
  // have to. We don't persist it.
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [deviceLabel, setDeviceLabel] = useState("");

  const begin = useMutation({
    mutationFn: () =>
      beginEnrollMfa(deviceLabel.trim() ? deviceLabel.trim() : undefined),
    onSuccess: (r) => {
      setEnrollState(r);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const verify = useMutation({
    mutationFn: () => verifyEnrollMfa(code.trim()),
    onSuccess: (r) => {
      setEnrollState(null);
      setCode("");
      if (r.recoveryCodes && r.recoveryCodes.length > 0) {
        setRecoveryCodes(r.recoveryCodes);
        // Defer the status refetch until the user dismisses the
        // recovery-code dialog — otherwise the EnrolledPanel
        // replaces us mid-display and the codes disappear.
      } else {
        // No codes returned (insert failed or already-verified
        // re-verify). Refetch immediately.
        void qc.invalidateQueries({ queryKey: statusKey });
      }
    },
    onError: (e: Error) => setError(e.message),
  });

  if (recoveryCodes) {
    return (
      <RecoveryCodesPanel
        codes={recoveryCodes}
        onDone={() => {
          setRecoveryCodes(null);
          void qc.invalidateQueries({ queryKey: statusKey });
        }}
      />
    );
  }

  if (!enrollState) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-amber-700" />
          <span className="font-medium text-amber-900">MFA not enrolled</span>
        </div>
        <p className="text-sm text-muted-foreground">
          {inProgress
            ? "There's an in-progress enrollment that wasn't completed. Click Begin to mint a fresh secret."
            : "Install an authenticator app on your phone (Google Authenticator, Authy, 1Password, etc.) before you start. The setup takes about a minute."}
        </p>
        {error && (
          <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
            {error}
          </div>
        )}
        <div>
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground block mb-1">
            Device label (optional)
          </label>
          <Input
            value={deviceLabel}
            onChange={(e) => setDeviceLabel(e.target.value.slice(0, 64))}
            placeholder="iPhone, Yubikey, Desktop authy…"
            aria-label="Device label"
            style={{ width: "16rem" }}
          />
        </div>
        <Button
          onClick={() => begin.mutate()}
          isLoading={begin.isPending}
          disabled={begin.isPending}
        >
          Begin enrollment
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm">
        Open your authenticator app and either scan the QR or type the secret
        manually. Then enter the 6-digit code it shows.
      </p>

      <div
        className="rounded border p-4 space-y-3 font-mono text-xs"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        <div className="flex justify-center">
          <QrCode
            value={enrollState.otpauthUri}
            ariaLabel="Authenticator enrollment QR code"
          />
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
            Setup key (manual entry)
          </div>
          <div className="break-all">{enrollState.secretBase32}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
            Or open this in your authenticator app
          </div>
          <a
            href={enrollState.otpauthUri}
            className="break-all text-[hsl(var(--penn-navy))] hover:underline"
          >
            {enrollState.otpauthUri}
          </a>
        </div>
        <div className="text-[10px] text-muted-foreground">
          Issuer: {enrollState.issuer} · Account: {enrollState.label}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={code}
          onChange={(e) =>
            setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
          }
          placeholder="123456"
          maxLength={6}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label="Authenticator code"
          style={{ width: "8rem", fontFamily: "monospace" }}
        />
        <Button
          disabled={code.length !== 6 || verify.isPending}
          isLoading={verify.isPending}
          onClick={() => verify.mutate()}
        >
          Confirm code + finish enrollment
        </Button>
      </div>

      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          {error}
        </div>
      )}
    </div>
  );
}

/** Shown EXACTLY ONCE after enrollment-verify succeeds. The codes
 *  never leave the user's session — there's no read API that
 *  returns them. The "I've saved these" button is the only way out
 *  of this view; it dismisses the codes and transitions the page
 *  into the EnrolledPanel via a status refetch. */
function RecoveryCodesPanel({
  codes,
  onDone,
}: {
  codes: string[];
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API may be unavailable in some browser/security
      // contexts — the codes are still visible on-screen.
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-700" />
        <span className="font-medium text-emerald-900">
          MFA enrolled — save your recovery codes
        </span>
      </div>

      <div className="flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
        <div>
          <strong>This is the only time these codes will be shown.</strong> Save
          them somewhere safe (password manager, sealed envelope in your desk).
          Each code can be used <em>once</em> to sign in if you ever lose your
          authenticator app.
        </div>
      </div>

      <div
        className="rounded border p-4 grid grid-cols-2 gap-2 font-mono text-sm"
        style={{ borderColor: "hsl(var(--line-1))" }}
        data-testid="recovery-codes"
      >
        {codes.map((c) => (
          <div key={c} className="select-all">
            {c}
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button intent="ghost" onClick={() => void handleCopy()}>
          {copied ? "Copied" : "Copy all"}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          I've saved these in a safe place
        </label>
        <Button disabled={!confirmed} onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

/**
 * Render a list of enrolled MFA devices with per-device removal controls.
 *
 * Each device shows its label, added date, and last-used date. The "Remove"
 * button is shown only when more than one device is enrolled and requires the
 * current 6-digit TOTP `code` to be present; removal opens a confirmation
 * dialog and invalidates the MFA status query on success. Returns null when
 * `devices` is empty.
 *
 * @param devices - The enrolled MFA devices to display
 * @param code - The current global 6-digit TOTP code used to authorize removals
 */
function DeviceList({ devices, code }: { devices: MfaDevice[]; code: string }) {
  const qc = useQueryClient();
  const [confirm, ConfirmDialogEl] = useConfirmDialog();
  const remove = useMutation({
    mutationFn: (id: string) => disableMfaDevice(id, code.trim()),
    onSuccess: () => void qc.invalidateQueries({ queryKey: statusKey }),
  });
  if (devices.length === 0) return null;
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">
        Enrolled devices ({devices.length})
      </div>
      <ul
        className="rounded border divide-y text-xs"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
        {devices.map((d) => (
          <li
            key={d.id}
            className="px-3 py-2 flex items-center justify-between gap-3"
            style={{ borderColor: "hsl(var(--line-1))" }}
          >
            <div className="min-w-0">
              <div className="font-medium">{d.label ?? "Unnamed device"}</div>
              <div className="text-[10px] text-muted-foreground">
                Added {new Date(d.createdAt).toLocaleDateString()}
                {d.lastUsedAt
                  ? ` · last used ${new Date(d.lastUsedAt).toLocaleDateString()}`
                  : " · never used"}
              </div>
            </div>
            {devices.length > 1 && (
              <Button
                intent="ghost"
                size="sm"
                disabled={code.length !== 6 || remove.isPending}
                onClick={async () => {
                  if (
                    !(await confirm({
                      title: "Remove device?",
                      description: `Remove "${d.label ?? "this device"}"? Other devices and recovery codes stay active.`,
                      confirmLabel: "Remove",
                      destructive: true,
                    }))
                  )
                    return;
                  remove.mutate(d.id);
                }}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>
      {remove.error instanceof Error && (
        <p className="text-[10px] text-rose-700 mt-1">{remove.error.message}</p>
      )}
      {ConfirmDialogEl}
    </div>
  );
}
