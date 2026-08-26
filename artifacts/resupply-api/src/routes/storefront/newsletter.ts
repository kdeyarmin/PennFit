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

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { requestHost } from "../../lib/request-host.js";
import { resolveBrandOrgIdByHost } from "../../lib/tenant-branding.js";

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

  // This route is mounted before attachSignedIn, so guest requests may
  // not have req.orgId yet; resolve by host as a fallback.
  const orgId = req.orgId ?? (await resolveBrandOrgIdByHost(requestHost(req)));
  if (!orgId) {
    res.status(500).json({ error: "tenant_context_missing" });
    return;
  }

  // DELIBERATE DESIGN: newsletter_subscribers is a single GLOBAL (public-
  // schema) marketing list keyed by email alone (migration 0354) — NOT a
  // per-tenant list. This is intentionally different from reminder_
  // subscriptions, which migration 0378 re-keyed to UNIQUE(org_id, email)
  // because those are tenant-scoped resupply reminders. We resolve orgId
  // above only to gate access; the upsert conflict target is `email` (not
  // `org_id,email`) on purpose, so the same address is one platform-wide
  // marketing record. If product ever wants per-tenant newsletter lists,
  // that's a schema change (add org_id + (org_id,email) uniqueness, mirroring
  // 0378) — not a silent edit here. Until then this asymmetry is by design,
  // not the 0378 cross-tenant bug.
  const supabase = getOrgScopedClient(orgId).raw();
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
