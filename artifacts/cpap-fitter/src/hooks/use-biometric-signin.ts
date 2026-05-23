// Biometric sign-in hook (Phase D / feature #6).
//
// Wraps the runtime helper with React state + a minimal API the
// sign-in page can drop in:
//
//   const biometric = useBiometricSignIn();
//   if (biometric.available) {
//     <Button onClick={biometric.prompt} disabled={biometric.busy}>
//       Use {biometric.label}
//     </Button>
//   }
//
// The hook deliberately doesn't drive navigation or session
// exchange. It returns a Promise<boolean> from `prompt()` so the
// sign-in page composes whatever follow-up makes sense — typically
// "if biometric ok, hit the silent-resume endpoint; otherwise show
// the password form".

import { useCallback, useEffect, useRef, useState } from "react";

import {
  isNativeApp,
  promptBiometric,
  type BiometricResult,
} from "@/lib/native-runtime";

export interface UseBiometricSignIn {
  /** True only when running inside a native Capacitor shell. The
   *  sign-in page hides the biometric button on plain web. */
  available: boolean;
  /** Cosmetic label for the button. Caller decides; defaults to
   *  "Face ID / Touch ID" until the plugin reports the specific
   *  hardware (a follow-up). */
  label: string;
  busy: boolean;
  /** Last attempt result; null until the user has tried. Useful
   *  for surfacing "denied — try password" copy. */
  lastResult: BiometricResult | null;
  /** Returns true on success. Consumer chains the silent-resume
   *  flow only on `true`. */
  prompt: (reason?: string) => Promise<boolean>;
}

const DEFAULT_LABEL = "Face ID / Touch ID";
const DEFAULT_REASON = "Unlock PennPaps";

export function useBiometricSignIn(): UseBiometricSignIn {
  const [available, setAvailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<BiometricResult | null>(null);
  // Tracks mount state so async callbacks in `prompt()` don't call
  // setState after the component has unmounted (e.g. the user
  // navigates away while the biometric prompt is still open).
  //
  // MUST set `mountedRef.current = true` on every mount inside the
  // effect body, not only the cleanup. In React 18 StrictMode the
  // effect double-invokes: first mount → cleanup → second mount.
  // Without the re-set, the second mount inherits `false` from
  // the cleanup and every subsequent `prompt()` call skips
  // `setBusy(false)` in the finally — the button stays disabled
  // with a spinner forever after the user's first attempt.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const native = await isNativeApp();
      if (!cancelled) setAvailable(native);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const prompt = useCallback(async (reason?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const r = await promptBiometric(reason ?? DEFAULT_REASON);
      if (mountedRef.current) {
        setLastResult(r);
      }
      return r.kind === "ok";
    } finally {
      if (mountedRef.current) {
        setBusy(false);
      }
    }
  }, []);

  return {
    available,
    label: DEFAULT_LABEL,
    busy,
    lastResult,
    prompt,
  };
}
