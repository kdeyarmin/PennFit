// GET /shop/orders/:sessionId/pod — proof-of-delivery photo for the
// patient-facing order-success / shop-orders page.
//
// Public (no auth): the session id is a 70+-char opaque Stripe token;
// possession of it implies the buyer. Same access model as the
// existing /shop/orders/:sessionId summary route (see order.ts).
//
// PHI hygiene: we never log the bucket object key (CLAUDE.md hard
// rule). The image bytes are served `private, no-store` so a
// shoulder-surfer on a shared device that hits the URL after the
// patient session closes can't pick the photo out of a browser
// disk cache.

import { Router, type IRouter } from "express";
import { Readable } from "node:stream";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  ObjectNotFoundError,
  ObjectStorageService,
} from "../../lib/object-storage/objectStorage";

const SESSION_ID_RE = /^cs_(test|live)_[A-Za-z0-9]{20,}$/;

const router: IRouter = Router();
const objectStorage = new ObjectStorageService();

router.get("/shop/orders/:sessionId/pod", async (req, res) => {
  const sessionId = req.params.sessionId;
  if (!SESSION_ID_RE.test(sessionId)) {
    res.status(400).json({ error: "invalid_session_id" });
    return;
  }
  const supabase = getSupabaseServiceRoleClient();
  const { data: order, error } = await supabase
    .schema("resupply")
    .from("shop_orders")
    .select("pod_object_key")
    .eq("stripe_session_id", sessionId)
    .limit(1)
    .maybeSingle();
  if (error) {
    req.log?.error(
      { err: error, sessionId },
      "shop_order_pod_patient_lookup_failed",
    );
    res.status(500).json({ error: "lookup_failed" });
    return;
  }
  if (!order || !order.pod_object_key) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  let file;
  try {
    file = await objectStorage.getObjectEntityFile(order.pod_object_key);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    req.log?.error(
      { err, sessionId },
      "shop_order_pod_patient_object_lookup_failed",
    );
    res.status(500).json({ error: "download_failed" });
    return;
  }

  try {
    const response = await objectStorage.downloadObject(file, 0);
    res.status(response.status);
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", "inline");
    if (response.body) {
      const nodeStream = Readable.fromWeb(
        response.body as ReadableStream<Uint8Array>,
      );
      nodeStream.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    req.log?.error(
      { err, sessionId },
      "shop_order_pod_patient_stream_failed",
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "download_failed" });
    } else {
      res.end();
    }
  }
});

export default router;
