// Provider MFA enrollment — mandatory before the document queue opens.
//
// Step 1: "Begin" mints a TOTP secret; we show the manual-entry key +
//         an otpauth:// link (no QR-code library is bundled; a QR is a
//         follow-up). The provider adds it to their authenticator app.
// Step 2: enter the 6-digit code to confirm; on success we show the
//         one-time recovery codes and let them continue to the queue.

import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Copy, Check } from "lucide-react";

import {
  beginProviderMfa,
  verifyProviderMfa,
  type ProviderMfaBegin,
} from "@/lib/provider/provider-api";
import { Button, Card, ErrorNote, ProviderShell } from "./provider-ui";

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function ProviderMfaSetup({
  providerName,
}: {
  providerName?: string | null;
}) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const [begin, setBegin] = useState<ProviderMfaBegin | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const beginMut = useMutation({
    mutationFn: beginProviderMfa,
    onSuccess: (data) => {
      setBegin(data);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const verifyMut = useMutation({
    mutationFn: () => verifyProviderMfa(code.trim()),
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes ?? []);
      setError(null);
      // Bust the provider-me cache so ProviderPortalRoute re-reads
      // mfaEnrolled: true and exits the setup redirect loop.
      void qc.invalidateQueries({ queryKey: ["provider", "me"] });
    },
    onError: (err: Error) => setError(err.message),
  });

  function copySecret() {
    if (!begin) return;
    navigator.clipboard?.writeText(begin.secretBase32).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => undefined,
    );
  }

  // Final screen: recovery codes shown once.
  if (recoveryCodes) {
    return (
      <ProviderShell providerName={providerName}>
        <Card className="mx-auto max-w-lg p-6">
          <h1 className="text-xl font-bold text-slate-900">Two-factor is on</h1>
          <p className="mt-1 text-sm text-slate-500">
            Save these one-time recovery codes somewhere safe. Each can be used
            once if you lose access to your authenticator app. They won't be
            shown again.
          </p>
          {recoveryCodes.length > 0 ? (
            <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg border border-slate-200 bg-slate-50 p-4 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
          ) : null}
          <Button
            className="mt-6 w-full"
            onClick={() => setLocation("/provider")}
          >
            Continue to my documents
          </Button>
        </Card>
      </ProviderShell>
    );
  }

  return (
    <ProviderShell providerName={providerName}>
      <Card className="mx-auto max-w-lg p-6">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-50 text-blue-700">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
          </span>
          <div>
            <h1 className="text-xl font-bold text-slate-900">
              Set up two-factor authentication
            </h1>
            <p className="text-sm text-slate-500">
              Required to protect patient health information.
            </p>
          </div>
        </div>

        {error ? (
          <div className="mt-4">
            <ErrorNote>{error}</ErrorNote>
          </div>
        ) : null}

        {!begin ? (
          <div className="mt-6 space-y-4 text-sm text-slate-600">
            <p>
              You'll need an authenticator app (Google Authenticator, Authy,
              1Password, Microsoft Authenticator, etc.) on your phone.
            </p>
            <Button
              onClick={() => beginMut.mutate()}
              disabled={beginMut.isPending}
            >
              {beginMut.isPending ? "Preparing…" : "Begin setup"}
            </Button>
          </div>
        ) : (
          <form
            className="mt-6 space-y-5"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              verifyMut.mutate();
            }}
          >
            <div className="space-y-2">
              <p className="text-sm font-medium text-slate-700">
                1. Add this key to your authenticator app
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-sm">
                  {begin.secretBase32}
                </code>
                <Button type="button" variant="secondary" onClick={copySecret}>
                  {copied ? (
                    <Check className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Copy className="h-4 w-4" aria-hidden="true" />
                  )}
                </Button>
              </div>
              <a
                href={begin.otpauthUri}
                className="inline-block text-sm text-blue-700 hover:underline"
              >
                Or tap here on your phone to add it automatically
              </a>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-slate-700">
                2. Enter the 6-digit code it shows
              </label>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className={`${inputClass} tracking-[0.4em] text-center text-lg`}
              />
            </div>

            <Button
              type="submit"
              disabled={verifyMut.isPending || code.length !== 6}
              className="w-full"
            >
              {verifyMut.isPending ? "Verifying…" : "Turn on two-factor"}
            </Button>
          </form>
        )}
      </Card>
    </ProviderShell>
  );
}
