// Stripe config — platform (SaaS) billing only.
//
// Stripe's ONLY remaining role is tenant→platform subscription billing:
// the DME businesses operating on CareMetric Breathe pay the platform
// through it. Patient-facing card payments were removed with the cash-pay
// storefront — patients receive equipment through insurance only — so
// there is no patient checkout config, no Connect account, and no
// publishable key for storefront Elements anymore.
//
// Env reads happen at call time (not at module load), so credential
// rotation is honored without a restart and a half-configured deploy
// degrades to `stripeConfigured: false` rather than crashing at boot.

import Stripe from "stripe";

export interface StripeConfig {
  secretKey: string;
  publishableKey: string | null;
  webhookSigningSecret: string | null;
  /**
   * Public origin used for Stripe Checkout/Billing-Portal return URLs.
   * Read from RESUPPLY_VOICE_PUBLIC_BASE_URL — the canonical public base
   * URL for the resupply-api, shared with the voice/Twilio callbacks —
   * then synthesized from RAILWAY_PUBLIC_DOMAIN.
   * RESUPPLY_PUBLIC_BASE_URL is accepted as a deprecated back-compat alias.
   */
  publicBaseUrl: string;
}

export function readPublicBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  // Explicit override wins — useful for staging deploys with a custom
  // domain that isn't yet in RAILWAY_PUBLIC_DOMAIN. Canonical name is
  // RESUPPLY_VOICE_PUBLIC_BASE_URL (consistent with voice + the README);
  // the older RESUPPLY_PUBLIC_BASE_URL stays as a deprecated alias.
  const explicit =
    env.RESUPPLY_VOICE_PUBLIC_BASE_URL || env.RESUPPLY_PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/$/, "");

  const railwayHost = env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railwayHost) return `https://${railwayHost}`;

  return null;
}

/**
 * Where the platform's SaaS-billing money lives. `"dedicated"` means the
 * operator has provisioned a Stripe account for tenant→platform
 * subscription billing (STRIPE_PLATFORM_SECRET_KEY set). `"shared"` means
 * the dedicated key is unset and the legacy STRIPE_SECRET_KEY is standing
 * in — a historical single-account fallback kept so an operator mid-way
 * through provisioning the dedicated account isn't cut off. The dedicated
 * webhook refuses to run in shared mode.
 */
export type PlatformBillingStripeMode = "dedicated" | "shared";

export interface PlatformBillingStripeConfig extends StripeConfig {
  mode: PlatformBillingStripeMode;
}

/**
 * Config for PLATFORM SaaS billing (tenants paying the platform). When
 * `STRIPE_PLATFORM_SECRET_KEY` is set we run platform billing on that
 * dedicated account and verify its webhooks with
 * `STRIPE_PLATFORM_WEBHOOK_SIGNING_SECRET`. When it is unset we fall back
 * to the legacy `STRIPE_SECRET_KEY` (`mode: "shared"`).
 *
 * A NULL return means platform billing can't run at all (no secret key
 * resolvable, or no public base URL) — callers degrade to
 * `stripeConfigured: false`.
 */
export function readPlatformBillingStripeConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): PlatformBillingStripeConfig | null {
  const dedicatedKey = env.STRIPE_PLATFORM_SECRET_KEY?.trim();
  const dedicated = !!dedicatedKey;

  const secretKey = dedicated ? dedicatedKey : env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const publicBaseUrl = readPublicBaseUrl(env);
  if (!publicBaseUrl) return null;

  // Webhook secrets are account-specific: the dedicated account has its own
  // signing secret. In shared mode there is no platform webhook to verify
  // (the handler refuses to run), so fall back to the legacy secret.
  const webhookSigningSecret = dedicated
    ? env.STRIPE_PLATFORM_WEBHOOK_SIGNING_SECRET?.trim() || null
    : (env.STRIPE_WEBHOOK_SIGNING_SECRET ?? null);

  return {
    secretKey,
    // The platform account's publishable key isn't used server-side
    // (hosted Checkout / Billing Portal only need the secret key).
    publishableKey: null,
    webhookSigningSecret,
    publicBaseUrl,
    mode: dedicated ? "dedicated" : "shared",
  };
}

// Memoize Stripe clients so we don't allocate one per request, keyed by
// secret key. A rotated key just adds an entry; the map is pruned if it
// ever grows past a small bound (rotation is rare, and stale clients are
// cheap but shouldn't accumulate unbounded).
const clientCache = new Map<string, Stripe>();
const MAX_CACHED_CLIENTS = 8;

export function getStripeClient(config: StripeConfig): Stripe {
  const existing = clientCache.get(config.secretKey);
  if (existing) return existing;
  if (clientCache.size >= MAX_CACHED_CLIENTS) clientCache.clear();
  const client = new Stripe(config.secretKey, {
    // Stripe SDK pins its own apiVersion default; relying on the SDK
    // default keeps us auto-updating with the SDK upgrade rather than
    // pinning to a date string we'd forget to refresh.
    typescript: true,
  });
  clientCache.set(config.secretKey, client);
  return client;
}
