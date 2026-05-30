// stripe config — single source of truth for "is the shop turned on?".
//
// Mirrors messaging-config.ts: env reads happen at call time (not at
// module load), and the shop route handlers return a clean 503 with a
// stable error code when any required value is missing. That way a
// half-configured deploy returns "shop_unavailable" instead of crashing
// with a generic 500.
//
// Why fail-closed:
//   The shop accepts money. A misconfigured Stripe key would either
//   create real charges in the wrong account or silently swallow
//   payment intents. We refuse to construct a Stripe client until the
//   secret is present, and refuse to process a webhook until the
//   signing secret is present. The publishable key is informational
//   for the frontend (we use Stripe Hosted Checkout, so the frontend
//   only needs the redirect URL — but we expose the publishable key
//   anyway for future Elements work).

import Stripe from "stripe";

export interface StripeConfig {
  secretKey: string;
  publishableKey: string | null;
  webhookSigningSecret: string | null;
  /**
   * Public origin used for Stripe Checkout success/cancel redirects.
   * Read from RESUPPLY_VOICE_PUBLIC_BASE_URL — the canonical public base
   * URL for the resupply-api, shared with the voice/Twilio callbacks and
   * documented as the var Stripe callbacks use — then synthesized from
   * RAILWAY_PUBLIC_DOMAIN. RESUPPLY_PUBLIC_BASE_URL is accepted as a
   * deprecated back-compat alias.
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

export function readStripeConfigOrNull(
  env: NodeJS.ProcessEnv = process.env,
): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) return null;

  const publicBaseUrl = readPublicBaseUrl(env);
  if (!publicBaseUrl) return null;

  return {
    secretKey,
    publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
    webhookSigningSecret: env.STRIPE_WEBHOOK_SIGNING_SECRET ?? null,
    publicBaseUrl,
  };
}

// Memoize the Stripe client so we don't allocate one per request, but
// still re-construct if the secret rotates between calls (cheap key
// comparison, no module-load coupling to env).
let cached: { key: string; client: Stripe } | null = null;

export function getStripeClient(config: StripeConfig): Stripe {
  if (cached && cached.key === config.secretKey) return cached.client;
  const client = new Stripe(config.secretKey, {
    // Stripe SDK pins its own apiVersion default; relying on the SDK
    // default keeps us auto-updating with the SDK upgrade rather than
    // pinning to a date string we'd forget to refresh.
    typescript: true,
  });
  cached = { key: config.secretKey, client };
  return client;
}

/**
 * Stable error envelope returned by shop routes when Stripe isn't
 * configured. Frontend pattern-matches on `error: "shop_unavailable"`
 * to render a friendly "shop coming soon" state instead of a generic
 * failure.
 */
export const SHOP_UNAVAILABLE_BODY = {
  error: "shop_unavailable",
  message:
    "The PennPaps shop isn't configured in this environment yet. Please check back soon.",
} as const;
