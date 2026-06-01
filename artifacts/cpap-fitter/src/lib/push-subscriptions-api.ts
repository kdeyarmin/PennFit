// Hand-rolled fetch wrappers for the W3C Web Push registration
// endpoints (Phase C.1 / feature #4).

import { csrfHeader } from "./csrf";

export async function fetchVapidPublicKey(): Promise<string | null> {
  const res = await fetch(
    "/resupply-api/shop/me/push-subscriptions/vapid-public-key",
    { headers: { Accept: "application/json" }, credentials: "include" },
  );
  if (res.status === 503) return null; // server not configured for push
  if (!res.ok) {
    throw new Error(`Failed to load VAPID key (${res.status})`);
  }
  const j = (await res.json()) as { publicKey: string };
  return j.publicKey;
}

export async function registerPushSubscription(
  sub: PushSubscriptionJSON,
): Promise<void> {
  const res = await fetch("/resupply-api/shop/me/push-subscriptions", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify(sub),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to register subscription (${res.status}): ${text}`);
  }
}

export async function unregisterPushSubscription(
  endpoint: string,
): Promise<void> {
  const res = await fetch("/resupply-api/shop/me/push-subscriptions", {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json", ...csrfHeader() },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok && res.status !== 204) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Failed to unregister subscription (${res.status}): ${text}`,
    );
  }
}

/**
 * Convert a base64-url string (the format VAPID public keys are
 * served in) to the Uint8Array PushManager.subscribe expects.
 * Standard helper from the W3C Web Push spec example; we inline it
 * rather than pulling in the `urlsafe-base64` package.
 */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    out[i] = rawData.charCodeAt(i);
  }
  return out;
}
