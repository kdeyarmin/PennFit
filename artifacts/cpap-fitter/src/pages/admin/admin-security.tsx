// /admin/security — per-admin account security settings.
//
// Phase A surface: TOTP enrollment + status + disable. The sign-in
// handler is NOT yet gated on enrollment (that's Phase B); the page
// makes that explicit so an admin doesn't enroll expecting an
// immediate enforcement change.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";

import { Card } from "@/components/admin/Card";
import { Spinner } from "@/components/admin/Spinner";
import { ErrorPanel } from "@/components/admin/ErrorPanel";
import { Button } from "@/components/admin/Button";
import { Input } from "@/components/admin/Input";
import {
  beginEnrollMfa,
  disableMfa,
  getMfaStatus,
  verifyEnrollMfa,
  type BeginEnrollResponse,
  type MfaStatus,
} from "@/lib/admin/mfa-api";

const statusKey = ["admin", "mfa", "status"] as const;

export function AdminSecurityPage() {
  const { data, isPending, isError, error, refetch } = useQuery({
    queryKey: statusKey,
    queryFn: getMfaStatus,
  });

  return (
    <div className="p-6 space-y-6 max-w-3xl">
      <header>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ShieldCheck className="h-6 w-6" />
          Account security
        </h1>
        <p
          className="text-sm mt-1"
          style={{ color: "hsl(var(--ink-3))" }}
        >
          Authenticator-app multi-factor for your admin account. Phase
          A: enrollment is optional and the sign-in flow is not yet
          gated on it. Enrolling now puts the secret in place so the
          team can switch on enforcement when ready.
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

function EnrolledPanel({ data }: { data: MfaStatus }) {
  const qc = useQueryClient();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disable = useMutation({
    mutationFn: () => disableMfa(code.trim()),
    onSuccess: () => {
      setCode("");
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="h-5 w-5 text-emerald-700" />
        <span className="font-medium text-emerald-900">MFA active</span>
      </div>
      <dl className="text-xs grid grid-cols-2 gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">Enrolled on</dt>
        <dd>
          {data.verifiedAt
            ? new Date(data.verifiedAt).toLocaleString()
            : "—"}
        </dd>
        <dt className="text-muted-foreground">Last used</dt>
        <dd>
          {data.lastUsedAt
            ? new Date(data.lastUsedAt).toLocaleString()
            : "—"}
        </dd>
      </dl>

      <div
        className="rounded border p-4 space-y-3"
        style={{ borderColor: "hsl(var(--line-2))" }}
      >
        <p className="text-sm">
          To disable MFA, enter a current 6-digit code from your
          authenticator. This prevents accidental disable from a
          compromised session.
        </p>
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
            style={{ width: "8rem", fontFamily: "monospace" }}
          />
          <Button
            intent="ghost"
            disabled={code.length !== 6 || disable.isPending}
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

  const begin = useMutation({
    mutationFn: beginEnrollMfa,
    onSuccess: (r) => {
      setEnrollState(r);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const verify = useMutation({
    mutationFn: () => verifyEnrollMfa(code.trim()),
    onSuccess: () => {
      setEnrollState(null);
      setCode("");
      void qc.invalidateQueries({ queryKey: statusKey });
    },
    onError: (e: Error) => setError(e.message),
  });

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
        Open your authenticator app and either scan the QR or type the
        secret manually. Then enter the 6-digit code it shows.
      </p>

      {/* The SPA renders an SVG QR client-side via a tiny QR
          generator. To avoid adding a dependency, we surface the
          otpauth URI as a copy-friendly link and the base32 secret
          for manual entry. Authenticator apps all accept manual
          entry of the secret string. */}
      <div
        className="rounded border p-4 space-y-3 font-mono text-xs"
        style={{ borderColor: "hsl(var(--line-1))" }}
      >
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
