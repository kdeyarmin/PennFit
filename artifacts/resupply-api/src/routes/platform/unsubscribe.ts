// Public one-click unsubscribe for platform outreach emails.
//
//   GET /resupply-api/platform-unsubscribe?t=<token>
//
// PUBLIC (no auth): the recipient clicks this from a marketing email.
// The token is an HMAC-signed binding to a platform_contacts row, so the
// endpoint can't be used to enumerate or unsubscribe arbitrary contacts.
// Idempotent: re-clicking a valid link is a no-op. Returns a tiny HTML
// confirmation page either way (success or an expired/invalid link).

import { Router, type IRouter, type Request, type Response } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger";
import { verifyPlatformUnsubscribeToken } from "../../lib/platform-outreach/unsubscribe-token";
import { rateLimit } from "../../middlewares/rate-limit";

const router: IRouter = Router();

// Public, unauthenticated endpoint — bound by a per-IP fixed window so a
// leaked link or a scanner can't hammer it. The token is HMAC-signed
// (enumeration-proof), so a generous budget still lets a real recipient
// click through (and re-click) without friction.
const unsubscribeLimiter = rateLimit({
  name: "platform_unsubscribe",
  windowMs: 60_000,
  max: 30,
});

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f7f9;color:#1a2230;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.08);padding:32px 36px;max-width:420px;text-align:center}
h1{font-size:18px;margin:0 0 8px}p{font-size:14px;color:#566;margin:0}</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

router.get(
  "/platform-unsubscribe",
  unsubscribeLimiter,
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const verified = verifyPlatformUnsubscribeToken(token);
    if (!verified.valid) {
      res
        .status(400)
        .type("html")
        .send(
          page(
            "Link expired",
            "This unsubscribe link is invalid or has expired. Reply to the email and we'll remove you.",
          ),
        );
      return;
    }
    try {
      const supabase = getSupabaseServiceRoleClient();
      const { error } = await supabase
        .schema("resupply")
        .from("platform_contacts")
        .update({
          unsubscribed: true,
          unsubscribed_at: new Date().toISOString(),
        })
        .eq("id", verified.contactId);
      if (error) throw error;
    } catch (err) {
      logger.error({ err }, "platform-unsubscribe: failed to flag contact");
      res
        .status(500)
        .type("html")
        .send(
          page(
            "Something went wrong",
            "We couldn't process that just now. Please try again, or reply to the email.",
          ),
        );
      return;
    }
    res
      .status(200)
      .type("html")
      .send(
        page(
          "You're unsubscribed",
          "You won't receive further marketing emails from CareMetric Breathe.",
        ),
      );
  },
);

export default router;
