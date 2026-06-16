// Per-tenant Twilio sending identity resolution (G7).
//
// Phase 2 lets each tenant send SMS / place calls under THEIR OWN Twilio
// number (or Messaging Service) while inbound webhooks route to the tenant
// the called number belongs to. The platform `TWILIO_ACCOUNT_SID` /
// `TWILIO_AUTH_TOKEN` stay the API credential; the per-tenant
// `organizations.sms_from_number` / `voice_from_number` /
// `twilio_messaging_service_sid` (migration 0361) select the sender.
//
// Two directions:
//   * OUTBOUND — `resolveTenantSmsFrom(orgId)` / `resolveTenantVoiceFrom(orgId)`
//     return the tenant's sender override, or `{}` / `null` (platform
//     default) when it has none. NULL → current single-tenant behavior.
//   * INBOUND — `resolveOrgIdByCalledNumber(toNumber)` reverse-maps an
//     inbound webhook's `To` (the called number) back to its owning
//     tenant so a tenant's SMS / call lands in the right `org_id`.
//
// The `organizations` directory is GLOBAL, so it's read via the `.raw()`
// escape hatch. Results are cached briefly; `invalidateTenantTelecomCache()`
// drops the cache after an operator changes a tenant's numbers. All reads
// fail soft (→ platform default / null) so a DB blip never blocks a send
// and never routes to the WRONG tenant.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "../logger";

const CACHE_TTL_MS = 60_000;

/** Outbound SMS sender override for a tenant. */
export interface TenantSmsFrom {
  /** Override from-number (E.164), or undefined for the platform default. */
  from?: string;
  /** Override Messaging Service SID, or undefined for the platform default. */
  messagingServiceSid?: string;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

// orgId → telecom identity row.
const byOrg = new Map<
  string,
  CacheEntry<{
    smsFromNumber: string | null;
    voiceFromNumber: string | null;
    messagingServiceSid: string | null;
  }>
>();
// called number → owning orgId (or null when unknown).
const byNumber = new Map<string, CacheEntry<string | null>>();

/** Drop all cached telecom bindings (call after changing a tenant's numbers). */
export function invalidateTenantTelecomCache(): void {
  byOrg.clear();
  byNumber.clear();
}

async function rawOrgClient() {
  const seedOrgId = await resolveSeedOrgId();
  if (!seedOrgId) return null;
  return getOrgScopedClient(seedOrgId).raw();
}

interface TelecomRow {
  smsFromNumber: string | null;
  voiceFromNumber: string | null;
  messagingServiceSid: string | null;
}

const EMPTY_ROW: TelecomRow = {
  smsFromNumber: null,
  voiceFromNumber: null,
  messagingServiceSid: null,
};

/** Load (and cache) a tenant's telecom identity row. Fails soft to empty. */
async function loadTelecomRow(orgId: string): Promise<TelecomRow> {
  const now = Date.now();
  const cached = byOrg.get(orgId);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: TelecomRow = EMPTY_ROW;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      const { data, error } = await raw
        .schema("resupply")
        .from("organizations")
        .select(
          "sms_from_number, voice_from_number, twilio_messaging_service_sid",
        )
        .eq("id", orgId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = data as {
        sms_from_number: string | null;
        voice_from_number: string | null;
        twilio_messaging_service_sid: string | null;
      } | null;
      value = {
        smsFromNumber: row?.sms_from_number?.trim() || null,
        voiceFromNumber: row?.voice_from_number?.trim() || null,
        messagingServiceSid: row?.twilio_messaging_service_sid?.trim() || null,
      };
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_telecom_lookup_failed", err, orgId },
      "tenant-telecom: lookup failed; using platform default sender",
    );
    value = EMPTY_ROW;
  }

  byOrg.set(orgId, { value, expiresAt: now + CACHE_TTL_MS });
  // Warm the reverse cache so an inbound webhook on a just-sent-from number
  // hits cache.
  if (value.smsFromNumber)
    byNumber.set(value.smsFromNumber, {
      value: orgId,
      expiresAt: now + CACHE_TTL_MS,
    });
  if (value.voiceFromNumber)
    byNumber.set(value.voiceFromNumber, {
      value: orgId,
      expiresAt: now + CACHE_TTL_MS,
    });
  return value;
}

/**
 * The tenant's outbound SMS sender override (`{ from }` and/or
 * `{ messagingServiceSid }`), or `{}` (→ platform default) when it has
 * none. Accepts `undefined` / blank orgId → `{}`.
 */
export async function resolveTenantSmsFrom(
  orgId: string | undefined,
): Promise<TenantSmsFrom> {
  if (!orgId || !orgId.trim()) return {};
  const row = await loadTelecomRow(orgId);
  const out: TenantSmsFrom = {};
  if (row.smsFromNumber) out.from = row.smsFromNumber;
  if (row.messagingServiceSid)
    out.messagingServiceSid = row.messagingServiceSid;
  return out;
}

/**
 * The tenant's outbound voice caller-id (E.164), or `null` (→ platform
 * default) when it has none. Accepts `undefined` / blank orgId → `null`.
 */
export async function resolveTenantVoiceFrom(
  orgId: string | undefined,
): Promise<string | null> {
  if (!orgId || !orgId.trim()) return null;
  const row = await loadTelecomRow(orgId);
  return row.voiceFromNumber;
}

/**
 * Reverse lookup for inbound webhooks: the `org_id` that owns the called
 * `To` number (SMS or voice), or `null` when no tenant is bound to it
 * (caller falls back to the seed org). The unique partial indexes
 * guarantee at most one match per number. Fails soft to `null`.
 */
export async function resolveOrgIdByCalledNumber(
  toNumber: string | undefined,
): Promise<string | null> {
  const number = toNumber?.trim();
  if (!number) return null;
  const now = Date.now();
  const cached = byNumber.get(number);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      // A number is registered as either an SMS or a voice sender; match
      // on either column.
      const { data, error } = await raw
        .schema("resupply")
        .from("organizations")
        .select("id")
        .or(`sms_from_number.eq.${number},voice_from_number.eq.${number}`)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      value = (data as { id: string } | null)?.id ?? null;
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_telecom_org_lookup_failed", err },
      "tenant-telecom: org-by-number lookup failed",
    );
    value = null;
  }

  byNumber.set(number, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
