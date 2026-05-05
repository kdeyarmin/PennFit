// Biometric-lock preference hook (Phase F.4 — Phase D follow-up).
//
// Stores the "lock /account behind biometric" setting in
// localStorage so it persists across app restarts. Web treats the
// preference as inert (the actual gate component checks
// isNativeApp() before showing the lock UI), so flipping the
// toggle on web is a no-op rather than a confusing block.
//
// Why localStorage rather than the comm-prefs blob: this is a
// device-local preference, not a customer-wide one. A patient
// might want biometric required on their personal phone but not
// on a tablet at home; storing it in the comm-prefs blob would
// mirror it across every device they sign in from.

import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "pennpaps:biometric-lock-enabled";

export interface UseBiometricLockPreference {
  enabled: boolean;
  setEnabled: (next: boolean) => void;
  /** True until the initial localStorage read resolves. Avoids
   *  a flicker from "default-off" to "user-set-on" on first paint. */
  loaded: boolean;
}

export function useBiometricLockPreference(): UseBiometricLockPreference {
  const [enabled, setEnabledState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") {
      setLoaded(true);
      return;
    }
    try {
      setEnabledState(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Private-browsing modes block localStorage; default to off.
    }
    setLoaded(true);
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    try {
      if (next) {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore — see above
    }
  }, []);

  return { enabled, setEnabled, loaded };
}
