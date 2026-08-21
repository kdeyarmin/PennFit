// Public one-click unsubscribe for the newsletter / demo-drip list.
//
//   GET /newsletter-unsubscribe?t=<token>
//
// PUBLIC (no auth): the recipient clicks this from a marketing email
// (welcome / demo follow-up / Learn newsletter). The token is an
// HMAC-signed binding to the recipient's email (see
// lib/demo-marketing/unsubscribe-token.ts), so the endpoint can't be used
// to enumerate or unsubscribe arbitrary addresses. Idempotent: re-clicking
// a valid link is a no-op. Returns a small branded HTML confirmation page
// either way.
//
// Mirrors routes/platform/unsubscribe.ts; that one targets
// platform_contacts (operator outreach), this one targets the global
// public.newsletter_subscribers list keyed by email.

import { Router, type IRouter, type Request, type Response } from "express";

import {
  rateLimit as expressRateLimit,
  ipKeyGenerator,
} from "express-rate-limit";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../../lib/logger.js";
import { verifyNewsletterUnsubscribeToken } from "../../lib/demo-marketing/unsubscribe-token.js";

const router: IRouter = Router();

// Public, unauthenticated endpoint — bound by a per-IP window so a leaked
// link or a scanner can't hammer it. The token is HMAC-signed
// (enumeration-proof), so a generous budget still lets a real recipient
// click through (and re-click) without friction. Built DIRECTLY from
// express-rate-limit (not the local rateLimit() wrapper) so CodeQL's
// js/missing-rate-limiting query recognises the upstream middleware at the
// call site — same rationale as routes/platform/unsubscribe.ts.
const unsubscribeLimiter = expressRateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  keyGenerator: (req) =>
    ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? "0.0.0.0"),
  message: { error: "too_many_requests", limiter: "newsletter_unsubscribe" },
});

function page(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#eef2fb;color:#0b1426;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;border-radius:16px;box-shadow:0 1px 3px rgba(11,20,38,.08);padding:36px 40px;max-width:440px;text-align:center}
.bar{height:4px;border-radius:4px;background:linear-gradient(90deg,#54c8ff,#2f6fe6,#f6a722);margin:0 0 20px}
h1{font-size:19px;margin:0 0 10px}p{font-size:14px;color:#475569;margin:0;line-height:1.6}</style></head>
<body><div class="card"><div class="bar"></div><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

router.get(
  "/newsletter-unsubscribe",
  unsubscribeLimiter,
  async (req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const token = typeof req.query.t === "string" ? req.query.t : "";
    const verified = verifyNewsletterUnsubscribeToken(token);
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
        .schema("public")
        .from("newsletter_subscribers")
        .update({
          unsubscribed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("email", verified.email)
        .is("unsubscribed_at", null);
      if (error) {
        // Log the failure shape only — never the address.
        logger.error(
          {
            event: "newsletter_unsubscribe_failed",
            pgCode: error.code ?? null,
          },
          "newsletter unsubscribe update failed",
        );
        res
          .status(500)
          .type("html")
          .send(
            page(
              "Something went wrong",
              "We couldn't process that just now. Please try again, or reply to the email and we'll remove you.",
            ),
          );
        return;
      }
    } catch (err) {
      logger.error(
        {
          event: "newsletter_unsubscribe_error",
          name: (err as Error)?.name ?? null,
        },
        "newsletter unsubscribe threw",
      );
      res
        .status(500)
        .type("html")
        .send(
          page(
            "Something went wrong",
            "We couldn't process that just now. Please try again, or reply to the email and we'll remove you.",
          ),
        );
      return;
    }
    res.status(200).type("html").send(
      page(
        "You're unsubscribed",
        // Brand-NEUTRAL on purpose: this global list mixes two
        // audiences — platform demo leads (CareMetric-branded drip) and
        // tenant-storefront newsletter signups (/learn) — and the host
        // resolver folds unknown hosts to the seed org, so neither the
        // platform nor a tenant name is safe to hardcode here. "From
        // us" is correct for every recipient.
        "You won't receive any more marketing emails from us. Changed your mind? Just sign up again any time.",
      ),
    );
  },
);

export default router;
