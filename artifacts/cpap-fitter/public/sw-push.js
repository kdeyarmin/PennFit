// PennPaps push-notification service worker (Phase C.1, feature #4).
//
// Purpose: receive Web Push events from the server and surface them
// as browser notifications, plus open /account on click.
//
// Why a SEPARATE worker file from any future generic service worker:
// keeping push concerns isolated means the dispatcher can register
// + unregister this worker independently of any caching / offline
// logic. The SPA registers it on demand from `usePushSubscription`
// when the user explicitly opts in — never automatically on load,
// to avoid surprising people with permission prompts.

self.addEventListener("install", (event) => {
  // Skip waiting so the worker activates the moment we register
  // it; the dispatcher only sends pushes to ACTIVE workers.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // Server payload shape: { title, body, url?, tag? }.
  // We tolerate a missing event.data (some browsers fire empty
  // pushes) by falling back to a generic copy.
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_err) {
      payload = { title: "PennPaps", body: event.data.text() };
    }
  }
  const title = payload.title || "PennPaps";
  const options = {
    body: payload.body || "",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    // `tag` lets repeated pushes for the same thing collapse rather
    // than stack (e.g. "your shipment is out for delivery" with two
    // tracking updates becomes one notification).
    tag: payload.tag || undefined,
    // Stash url so the click handler can route correctly.
    data: { url: payload.url || "/account" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  // Defense-in-depth same-origin guard. The push payload is minted by
  // our own backend behind signed VAPID, so in normal operation
  // data.url is always a same-origin path like "/account/orders/123".
  // If the VAPID private key ever leaked an attacker could craft a
  // payload that pointed at an external URL — clicking the notification
  // would open the attacker's site through clients.openWindow(), which
  // is good phishing material. We parse the URL against the SW's own
  // origin and only navigate when the resulting origin matches;
  // anything else (cross-origin, malformed) falls back to /account.
  const rawTarget =
    (event.notification.data && event.notification.data.url) || "/account";
  let targetUrl = "/account";
  try {
    const parsed = new URL(rawTarget, self.location.origin);
    if (parsed.origin === self.location.origin) {
      targetUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
  } catch (_err) {
    targetUrl = "/account";
  }
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clientList) => {
        // Re-focus an existing PennPaps tab if one is open; otherwise
        // open a new one. This matches the standard W3C example and
        // avoids spawning a new tab on every click.
        for (const client of clientList) {
          if (
            new URL(client.url).origin === self.location.origin &&
            "focus" in client
          ) {
            client.navigate(targetUrl);
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      }),
  );
});

self.addEventListener("pushsubscriptionchange", (event) => {
  // Browser rotated the subscription. We must re-subscribe and post
  // the new credentials back, otherwise users with the PWA installed
  // but rarely open it (typical CPAP-resupply patients) silently lose
  // push — the SPA's reconcile-on-visit path only fires when they
  // come back, which may be never. Steps:
  //
  //   1. DELETE the old endpoint from the server (best-effort).
  //   2. Fetch the VAPID public key from /resupply-api so we can
  //      subscribe again.
  //   3. Call pushManager.subscribe() with the fresh key.
  //   4. POST the new subscription back to the server.
  //
  // Anything that fails is logged and falls through to the next
  // visit's reconcile; we never re-throw because the browser won't
  // surface a useful error from a background event.
  event.waitUntil(
    (async () => {
      const oldEndpoint = event.oldSubscription
        ? event.oldSubscription.endpoint
        : null;
      if (oldEndpoint) {
        try {
          await fetch("/resupply-api/shop/me/push-subscriptions", {
            method: "DELETE",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ endpoint: oldEndpoint }),
          });
        } catch (_err) {
          // Network blip on a background event — ignore.
        }
      }
      try {
        const keyResp = await fetch(
          "/resupply-api/shop/me/push-subscriptions/vapid-public-key",
          { credentials: "include" },
        );
        if (!keyResp.ok) return;
        const { publicKey } = await keyResp.json();
        if (!publicKey || typeof publicKey !== "string") return;
        const applicationServerKey = urlBase64ToUint8Array(publicKey);
        const reg = await self.registration;
        const newSub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey,
        });
        const json = newSub.toJSON();
        await fetch("/resupply-api/shop/me/push-subscriptions", {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(json),
        });
      } catch (_err) {
        // Re-subscribe failed. Next SPA visit will reconcile via
        // the on-mount push-prompt-banner flow.
      }
    })(),
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) {
    out[i] = rawData.charCodeAt(i);
  }
  return out;
}
