// System Configuration runtime resolver.
//
// Bridges the resupply.app_config table (values a super-admin entered
// in the UI) into the values the rest of the process reads from
// `process.env`. Two consumption paths:
//
//   * LIVE (therapy cloud): the integration registry calls
//     `getEffectiveEnv()` on each rebuild, so a rotated AirView /
//     Care Orchestrator / React Health credential takes effect on the
//     next sync without a restart. Cached for a few seconds so we
//     don't hit Supabase on every adapter construction.
//
//   * RESTART (everything else — Stripe, Twilio, SendGrid, …):
//     `applyAppConfigOverlayToEnv()` folds saved values into
//     `process.env` ONCE at boot, so vendor clients that read the env
//     at startup pick them up on the next deploy.
//
// Precedence: a DB value WINS over the matching `process.env` value
// for catalog keys — the admin UI is authoritative for these optional
// integration settings (entering a value there is meant to be used).
// "Clear" removes the row and the env value takes over again.
//
// Posture:
//   * Fail-soft. Any Supabase error/timeout degrades to "no overrides"
//     (the process keeps running on its Railway env). This MUST NOT be
//     able to take the site down — it sits in the same don't-couple-
//     boot-to-the-DB spirit as the feature-flag reader and the
//     decoupled worker boot.
//   * Boot-critical keys are NEVER overlaid (defense in depth — they
//     aren't in the catalog either), so there's no "need the DB to read
//     the creds that reach the DB" cycle.
//   * Kill switch: APP_CONFIG_OVERLAY_DISABLED=1 bypasses the overlay
//     entirely (both live and boot) in case a bad row ever needs to be
//     ignored without a DB round-trip.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";
import { APP_CONFIG_KEYS, isAppConfigKey } from "./catalog";

// Catalog keys are all optional/feature-gated, but guard the bootstrap
// credentials explicitly so a future catalog edit can never make the
// process depend on a value it can only read AFTER it has started.
const BOOT_CRITICAL_KEYS: ReadonlySet<string> = new Set([
  "DATABASE_URL",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PORT",
  "NODE_ENV",
  "RESUPPLY_LINK_HMAC_KEY",
  "RAILWAY_PUBLIC_DOMAIN",
  "RESUPPLY_ALLOWED_ORIGINS",
  "SUPABASE_STORAGE_BUCKET_PRIVATE",
]);

const CACHE_TTL_MS = 10_000;
const LIVE_TIMEOUT_MS = 1_500;
const BOOT_TIMEOUT_MS = 2_500;

interface OverlayCache {
  overrides: Record<string, string>;
  expiresAt: number;
}

let cache: OverlayCache | null = null;

function overlayDisabled(): boolean {
  const v = process.env.APP_CONFIG_OVERLAY_DISABLED;
  return v === "1" || v === "true";
}

class AppConfigLookupTimeout extends Error {
  constructor() {
    super("app_config_lookup_timeout");
    this.name = "AppConfigLookupTimeout";
  }
}

/**
 * Read every app_config row, keeping only catalog keys that are safe to
 * overlay. Fail-soft: returns `{}` on any error/timeout (the caller
 * degrades to `process.env`). Never throws.
 */
async function loadOverridesFromDb(
  timeoutMs: number,
): Promise<Record<string, string>> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const lookup = supabase
      .schema("resupply")
      .from("app_config")
      .select("key, value");

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppConfigLookupTimeout()), timeoutMs);
    });
    let result: Awaited<typeof lookup>;
    try {
      result = await Promise.race([lookup, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const { data, error } = result;
    if (error) throw error;

    const out: Record<string, string> = {};
    for (const row of data ?? []) {
      const key = (row as { key: string }).key;
      const value = (row as { value: string }).value;
      // Ignore stray / retired keys and bootstrap creds defensively.
      if (!isAppConfigKey(key)) continue;
      if (BOOT_CRITICAL_KEYS.has(key)) continue;
      if (typeof value === "string") out[key] = value;
    }
    return out;
  } catch (err) {
    // Log the Error OBJECT (not the raw message string) so the logger's
    // redaction scrubs err.message / err.stack — an upstream error could
    // otherwise embed a DSN fragment or secret. Fail-soft: degrade to
    // "no overrides" and let the caller run on process.env.
    const normalized =
      err instanceof Error
        ? err
        : new Error(String((err as unknown) ?? "unknown"));
    logger.warn(
      { event: "app_config_overlay_load_failed", err: normalized },
      "app_config overlay load failed; falling back to process.env only",
    );
    return {};
  }
}

/**
 * The current DB overrides (catalog keys → value), process-cached for a
 * few seconds. Empty when the overlay is disabled or the DB is
 * unreachable. NOTE: values may include secrets — never log this map.
 */
export async function getConfigOverrides(): Promise<Record<string, string>> {
  if (overlayDisabled()) return {};
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.overrides;
  const overrides = await loadOverridesFromDb(LIVE_TIMEOUT_MS);
  cache = { overrides, expiresAt: now + CACHE_TTL_MS };
  return overrides;
}

/**
 * `process.env` with the DB overrides layered on top (DB wins). Passed
 * to the integration registry so therapy-cloud credentials entered in
 * the UI take effect live. Returns the base object unchanged when there
 * are no overrides so the common (nothing-entered) case allocates
 * nothing.
 */
export async function getEffectiveEnv(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const overrides = await getConfigOverrides();
  if (Object.keys(overrides).length === 0) return base;
  return { ...base, ...overrides };
}

/** Drop the cached overlay so a recent write is visible next read. */
export function invalidateAppConfigCache(): void {
  cache = null;
}

/**
 * Boot-time merge: fold saved config values into `process.env` so the
 * "restart" settings (read at startup elsewhere) pick them up. Called
 * once during the decoupled, post-listen boot path — NEVER on the
 * request hot path, and NEVER allowed to throw (a failure just leaves
 * the Railway env in place). Returns a count for the boot log; logs
 * only the count + key NAMES (never values).
 */
export async function applyAppConfigOverlayToEnv(): Promise<{
  applied: number;
}> {
  if (overlayDisabled()) {
    logger.info(
      { event: "app_config_overlay_skipped", reason: "disabled" },
      "app_config overlay disabled via APP_CONFIG_OVERLAY_DISABLED",
    );
    return { applied: 0 };
  }
  const overrides = await loadOverridesFromDb(BOOT_TIMEOUT_MS);
  const appliedKeys: string[] = [];
  for (const [key, value] of Object.entries(overrides)) {
    // loadOverridesFromDb already filtered to safe catalog keys.
    process.env[key] = value;
    appliedKeys.push(key);
  }
  // Refresh the live cache so the first post-boot read reflects what we
  // just merged without another round-trip.
  cache = { overrides, expiresAt: Date.now() + CACHE_TTL_MS };
  if (appliedKeys.length > 0) {
    logger.info(
      {
        event: "app_config_overlay_applied",
        applied: appliedKeys.length,
        // Key NAMES are env-var identifiers, not secrets. Values are
        // never logged.
        keys: appliedKeys,
      },
      `applied ${appliedKeys.length} config override(s) from app_config`,
    );
  }
  return { applied: appliedKeys.length };
}

/**
 * Mask a secret for display: reveal only the last 4 characters so an
 * operator can confirm WHICH value is set without exposing it. Short
 * values are fully masked.
 */
export function maskSecretHint(value: string): string {
  if (value.length <= 4) return "••••";
  return `••••${value.slice(-4)}`;
}

/** Test-only: clear the module cache between cases. */
export function __resetAppConfigCacheForTests(): void {
  cache = null;
}

// Re-export the catalog key list for callers that only need the closed
// set (e.g. the boot overlay's symmetry with the route layer).
export { APP_CONFIG_KEYS };
