// Central company-identity resolver.
//
// One place answers "what is this company called and how do patients
// reach it" for every surface: SMS/email copy, the voice agent, the
// chatbots, generated PDFs, and the storefront footer. The source of
// truth is the dme_organization singleton the admin edits at
// /admin/company-information (DB wins), falling back to the
// RESUPPLY_PRACTICE_NAME environment variable and finally to the
// historical hardcoded defaults so dev/preview environments keep
// working with nothing seeded.
//
// Posture mirrors lib/app-config/store.ts:
//   * Fail-soft. A Supabase error/timeout degrades to env + defaults;
//     this must never be able to take a request path down.
//   * Cached for a short TTL so hot paths (chat prompts, worker jobs)
//     don't hit the DB per call.
//   * `applyCompanyInfoToEnv()` folds the admin-entered name into
//     process.env.RESUPPLY_PRACTICE_NAME (and the SENDGRID_FROM_NAME
//     alias) at boot and again whenever the org row is saved, so the
//     ~30 existing `env.RESUPPLY_PRACTICE_NAME` readers pick up the
//     value without each being rewritten.

import { getOrgScopedClient, resolveSeedOrgId } from "@workspace/resupply-db";

import { logger } from "./logger";
import { getTenantConfigValue } from "./app-config/store.js";

/**
 * The platform/parent-company brand. PennFit is the codename of this
 * SaaS; the product the business sells is **CareMetric Breathe**. It is
 * the constant that does NOT change per tenant — every DME company
 * (Penn Home Medical Supply / "PennPaps" is one such tenant) runs its
 * own storefront brand on top of the CareMetric Breathe platform. Use
 * this anywhere the app refers to *itself* (the software/platform), as
 * opposed to the operating tenant's own brand (see `CompanyInfo.name`).
 */
export const PLATFORM_NAME = "CareMetric Breathe";

/**
 * CareMetric platform defaults for the two in-app AI assistants. A
 * tenant owner may rename them from System Configuration
 * (RESUPPLY_ASSISTANT_STOREFRONT_NAME / RESUPPLY_ASSISTANT_ADMIN_NAME);
 * the Penn Home Medical Supply tenant is seeded to "PennBot"/"PennPilot".
 */
export const DEFAULT_STOREFRONT_ASSISTANT_NAME = "CareMetric Assistant";
export const DEFAULT_ADMIN_ASSISTANT_NAME = "CareMetric Copilot";

export interface CompanyAddress {
  line1: string;
  line2: string | null;
  city: string;
  state: string;
  zip: string;
}

export interface CompanyInfo {
  /** Patient-facing display/brand name (DBA when set, else legal name). */
  name: string;
  /** Registered legal name (falls back to `name`). */
  legalName: string;
  /** Main business phone, E.164 (+1...). */
  phoneE164: string;
  /** Main business phone formatted for display, e.g. "(814) 471-0627". */
  phoneDisplay: string;
  /** Customer-support phone (falls back to the main phone). */
  supportPhoneE164: string;
  supportPhoneDisplay: string;
  /** Customer-support mailbox (falls back to general, then billing email). */
  supportEmail: string;
  /** Legal/privacy contact mailbox. */
  generalEmail: string;
  billingEmail: string;
  faxE164: string | null;
  websiteUrl: string | null;
  /** Published support hours, e.g. "Mon–Fri 9a–5p ET". */
  supportHours: string;
  /**
   * Display name for the customer-facing storefront chat assistant.
   * Tenant-configurable; defaults to the CareMetric platform name.
   */
  assistantStorefrontName: string;
  /**
   * Display name for the in-app admin-console assistant.
   * Tenant-configurable; defaults to the CareMetric platform name.
   */
  assistantAdminName: string;
  /** Physical business address (null until the org row is seeded). */
  address: CompanyAddress | null;
  organizationalNpi: string | null;
  /** Where the values came from — surfaced on the admin page. */
  source: "database" | "environment" | "fallback";
}

// Platform-identity fallback for an UNCONFIGURED tenant — used only when
// no `dme_organization` row exists (and no RESUPPLY_PRACTICE_NAME env).
//
// Brand architecture: the platform is **CareMetric Breathe** (cmbreathe.com).
// "Penn Home Medical Supply" / storefront brand "PennPaps" is ONE TENANT, not
// the platform default — so an unseeded environment, or a second tenant that
// hasn't filled in Company Information, falls back to the NEUTRAL platform
// identity rather than inheriting the seed tenant's brand. The seed tenant
// (Penn) carries its own brand in its `dme_organization` row (source =
// "database"), so this fallback never changes Penn's patient-facing copy.
//
// The platform is not itself a DME with a patient support line, so there is
// no platform phone — `phoneE164`/`phoneDisplay` are blank in the fallback
// (a configured tenant always supplies its own). The historical Penn literals
// live on only as the `identityReplacements()` needles below, which rewrite
// the brand-baked source text to a DB-backed tenant's own values.
const DEFAULTS = {
  name: "CareMetric Breathe",
  legalName: "CareMetric Breathe",
  phoneE164: "",
  phoneDisplay: "",
  supportEmail: "support@cmbreathe.com",
  generalEmail: "support@cmbreathe.com",
  supportHours: "Mon–Fri 9a–5p ET",
} as const;

const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 1_500;

interface CacheEntry {
  info: CompanyInfo;
  expiresAt: number;
}

// Company identity is per-tenant (dme_organization carries org_id). Cache by
// org so a tenant's documents/statements show ITS company, not the seed's.
// The no-orgId / seed path uses the SEED_CACHE_KEY entry, which the boot
// hydration + periodic re-apply keep warm for the synchronous accessors.
const SEED_CACHE_KEY = "__seed__";
const cacheByOrg = new Map<string, CacheEntry>();

/** "+18144710627" → "(814) 471-0627"; non-NANP numbers pass through. */
export function formatPhoneForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function trimmed(v: string | null | undefined): string {
  return (v ?? "").trim();
}

/**
 * The two assistant display names, resolved from the tenant-configurable
 * env vars (populated by the app_config overlay at boot) with the
 * CareMetric platform defaults as the fallback. Independent of the
 * dme_organization row so the names resolve even for an unseeded tenant.
 */
function resolveAssistantNames(): {
  assistantStorefrontName: string;
  assistantAdminName: string;
} {
  return {
    assistantStorefrontName:
      trimmed(process.env.RESUPPLY_ASSISTANT_STOREFRONT_NAME) ||
      DEFAULT_STOREFRONT_ASSISTANT_NAME,
    assistantAdminName:
      trimmed(process.env.RESUPPLY_ASSISTANT_ADMIN_NAME) ||
      DEFAULT_ADMIN_ASSISTANT_NAME,
  };
}

function envFallbackInfo(): CompanyInfo {
  const envName = trimmed(process.env.RESUPPLY_PRACTICE_NAME);
  const name = envName || DEFAULTS.name;
  return {
    name,
    legalName: envName || DEFAULTS.legalName,
    phoneE164: DEFAULTS.phoneE164,
    phoneDisplay: DEFAULTS.phoneDisplay,
    supportPhoneE164: DEFAULTS.phoneE164,
    supportPhoneDisplay: DEFAULTS.phoneDisplay,
    supportEmail: DEFAULTS.supportEmail,
    generalEmail: DEFAULTS.generalEmail,
    billingEmail: DEFAULTS.generalEmail,
    faxE164: null,
    websiteUrl: null,
    supportHours: DEFAULTS.supportHours,
    address: null,
    organizationalNpi: null,
    ...resolveAssistantNames(),
    source: envName ? "environment" : "fallback",
  };
}

// The NEUTRAL platform identity, with NO reading of the process-global
// RESUPPLY_PRACTICE_NAME / RESUPPLY_ASSISTANT_* env (which the boot hydration
// folds to the SEED tenant's brand). Used for an explicitly-addressed tenant
// that has no dme_organization row yet: a brand-new tenant must fall back to
// CareMetric Breathe, never inherit the seed (Penn) tenant's name/bots.
function platformFallbackInfo(): CompanyInfo {
  return {
    name: DEFAULTS.name,
    legalName: DEFAULTS.legalName,
    phoneE164: DEFAULTS.phoneE164,
    phoneDisplay: DEFAULTS.phoneDisplay,
    supportPhoneE164: DEFAULTS.phoneE164,
    supportPhoneDisplay: DEFAULTS.phoneDisplay,
    supportEmail: DEFAULTS.supportEmail,
    generalEmail: DEFAULTS.generalEmail,
    billingEmail: DEFAULTS.generalEmail,
    faxE164: null,
    websiteUrl: null,
    supportHours: DEFAULTS.supportHours,
    address: null,
    organizationalNpi: null,
    assistantStorefrontName: DEFAULT_STOREFRONT_ASSISTANT_NAME,
    assistantAdminName: DEFAULT_ADMIN_ASSISTANT_NAME,
    source: "fallback",
  };
}

class CompanyInfoLookupTimeout extends Error {
  constructor() {
    super("company_info_lookup_timeout");
    this.name = "CompanyInfoLookupTimeout";
  }
}

async function loadFromDb(orgId: string): Promise<CompanyInfo | null> {
  const supabase = getOrgScopedClient(orgId);
  // Org-scoped: the facade appends `.eq("org_id", orgId)`, so this reads the
  // caller's company identity (one row per org, migration 0375). The legacy
  // `.eq("singleton", true)` filter is dropped — it would exclude a non-seed
  // tenant's row and is redundant now that org_id selects the right row.
  const lookup = supabase
    .from("dme_organization")
    .select("*")
    .limit(1)
    .maybeSingle();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CompanyInfoLookupTimeout()),
      LOOKUP_TIMEOUT_MS,
    );
  });
  let result: Awaited<typeof lookup>;
  try {
    result = await Promise.race([lookup, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const { data: org, error } = result;
  if (error) throw error;
  if (!org || !trimmed(org.legal_name)) return null;

  const fallback = envFallbackInfo();
  const name = trimmed(org.dba_name) || trimmed(org.legal_name);
  const phoneE164 = trimmed(org.phone_e164) || fallback.phoneE164;
  const supportPhoneE164 = trimmed(org.support_phone_e164) || phoneE164;
  const generalEmail =
    trimmed(org.general_email) ||
    trimmed(org.billing_email) ||
    fallback.generalEmail;
  return {
    name,
    legalName: trimmed(org.legal_name),
    phoneE164,
    phoneDisplay: formatPhoneForDisplay(phoneE164),
    supportPhoneE164,
    supportPhoneDisplay: formatPhoneForDisplay(supportPhoneE164),
    supportEmail: trimmed(org.support_email) || generalEmail,
    generalEmail,
    billingEmail: trimmed(org.billing_email) || generalEmail,
    faxE164: trimmed(org.fax_e164) || null,
    websiteUrl: trimmed(org.website_url) || null,
    supportHours: trimmed(org.support_hours_text) || DEFAULTS.supportHours,
    address: {
      line1: org.physical_address_line1,
      line2: org.physical_address_line2,
      city: org.physical_city,
      state: org.physical_state,
      zip: org.physical_zip,
    },
    organizationalNpi: trimmed(org.organizational_npi) || null,
    ...resolveAssistantNames(),
    source: "database",
  };
}

/**
 * The effective company identity. Cached for ~30s; DB wins over env;
 * never throws (any failure degrades to env + historical defaults).
 */
export async function getCompanyInfo(orgId?: string): Promise<CompanyInfo> {
  const now = Date.now();
  const key = orgId?.trim() || SEED_CACHE_KEY;
  const hit = cacheByOrg.get(key);
  if (hit && hit.expiresAt > now) return hit.info;
  let info: CompanyInfo;
  try {
    const explicitOrgId = orgId?.trim();
    const seedOrgId = await resolveSeedOrgId();
    if (explicitOrgId && explicitOrgId !== seedOrgId) {
      // A specific NON-seed tenant. Its own row, or the neutral platform
      // identity — never the seed (Penn) tenant's env-folded brand. This is
      // what stops a new/unconfigured tenant from inheriting "PennPaps".
      info = (await loadFromDb(explicitOrgId)) ?? platformFallbackInfo();
    } else {
      // The seed tenant (explicit or default). Single-tenant behavior is
      // unchanged: its DB row wins, else the env-folded practice name.
      const effectiveOrgId = explicitOrgId || seedOrgId;
      info = effectiveOrgId
        ? ((await loadFromDb(effectiveOrgId)) ?? envFallbackInfo())
        : envFallbackInfo();
    }
  } catch (err) {
    const normalized =
      err instanceof Error
        ? err
        : new Error(String((err as unknown) ?? "unknown"));
    logger.warn(
      { event: "company_info_load_failed", err: normalized },
      "company info load failed; falling back to defaults",
    );
    // Degrade WITHOUT leaking the seed (Penn) brand to another tenant. The
    // env-folded fallback (envFallbackInfo) carries the SEED tenant's
    // practice name, so a non-seed tenant whose DB read times out/errors
    // must fall back to the NEUTRAL platform identity, never Penn's brand —
    // the same rule the happy path enforces. Only the default path (no
    // explicit orgId) or the seed tenant itself may use the env fallback.
    const explicitOrgId = orgId?.trim();
    if (!explicitOrgId) {
      info = envFallbackInfo();
    } else {
      let seedOrgId: string | null;
      try {
        // Cached + side-effect-free, but guard so a degraded path can't throw.
        seedOrgId = await resolveSeedOrgId();
      } catch {
        seedOrgId = null;
      }
      info =
        seedOrgId && explicitOrgId === seedOrgId
          ? envFallbackInfo()
          : platformFallbackInfo();
    }
  }
  cacheByOrg.set(key, { info, expiresAt: now + CACHE_TTL_MS });
  return info;
}

/** Drop every cached org so an admin save is visible on the next read. */
export function invalidateCompanyInfoCache(): void {
  cacheByOrg.clear();
}

/**
 * Last-loaded company info without a DB round-trip, for synchronous
 * contexts (degraded-mode fallback replies, prompt builders). May be
 * stale by up to the refresh interval; the boot hydration plus the
 * periodic re-apply in index.ts keep it warm. Cold cache (tests, very
 * early boot) degrades to env + historical defaults.
 */
export function getCompanyInfoSync(): CompanyInfo {
  // The seed/default entry — kept warm by boot hydration + the periodic
  // re-apply. Per-tenant sync identity isn't available (no DB round-trip);
  // callers that need a specific tenant must use the async getCompanyInfo(orgId).
  return cacheByOrg.get(SEED_CACHE_KEY)?.info ?? envFallbackInfo();
}

/**
 * Name to print on official DME documents — SWO/CMN/DWO letterheads,
 * fax covers, prescription requests, manual documents, and report
 * sign-offs. Always the registered legal name ("Penn Home Medical
 * Supply"), never the online-storefront brand ("PennPaps").
 */
export async function getDocumentSupplierName(orgId?: string): Promise<string> {
  return (await getCompanyInfo(orgId)).legalName;
}

/** Synchronous variant for non-async contexts (warm cache or fallback). */
export function getDocumentSupplierNameSync(): string {
  return getCompanyInfoSync().legalName;
}

// The literal strings that were historically hardcoded across chat
// knowledge, fallback replies, and storefront copy. When the admin has
// saved a company row, `applyCompanyIdentityToText` rewrites these to
// the saved values; until then the text passes through unchanged.
// Longest-first so e.g. emails are consumed before the bare brand name.
function identityReplacements(info: CompanyInfo): Array<[string, string]> {
  const websiteHost = (() => {
    if (!info.websiteUrl) return info.name;
    try {
      return new URL(info.websiteUrl).host.replace(/^www\./, "");
    } catch {
      return info.name;
    }
  })();
  return [
    ["support@pennpaps.com", info.supportEmail],
    ["info@pennpaps.com", info.generalEmail],
    ["Penn Home Medical Supply", info.legalName],
    ["PennPaps.com", websiteHost],
    ["pennpaps.com", websiteHost],
    ["(814) 471-0627", info.supportPhoneDisplay],
    ["+18144710627", info.supportPhoneE164],
    // The voice/IVR (TTS) day-copy spaces the storefront brand as two
    // words ("Penn Paps") so Polly/ElevenLabs pronounce it naturally;
    // rewrite that spelling too for a non-seed tenant. Skip it when the
    // brand IS the seed "PennPaps" so the seed tenant keeps its deliberate
    // two-word TTS spelling rather than collapsing to camel case.
    ...(info.name === "PennPaps"
      ? []
      : ([["Penn Paps", info.name]] as Array<[string, string]>)),
    ["PennPaps", info.name],
    // Hour-blurb variants that appear across the knowledge bases.
    ["Monday-Friday 9 AM - 5 PM Eastern", info.supportHours],
    ["Mon-Fri 9 AM - 5 PM Eastern", info.supportHours],
    ["Mon–Fri 9a–5p ET", info.supportHours],
    ["Mon-Fri 9-5 ET", info.supportHours],
  ];
}

/**
 * Rewrite the historical hardcoded brand/contact strings in `text` to
 * the admin-entered values. No-op until a company row exists (the
 * defaults are already baked into the source text). Synchronous — uses
 * the warm cache via `getCompanyInfoSync()` unless `info` is passed.
 */
export function applyCompanyIdentityToText(
  text: string,
  info: CompanyInfo = getCompanyInfoSync(),
): string {
  if (info.source !== "database") return text;
  let out = text;
  for (const [needle, replacement] of identityReplacements(info)) {
    if (replacement) out = out.split(needle).join(replacement);
  }
  return out;
}

/**
 * Normalize the platform/assistant brand tokens in machine-generated
 * text (chat system prompts, assistant offline replies, suggestion
 * emails) to the current tenant's effective names. Distinct from
 * `applyCompanyIdentityToText`, which swaps the *tenant's* own
 * brand/contact strings and only fires once a company row is saved:
 *
 *   - "PennFit"   → the platform brand (CareMetric Breathe) for EVERY
 *                   tenant — PennFit is the internal codename; the
 *                   product is always CareMetric Breathe.
 *   - "PennBot"   → the tenant's configured storefront assistant name
 *                   (CareMetric Assistant by default; "PennBot" for the
 *                   Penn Home Medical Supply tenant — a no-op there).
 *   - "PennPilot" → the tenant's configured admin assistant name
 *                   (CareMetric Copilot by default; "PennPilot" for Penn
 *                   Home Medical Supply — a no-op there).
 *
 * Keeping the Penn* tokens as the in-source placeholders means the large
 * prompt knowledge bases don't need to change; the correct names are
 * produced at the point the text leaves the server. Idempotent.
 */
export function applyPlatformBranding(
  text: string,
  info: CompanyInfo = getCompanyInfoSync(),
): string {
  if (!text) return text;
  let out = text.split("PennFit").join(PLATFORM_NAME);
  if (
    info.assistantStorefrontName &&
    info.assistantStorefrontName !== "PennBot"
  )
    out = out.split("PennBot").join(info.assistantStorefrontName);
  if (info.assistantAdminName && info.assistantAdminName !== "PennPilot")
    out = out.split("PennPilot").join(info.assistantAdminName);
  return out;
}

/**
 * Resolve the two assistant display names for a SPECIFIC tenant. The
 * per-tenant counterpart of `resolveAssistantNames()` (which reads the seed
 * value folded into `process.env` at boot): this reads the tenant-scoped
 * `RESUPPLY_ASSISTANT_*` app_config keys via `getTenantConfigValue`, which
 * falls back to the seed org's value (the platform default) when the tenant
 * has no row, then to the CareMetric defaults when neither is set.
 *
 * Fail-soft: `getTenantConfigValue` never throws, so a flaky lookup degrades
 * to the platform defaults. Single-tenant: the seed org's row is the only
 * one, so this returns exactly what `resolveAssistantNames()` does.
 */
export async function resolveAssistantNamesForOrg(orgId: string): Promise<{
  assistantStorefrontName: string;
  assistantAdminName: string;
}> {
  const [storefront, admin] = await Promise.all([
    getTenantConfigValue(orgId, "RESUPPLY_ASSISTANT_STOREFRONT_NAME"),
    getTenantConfigValue(orgId, "RESUPPLY_ASSISTANT_ADMIN_NAME"),
  ]);
  return {
    assistantStorefrontName:
      trimmed(storefront) || DEFAULT_STOREFRONT_ASSISTANT_NAME,
    assistantAdminName: trimmed(admin) || DEFAULT_ADMIN_ASSISTANT_NAME,
  };
}

/**
 * `applyPlatformBranding`, but resolving the assistant names for a SPECIFIC
 * tenant rather than the process-global (seed) names. Use this on
 * per-request surfaces that know their `orgId` (storefront chatbot, admin
 * assistant) so a second tenant's configured assistant names appear in
 * machine-generated text. When `orgId` is absent it degrades to the
 * synchronous, seed-scoped `applyPlatformBranding` — so single-tenant and
 * host-unresolved requests are unchanged.
 */
export async function applyPlatformBrandingForOrg(
  text: string,
  orgId: string | null | undefined,
): Promise<string> {
  if (!text || !orgId) return applyPlatformBranding(text);
  const names = await resolveAssistantNamesForOrg(orgId);
  return applyPlatformBranding(text, { ...getCompanyInfoSync(), ...names });
}

// What SENDGRID_FROM_NAME / RESUPPLY_PRACTICE_NAME looked like before
// this module ever touched them, captured at module load (i.e. after
// applyEnvAliases() but before any hydration). Used to tell "operator
// explicitly set this in Railway" apart from "we wrote it earlier" so
// re-hydration stays idempotent and an explicit From-name still wins.
const initialEnvPracticeName = trimmed(process.env.RESUPPLY_PRACTICE_NAME);
const initialEnvFromName = trimmed(process.env.SENDGRID_FROM_NAME);

/**
 * Fold the admin-entered company name into process.env so the existing
 * `RESUPPLY_PRACTICE_NAME` readers (SMS/email copy, voice prompt, PDF
 * headers, MFA issuer) all use it without being rewritten. DB wins —
 * the Company information page is authoritative, matching the
 * app_config overlay precedence. Fail-soft; never throws. Called once
 * post-listen at boot and again after every org-row save.
 */
export async function applyCompanyInfoToEnv(): Promise<{
  applied: boolean;
}> {
  const info = await getCompanyInfo();
  if (info.source !== "database") return { applied: false };
  process.env.RESUPPLY_PRACTICE_NAME = info.name;
  // Keep the email From-name aliased to the brand name unless the
  // operator explicitly set a distinct SENDGRID_FROM_NAME in the env.
  if (!initialEnvFromName || initialEnvFromName === initialEnvPracticeName) {
    process.env.SENDGRID_FROM_NAME = info.name;
  }
  return { applied: true };
}

/** Test-only: reset module state between cases. */
export function __resetCompanyInfoForTests(): void {
  cacheByOrg.clear();
}
