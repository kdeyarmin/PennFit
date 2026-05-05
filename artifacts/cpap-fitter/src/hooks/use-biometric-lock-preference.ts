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

// Module-level subscriber set so every hook instance in the same tab
// stays in sync when any caller invokes setEnabled(). Without this,
// BiometricLockGate and BiometricLockToggle each keep a private copy
// of the value and diverge after the first write.
type Listener = (next: boolean) => void;
const listeners = new Set<Listener>();

function readFromStorage(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

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
    setEnabledState(readFromStorage());
    setLoaded(true);

    // Keep in sync with changes from other hook instances in this tab.
    listeners.add(setEnabledState);

    // Keep in sync with changes from other browser tabs/windows.
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) {
        setEnabledState(e.newValue === "1");
      }
    };
    window.addEventListener("storage", onStorage);

    return () => {
      listeners.delete(setEnabledState);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    try {
      if (next) {
        window.localStorage.setItem(STORAGE_KEY, "1");
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      // Notify all hook instances in this tab only after a successful
      // storage write. If localStorage is blocked (private browsing),
      // we leave the in-memory state unchanged so it stays consistent
      // with what will be read on the next page load.
      listeners.forEach((cb) => cb(next));
    } catch {
      // ignore — private-browsing modes block localStorage
    }
  }, []);

  return { enabled, setEnabled, loaded };
}
