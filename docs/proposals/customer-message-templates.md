# Proposal: Customer Message Template Library

**Status:** Design — awaiting greenlight before implementation.
**Author:** Claude Code (per request, 2026-05-08).
**Scope estimate:** 3–4 PRs across 2–3 weeks of engineering, gated on
the schema-deploy blocker described below.

## Problem

Customer-facing messages (reminders, order confirmations, smart-trigger
nudges, Rx renewals, onboarding check-ins, auth emails, etc.) are
currently rendered from **hard-coded TypeScript** in
`artifacts/resupply-api/src/lib/*/renderers.ts` and friends. Three
recurring asks the team has hit:

1. **Edit a single message without a deploy.** Today, fixing a typo
   in the day-30 onboarding SMS requires a code change + deploy +
   regression-test cycle.
2. **A/B-test or seasonally tweak a message.** Same shape — code
   change for a one-off.
3. **Carve out a per-customer exception.** Today, the only escape
   hatch is the CSR replying manually via the conversation composer.
   "Send all rx-renewal nudges to customer X via email only, never
   SMS, with a custom signature" has no expression in code.

The CSR macro library (migration `0017_csr_macros.sql`) is the prior
art for #1 — admin-managed canned replies persisted in
`resupply.csr_macros`. This proposal extends that model to all
customer-facing automated messages and adds a per-customer override
layer.

## Inventory of in-scope messages

Counted from the current tree. Roughly 30 distinct templates across
~15 files; the table below groups by call site.

| File                                                      | Templates today                                                   | Channels          |
| --------------------------------------------------------- | ----------------------------------------------------------------- | ----------------- |
| `lib/checkin-dispatcher.ts` (onboarding day 3/7/30/60/90) | 5 days × subject + text + html + sms + voice = ~20                | email, sms, voice |
| `lib/smart-triggers/renderers.ts`                         | per-trigger-kind: subject, text, html, sms, push                  | email, sms, push  |
| `lib/rx-renewal/renderers.ts`                             | subject, text, html, sms, push (parameterised by daysUntilExpiry) | email, sms, push  |
| `lib/order-emails/send-order-confirmation-email.ts`       | subject + html + text inline                                      | email             |
| `lib/order-emails/send-shipping-notification-email.ts`    | subject + html + text inline                                      | email             |
| `lib/cart-abandonment/send-cart-abandonment-email.ts`     | subject + html + text inline                                      | email             |
| `lib/back-in-stock-email.ts`                              | subject + html + text inline                                      | email             |
| `lib/insurance-lead-email.ts`                             | two: customer ack + admin notify                                  | email             |
| `lib/messaging/review-request-email.ts`                   | subject + html + text inline                                      | email             |
| `lib/resupply-auth/src/http/email-templates.ts`           | verify-email, password-reset, invite                              | email             |
| `lib/resupply-reminders` (signed-link tokens)             | reminder body                                                     | email + sms       |
| **Existing in DB:** `csr_macros`                          | CSR canned replies                                                | email, sms        |

Out of scope: anything that's not a customer-facing message
(internal ops alerts, fax cover letters, audit log strings).

## Constraints (do-not-break)

- **PHI never enters template strings.** A template body is
  _content_ — it can contain placeholders (`{{patient_first_name}}`)
  but the resolved patient name lives only at render time, never in
  the persisted template row. The template editor never displays a
  rendered preview against a real patient.
- **Variable allowlist per template type.** Each template kind gets
  a fixed set of variables it can reference. The editor enforces
  the allowlist (you can't add `{{ssn}}` to the rx-renewal email
  template even by typing it). Unknown variables render as the
  literal `{{unknown_var}}` so a typo is visible, not silently
  blank.
- **No template injection.** Substitution is a fixed-syntax
  `{{snake_case_var}}` regex replace, NOT Handlebars / Mustache /
  EJS. No expressions, no conditionals, no loops, no partials.
  Different copy for the day-3 vs day-7 onboarding goes in different
  template rows, not in a single conditional template.
- **Audit every edit.** Every template + override write goes through
  `logAudit()` with `action: "message_template.update"` and a metadata
  envelope of `{template_key, old_length, new_length, channel}` —
  NEVER the body itself (treat templates as content that may quote
  PHI-shaped patterns even though it shouldn't).
- **Render-time fallback.** If the DB lookup fails (network blip,
  migration mid-deploy), each renderer falls back to a hard-coded
  baseline shipped with the code so customer comms never silently
  break. The fallback is the seed value; templates start out
  identical to today's behaviour.

## Schema (proposed)

Two new tables under `resupply.*`. Both follow the `csr_macros`
column conventions (`id text PK, key text UNIQUE, isActive,
sortOrder, audit columns`).

### `resupply.message_templates`

The global library — one row per (template_key, channel) tuple.

```ts
export const messageTemplates = resupplySchema.table(
  "message_templates",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    // Stable identifier used by render call sites. Snake-case
    // domain.subject pattern: e.g. "onboarding.day_3",
    // "rx_renewal.30_day", "smart_trigger.usage_drop",
    // "order_confirmation.shop", "auth.password_reset".
    templateKey: text("template_key").notNull(),
    channel: text("channel").notNull(), // "email" | "sms" | "voice" | "push"
    // For email: subject is required + html/text body. For SMS / push:
    // subject is null + body required. For voice: body is the
    // voice-script transcript.
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text").notNull(),
    // Allowlist of variables this template may reference. The render
    // call site declares the allowlist; the admin UI uses it both
    // to validate edits and to render a "available variables" hint.
    // Stored on the row so the allowlist can evolve in lockstep with
    // the template content.
    allowedVariables: jsonb("allowed_variables")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    // Updated on every write; admin UI shows the most recent edit as
    // an at-a-glance history. Full version history is V2 (see Phase
    // 4 below).
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
    updatedBy: text("updated_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdBy: text("created_by"),
  },
  (t) => ({
    keyChannelIdx: uniqueIndex("message_templates_key_channel_idx").on(
      t.templateKey,
      t.channel,
    ),
    activeKeyIdx: index("message_templates_active_key_idx").on(
      t.isActive,
      t.templateKey,
    ),
    bodyTextLength: check(
      "message_templates_body_text_max_length",
      sql`length(${t.bodyText}) <= 50000`,
    ),
    bodyHtmlLength: check(
      "message_templates_body_html_max_length",
      sql`length(${t.bodyHtml}) <= 200000`,
    ),
    channelEnum: check(
      "message_templates_channel_enum",
      sql`${t.channel} IN ('email','sms','voice','push')`,
    ),
  }),
);
```

### `resupply.shop_customer_message_template_overrides`

Per-customer overrides. Sparse — only created when an admin
deliberately customises one template for one customer.

```ts
export const shopCustomerMessageTemplateOverrides = resupplySchema.table(
  "shop_customer_message_template_overrides",
  {
    id: text("id")
      .primaryKey()
      .default(sql`gen_random_uuid()::text`),
    customerId: text("customer_id").notNull(), // shop_customers.customer_id
    templateKey: text("template_key").notNull(),
    channel: text("channel").notNull(),
    // null fields here mean "use the global template's value for this
    // field". Override fields are independently nullable so an admin
    // can override just the SMS body for one customer while inheriting
    // the email subject + html.
    subject: text("subject"),
    bodyHtml: text("body_html"),
    bodyText: text("body_text"),
    // Independent enable/disable. When false, this customer is
    // suppressed entirely for this (template_key, channel) pair —
    // useful for "stop SMSing this patient on the rx-renewal flow,
    // but keep the email".
    isActive: boolean("is_active").notNull().default(true),
    // Per-customer override deserves a free-form note explaining
    // WHY the override exists, so a future admin reviewing the
    // record understands the call. PHI-redacted — body length capped.
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    createdBy: text("created_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`)
      .$onUpdateFn(() => new Date()),
    updatedBy: text("updated_by"),
  },
  (t) => ({
    customerKeyChannelIdx: uniqueIndex(
      "shop_customer_message_template_overrides_unique_idx",
    ).on(t.customerId, t.templateKey, t.channel),
    noteLength: check(
      "shop_customer_message_template_overrides_note_max_length",
      sql`${t.note} IS NULL OR length(${t.note}) <= 2000`,
    ),
  }),
);
```

## Render-path contract

A new helper in `lib/resupply-messaging` (or a new
`lib/resupply-templates` package) replaces the today-renderers'
hard-coded strings:

```ts
interface RenderRequest {
  templateKey: string;
  channel: "email" | "sms" | "voice" | "push";
  customerId?: string | null; // for override lookup
  variables: Record<string, string>;
}

interface RenderResult {
  subject: string | null;
  bodyHtml: string | null;
  bodyText: string;
}

/** Returns the rendered template, or the fallback if DB lookup fails
 *  or the template is missing. NEVER throws — failures degrade to
 *  the fallback so a misconfigured DB doesn't take outbound comms
 *  down. */
async function renderMessage(
  req: RenderRequest,
  fallback: RenderResult,
): Promise<RenderResult>;
```

Lookup precedence:

1. **Per-customer override** if `customerId` is present, enabled, and
   has non-null fields for the requested channel. Inherit per-field
   from the global where the override field is null.
2. **Global template** at `(template_key, channel)` if active.
3. **Fallback** passed in by the caller (the current hard-coded
   string).

Variable substitution: `{{snake_case_name}}` only. Replace with the
value from `req.variables`. Unknown placeholder remains literal
(`{{foo}}` → `{{foo}}`) so misuse is visible.

In-process LRU cache (5-min TTL, ~50 entries) keyed by
`(templateKey, channel, customerId ?? "_global_")`. Invalidated on
edit via a small pg-boss notification or — simpler — relies on TTL.

## Admin UI (proposed shape)

Two surfaces in the existing admin SPA, both under the existing
`AppShell` (so `.admin-root` discipline is respected):

### `/admin/templates` — the global library

- Sidebar list of template keys grouped by domain
  (`onboarding.*`, `rx_renewal.*`, `smart_trigger.*`,
  `order.*`, `auth.*`, `csr_macros.*`).
- Selecting one opens the per-channel editor pane: tabs for the
  channels this key declares, each with subject (if applicable) +
  body text + body html (rich) + the allowed-variables hint.
- "Test render" button: previews the body with admin-supplied test
  values for each variable (NEVER pulled from a real customer).
- Save → audit row written, in-process LRU invalidated next tick.

### `/admin/customers/:userId/messaging` — the per-customer override pane

- Surface inside the existing customer-360 screen (new tab).
- List of override rows for this customer; "Add override" picks a
  (template_key, channel) and opens the same editor as the global
  page, pre-filled with the global content for the operator to
  diff against.
- Disable toggle (suppress the customer from the channel entirely
  for this template_key).
- Required note field on every override — captures WHY.

## Phased delivery

| Phase            | Scope                                                                                                                                                | Risk                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **0** (this doc) | Design + open questions + schema-deploy gate                                                                                                         | None                                               |
| **1**            | Schema migration + seed data + `renderMessage()` helper + `lib/resupply-templates` package + a SINGLE renderer migration (rx_renewal email) as proof | Adds a migration; gated on P0.1/P0.2 (see blocker) |
| **2**            | Migrate the remaining email renderers + admin UI list/edit page                                                                                      | Low — additive                                     |
| **3**            | Per-customer overrides table + admin UI override pane                                                                                                | Medium — new surface area in customer detail       |
| **4**            | SMS / voice / push template parity + version history                                                                                                 | Low                                                |

Each phase is its own PR; Phase 1 is the only one that touches
schema.

## Schema-deploy blocker

**`docs/migration-state-investigation-2026-05-08.md` documents a real
problem:** the on-disk `_journal.json` lags the SQL files by 21
entries, and the deploy mechanism that's actually in production is
unverified. Adding two more tables here would compound that drift
and may not actually reach production via `migrate.mjs`.

Phase 1 cannot ship safely until ONE of:

- The production-state inspection in
  `docs/migration-state-investigation-2026-05-08.md` is run and the
  journal is reconciled with what's applied; OR
- We confirm production runs `drizzle-kit generate` before
  `migrate.mjs` (which would mean the on-disk journal is
  regenerated each deploy and the new tables would land naturally).

Until then, Phase 1 must wait. Phases 2–4 cannot start without
Phase 1.

## Open questions for review

1. **Do you want all ~30 templates migrated to the DB, or just a
   subset?** The proposal says "all" but a more conservative MVP
   could be just the onboarding check-ins + rx renewal (the two
   highest-volume + most-frequently-tweaked sets). Auth emails
   in particular have security implications around link tokens
   and may be a poor fit for ad-hoc admin edits.
2. **Per-customer override UI placement.** Inside customer-360 (as
   proposed) keeps the override discoverable when triaging that
   customer. Alternatively, a global "all overrides" page would
   give ops a single place to audit non-default behaviour. Do
   both?
3. **Variable allowlist source of truth.** Stored on the row (as
   proposed) means the allowlist evolves with the template, but
   forks if the call-site declares a different list. Stored in
   code (a constant per template_key) keeps them in sync but
   requires a deploy to add a new variable. Which is more important?
4. **Render-time fallback policy.** "Fall back to the hard-coded
   string on DB miss" keeps comms flowing through a DB outage but
   means edits silently revert during the outage window. The
   alternative — suppress the send and queue for retry — is
   stricter but blocks reminders on a misconfigured deploy. Which
   posture?
5. **Voice templates.** The day-3/7/30/60/90 onboarding has voice
   press-1 transcripts. Editing those touches Twilio TwiML; the
   editor needs SSML guard rails or restricts to plain text. Which
   does ops actually need to edit?
6. **Versioning.** V1 records the most-recent edit (audit + a
   single `updated_by` column). V2 (Phase 4) would add full row
   history in `message_template_versions`. Is V2 important or can
   ops live with the audit log + an occasional `git blame` on the
   seed file?
7. **Template editor UX for HTML body.** Rich-text WYSIWYG
   (TipTap, Lexical) is more work but safer than raw HTML edit
   (which lets an admin paste in `<script>`). Recommend WYSIWYG
   with an HTML allowlist sanitizer (DOMPurify on save).

## What I'd build for Phase 1 if greenlit

- `lib/resupply-db/drizzle/<NN>_message_templates.sql` (paired with
  schema TS). Gated on the schema blocker above.
- `lib/resupply-templates/` (new workspace package): `renderMessage()`,
  variable substitution, in-process cache.
- `artifacts/resupply-api/src/routes/admin/message-templates.ts`:
  GET list / GET one / PATCH update.
- Migrate `lib/rx-renewal/renderers.ts` to call `renderMessage()`
  with the existing hard-coded strings as fallback. Verify the
  existing rx-renewal tests still pass byte-for-byte with the
  template seeded from the same strings.
- Tests for the helper (variable substitution, allowlist enforcement,
  per-customer override precedence, fallback on DB miss).
- Audit verb registration: `message_template.update` +
  `message_template.override.create` /
  `message_template.override.update`.

Estimated 4–6 engineer-days for Phase 1.

## Recommendation

Land the design (this doc) so the open questions can be answered in
review. Hold Phase 1 until either (a) the schema-deploy blocker is
resolved or (b) you accept the risk and plan for the migration to be
applied out-of-band.
