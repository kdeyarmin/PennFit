// GET /shop/me/wallet-pass.pkpass — issue an Apple Wallet pass for
// the signed-in customer.
//
// Why this exists
// ---------------
// The CPAP demographic skews older and a meaningful slice keep a
// Wallet card per supplier they trust — one tap from the lock
// screen to the support phone, one tap to reorder. Activating that
// channel is a small surface that compounds with the existing
// patient-comm work (the pass back fields link to /shop for the
// reorder flow + carry the support phone).
//
// Configuration
// -------------
// Behind the same env-var gate as every other vendor-channel feature:
// APPLE_WALLET_PASS_TYPE_ID / TEAM_ID / SIGNER_KEY_PEM /
// SIGNER_CERT_PEM / WWDR_CERT_PEM. When any of those is missing the
// endpoint returns 503 with a stable error code, matching the
// existing fail-closed posture for shop / messaging / push.
//
// The route also requires the `openssl` binary on PATH for PKCS#7
// signing. Any standard Linux/macOS production image has it; if a
// future deploy strips openssl, sign failures bubble as 502.
//
// Auth
// ----
// requireSignedIn — the pass binds to the patient's customer_id,
// which we only know after the session cookie is verified. A
// future "guest pass" would need a separate signed-link surface;
// we don't need it for v1.

import { Router, type IRouter } from "express";

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import {
  AppleWalletNotConfiguredError,
  AppleWalletSignError,
  buildPkpass,
} from "../../lib/apple-wallet/pkpass";
import { defaultIconPng, defaultLogoPng } from "../../lib/apple-wallet/assets";
import { logger } from "../../lib/logger";

// Branding constants — kept in sync with the cpap-fitter
// `lib/contact.ts` copy. Inlined on the server because the
// resupply-api workspace doesn't depend on the frontend bundle.
const SUPPORT_PHONE_DISPLAY = "(814) 471-0627";
const SUPPORT_EMAIL = "support@pennpaps.com";
import { rateLimit } from "../../middlewares/rate-limit";
import { requireSignedIn } from "../../middlewares/requireSignedIn";

const router: IRouter = Router();

const DEFAULT_BASE_URL = "https://pennpaps.com";

function publicBaseUrl(): string {
  const raw =
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    DEFAULT_BASE_URL;
  return raw.replace(/\/$/, "");
}

router.get(
  "/shop/me/wallet-pass.pkpass",
  // Per-customer cap. Adding the pass is a one-shot action, but
  // some Wallet versions retry on transient errors. 6/15min is
  // generous enough for that and tight enough to catch hostile
  // probing.
  rateLimit({ windowMs: 15 * 60_000, max: 6, name: "shop_wallet_pass" }),
  requireSignedIn,
  async (req, res) => {
    const customerId = req.userCustomerId;
    if (!customerId) {
      res.status(401).json({ error: "sign_in_required" });
      return;
    }

    // Pull the customer's name + email for the pass face. We use
    // shop_customers (cheap PK read) rather than the patients table
    // — the pass is a "PennPaps member card", not a clinical
    // surface, and shop_customers is the canonical source for
    // display_name on this side of the app.
    const supabase = getSupabaseServiceRoleClient();
    const { data: cust, error: custErr } = await supabase
      .schema("resupply")
      .from("shop_customers")
      .select("customer_id, email_lower, display_name")
      .eq("customer_id", customerId)
      .limit(1)
      .maybeSingle();
    if (custErr) {
      logger.warn(
        { err: custErr.message },
        "wallet-pass: shop_customers read failed",
      );
      res.status(500).json({ error: "lookup_failed" });
      return;
    }
    if (!cust) {
      // No shop_customer row yet. The /shop/me/billing-portal route
      // ensureShopCustomerRow's-its-way through this; here we just
      // bail because we don't have a display name. A future
      // enhancement could mint a placeholder pass.
      res.status(404).json({ error: "no_customer_row" });
      return;
    }

    const memberName =
      cust.display_name && cust.display_name.trim().length > 0
        ? cust.display_name.trim()
        : (req.shopCustomerEmail ?? "PennPaps Member");

    try {
      const pkpass = await buildPkpass({
        serialNumber: customerId,
        memberName,
        logoText: "PennPaps",
        supportPhone: SUPPORT_PHONE_DISPLAY,
        supportEmail: SUPPORT_EMAIL,
        buyAgainUrl: `${publicBaseUrl()}/shop`,
        iconPng: defaultIconPng(),
        logoPng: defaultLogoPng(),
      });
      // Per Apple, the .pkpass MIME type is
      // application/vnd.apple.pkpass and the response MUST be
      // application/octet-stream-safe (no chunked-transfer-encoding
      // surprises). Express handles that for us when we send a
      // Buffer.
      res
        .status(200)
        .setHeader(
          "Content-Disposition",
          `attachment; filename="pennpaps-${customerId.slice(0, 8)}.pkpass"`,
        )
        .type("application/vnd.apple.pkpass")
        .send(pkpass);
    } catch (err) {
      if (err instanceof AppleWalletNotConfiguredError) {
        // Stable error envelope — UI distinguishes "this feature
        // isn't turned on in your environment" from genuine
        // failures and hides the "Add to Wallet" CTA.
        res.status(503).json({
          error: "wallet_not_configured",
          message: "Apple Wallet passes are not enabled in this environment.",
        });
        return;
      }
      if (err instanceof AppleWalletSignError) {
        logger.error(
          { errName: err.name, customerId },
          "wallet-pass: PKCS#7 sign failed",
        );
        res.status(502).json({ error: "wallet_sign_failed" });
        return;
      }
      logger.error(
        {
          errName: err instanceof Error ? err.name : "unknown",
          customerId,
        },
        "wallet-pass: unexpected error",
      );
      res.status(500).json({ error: "wallet_build_failed" });
    }
  },
);

export default router;
