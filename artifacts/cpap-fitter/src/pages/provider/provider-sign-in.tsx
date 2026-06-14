// Provider portal sign-in — two-step like the admin flow:
//   1. Email + password → POST /api/provider/auth/sign-in
//   2. If MFA enrolled → 6-digit code (or recovery code) →
//      POST /api/provider/auth/sign-in/verify-mfa
// On success, redirect to /provider (which routes to MFA setup if the
// provider hasn't enrolled yet).

import { useState, type FormEvent } from "react";
import { useLocation } from "wouter";

import { AuthError, authErrorMessage } from "@workspace/resupply-auth-react";

import { providerAuthHooks } from "@/lib/provider/provider-auth";
import { Button, Card, ErrorNote, ProviderAuthLayout } from "./provider-ui";

type Step = { kind: "password" } | { kind: "mfa"; challengeToken: string };

const inputClass =
  "w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100";

export function ProviderSignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [usingRecovery, setUsingRecovery] = useState(false);
  const [step, setStep] = useState<Step>({ kind: "password" });
  const [error, setError] = useState<string | null>(null);
  const signIn = providerAuthHooks.useSignIn();
  const verifyMfa = providerAuthHooks.useVerifySignInMfa();
  const [, setLocation] = useLocation();

  function onPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    signIn.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (result) => {
          if (result.mfaRequired) {
            setStep({ kind: "mfa", challengeToken: result.challengeToken });
            setCode("");
          } else {
            setLocation("/provider");
          }
        },
        onError: (err) =>
          setError(
            authErrorMessage(err, {
              action: "sign you in",
              subject: "password",
              fallback:
                "We couldn't sign you in. Check your email and password.",
            }),
          ),
      },
    );
  }

  function onMfaSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (step.kind !== "mfa") return;
    setError(null);
    const payload = usingRecovery
      ? {
          challengeToken: step.challengeToken,
          recoveryCode: recoveryCode.trim(),
        }
      : { challengeToken: step.challengeToken, code: code.trim() };
    verifyMfa.mutate(payload, {
      onSuccess: () => setLocation("/provider"),
      onError: (err) => {
        if (
          err instanceof AuthError &&
          (err.code === "mfa_challenge_expired" ||
            err.code === "mfa_challenge_invalid")
        ) {
          setStep({ kind: "password" });
          setPassword("");
          setError("Your session timed out. Please enter your password again.");
          return;
        }
        setError(
          authErrorMessage(err, {
            action: "verify your code",
            subject: "code",
            fallback: "That code didn't work. Please try again.",
          }),
        );
      },
    });
  }

  return (
    <ProviderAuthLayout>
      <Card className="p-6">
        {step.kind === "password" ? (
          <form onSubmit={onPasswordSubmit} className="space-y-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900">Sign in</h1>
              <p className="mt-1 text-sm text-slate-500">
                Review and electronically sign documents for your patients.
              </p>
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Email
              </label>
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value);
                  setError(null);
                }}
                className={inputClass}
              />
            </div>
            <div className="space-y-1">
              <label className="text-sm font-medium text-slate-700">
                Password
              </label>
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
                className={inputClass}
              />
            </div>
            <Button
              type="submit"
              disabled={signIn.isPending}
              className="w-full"
            >
              {signIn.isPending ? "Signing in…" : "Continue"}
            </Button>
            {/*
              Provider accounts authenticate against /api/provider/auth/*,
              which has no self-service reset flow. Don't link to the
              customer storefront's /forgot-password — that posts to a
              different auth backend and can't reset a provider account.
              Recovery is coordinator-mediated.
            */}
            <p className="text-center text-sm text-slate-500">
              Locked out? Contact your PennPaps coordinator to reset your
              access.
            </p>
          </form>
        ) : (
          <form onSubmit={onMfaSubmit} className="space-y-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900">
                Two-factor verification
              </h1>
              <p className="mt-1 text-sm text-slate-500">
                {usingRecovery
                  ? "Enter one of your backup recovery codes."
                  : "Enter the 6-digit code from your authenticator app."}
              </p>
            </div>
            {error ? <ErrorNote>{error}</ErrorNote> : null}
            {usingRecovery ? (
              <input
                inputMode="text"
                autoComplete="one-time-code"
                placeholder="ABCD-EFGH"
                value={recoveryCode}
                onChange={(e) => setRecoveryCode(e.target.value)}
                className={inputClass}
              />
            ) : (
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                className={`${inputClass} tracking-[0.4em] text-center text-lg`}
              />
            )}
            <Button
              type="submit"
              disabled={verifyMfa.isPending}
              className="w-full"
            >
              {verifyMfa.isPending ? "Verifying…" : "Verify"}
            </Button>
            <div className="flex items-center justify-between text-sm">
              <button
                type="button"
                className="text-blue-700 hover:underline"
                onClick={() => {
                  setUsingRecovery((v) => !v);
                  setError(null);
                }}
              >
                {usingRecovery
                  ? "Use authenticator code"
                  : "Use a recovery code"}
              </button>
              <button
                type="button"
                className="text-slate-500 hover:underline"
                onClick={() => {
                  setStep({ kind: "password" });
                  setError(null);
                }}
              >
                Start over
              </button>
            </div>
          </form>
        )}
      </Card>
    </ProviderAuthLayout>
  );
}
