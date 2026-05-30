// Biometric lock gate (Phase F.4 / Phase D follow-up).
//
// Wraps a region (typically /account) so that on native iOS /
// Android, when the customer has previously opted into "require
// Face ID to open the app", the region is gated behind a fresh
// biometric prompt on every cold launch.
//
// Purely additive: web users + customers who haven't enabled the
// preference render children unchanged.
//
// Why session-scoped (sessionStorage), not localStorage: we only
// want to require biometric ONCE per app launch, not once per
// route navigation. Killing + reopening the app fires another
// prompt. localStorage would persist across cold launches and
// make the lock useless after the first unlock.

import { useEffect, useState, type ReactNode } from "react";
import { Lock, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useBiometricLockPreference } from "@/hooks/use-biometric-lock-preference";
import {
  isNativeApp,
  promptBiometric,
  getNativePlatform,
} from "@/lib/native-runtime";

const SESSION_FLAG = "pennpaps:biometric-unlocked";

type GateState =
  | { kind: "checking" }
  | { kind: "unlocked" }
  | { kind: "needs-prompt" }
  | { kind: "denied"; message: string }
  | { kind: "error"; message: string };

export function BiometricLockGate({ children }: { children: ReactNode }) {
  const pref = useBiometricLockPreference();
  const [state, setState] = useState<GateState>({ kind: "checking" });

  useEffect(() => {
    if (!pref.loaded) return;
    let cancelled = false;
    void (async () => {
      // Bypass: pref off OR running on web.
      if (!pref.enabled) {
        if (!cancelled) setState({ kind: "unlocked" });
        return;
      }
      const native = await isNativeApp();
      if (!native) {
        if (!cancelled) setState({ kind: "unlocked" });
        return;
      }
      // Already unlocked this session?
      try {
        if (window.sessionStorage.getItem(SESSION_FLAG) === "1") {
          if (!cancelled) setState({ kind: "unlocked" });
          return;
        }
      } catch {
        // sessionStorage blocked — fall through to prompt.
      }
      if (!cancelled) setState({ kind: "needs-prompt" });
    })();
    return () => {
      cancelled = true;
    };
  }, [pref.loaded, pref.enabled]);

  const tryUnlock = async () => {
    setState({ kind: "checking" });
    const result = await promptBiometric("Unlock PennPaps");
    if (result.kind === "ok") {
      try {
        window.sessionStorage.setItem(SESSION_FLAG, "1");
      } catch {
        // ignore
      }
      setState({ kind: "unlocked" });
      return;
    }
    if (result.kind === "denied") {
      const platform = getNativePlatform();
      const settingsPath =
        platform === "ios"
          ? "Settings → PennPaps → Face ID & Passcode"
          : platform === "android"
            ? "Settings → Apps → PennPaps → Permissions"
            : "your device's app settings";
      setState({
        kind: "denied",
        message:
          result.reason === "user-cancel"
            ? "Cancelled — tap below to try again."
            : result.reason === "lockout"
              ? "Too many attempts. Lock your phone, then try again."
              : `Permission denied. Open ${settingsPath} to allow biometric authentication.`,
      });
      return;
    }
    if (result.kind === "not-supported") {
      // Hardware missing or plugin not installed. Don't trap the
      // user — fall open.
      setState({ kind: "unlocked" });
      return;
    }
    setState({ kind: "error", message: result.message });
  };

  if (state.kind === "unlocked") return <>{children}</>;

  return (
    <div
      className="min-h-[60vh] flex items-center justify-center px-4 py-12"
      data-testid="biometric-lock-gate"
    >
      <div className="max-w-sm w-full rounded-2xl border border-border bg-background/80 p-6 text-center">
        <div className="h-12 w-12 mx-auto rounded-full bg-[hsl(var(--penn-navy)/0.08)] flex items-center justify-center mb-3">
          <Lock className="w-5 h-5 text-[hsl(var(--penn-navy))]" />
        </div>
        <h1 className="text-base font-semibold text-[hsl(var(--penn-navy))]">
          Locked
        </h1>
        <p className="text-xs text-muted-foreground mt-1.5">
          You asked PennPaps to require Face ID / Touch ID before opening your
          account. One quick scan and you&apos;re back in.
        </p>

        {state.kind === "checking" && (
          <div
            className="mt-4 inline-flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="biometric-lock-checking"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Verifying…
          </div>
        )}

        {(state.kind === "needs-prompt" ||
          state.kind === "denied" ||
          state.kind === "error") && (
          <div className="mt-4 space-y-2">
            <Button
              type="button"
              onClick={() => void tryUnlock()}
              data-testid="biometric-lock-prompt"
            >
              Use Face ID / Touch ID
            </Button>
            {(state.kind === "denied" || state.kind === "error") && (
              <p
                className="text-[11px] text-rose-700"
                role="alert"
                data-testid="biometric-lock-error"
              >
                {state.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
