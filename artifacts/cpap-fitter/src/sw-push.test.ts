// Static source-analysis tests for public/sw-push.js.
//
// The vitest environment is "node" (no DOM/jsdom) so we read the file
// as a string and assert structural and behavioural properties rather
// than importing or executing it.
//
// This PR simplified the service worker in two areas:
//
//   1. notificationclick — removed the same-origin URL-validation block;
//      the handler now reads event.notification.data.url directly as
//      `targetUrl` without the rawUrl / URL-parsing guard path.
//
//   2. pushsubscriptionchange — removed the re-subscribe flow (fetch
//      VAPID key → pushManager.subscribe → POST new sub); it now only
//      issues a DELETE for the old endpoint and defers re-subscription
//      to the next SPA visit.
//
//   3. urlBase64ToUint8Array — removed from the service worker entirely;
//      the SPA's use-push-subscription hook supplies the key via the
//      push-subscriptions-api helper instead.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SW_SRC = readFileSync(
  path.join(__dirname, "../public/sw-push.js"),
  "utf8",
);

// ---------------------------------------------------------------------------
// notificationclick — simplified URL handling
// ---------------------------------------------------------------------------
describe("sw-push.js notificationclick — simplified URL handling", () => {
  it("assigns targetUrl directly from event.notification.data.url (no rawUrl indirection)", () => {
    // After the simplification the assignment is a single expression:
    //   const targetUrl = (event.notification.data && event.notification.data.url) || "/account";
    // No `rawUrl` variable exists at all.
    expect(SW_SRC).toContain("const targetUrl =");
    expect(SW_SRC).not.toContain("const rawUrl =");
  });

  it("falls back to /account when event.notification.data.url is absent", () => {
    expect(SW_SRC).toContain('|| "/account"');
  });

  it("does NOT contain the same-origin URL-validation try/catch block", () => {
    // The removed block parsed the URL with `new URL(rawUrl, self.location.origin)` and
    // checked `parsed.origin === self.location.origin`.
    expect(SW_SRC).not.toContain("new URL(rawUrl");
    expect(SW_SRC).not.toContain("parsed.origin === self.location.origin");
  });

  it("does NOT contain the rawUrl startsWith('/') path-validation branch", () => {
    expect(SW_SRC).not.toContain("rawUrl.startsWith");
  });

  it("does NOT contain a try/catch wrapping the URL validation", () => {
    // The removed try/catch had the comment "Malformed URL — keep the /account fallback."
    expect(SW_SRC).not.toContain("Malformed URL");
  });

  it("does NOT contain protocol-relative URL guard (startsWith '//')", () => {
    // The removed guard excluded `//` (protocol-relative) URLs.
    expect(SW_SRC).not.toContain("startsWith(\"/\\/\\/\")");
    expect(SW_SRC).not.toContain('startsWith("//")');
  });

  it("still uses self.clients.matchAll to re-focus an existing tab", () => {
    expect(SW_SRC).toContain(
      "self.clients.matchAll({ type: \"window\", includeUncontrolled: true })",
    );
  });

  it("still falls back to self.clients.openWindow when no matching tab is found", () => {
    expect(SW_SRC).toContain("self.clients.openWindow(targetUrl)");
  });

  it("still calls client.navigate(targetUrl) and client.focus()", () => {
    expect(SW_SRC).toContain("client.navigate(targetUrl)");
    expect(SW_SRC).toContain("client.focus()");
  });

  it("still closes the notification before navigating", () => {
    // event.notification.close() must be the first thing inside the listener.
    const listenerBody = SW_SRC.slice(
      SW_SRC.indexOf('addEventListener("notificationclick"'),
    );
    const closeIdx = listenerBody.indexOf("event.notification.close()");
    const waitIdx = listenerBody.indexOf("event.waitUntil(");
    expect(closeIdx).toBeGreaterThan(-1);
    expect(closeIdx).toBeLessThan(waitIdx);
  });
});

// ---------------------------------------------------------------------------
// pushsubscriptionchange — re-subscribe flow removed
// ---------------------------------------------------------------------------
describe("sw-push.js pushsubscriptionchange — re-subscribe flow removed", () => {
  it("still registers a pushsubscriptionchange event listener", () => {
    expect(SW_SRC).toContain('addEventListener("pushsubscriptionchange"');
  });

  it("still deletes the old endpoint when oldSubscription is present", () => {
    expect(SW_SRC).toContain("oldEndpoint");
    expect(SW_SRC).toContain(
      'method: "DELETE"',
    );
    expect(SW_SRC).toContain(
      "/resupply-api/shop/me/push-subscriptions",
    );
  });

  it("does NOT fetch the VAPID public key from the server", () => {
    // The removed block fetched:
    //   /resupply-api/shop/me/push-subscriptions/vapid-public-key
    expect(SW_SRC).not.toContain("vapid-public-key");
  });

  it("does NOT call pushManager.subscribe inside pushsubscriptionchange", () => {
    // The removed flow called reg.pushManager.subscribe({ userVisibleOnly: true, ... }).
    expect(SW_SRC).not.toContain("pushManager.subscribe");
  });

  it("does NOT POST a new subscription to the server in pushsubscriptionchange", () => {
    // The removed block posted the new sub JSON back. After removal only a
    // DELETE call remains. Verify there's no POST inside this handler.
    const handlerStart = SW_SRC.indexOf('addEventListener("pushsubscriptionchange"');
    const handlerSrc = SW_SRC.slice(handlerStart);
    // The entire pushsubscriptionchange handler should not contain 'method: "POST"'
    // (the push handler and notificationclick don't send POST either).
    expect(handlerSrc).not.toContain('method: "POST"');
  });

  it("does NOT define or call applicationServerKey inside pushsubscriptionchange", () => {
    expect(SW_SRC).not.toContain("applicationServerKey");
  });

  it("uses event.waitUntil with an async IIFE", () => {
    expect(SW_SRC).toContain("event.waitUntil(");
    expect(SW_SRC).toContain("(async () => {");
  });
});

// ---------------------------------------------------------------------------
// urlBase64ToUint8Array — removed from service worker
// ---------------------------------------------------------------------------
describe("sw-push.js — urlBase64ToUint8Array removed", () => {
  it("does not define a urlBase64ToUint8Array function", () => {
    expect(SW_SRC).not.toContain("function urlBase64ToUint8Array");
  });

  it("does not reference urlBase64ToUint8Array anywhere", () => {
    expect(SW_SRC).not.toContain("urlBase64ToUint8Array");
  });

  it("does not perform the base64-padding replacement that urlBase64ToUint8Array did", () => {
    // The removed function replaced `-` with `+` and `_` with `/` for URL-safe base64.
    // Now that the function is gone, neither replacement should appear in the file.
    expect(SW_SRC).not.toContain(".replace(/-/g, \"+\")");
    expect(SW_SRC).not.toContain(".replace(/_/g, \"/\")");
  });
});

// ---------------------------------------------------------------------------
// Baseline: install/activate/push listeners still present
// ---------------------------------------------------------------------------
describe("sw-push.js — install/activate/push listeners still present", () => {
  it("still registers an install listener that calls skipWaiting()", () => {
    expect(SW_SRC).toContain('addEventListener("install"');
    expect(SW_SRC).toContain("self.skipWaiting()");
  });

  it("still registers an activate listener that calls clients.claim()", () => {
    expect(SW_SRC).toContain('addEventListener("activate"');
    expect(SW_SRC).toContain("self.clients.claim()");
  });

  it("still registers a push listener that calls showNotification()", () => {
    expect(SW_SRC).toContain('addEventListener("push"');
    expect(SW_SRC).toContain("self.registration.showNotification(");
  });

  it("push listener falls back to generic title when event.data is missing", () => {
    expect(SW_SRC).toContain('payload.title || "PennPaps"');
  });

  it("push listener stashes url in notification data for the click handler", () => {
    expect(SW_SRC).toContain('data: { url: payload.url || "/account" }');
  });

  it("push listener uses the expected icon path", () => {
    expect(SW_SRC).toContain('icon: "/icon-192.png"');
  });
});
