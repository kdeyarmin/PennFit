// Optional Cloudflare Turnstile (CAPTCHA) verification for public
// write endpoints (the Breathe self-serve signup).
//
// Fail-soft posture, matching the repo's feature-gated integrations:
// when TURNSTILE_SECRET_KEY is unset (dev/preview, or before the team
// provisions a key) verification is SKIPPED so signup still works — the
// per-IP rate limit + honeypot remain the active anti-abuse guards. The
// app CSP already allows https://challenges.cloudflare.com for the
// widget + script.

import { logger } from "./logger.js";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Whether a Turnstile secret is configured (widget should be shown). */
export function turnstileConfigured(): boolean {
  return Boolean(process.env.TURNSTILE_SECRET_KEY?.trim());
}

/**
 * Verify a Turnstile token.
 *   - No secret configured → `true` (skip; rate limit still applies).
 *   - Secret configured, no token → `false` (block).
 *   - Explicit failure from Cloudflare → `false` (likely a bot).
 *   - Network/parse error talking to Cloudflare → `true` (fail-open so a
 *     verification outage doesn't block legitimate signups; the per-IP
 *     rate limit is the backstop).
 */
export async function verifyTurnstile(
  token: string | undefined,
  ip: string | undefined,
): Promise<boolean> {
  const secret = process.env.TURNSTILE_SECRET_KEY?.trim();
  if (!secret) return true;
  if (!token) return false;
  try {
    const form = new URLSearchParams();
    form.set("secret", secret);
    form.set("response", token);
    if (ip) form.set("remoteip", ip);
    const resp = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    const data = (await resp.json()) as { success?: boolean };
    return data.success === true;
  } catch (err) {
    logger.warn(
      { event: "turnstile_verify_error", name: (err as Error)?.name ?? null },
      "turnstile verify request failed (fail-open)",
    );
    return true;
  }
}
