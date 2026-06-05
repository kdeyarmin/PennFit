// Soft format validation for System Configuration values.
//
// These checks are advisory, NOT a gate: the route NEVER rejects a save
// because the format "looks off". A too-strict regex that locked out a
// legitimate (but unusual) credential would be worse than a missing
// check — so a mismatch only surfaces a "format looks unexpected"
// warning in the UI (computed server-side and returned as a boolean, so
// the secret itself never crosses the wire to be re-validated).
//
// Keep the patterns LENIENT and prefix-based — enough to catch an
// obvious paste error (wrong field, truncated value, swapped key) but
// permissive about live-vs-test and provider variations.

const URL_RULE: FormatRule = {
  test: /^https:\/\/\S+$/,
  hint: "an https:// URL",
};
const E164_RULE: FormatRule = {
  test: /^\+[1-9]\d{1,14}$/,
  hint: "E.164, e.g. +12155551234",
};

interface FormatRule {
  test: RegExp;
  /** Short human description of the expected shape (for the UI). */
  hint: string;
}

// Keyed by the literal env-var name (matches the catalog key). Only
// fields with a recognisable, stable shape are listed; everything else
// has no rule and is never flagged.
const FORMAT_RULES: Readonly<Record<string, FormatRule>> = {
  OPENAI_API_KEY: { test: /^sk-/, hint: "usually starts with sk-" },
  ANTHROPIC_API_KEY: { test: /^sk-ant-/, hint: "usually starts with sk-ant-" },

  STRIPE_SECRET_KEY: {
    test: /^(sk|rk)_(live|test)_/,
    hint: "sk_live_… / sk_test_…",
  },
  STRIPE_WEBHOOK_SIGNING_SECRET: {
    test: /^whsec_/,
    hint: "starts with whsec_",
  },
  STRIPE_PUBLISHABLE_KEY: {
    test: /^pk_(live|test)_/,
    hint: "pk_live_… / pk_test_…",
  },

  SENDGRID_API_KEY: { test: /^SG\./, hint: "starts with SG." },

  TWILIO_ACCOUNT_SID: {
    test: /^AC[0-9a-fA-F]{32}$/,
    hint: "AC + 32 hex chars",
  },
  TWILIO_MESSAGING_SERVICE_SID: {
    test: /^MG[0-9a-fA-F]{32}$/,
    hint: "MG + 32 hex chars",
  },
  TWILIO_PHONE_NUMBER: E164_RULE,
  TWILIO_FAX_FROM_NUMBER: E164_RULE,

  OFFICE_ALLY_USAGE_INDICATOR: { test: /^[PT]$/, hint: "P or T" },
  OFFICE_ALLY_PORT: { test: /^\d+$/, hint: "a numeric port" },

  AIRVIEW_API_BASE_URL: URL_RULE,
  AIRVIEW_OAUTH_TOKEN_URL: URL_RULE,
  CARE_ORCHESTRATOR_API_BASE_URL: URL_RULE,
  CARE_ORCHESTRATOR_OAUTH_TOKEN_URL: URL_RULE,
  REACT_HEALTH_API_BASE_URL: URL_RULE,
  REACT_HEALTH_OAUTH_TOKEN_URL: URL_RULE,
};

/**
 * Does `value` match the expected shape for `key`?
 *   * true  — matches.
 *   * false — there's a rule and the value doesn't match (UI warns).
 *   * null  — no rule for this key (nothing to check).
 */
export function checkConfigFormat(key: string, value: string): boolean | null {
  const rule = FORMAT_RULES[key];
  if (!rule) return null;
  return rule.test.test(value);
}

/** Human hint for the expected shape, or null when there's no rule. */
export function configFormatHint(key: string): string | null {
  return FORMAT_RULES[key]?.hint ?? null;
}

/** Every key that has a format rule — used by tests to pin catalog drift. */
export const FORMAT_RULE_KEYS: readonly string[] = Object.keys(FORMAT_RULES);
