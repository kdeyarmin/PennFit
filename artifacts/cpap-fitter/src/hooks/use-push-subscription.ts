// React hook that manages the W3C Web Push opt-in flow for a
// signed-in shop customer (Phase C.1 / feature #4).
//
// State machine:
//   "checking"      — initial; we're discovering current support +
//                     subscription status.
//   "unsupported"   — browser doesn't have ServiceWorker + Push.
//                     (Safari 16+, Firefox, Chrome do.)
//   "not-configured" — server's VAPID public key isn't set; the
//                     toggle is hidden so we don't promise something
//                     we can't deliver.
//   "denied"        — permission was previously denied.
//   "off"           — supported, configured, no subscription yet.
//   "on"            — subscribed and live.
//
// Why a hook + state machine rather than imperative flow: this
// surface lives in the comm-prefs section of /account where users
// also toggle email / SMS prefs. The hook keeps the UI consistent
// with those toggles (read state, render switch, mutate on click).

import { useCallback, useEffect, useState } from "react";

import {
  fetchVapidPublicKey,
  registerPushSubscription,
  unregisterPushSubscription,
  urlBase64ToUint8Array,
} from "@/lib/push-subscriptions-api";

export type PushState =
  | "checking"
  | "unsupported"
  | "not-configured"
  | "denied"
  | "off"
  | "on";

export interface UsePushSubscription {
  state: PushState;
  busy: boolean;
  error: string | null;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
}

export function usePushSubscription(): UsePushSubscription {
  const [state, setState] = useState<PushState>("checking");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vapidKey, setVapidKey] = useState<string | null>(null);

  // Initial discovery: do we have the APIs, and is the server
  // configured to use them.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supported =
        typeof navigator !== "undefined" &&
        "serviceWorker" in navigator &&
        "PushManager" in window;
      if (!supported) {
        if (!cancelled) setState("unsupported");
        return;
      }
      try {
        const key = await fetchVapidPublicKey();
        if (cancelled) return;
        if (!key) {
          setState("not-configured");
          return;
        }
        setVapidKey(key);

        if (Notification.permission === "denied") {
          setState("denied");
          return;
        }

        // Already subscribed? Inspect the registered SW.
        const reg =
          await navigator.serviceWorker.getRegistration("/sw-push.js");
        const existing = await reg?.pushManager.getSubscription();
        if (cancelled) return;
        setState(existing ? "on" : "off");
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          // Treat discovery error as "off" — user can still try.
          setState("off");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const enable = useCallback(async () => {
    if (!vapidKey) return;
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.register("/sw-push.js");
      await navigator.serviceWorker.ready;

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState("denied");
        return;
      }

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // Cast through BufferSource — TypeScript's lib.dom narrows the
        // Uint8Array's buffer type away from the more permissive
        // ArrayBufferLike that we get back from urlBase64ToUint8Array.
        applicationServerKey: urlBase64ToUint8Array(vapidKey) as BufferSource,
      });
      // toJSON() gives us the canonical { endpoint, keys: { auth,
      // p256dh } } shape the server expects.
      const json = sub.toJSON() as PushSubscriptionJSON;
      await registerPushSubscription(json);
      setState("on");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [vapidKey]);

  const disable = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/sw-push.js");
      const sub = await reg?.pushManager.getSubscription();
      const endpoint = sub?.endpoint;
      if (sub) await sub.unsubscribe();
      if (endpoint) {
        // Best-effort server tell so we don't try to send to a dead
        // endpoint. A network blip is OK — the dispatcher will
        // expire-mark it on first 410.
        await unregisterPushSubscription(endpoint).catch(() => {
          // swallow — see comment above.
        });
      }
      setState("off");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  return { state, busy, error, enable, disable };
}
