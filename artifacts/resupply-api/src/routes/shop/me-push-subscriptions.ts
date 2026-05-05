// /shop/me/push-subscriptions — W3C Web Push registration for the
// signed-in shop customer (Phase C.1 / feature #4).
//
//   GET    /shop/me/push-subscriptions/vapid-public-key
//          — returns the server's VAPID public key. The SPA passes
//            it to PushManager.subscribe().
//   POST   /shop/me/push-subscriptions
//          — register / upsert a subscription. Body is the
//            PushSubscription.toJSON() shape from the browser.
//   DELETE /shop/me/push-subscriptions
//          — by-endpoint unregister (browser already revoked or
//            customer toggled push off).
//
// Why upsert on endpoint: the browser hands us the SAME endpoint
// every time the user re-grants permission. Inserting a new row on
// each grant would accumulate dead duplicates. UPSERT on endpoint
// = at most one row per device-browser pair. The auth_b64 / p256dh
// keys CAN rotate on re-subscribe, so we update them.
//
// The actual server-side push send (using the `web-push` package)
// is deferred to a follow-up phase — this PR establishes the data
// path; no dispatcher uses it yet.
//
// Privacy: the endpoint URL is push-service-specific (Mozilla,
// Apple, Google). User agent is informational. We never log
// anything beyond customer_id + count in request logs.

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";

import {
  getDbPool,
  shopCustomerPushSubscriptions,
} from "@workspace/resupply-db";

import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

// Body shape from PushSubscription.toJSON(). Browsers all converge
// on this shape. We accept exactly the fields we use.
const subscribeBody = z
  .object({
    endpoint: z.string().url().max(2048),
    keys: z
      .object({
        auth: z.string().min(1).max(512),
        p256dh: z.string().min(1).max(512),
      })
      .strict(),
    // Optional — most browsers expose `expirationTime` but it's
    // typically null on Chrome/Firefox/Safari.
    expirationTime: z.number().nullable().optional(),
  })
  .strict();

const unsubscribeBody = z
  .object({
    endpoint: z.string().url().max(2048),
  })
  .strict();

router.get(
  "/shop/me/push-subscriptions/vapid-public-key",
  requireSignedIn,
  async (_req, res) => {
    const key = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
    if (!key) {
      // Same shape as other "feature not configured" responses in
      // the codebase. The SPA hides the "Enable push" toggle when
      // it sees this.
      res.status(503).json({
        error: "push_not_configured",
        message: "Push notifications are not configured on this server.",
      });
      return;
    }
    res.json({ publicKey: key });
  },
);

router.post(
  "/shop/me/push-subscriptions",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const parsed = subscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const { endpoint, keys } = parsed.data;
    const userAgent = req.get("user-agent")?.slice(0, 500) ?? null;

    const db = drizzle(getDbPool());
    const now = new Date();

    // Upsert on endpoint. If the row exists we re-bind it to this
    // customer (browser permission grants don't carry identity, so a
    // new sign-in on the same browser legitimately rebinds the
    // subscription) and clear any prior expired_at marker.
    await db
      .insert(shopCustomerPushSubscriptions)
      .values({
        customerId,
        endpoint,
        authB64: keys.auth,
        p256dhB64: keys.p256dh,
        userAgent,
      })
      .onConflictDoUpdate({
        target: shopCustomerPushSubscriptions.endpoint,
        set: {
          customerId,
          authB64: keys.auth,
          p256dhB64: keys.p256dh,
          userAgent,
          expiredAt: null,
          updatedAt: now,
        },
      });

    res.status(204).send();
  },
);

router.delete(
  "/shop/me/push-subscriptions",
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    const parsed = unsubscribeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_body",
        issues: parsed.error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      });
      return;
    }

    const db = drizzle(getDbPool());
    // Defense-in-depth: only delete rows that belong to the caller.
    // A malicious actor who learns another user's endpoint can't
    // unsubscribe them.
    await db
      .delete(shopCustomerPushSubscriptions)
      .where(
        and(
          eq(shopCustomerPushSubscriptions.endpoint, parsed.data.endpoint),
          eq(shopCustomerPushSubscriptions.customerId, customerId),
        ),
      );

    res.status(204).send();
  },
);

router.get("/shop/me/push-subscriptions", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const db = drizzle(getDbPool());
  const rows = await db
    .select({
      id: shopCustomerPushSubscriptions.id,
      endpoint: shopCustomerPushSubscriptions.endpoint,
      userAgent: shopCustomerPushSubscriptions.userAgent,
      createdAt: shopCustomerPushSubscriptions.createdAt,
    })
    .from(shopCustomerPushSubscriptions)
    .where(
      and(
        eq(shopCustomerPushSubscriptions.customerId, customerId),
        isNull(shopCustomerPushSubscriptions.expiredAt),
      ),
    )
    .limit(50);
  res.json({
    subscriptions: rows.map((r) => ({
      id: r.id,
      // We deliberately DON'T return the endpoint URL on the SPA —
      // it's a capability token. The client only needs id +
      // user-agent for the "you have N devices subscribed" badge.
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

export default router;
