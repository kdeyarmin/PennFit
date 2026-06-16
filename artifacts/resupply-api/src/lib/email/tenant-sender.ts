// Per-tenant outbound email sender resolution (G6).
//
// Phase 2 lets each tenant send under THEIR OWN From identity while every
// email still funnels through the shared `createSendgridClient()` (ADR
// 016/018 — the "one From address" rule, relaxed to "one From PER
// TENANT"). A tenant's `from_email` / `from_name` (migration 0359)
// override the platform default (`SENDGRID_FROM_EMAIL` →
// `info@pennpaps.com`); NULL columns leave the platform default in place,
// so single-tenant behavior is unchanged.
//
//   * resolveTenantSender(orgId)   — the override options for a tenant, or
//     `{}` (platform default) when it has no configured sender / on any
//     lookup error (fail soft — a DB blip must never block mail; it just
//     uses the platform From, never the WRONG tenant's).
//   * createTenantSendgridClient(orgId) — convenience: a SendgridClient
//     already bound to the tenant's sender. Callers with an `orgId` use
//     this instead of bare `createSendgridClient()`.
//
// The `organizations` directory is GLOBAL, so it's read via the `.raw()`
// escape hatch (the org-scoped facade would wrongly filter it to one
// tenant). Results are cached briefly; `invalidateTenantSenderCache()`
// drops the cache after an operator changes a tenant's sender.

import {
  createSendgridClient,
  type SendgridClient,
} from "@workspace/resupply-email";
import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";

const CACHE_TTL_MS = 60_000;

export interface TenantSender {
  /** Override From address, or undefined to use the platform default. */
  fromEmail?: string;
  /** Override From display name, or undefined for the platform default. */
  fromName?: string;
}

interface CacheEntry {
  value: TenantSender;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();

/** Drop all cached senders (call after changing a tenant's From). */
export function invalidateTenantSenderCache(): void {
  cache.clear();
}

/**
 * The SendGrid `fromEmail` / `fromName` overrides for a tenant, or `{}`
 * (→ platform default From) when it has none. Accepts `undefined`
 * (the type of `req.orgId` before a tenant resolves) → `{}`. Fails soft:
 * any lookup error resolves to `{}` so mail always sends, from the
 * platform default rather than the wrong tenant.
 */
export async function resolveTenantSender(
  orgId: string | undefined,
): Promise<TenantSender> {
  // Treat a blank / whitespace-only orgId the same as missing tenant
  // context (org ids are non-empty after trimming, per getOrgScopedClient)
  // so we skip a pointless lookup and don't cache under an invalid key.
  if (!orgId || !orgId.trim()) return {};
  const now = Date.now();
  const cached = cache.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: TenantSender = {};
  try {
    const seedOrgId = await resolveSeedOrgId();
    if (seedOrgId) {
      const { data, error } = await getOrgScopedClient(seedOrgId)
        .raw()
        .schema("resupply")
        .from("organizations")
        .select("from_email, from_name")
        .eq("id", orgId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = data as {
        from_email: string | null;
        from_name: string | null;
      } | null;
      // Only an explicit, non-blank from_email switches a tenant off the
      // platform default. from_name alone (without an address) is ignored
      // so a stray display name can't reframe the platform sender.
      const fromEmail = row?.from_email?.trim();
      if (fromEmail) {
        // When a tenant overrides the From ADDRESS, also PIN the display
        // name — otherwise createSendgridClient() falls fromName back to
        // the platform `SENDGRID_FROM_NAME` (PennPaps), leaking the seed
        // tenant's brand onto a non-Penn tenant's mail
        // ("PennPaps <billing@tenant.example>"). An empty string suppresses
        // the name entirely (address-only From) until the tenant sets one.
        value = { fromEmail, fromName: row?.from_name?.trim() || "" };
      }
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_sender_lookup_failed", err, orgId },
      "tenant-sender: lookup failed; using platform default From",
    );
    value = {};
  }

  cache.set(orgId, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * A SendgridClient bound to the tenant's From identity (or the platform
 * default when the tenant has none / on a missing orgId). Drop-in for
 * `createSendgridClient()` at any callsite that knows its `orgId`.
 */
export async function createTenantSendgridClient(
  orgId: string | undefined,
): Promise<SendgridClient> {
  const sender = await resolveTenantSender(orgId);
  return createSendgridClient(sender);
}
