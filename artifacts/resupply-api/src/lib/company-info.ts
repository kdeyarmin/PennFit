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

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "./logger";

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
  /** Physical business address (null until the org row is seeded). */
  address: CompanyAddress | null;
  organizationalNpi: string | null;
  /** Where the values came from — surfaced on the admin page. */
  source: "database" | "environment" | "fallback";
}

// Historical hardcoded values — kept byte-identical to what shipped
// before this module existed so an unseeded environment renders exactly
// what it used to.
const DEFAULTS = {
  name: "PennPaps",
  // The registered DME business name. "PennPaps" is only the online
  // storefront brand; official paperwork carries the legal name.
  legalName: "Penn Home Medical Supply",
  phoneE164: "+18144710627",
  phoneDisplay: "(814) 471-0627",
  supportEmail: "support@pennpaps.com",
  generalEmail: "info@pennpaps.com",
  supportHours: "Mon–Fri 9a–5p ET",
} as const;

const CACHE_TTL_MS = 30_000;
const LOOKUP_TIMEOUT_MS = 1_500;

interface CacheEntry {
  info: CompanyInfo;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/** "+18144710627" → "(814) 471-0627"; non-NANP numbers pass through. */
export function formatPhoneForDisplay(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164.trim());
  if (!m) return e164;
  return `(${m[1]}) ${m[2]}-${m[3]}`;
}

function trimmed(v: string | null | undefined): string {
  return (v ?? "").trim();
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
    source: envName ? "environment" : "fallback",
  };
}

class CompanyInfoLookupTimeout extends Error {
  constructor() {
    super("company_info_lookup_timeout");
    this.name = "CompanyInfoLookupTimeout";
  }
}

async function loadFromDb(): Promise<CompanyInfo | null> {
  const supabase = getSupabaseServiceRoleClient();
  const lookup = supabase
    .schema("resupply")
    .from("dme_organization")
    .select("*")
    .eq("singleton", true)
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
    source: "database",
  };
}

/**
 * The effective company identity. Cached for ~30s; DB wins over env;
 * never throws (any failure degrades to env + historical defaults).
 */
export async function getCompanyInfo(): Promise<CompanyInfo> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.info;
  let info: CompanyInfo;
  try {
    info = (await loadFromDb()) ?? envFallbackInfo();
  } catch (err) {
    const normalized =
      err instanceof Error
        ? err
        : new Error(String((err as unknown) ?? "unknown"));
    logger.warn(
      { event: "company_info_load_failed", err: normalized },
      "company info load failed; falling back to environment defaults",
    );
    info = envFallbackInfo();
  }
  cache = { info, expiresAt: now + CACHE_TTL_MS };
  return info;
}

/** Drop the cache so an admin save is visible on the next read. */
export function invalidateCompanyInfoCache(): void {
  cache = null;
}

/**
 * Last-loaded company info without a DB round-trip, for synchronous
 * contexts (degraded-mode fallback replies, prompt builders). May be
 * stale by up to the refresh interval; the boot hydration plus the
 * periodic re-apply in index.ts keep it warm. Cold cache (tests, very
 * early boot) degrades to env + historical defaults.
 */
export function getCompanyInfoSync(): CompanyInfo {
  return cache?.info ?? envFallbackInfo();
}

/**
 * Name to print on official DME documents — SWO/CMN/DWO letterheads,
 * fax covers, prescription requests, manual documents, and report
 * sign-offs. Always the registered legal name ("Penn Home Medical
 * Supply"), never the online-storefront brand ("PennPaps").
 */
export async function getDocumentSupplierName(): Promise<string> {
  return (await getCompanyInfo()).legalName;
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
  cache = null;
}
