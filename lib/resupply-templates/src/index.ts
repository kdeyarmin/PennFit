// @workspace/resupply-templates — render-path helper for the
// customer-message template library (Phase 1).
//
// Why this is a separate package
// ------------------------------
// The render path needs to be callable from any artifact that sends
// customer-facing messages — today that's resupply-api but a future
// out-of-process worker (see ADR 015 migration trigger) would want
// the same primitive. Packaging keeps it portable and unit-testable
// without a DB.
//
// Why DB lookup is INJECTED, not imported
// ---------------------------------------
// The helper accepts a `lookup` callback. The host artifact
// (resupply-api) supplies a function that does the actual Supabase
// (PostgREST) queries; this package stays free of @workspace/resupply-db
// and getDbPool(), meaning it can be exercised in tests with a
// trivial in-memory stub. Same registration pattern as
// `lib/resupply-audit`'s registerAuditRequestIdResolver (P3.7).
//
// Design constraints (see docs/proposals/customer-message-templates.md)
// --------------------------------------------------------------------
// - Substitution is fixed-syntax `{{snake_case_var}}`. NOT Handlebars,
//   NOT Mustache. No expressions, no conditionals, no loops, no
//   partials. Different copy goes in different template rows.
// - Per-template variable allowlist enforced at render time: an
//   unknown variable in `req.variables` is dropped silently (not a
//   render-time error — the call site is allowed to over-supply
//   to keep its render-call cheap), and a `{{var}}` reference NOT
//   in the template's own allowedVariables remains literal so a
//   typo is visible in QA.
// - Render-time fallback: if the lookup returns null (template
//   missing) or throws (DB outage), `renderMessage` returns the
//   `fallback` argument unchanged. Customer comms never silently
//   break on a misconfigured deploy or a transient DB blip.
//
// Phase scope
// -----------
// Phase 1 (this file): render + substitution + cache + fallback.
// Phase 3 will add per-customer override precedence to the lookup
// signature; the helper's signature already accepts customerId so
// the lookup fn can implement that internally without breaking
// callers.

export type Channel = "email" | "sms" | "voice" | "push";

export interface MessageTemplate {
  /** Stable identifier the call site uses to look this up. */
  templateKey: string;
  channel: Channel;
  /** Required for `email`; null for `sms` / `voice` / `push`. */
  subject: string | null;
  /** Required for `email`; null otherwise. */
  bodyHtml: string | null;
  /** Always present. For voice channels this is the spoken transcript. */
  bodyText: string;
  /**
   * Variables this template is allowed to reference. Variables in
   * `bodyText` / `bodyHtml` / `subject` outside this list remain
   * literal so a typo is visible in QA. Variables IN this list but
   * not supplied by the caller at render time also remain literal —
   * same visibility property.
   */
  allowedVariables: ReadonlyArray<string>;
}

export interface RenderRequest {
  templateKey: string;
  channel: Channel;
  /**
   * For Phase 3: the per-customer override path keys on this. In
   * Phase 1 the lookup ignores it (and per-customer overrides are
   * not yet exposed) but the field is in the contract today so
   * Phase 3 doesn't have to break existing call sites.
   */
  customerId?: string | null;
  /**
   * The substitution dictionary. Keys are snake_case_var without
   * the `{{ }}` braces; values are the rendered strings (caller
   * is responsible for any HTML-escaping the value needs).
   */
  variables: Readonly<Record<string, string>>;
}

export interface RenderResult {
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
}

/** Pluggable: the host artifact wires this to its DB query layer. */
export type TemplateLookup = (
  templateKey: string,
  channel: Channel,
  customerId: string | null,
) => Promise<MessageTemplate | null>;

/**
 * Replace every `{{var_name}}` token in `template` with the matching
 * value from `vars`, IF the variable is in `allowed` AND the value
 * is supplied. Tokens that don't satisfy both conditions are left
 * literal so QA can spot the issue.
 *
 * The regex deliberately rejects whitespace inside the braces so
 * `{{ patient_name }}` (with spaces) doesn't accidentally match —
 * that's a common Handlebars-ism we want to NOT support, to keep
 * the token shape boring.
 */
export function applyVariables(
  template: string,
  vars: Readonly<Record<string, string>>,
  allowed: ReadonlyArray<string>,
): string {
  if (!template) return template;
  const allowedSet = new Set(allowed);
  return template.replace(
    /\{\{([a-z][a-z0-9_]*)\}\}/g,
    (match, name: string) => {
      if (!allowedSet.has(name)) return match;
      const value = vars[name];
      if (value === undefined) return match;
      return value;
    },
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Same as `applyVariables` but HTML-escapes every interpolated
 * value by default. Use for the `bodyHtml` field of an email
 * template so a patient name like `<script>` or `O'Connor` lands
 * safely in the rendered HTML.
 *
 * Opt-out convention: variable names ending in `_html` are
 * substituted VERBATIM (the value is already trusted/sanitised
 * HTML). This matches the existing `image_block_html` /
 * `product_name_html` callsites that the messaging code uses
 * deliberately.
 */
export function applyVariablesHtmlSafe(
  template: string,
  vars: Readonly<Record<string, string>>,
  allowed: ReadonlyArray<string>,
): string {
  if (!template) return template;
  const allowedSet = new Set(allowed);
  return template.replace(
    /\{\{([a-z][a-z0-9_]*)\}\}/g,
    (match, name: string) => {
      if (!allowedSet.has(name)) return match;
      const value = vars[name];
      if (value === undefined) return match;
      return name.endsWith("_html") ? value : escapeHtml(value);
    },
  );
}

/**
 * In-process LRU-ish cache. Map preserves insertion order in JS, so
 * "delete + re-set on hit" gives us LRU eviction at no extra cost.
 *
 * 5-min TTL is a deliberate balance: long enough to absorb a burst
 * of sends that all reference the same template (typical for the
 * cron dispatchers — one tick produces N sends with the same
 * templateKey), short enough that an admin edit propagates without
 * an explicit invalidation hop.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  expiresAt: number;
  value: MessageTemplate | null;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(
  templateKey: string,
  channel: Channel,
  customerId: string | null,
): string {
  return `${templateKey}|${channel}|${customerId ?? "_global_"}`;
}

function cacheGet(key: string): CacheEntry | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return null;
  }
  // LRU touch: re-insert to move to most-recent slot.
  cache.delete(key);
  cache.set(key, entry);
  return entry;
}

function cacheSet(key: string, value: MessageTemplate | null): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    // Drop the oldest entry. Map iteration order is insertion order
    // (LRU thanks to cacheGet's touch); .keys().next().value is the
    // least-recently-used.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, {
    expiresAt: Date.now() + CACHE_TTL_MS,
    value,
  });
}

/**
 * Test-only seam: drop the cache so a test that seeds a different
 * lookup result doesn't see stale data from a previous case. NOT
 * exported via the public surface; only the in-package tests use it.
 */
export function __resetTemplateCacheForTests(): void {
  cache.clear();
}

/**
 * Render a customer-facing message.
 *
 * Lookup precedence:
 *   1. Per-customer override (delegated to the lookup fn — Phase 3).
 *   2. Global template at (templateKey, channel).
 *   3. Caller-supplied `fallback`.
 *
 * Variable substitution is applied AFTER the template body is chosen,
 * using the chosen template's allowedVariables. The fallback's
 * subject/body/text are passed through `applyVariables` against the
 * fallback's own implicit allowlist (the union of variable names
 * that appear in the fallback strings) so the fallback path
 * substitutes too — otherwise a DB miss would silently render the
 * raw template syntax to the customer.
 */
export async function renderMessage(
  req: RenderRequest,
  fallback: RenderResult,
  lookup: TemplateLookup,
): Promise<RenderResult> {
  const customerId = req.customerId ?? null;
  const key = cacheKey(req.templateKey, req.channel, customerId);

  let entry = cacheGet(key);
  if (!entry) {
    let value: MessageTemplate | null;
    try {
      value = await lookup(req.templateKey, req.channel, customerId);
    } catch {
      // Lookup failed (DB outage, table missing, network blip).
      // Cache the null briefly so we don't hammer the DB on every
      // send during the outage window; subsequent calls fall back.
      value = null;
    }
    cacheSet(key, value);
    entry = { expiresAt: Date.now() + CACHE_TTL_MS, value };
  }

  const template = entry.value;
  if (template) {
    return {
      subject:
        template.subject !== null
          ? applyVariables(
              template.subject,
              req.variables,
              template.allowedVariables,
            )
          : null,
      bodyHtml:
        template.bodyHtml !== null
          ? applyVariablesHtmlSafe(
              template.bodyHtml,
              req.variables,
              template.allowedVariables,
            )
          : null,
      bodyText: applyVariables(
        template.bodyText,
        req.variables,
        template.allowedVariables,
      ),
    };
  }

  // Fallback path. The fallback strings may contain placeholder
  // tokens too; substitute against the union of variable names the
  // caller supplied so unset placeholders stay literal.
  const fallbackAllowlist = Object.keys(req.variables);
  return {
    subject:
      fallback.subject !== null
        ? applyVariables(fallback.subject, req.variables, fallbackAllowlist)
        : null,
    bodyHtml:
      fallback.bodyHtml !== null
        ? applyVariablesHtmlSafe(
            fallback.bodyHtml,
            req.variables,
            fallbackAllowlist,
          )
        : null,
    bodyText: applyVariables(
      fallback.bodyText,
      req.variables,
      fallbackAllowlist,
    ),
  };
}
