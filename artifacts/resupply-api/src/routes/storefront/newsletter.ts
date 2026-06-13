// POST /newsletter/subscribe — anonymous marketing email capture for
// the storefront newsletter signup (Learn page + related surfaces).
//
// History: the NewsletterSignup component shipped POSTing here before
// any backend existed, so every address was silently dropped while the
// UI showed success. This route is the real wire-up.
//
// Shape:
//   * Anonymous — no session required, no CSRF (nothing to replay).
//   * Honeypot field `website` (same convention as POST /reminders) —
//     bots that fill it get a fake success and no row.
//   * Upsert on lowercased email so repeat submissions don't 500 on
//     the unique index; re-subscribing clears unsubscribed_at.
//   * Rate-limited per-IP at the app level (newsletter_subscribe).
//   * PHI: none — a volunteered marketing address. Never logged.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

const subscribeBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  source: z.string().trim().max(100).optional(),
});

router.post("/newsletter/subscribe", async (req, res) => {
  // Honeypot must run before zod (zod strip would drop the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)
    ?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.json({ success: true });
    return;
  }

  const parsed = subscribeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "Please enter a valid email address.",
    });
    return;
  }
  const { email, source } = parsed.data;

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema("public")
    .from("newsletter_subscribers")
    .upsert(
      {
        email,
        source: source ?? null,
        updated_at: new Date().toISOString(),
        unsubscribed_at: null,
      },
      { onConflict: "email" },
    );
  if (error) {
    // Log the failure shape only — never the address.
    logger.error(
      { event: "newsletter_subscribe_failed", pgCode: error.code ?? null },
      "newsletter subscribe upsert failed",
    );
    res.status(500).json({
      error: "Something went wrong saving your signup. Please try again.",
    });
    return;
  }

  res.json({ success: true });
});

export default router;
