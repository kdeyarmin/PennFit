// resolveDavinciPasToken — single source of truth for "what Bearer token do
// we forward to this payer's Da Vinci PAS endpoint" at runtime.
//
// Resolution order (highest priority first):
//   1. The org-scoped davinci_pas_credentials row for (orgId, payerSlug)
//      (is_active = true). This is the editable, per-tenant source that
//      moves the token out of process env (migration 0453).
//   2. The DAVINCI_PAS_TOKEN_<PAYER_SLUG> env var — the legacy path,
//      preserved verbatim so the current single-tenant deploy and
//      dev/preview keep working unchanged when no row is stored.
//
// Returns the token string, or null when NEITHER source has one (the
// caller maps that to the same `no_pas_credentials` 409 as before).
//
// SECRET HANDLING: the returned value is a Bearer token. This module never
// logs it (no bytes, not even a prefix) — see the data hard rules.

import { getOrgScopedClient } from "@workspace/resupply-db";

import { logger } from "../logger";

/** Derive the legacy env-var name for a payer's PAS token. */
export function davinciPasTokenEnvKey(payerSlug: string): string {
  return `DAVINCI_PAS_TOKEN_${payerSlug.toUpperCase()}`;
}

export interface ResolveDavinciPasTokenInput {
  /** Tenant for the org-scoped credential read. Required — fail closed. */
  orgId: string;
  /** The payer's Da Vinci PAS slug (payer_profiles.slug). */
  payerSlug: string;
  /** Test seam — defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Da Vinci PAS Bearer token for a (tenant, payer), preferring a
 * stored credential and falling back to the legacy env var.
 */
export async function resolveDavinciPasToken(
  input: ResolveDavinciPasTokenInput,
): Promise<string | null> {
  const { orgId, payerSlug } = input;
  const env = input.env ?? process.env;

  // Fail closed: a missing tenant must never resolve a token. (getOrgScopedClient
  // also throws on a blank orgId, but assert here so the env fallback below is
  // never reached for an unscoped caller.)
  if (!orgId || !orgId.trim()) {
    throw new Error(
      "resolveDavinciPasToken requires a non-empty orgId (tenant context missing).",
    );
  }

  // 1. Org-scoped stored credential takes precedence.
  const supabase = getOrgScopedClient(orgId);
  const { data: row, error } = await supabase
    .from("davinci_pas_credentials")
    .select("access_token")
    .eq("payer_slug", payerSlug)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) {
    // A read failure must NOT silently fall through to env and mask a
    // misconfiguration; but it also must not crash submission for the
    // existing env-only deploy. Log (no token bytes — the row never reached
    // us) and continue to the env fallback, exactly as a "no row" miss.
    logger.warn(
      { err: error.message, payerSlug },
      "davinci-pas: davinci_pas_credentials read failed; falling back to env",
    );
  } else {
    const stored = row?.access_token;
    if (stored && stored.trim().length > 0) {
      return stored.trim();
    }
  }

  // 2. Legacy env fallback — unchanged behavior for the current deploy.
  const envToken = env[davinciPasTokenEnvKey(payerSlug)];
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  return null;
}
