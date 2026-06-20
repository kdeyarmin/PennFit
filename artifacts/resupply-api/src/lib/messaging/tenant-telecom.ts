// Per-tenant Twilio sending identity resolution (G7).
//
// Phase 2 lets each tenant send SMS / place calls under THEIR OWN Twilio
// number (or Messaging Service) while inbound webhooks route to the tenant
// the called number belongs to. The platform `TWILIO_ACCOUNT_SID` /
// `TWILIO_AUTH_TOKEN` stay the API credential; the per-tenant
// `organizations.sms_from_number` / `voice_from_number` /
// `twilio_messaging_service_sid` (migration 0364) select the sender.
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
    faxFromNumber: string | null;
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
  faxFromNumber: string | null;
}

const EMPTY_ROW: TelecomRow = {
  smsFromNumber: null,
  voiceFromNumber: null,
  messagingServiceSid: null,
  faxFromNumber: null,
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
          "sms_from_number, voice_from_number, twilio_messaging_service_sid, fax_from_number",
        )
        .eq("id", orgId)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      const row = data as {
        sms_from_number: string | null;
        voice_from_number: string | null;
        twilio_messaging_service_sid: string | null;
        fax_from_number: string | null;
      } | null;
      value = {
        smsFromNumber: row?.sms_from_number?.trim() || null,
        voiceFromNumber: row?.voice_from_number?.trim() || null,
        messagingServiceSid: row?.twilio_messaging_service_sid?.trim() || null,
        faxFromNumber: row?.fax_from_number?.trim() || null,
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
  if (value.faxFromNumber)
    byNumber.set(value.faxFromNumber, {
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
  const tenantOrgId = orgId?.trim();
  if (!tenantOrgId) return {};
  const row = await loadTelecomRow(tenantOrgId);
  const out: TenantSmsFrom = {};
  if (row.smsFromNumber) out.from = row.smsFromNumber;
  if (row.messagingServiceSid)
    out.messagingServiceSid = row.messagingServiceSid;
  return out;
}

/**
 * Apply a tenant's SMS sender override onto an SMS-send config object
 * (the `{ twilioPhoneNumber, twilioMessagingServiceSid }` shape every
 * `SmsSendConfig` / `createTwilioSmsClient` caller threads). Returns a
 * NEW object — the platform-default fields are preserved unless the
 * tenant has its own override. This is the layering-correct seam for
 * app-side callers of `@workspace/resupply-reminders` (a lib that must
 * not import the app): the app resolves the tenant identity and hands
 * the resolved config into the lib.
 *
 * When the tenant sets ONLY a Messaging Service SID, the platform
 * `twilioPhoneNumber` is cleared so Twilio uses the tenant's Messaging
 * Service (a `from` + `messagingServiceSid` together is ambiguous), and
 * vice-versa — a tenant from-number clears the platform Messaging
 * Service SID. A tenant with NEITHER leaves both platform defaults in
 * place (single-tenant unchanged). Fails soft via `resolveTenantSmsFrom`.
 */
export async function applyTenantSmsFrom<
  T extends {
    // Accept both the `string | undefined` (SmsSendConfig) and the
    // `string | null` (OutreachMessagingConfig) shapes that thread an
    // SMS sender. We only ever WRITE non-null strings back.
    twilioPhoneNumber?: string | null;
    twilioMessagingServiceSid?: string | null;
  },
>(orgId: string | undefined, cfg: T): Promise<T> {
  const tenant = await resolveTenantSmsFrom(orgId);
  if (!tenant.from && !tenant.messagingServiceSid) return cfg;
  const next = { ...cfg };
  if (tenant.messagingServiceSid) {
    next.twilioMessagingServiceSid = tenant.messagingServiceSid;
    next.twilioPhoneNumber = "";
  } else if (tenant.from) {
    next.twilioPhoneNumber = tenant.from;
    // Clear with an EMPTY STRING, not `undefined`: when this cfg reaches
    // `createTwilioSmsClient({ messagingServiceSid })`, `undefined` would
    // fall back to the env Messaging Service SID and shadow the tenant's
    // from-number (msid takes precedence). An empty string is falsy at
    // the client's send-time guard, so the tenant's number is used.
    next.twilioMessagingServiceSid = "";
  }
  return next;
}

/** Explicit sender options for `createTwilioSmsClient(...)`. */
export interface TenantSmsClientOptions {
  from?: string;
  messagingServiceSid?: string;
}

/**
 * Resolve the explicit `{ from, messagingServiceSid }` to hand
 * `createTwilioSmsClient(...)` so the call sends under the tenant's own
 * sender when it has one, else the platform env default.
 *
 * Direct `createTwilioSmsClient()` callers (no args) inherit the env
 * `TWILIO_PHONE_NUMBER` / `TWILIO_MESSAGING_SERVICE_SID`. Passing the
 * tenant override alone is not enough because the client prefers
 * `messagingServiceSid` over `from`: a tenant from-number would be
 * shadowed by the platform Messaging Service env. So we resolve the
 * effective pair HERE — when the tenant has an override we set the
 * chosen field and explicitly clear the opposing one; when it has none
 * we return `{}` so the env defaults apply unchanged (single-tenant
 * behavior preserved). Fails soft via `resolveTenantSmsFrom`.
 */
export async function resolveTenantSmsClientOptions(
  orgId: string | undefined,
): Promise<TenantSmsClientOptions> {
  const tenant = await resolveTenantSmsFrom(orgId);
  // Tenant Messaging Service wins (mirrors the client's own precedence).
  if (tenant.messagingServiceSid) {
    return { messagingServiceSid: tenant.messagingServiceSid };
  }
  if (tenant.from) {
    // Explicitly clear the Messaging Service with an EMPTY STRING (not
    // `undefined`, which the client treats as "use the env default" and
    // would shadow the tenant's from-number, since `messagingServiceSid`
    // takes precedence over `from`). An empty string is falsy at the
    // client's send-time guard, so the tenant's number is actually used.
    return { from: tenant.from, messagingServiceSid: "" };
  }
  return {};
}

/**
 * The tenant's outbound voice caller-id (E.164), or `null` (→ platform
 * default) when it has none. Accepts `undefined` / blank orgId → `null`.
 */
export async function resolveTenantVoiceFrom(
  orgId: string | undefined,
): Promise<string | null> {
  const tenantOrgId = orgId?.trim();
  if (!tenantOrgId) return null;
  const row = await loadTelecomRow(tenantOrgId);
  return row.voiceFromNumber;
}

/**
 * The tenant's outbound fax sender (E.164), or `null` (→ platform default
 * `TELNYX_FAX_FROM_NUMBER`) when it has none. Accepts `undefined` / blank
 * orgId → `null`.
 */
export async function resolveTenantFaxFrom(
  orgId: string | undefined,
): Promise<string | null> {
  const tenantOrgId = orgId?.trim();
  if (!tenantOrgId) return null;
  const row = await loadTelecomRow(tenantOrgId);
  return row.faxFromNumber;
}

/**
 * Reverse lookup for an inbound FAX webhook: the `org_id` that owns the
 * called fax number, or `null` when no tenant is bound to it (caller falls
 * back to the seed org). The unique partial index on `fax_from_number`
 * guarantees at most one match. Fails soft to `null` so a DB blip never
 * misroutes an inbound fax — it just lands in the seed tenant's queue.
 */
export async function resolveOrgIdByFaxNumber(
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
      const { data, error } = await raw
        .schema("resupply")
        .from("organizations")
        .select("id")
        .eq("fax_from_number", number)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      value = (data as { id: string } | null)?.id ?? null;
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_telecom_org_by_fax_lookup_failed", err },
      "tenant-telecom: org-by-fax-number lookup failed",
    );
    value = null;
  }

  byNumber.set(number, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
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
