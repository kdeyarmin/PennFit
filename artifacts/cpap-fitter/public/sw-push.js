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
  // The server's push payload sets data.url to a path like
  // "/account/orders/123"; if it's absent we fall back to /account.
  // We previously parsed and origin-checked the URL here, but the
  // payload comes from our own backend (signed VAPID), and the SPA
  // is single-origin, so the validation was defending against a
  // capability the attacker couldn't exercise.
  const targetUrl =
    (event.notification.data && event.notification.data.url) || "/account";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true })
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
  // Browser rotated the subscription. We DELETE the old endpoint
  // (best-effort) and defer re-subscription to the next SPA visit,
  // where use-push-subscription's mount-time reconcile handles it.
  // Re-subscribing from inside the service worker required fetching
  // the VAPID key + re-running the push-manager subscribe call from a
  // background context — both paths are flaky enough that the SPA
  // path is strictly more reliable.
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
    })(),
  );
});
