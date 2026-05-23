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
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { isPushConfigured } from "../../lib/web-push";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

// Domain allowlist for push subscription endpoints. The Web Push API
// only ever produces endpoints on these four host families — anything
// else is either a bug, a stale client, or an SSRF attempt routing
// our server's encrypted POSTs through an attacker-controlled host.
// (We DO encrypt the body with the subscriber's public key, but the
// fact of a POST + headers + timing is still a side-channel we'd
// rather not lend out for free.)
const PUSH_ENDPOINT_HOST_ALLOWLIST = [
  // FCM (Chrome, Edge, Opera, Brave, most Android).
  /\.googleapis\.com$/,
  /\.google\.com$/,
  // Mozilla autopush (Firefox).
  /\.mozaws\.net$/,
  /\.mozilla\.com$/,
  // Microsoft (Edge legacy / WNS).
  /\.windows\.com$/,
  /\.notify\.windows\.com$/,
  // Apple (Safari).
  /\.push\.apple\.com$/,
  /\.web\.push\.apple\.com$/,
];

function isAllowedPushEndpoint(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  return PUSH_ENDPOINT_HOST_ALLOWLIST.some((re) => re.test(host));
}

// Body shape from PushSubscription.toJSON(). Browsers all converge
// on this shape. We accept exactly the fields we use.
const subscribeBody = z
  .object({
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine(
        isAllowedPushEndpoint,
        "endpoint must be a recognised browser push service",
      ),
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
    endpoint: z
      .string()
      .url()
      .max(2048)
      .refine(
        isAllowedPushEndpoint,
        "endpoint must be a recognised browser push service",
      ),
  })
  .strict();

router.get(
  "/shop/me/push-subscriptions/vapid-public-key",
  requireSignedIn,
  async (_req, res) => {
    // Phase G.8: gate on the full VAPID triple, not just the public
    // key. If a deployer has set the public key but the server can't
    // actually sign+send (missing PRIVATE / SUBJECT), the SPA must
    // hide the "Enable push" toggle — otherwise we'd accept
    // subscriptions we can never deliver to, accumulating dead rows
    // and silently failing for users who think they opted in.
    if (!isPushConfigured()) {
      res.status(503).json({
        error: "push_not_configured",
        message: "Push notifications are not configured on this server.",
      });
      return;
    }
    const key = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
    if (!key) {
      // Defensive — isPushConfigured() above already required this,
      // but a concurrent env mutation could in principle race. Keep
      // the 503 path explicit so the SPA always sees a typed error.
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

    const supabase = getSupabaseServiceRoleClient();

    // Upsert on endpoint. If the row exists we re-bind it to this
    // customer (browser permission grants don't carry identity, so a
    // new sign-in on the same browser legitimately rebinds the
    // subscription) and clear any prior expired_at marker.
    const { error } = await supabase
      .schema("resupply")
      .from("shop_customer_push_subscriptions")
      .upsert(
        {
          customer_id: customerId,
          endpoint,
          auth_b64: keys.auth,
          p256dh_b64: keys.p256dh,
          user_agent: userAgent,
          expired_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "endpoint" },
      );
    if (error) throw error;

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

    const supabase = getSupabaseServiceRoleClient();
    // Defense-in-depth: only delete rows that belong to the caller.
    // A malicious actor who learns another user's endpoint can't
    // unsubscribe them.
    const { error } = await supabase
      .schema("resupply")
      .from("shop_customer_push_subscriptions")
      .delete()
      .eq("endpoint", parsed.data.endpoint)
      .eq("customer_id", customerId);
    if (error) throw error;

    res.status(204).send();
  },
);

router.get("/shop/me/push-subscriptions", requireSignedIn, async (req, res) => {
  const customerId = req.userCustomerId;
  if (!customerId) {
    res.status(401).json({ error: "sign_in_required" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: rows, error } = await supabase
    .schema("resupply")
    .from("shop_customer_push_subscriptions")
    .select("id, user_agent, created_at")
    .eq("customer_id", customerId)
    .is("expired_at", null)
    .limit(50);
  if (error) throw error;
  res.json({
    subscriptions: (rows ?? []).map((r) => ({
      id: r.id,
      // We deliberately DON'T return the endpoint URL on the SPA —
      // it's a capability token. The client only needs id +
      // user-agent for the "you have N devices subscribed" badge.
      userAgent: r.user_agent,
      createdAt: r.created_at,
    })),
  });
});

export default router;
