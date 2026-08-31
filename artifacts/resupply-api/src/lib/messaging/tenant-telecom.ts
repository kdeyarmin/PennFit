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

import { normalizeE164 } from "@workspace/resupply-domain";
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
  byPatientPhone.clear();
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
 * called fax number, or `null` when no tenant is bound to it. The unique
 * partial index on `fax_from_number` guarantees at most one match. Fails
 * soft to `null` on a DB blip so the caller can refuse the write (ingest
 * fail-closes — it must not park PHI in another tenant's inbox).
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

// patient phone (normalized E.164) → owning orgId, for routing an inbound
// reply that landed on a SHARED number. Cached briefly like the others.
const byPatientPhone = new Map<string, CacheEntry<string | null>>();

/**
 * Disambiguate an inbound reply that arrived on a SHARED platform number —
 * one not bound to any single tenant — by the PATIENT's number: route it to
 * the tenant that patient belongs to.
 *
 * This is the middle step between `resolveOrgIdByCalledNumber` (number owned
 * by a specific tenant → route straight there) and the caller's fail-closed
 * path. Without it, every tenant sharing one number would have its patients'
 * replies collapse into the single org that owns the number. With it, a
 * shared number works for two-way texting across tenants until each
 * provisions its own.
 *
 * Resolution: find every patient row across all tenants with this phone.
 * EXACTLY ONE owning tenant → route there. More than one → return null and
 * let the caller fail closed. There is no tie-break, deliberately: see the
 * ambiguity branch below. Cross-tenant read via `.raw()`; returns ONLY an
 * org_id, never PHI. Fails soft to null on any error.
 */
export async function resolveOrgIdByPatientPhone(
  fromNumber: string | undefined,
): Promise<string | null> {
  // Same normalize-before-lookup posture as resolveOrgIdByCalledNumber /
  // SMS inbound: bare NANP / 11-digit forms must become +1… before the
  // phone_e164 equality, and non-E.164 input must not reach PostgREST.
  const number = normalizeE164(fromNumber);
  if (!number) return null;
  const now = Date.now();
  const cached = byPatientPhone.get(number);
  if (cached && cached.expiresAt > now) return cached.value;

  let value: string | null = null;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      const { data, error } = await raw
        .schema("resupply")
        .from("patients")
        .select("id, org_id")
        .eq("phone_e164", number)
        .not("org_id", "is", null)
        .limit(25);
      if (error) throw error;
      const rows =
        (data as { id: string; org_id: string | null }[] | null) ?? [];
      const orgs = [
        ...new Set(rows.map((r) => r.org_id).filter((o): o is string => !!o)),
      ];
      if (orgs.length === 1) {
        value = orgs[0] ?? null;
      } else if (orgs.length > 1) {
        // AMBIGUOUS — fail closed.
        //
        // This used to tie-break on the most recent `conversations.
        // last_message_at`, which is a coin flip dressed up as a
        // heuristic: recency of contact is not evidence of ownership, and
        // whichever tenant happened to message the number last would
        // receive this patient's inbound reply, their conversation
        // thread, and any PHI in it.
        //
        // A shared platform number is exactly where this happens, and it
        // is exactly where getting it wrong is worst. Returning null hands
        // the caller its own fail-closed path (the inbound routes hang up
        // / drop rather than guess), which loses a message the tenant can
        // recover by provisioning their own DID — a cost measured in
        // configuration, not in a disclosure.
        value = null;
        logger.warn(
          {
            event: "tenant_telecom_patient_phone_ambiguous",
            orgCount: orgs.length,
          },
          "tenant-telecom: patient phone exists in multiple tenants — refusing to guess",
        );
      }
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_telecom_org_by_patient_phone_failed", err },
      "tenant-telecom: org-by-patient-phone lookup failed",
    );
    value = null;
  }

  byPatientPhone.set(number, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
export type InboundChannelKind = "sms" | "voice";

export async function resolveOrgIdByCalledNumber(
  toNumber: string | undefined,
  /**
   * WHICH channel the number was dialled on.
   *
   * This is not cosmetic. The lookup used to try `sms_from_number` and
   * then `voice_from_number` as two INDEPENDENT probes, and the two
   * partial unique indexes are per-column — nothing stops tenant A from
   * registering a DID as its SMS number while tenant B registers the same
   * DID for voice. An inbound CALL to that number then resolved to
   * tenant A, silently, and every downstream read was scoped to the wrong
   * practice.
   *
   * Asking for the owner of the channel the event actually arrived on
   * removes the ambiguity entirely. Defaults to trying both, in the old
   * order, only for callers that genuinely do not know (none today).
   */
  kind?: InboundChannelKind,
): Promise<string | null> {
  // Normalize to strict E.164 BEFORE the lookup. The inbound webhook schema
  // validates `To` only as `min(1)` (NOT E.164), and stored sender numbers
  // are E.164, so an un-normalized value would never match a real number —
  // and, critically, it MUST NOT be interpolated raw into a PostgREST filter:
  // a value carrying filter metacharacters (commas, dots, parentheses) could
  // alter the OR expression against the GLOBAL organizations directory and
  // misroute an inbound message to the wrong tenant. normalizeE164 strips
  // everything outside `[+0-9]` and rejects non-conforming input, so the
  // value we bind is always `+<digits>`.
  const number = normalizeE164(toNumber);
  if (!number) return null;
  const now = Date.now();
  // Cache per (kind, number): the same DID can legitimately answer to a
  // different tenant on SMS than on voice, so a kind-blind cache key
  // would let the first channel's answer serve the second.
  const cacheKey = `${kind ?? "any"}:${number}`;
  const cached = byNumber.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.value;

  // Columns to probe, in order. The value is always BOUND as an equality
  // argument, never interpolated into a filter expression, so a number
  // carrying filter metacharacters cannot alter the query against the
  // GLOBAL organizations directory.
  const columns: string[] =
    kind === "sms"
      ? ["sms_from_number"]
      : kind === "voice"
        ? ["voice_from_number"]
        : ["sms_from_number", "voice_from_number"];

  let value: string | null = null;
  try {
    const raw = await rawOrgClient();
    if (raw) {
      for (const column of columns) {
        const { data, error } = await raw
          .schema("resupply")
          .from("organizations")
          .select("id")
          .eq(column, number)
          .limit(1)
          .maybeSingle();
        if (error) throw error;
        value = (data as { id: string } | null)?.id ?? null;
        if (value) break;
      }
    }
  } catch (err) {
    logger.warn(
      { event: "tenant_telecom_org_lookup_failed", err },
      "tenant-telecom: org-by-number lookup failed",
    );
    value = null;
  }

  byNumber.set(cacheKey, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}
