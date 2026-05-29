// Static source-analysis tests for public/sw-push.js.
//
// The vitest environment is "node" (no DOM/jsdom) so we read the file
// as a string and assert structural and behavioural properties rather
// than importing or executing it.
//
// These tests pin the canonical service-worker behaviour that ships on
// main. A feature branch once tried to simplify the worker (drop the
// notificationclick same-origin guard, gut the pushsubscriptionchange
// re-subscribe flow, and delete urlBase64ToUint8Array); that change was
// reverted on main, so the worker retains all three:
//
//   1. notificationclick — keeps the same-origin URL-validation block;
//      the handler parses the candidate URL against self.location.origin
//      and falls back to /account on a cross-origin / malformed payload.
//
//   2. pushsubscriptionchange — keeps the full re-subscribe flow (DELETE
//      old endpoint → fetch VAPID key → pushManager.subscribe → POST new
//      sub) so PWA users who rarely reopen the app don't silently lose
//      push when the browser rotates their subscription.
//
//   3. urlBase64ToUint8Array — defined in the worker and used to turn the
//      base64url VAPID key into the applicationServerKey for re-subscribe.

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
// notificationclick — same-origin URL handling
// ---------------------------------------------------------------------------
//
// History: an earlier revision of this file simplified the click handler
// to assign `targetUrl` directly from `event.notification.data.url`,
// dropping the same-origin guard on the rationale that the push payload
// is minted by our own backend behind signed VAPID. PR #340 review then
// re-added the guard as defense-in-depth (CodeRabbit thread on PR #340,
// commit 0428ac9). The current shape uses `rawTarget` as the
// pre-validation variable and falls back to `/account` if either the
// origin check fails or the URL is malformed.
describe("sw-push.js notificationclick — same-origin URL handling", () => {
  it("uses rawTarget as the pre-validation variable, not rawUrl", () => {
    // `rawUrl` was the name of the variable in the original guard the
    // simplification commit removed; the re-added guard uses `rawTarget`.
    // The test pins the current name so a future rename re-surfaces
    // here intentionally.
    expect(SW_SRC).toContain("const rawTarget =");
    expect(SW_SRC).not.toContain("const rawUrl =");
  });

  it("falls back to /account when event.notification.data.url is absent", () => {
    expect(SW_SRC).toContain('|| "/account"');
  });

  it("parses the candidate URL against self.location.origin", () => {
    expect(SW_SRC).toContain("new URL(rawTarget, self.location.origin)");
  });

  it("only navigates to URLs whose origin matches self.location.origin", () => {
    expect(SW_SRC).toContain("parsed.origin === self.location.origin");
  });

  it("falls back to /account on a malformed URL (try/catch guard)", () => {
    // The catch arm reassigns targetUrl back to /account so a crafted
    // payload can't crash the click handler.
    expect(SW_SRC).toMatch(/catch[\s\S]{0,80}targetUrl\s*=\s*"\/account"/);
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
describe("sw-push.js pushsubscriptionchange — re-subscribe flow retained", () => {
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

  it("fetches the VAPID public key from the server to re-subscribe", () => {
    // The flow fetches:
    //   /resupply-api/shop/me/push-subscriptions/vapid-public-key
    expect(SW_SRC).toContain("vapid-public-key");
  });

  it("calls pushManager.subscribe inside pushsubscriptionchange", () => {
    // reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }).
    expect(SW_SRC).toContain("pushManager.subscribe");
  });

  it("POSTs the new subscription back to the server in pushsubscriptionchange", () => {
    // After re-subscribing, the new sub JSON is POSTed back so the server
    // can replace the rotated credentials.
    const handlerStart = SW_SRC.indexOf('addEventListener("pushsubscriptionchange"');
    const handlerSrc = SW_SRC.slice(handlerStart);
    expect(handlerSrc).toContain('method: "POST"');
  });

  it("derives applicationServerKey for the re-subscribe call", () => {
    expect(SW_SRC).toContain("applicationServerKey");
  });

  it("uses event.waitUntil with an async IIFE", () => {
    expect(SW_SRC).toContain("event.waitUntil(");
    expect(SW_SRC).toContain("(async () => {");
  });
});

// ---------------------------------------------------------------------------
// urlBase64ToUint8Array — removed from service worker
// ---------------------------------------------------------------------------
describe("sw-push.js — urlBase64ToUint8Array retained", () => {
  it("defines a urlBase64ToUint8Array function", () => {
    expect(SW_SRC).toContain("function urlBase64ToUint8Array");
  });

  it("references urlBase64ToUint8Array to build the applicationServerKey", () => {
    expect(SW_SRC).toContain("urlBase64ToUint8Array");
  });

  it("performs the URL-safe base64-padding replacement", () => {
    // The function replaces `-` with `+` and `_` with `/` before atob so a
    // base64url VAPID key decodes correctly.
    expect(SW_SRC).toContain(".replace(/-/g, \"+\")");
    expect(SW_SRC).toContain(".replace(/_/g, \"/\")");
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
