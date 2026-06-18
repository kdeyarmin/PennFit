// POST /demo-lead — anonymous marketing email capture for the public
// "Breathe" self-serve demo gate.
//
// A visitor volunteers their email to start the product demo; we save it
// to the shared marketing list (public.newsletter_subscribers, tagged
// source="breathe-demo") so the team can follow up. The demo itself is a
// CLIENT-ONLY sandbox (?demo=1) backed entirely by in-browser fixtures —
// no real PHI, no integrations — so this route only captures the lead.
//
// Why this isn't just /newsletter/subscribe: that route requires a tenant
// (resolves req.orgId by host) because it is a storefront surface. The
// Breathe marketing site is served on the PLATFORM apex (cmbreathe.com)
// where no tenant resolves, so this route writes through the base
// service-role client and needs no org context.
//
// Shape mirrors /newsletter/subscribe: anonymous (no session/CSRF —
// nothing to replay), honeypot field `website`, per-IP rate limited at
// the app level. PHI: none — a volunteered marketing address, never
// logged. Persistence is best-effort: a DB hiccup must never block the
// visitor from entering the demo, so the route always resolves 200.

import { Router, type IRouter } from "express";
import { z } from "zod";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";

const router: IRouter = Router();

const demoLeadBody = z.object({
  email: z.string().trim().email().max(254).toLowerCase(),
  source: z.string().trim().max(100).optional(),
});

router.post("/demo-lead", async (req, res) => {
  // Honeypot must run before zod (zod strip would drop the unknown field).
  const honeypot = (req.body as Record<string, unknown> | null | undefined)
    ?.website;
  if (typeof honeypot === "string" && honeypot.trim().length > 0) {
    res.json({ ok: true });
    return;
  }

  const parsed = demoLeadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Please enter a valid email address." });
    return;
  }
  const { email, source } = parsed.data;

  // Best-effort persistence. We capture the lead when we can but never
  // surface a failure to the visitor — the demo opens regardless.
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("public")
      .from("newsletter_subscribers")
      .upsert(
        {
          email,
          source: source && source.length > 0 ? source : "breathe-demo",
          updated_at: new Date().toISOString(),
          unsubscribed_at: null,
        },
        { onConflict: "email" },
      );
    if (error) {
      // Log the failure shape only — never the address.
      logger.error(
        { event: "demo_lead_capture_failed", pgCode: error.code ?? null },
        "demo lead upsert failed",
      );
    }
  } catch (err) {
    // Supabase env unset (preview) or a transient client error: swallow.
    logger.error(
      { event: "demo_lead_capture_error", name: (err as Error)?.name ?? null },
      "demo lead capture threw",
    );
  }

  res.json({ ok: true });
});

export default router;
