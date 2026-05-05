// Server-side web-push helper (Phase G.1 — Phase C.1 follow-up).
//
// Wraps the `web-push` npm library so the rest of the API only sees a
// small typed surface: `isPushConfigured()` + `sendPushToCustomer()`.
//
// What this module owns:
//
//   1. Reading the VAPID env triple (PUBLIC / PRIVATE / SUBJECT) and
//      exposing a `configured: boolean` so dispatchers can no-op when
//      a deployer hasn't generated keys yet.
//   2. Loading every active push subscription for a customer and
//      firing one notification per row in parallel.
//   3. Translating the push service's HTTP response into one of three
//      typed outcomes:
//        * delivered    — 2xx, the push service accepted the payload
//        * expired      — 404 / 410, the subscription is permanently
//                         dead. We mark `expired_at` so the dispatcher
//                         skips it next time.
//        * transient    — anything else (4xx caps, 5xx, network). The
//                         caller decides whether to retry; we don't
//                         delete the row.
//   4. Audit-friendly counts: dispatchers get back `{ delivered,
//      expired, transient }` and log the structural counts only —
//      never the payload, never the endpoint URL.
//
// Why a tiny wrapper rather than calling web-push directly: the
// library throws on non-2xx responses, which means every caller would
// need to remember the 404/410 mark-expired dance. Centralizing it
// here keeps the dispatcher code straight-line and audit-correct.

import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";

import {
  getDbPool,
  shopCustomerPushSubscriptions,
  shopCustomers,
} from "@workspace/resupply-db";

import { logger } from "../logger";

export interface PushPayload {
  title: string;
  body: string;
  /** Deep link the SPA's service worker opens on click. Passed
   *  through as provided; callers should supply the exact URL/path
   *  they want clients to open. */
  url?: string;
  /** Tag groups same-kind notifications so a re-send replaces the
   *  prior one rather than stacking. */
  tag?: string;
}

export interface DeliveryCounts {
  delivered: number;
  expired: number;
  transient: number;
}

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  /** RFC 8292 "sub" claim — must be a `mailto:` URL or HTTPS. */
  subject: string;
}

/**
 * Reads the VAPID env triple. Returns null when any of the three is
 * missing or blank — every caller treats null as "feature off, skip
 * silently" (mirrors the SendGrid-not-configured pattern).
 */
export function readPushConfig(): PushConfig | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export function isPushConfigured(): boolean {
  return readPushConfig() !== null;
}

/**
 * The minimal slice of the web-push package we depend on. Defined
 * here (rather than importing the package's own types) so a unit
 * test can pass a stub without touching the network.
 */
export interface WebPushSdk {
  setVapidDetails: (
    subject: string,
    publicKey: string,
    privateKey: string,
  ) => void;
  sendNotification: (
    subscription: { endpoint: string; keys: { auth: string; p256dh: string } },
    payload: string,
  ) => Promise<unknown>;
}

let cachedSdk: WebPushSdk | null = null;
let sdkLoadFailed = false;

/**
 * Lazily resolve the `web-push` module via dynamic import so bundlers
 * can tree-shake it. If the import fails (for example because the
 * optional package is not installed), we record that failure and
 * return null on subsequent calls rather than retrying.
 */
async function loadSdk(): Promise<WebPushSdk | null> {
  if (cachedSdk) return cachedSdk;
  if (sdkLoadFailed) return null;
  try {
    const mod = (await import("web-push")) as unknown as {
      default?: WebPushSdk;
    } & WebPushSdk;
    cachedSdk = mod.default ?? mod;
    return cachedSdk;
  } catch {
    sdkLoadFailed = true;
    return null;
  }
}

/** Test-only override; pass null to clear. */
export function __setSdkForTesting(sdk: WebPushSdk | null): void {
  cachedSdk = sdk;
  sdkLoadFailed = false;
}

/**
 * Send `payload` to every active subscription belonging to
 * `customerId`. Marks 404/410 rows as expired so the dispatcher
 * doesn't re-send to dead endpoints. Returns the per-outcome counts.
 *
 * Caller is responsible for authorization: this helper trusts that
 * `customerId` was already pulled off an authenticated request /
 * worker job context.
 */
export async function sendPushToCustomer(
  customerId: string,
  payload: PushPayload,
): Promise<DeliveryCounts> {
  const config = readPushConfig();
  if (!config) {
    logger.warn(
      { customerId },
      "web_push_not_configured — set WEB_PUSH_VAPID_PUBLIC_KEY / _PRIVATE_KEY / _SUBJECT to enable delivery",
    );
    return { delivered: 0, expired: 0, transient: 0 };
  }
  const sdk = await loadSdk();
  if (!sdk) {
    logger.warn(
      { customerId },
      "web_push_sdk_missing — install web-push to enable delivery",
    );
    return { delivered: 0, expired: 0, transient: 0 };
  }
  sdk.setVapidDetails(config.subject, config.publicKey, config.privateKey);

  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopCustomerPushSubscriptions.id,
      endpoint: shopCustomerPushSubscriptions.endpoint,
      authB64: shopCustomerPushSubscriptions.authB64,
      p256dhB64: shopCustomerPushSubscriptions.p256dhB64,
    })
    .from(shopCustomerPushSubscriptions)
    .where(
      and(
        eq(shopCustomerPushSubscriptions.customerId, customerId),
        isNull(shopCustomerPushSubscriptions.expiredAt),
      ),
    )
    .limit(50);

  if (rows.length === 0) {
    return { delivered: 0, expired: 0, transient: 0 };
  }

  const serialized = JSON.stringify({
    title: payload.title,
    body: payload.body,
    url: payload.url ?? null,
    tag: payload.tag ?? null,
  });

  let delivered = 0;
  let expired = 0;
  let transient = 0;

  await Promise.all(
    rows.map(async (row) => {
      try {
        await sdk.sendNotification(
          {
            endpoint: row.endpoint,
            keys: { auth: row.authB64, p256dh: row.p256dhB64 },
          },
          serialized,
        );
        delivered += 1;
      } catch (err) {
        const status = pushErrorStatus(err);
        if (status === 404 || status === 410) {
          expired += 1;
          await markExpired(row.id);
        } else {
          transient += 1;
          // Audit-safe: log status + customer + row id only. No body.
          logger.warn(
            {
              customerId,
              subscriptionId: row.id,
              status: status ?? null,
            },
            "web_push_transient_failure",
          );
        }
      }
    }),
  );

  return { delivered, expired, transient };
}

/**
 * Convenience: resolve a customer by `email_lower` and fan out
 * push to whatever active subscriptions they have. Returns
 * {0,0,0} when no shop_customers row matches the email — useful
 * for patient-side dispatchers (smart-trigger, Rx renewal) where
 * the patient may or may not also be a shop customer.
 *
 * Lower-casing happens here so callers can pass any-case input
 * without thinking about it.
 *
 * email_lower is not unique — if more than one shop_customers row
 * shares the same email we treat the lookup as ambiguous and skip
 * push (returns {0,0,0}) rather than risk delivering a PHI-tagged
 * notification to the wrong device.
 */
export async function sendPushToCustomerByEmail(
  email: string,
  payload: PushPayload,
): Promise<DeliveryCounts> {
  const lower = email.trim().toLowerCase();
  if (!lower) return { delivered: 0, expired: 0, transient: 0 };
  if (!isPushConfigured()) {
    return { delivered: 0, expired: 0, transient: 0 };
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select({ customerId: shopCustomers.customerId })
    .from(shopCustomers)
    .where(eq(shopCustomers.emailLower, lower))
    .limit(2);
  if (rows.length === 0) {
    return { delivered: 0, expired: 0, transient: 0 };
  }
  if (rows.length > 1) {
    logger.warn("web_push_customer_email_ambiguous");
    return { delivered: 0, expired: 0, transient: 0 };
  }
  return sendPushToCustomer(rows[0].customerId, payload);
}

/**
 * The SDK throws a `WebPushError` on non-2xx, which carries
 * `statusCode`. We don't want to import the class for an instanceof
 * check (would couple this module to the package's runtime even when
 * it's missing), so duck-type instead.
 */
function pushErrorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { statusCode?: unknown };
  return typeof e.statusCode === "number" ? e.statusCode : null;
}

async function markExpired(subscriptionId: string): Promise<void> {
  try {
    const db = drizzle(getDbPool());
    await db
      .update(shopCustomerPushSubscriptions)
      .set({ expiredAt: new Date(), updatedAt: new Date() })
      .where(eq(shopCustomerPushSubscriptions.id, subscriptionId));
  } catch (err) {
    logger.warn(
      { subscriptionId, err: (err as Error).message },
      "web_push_mark_expired_failed",
    );
  }
}
