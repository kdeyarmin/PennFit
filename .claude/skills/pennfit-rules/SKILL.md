---
name: pennfit-rules
description: PennFit-specific invariants and "hard rules" to check when writing, reviewing, or committing changes in this repo — PHI/image logging, Supabase-only data path, admin theme scoping, no column encryption, no password pepper, no compliance/audit_log machinery, single email From address, the decoupled service-boot contract, and the rule that nothing but a per-tenant sign-off may clear `needs_clinical_review` (which records provenance — it no longer gates confidence), and the rule that a tenant brand in shared code must be resolved rather than typed. Use when editing code under artifacts/ or lib/, reviewing a diff or PR, or before committing. These are correctness invariants, not style — a violation is a real bug.
---

# PennFit hard-rules reviewer

PennFit is a CPAP-resupply storefront + admin console handling PHI for a
DME business. It has a set of non-negotiable invariants (see the
"Hard rules — do not break" section of `CLAUDE.md`). Generic linters do
not know about them. Use this skill to catch app-specific regressions
before they ship.

## When to use

- Reviewing a diff/PR that touches `artifacts/**` or `lib/**`.
- Right before committing backend (`resupply-api`), shared-lib, or
  storefront/admin (`cpap-fitter`) changes.
- Any time you add logging, touch the data layer, send email, change the
  admin UI theme, or modify service boot/health-check code.

## Step 1 — run the automated sweep

Run the repo's own drift checks plus the targeted greps below from the
repo root. Anything that prints a match (other than the rule's own
allowed location) is a candidate finding to investigate.

```bash
# Repo's committed drift checks (these gate commits/CI):
bash scripts/check-resupply-architecture.sh        # Rule 7: no `pg` outside lib/resupply-db; Rule 2: no drizzle-orm in resupply-domain
bash scripts/check-admin-route-gates.sh            # every admin mutation must have requireAdmin or requirePermission
bash scripts/check-resupply-migration-prefix.sh    # migration numbering / prefix drift
bash scripts/ci-check-ts-syntax.sh                 # TS syntax sanity

# Full quality gates (run before pushing):
pnpm typecheck && pnpm lint:resupply && pnpm test
```

```bash
# --- targeted invariant greps (heuristic; investigate each hit) ---

# R1 image bytes/frames in backend logs
rg -nP 'logger\.\w+\([^)]*(base64|data:image|dataUrl|image(Bytes|Buffer)|videoFrame|frame[A-Z])' artifacts lib

# R2 order request bodies in the application logger
rg -nP 'logger\.\w+\([^)]*\breq\.body\b' artifacts/resupply-api/src

# R3 reintroduced column-level encryption / dropped helpers
rg -n 'RESUPPLY_MASTER_KEY|RESUPPLY_DATA_KEY|RESUPPLY_PHONE_HMAC_KEY|pgp_sym_encrypt|phone_lookup' artifacts lib

# R4 password pepper
rg -ni 'AUTH_PASSWORD_PEPPER|password.?pepper' artifacts lib

# R5 new audit_log readers / retired compliance env + writing logic vs the no-op audit stub
rg -nP "\.from\(\s*[\"\x27]audit_log[\"\x27]\s*\)|RESUPPLY_AUDIT_HMAC_KEY" artifacts lib

# R6 email sent outside the shared SendGrid client
rg -n '@sendgrid/mail|new MailService|sgMail|setApiKey\(' artifacts lib --glob '!lib/resupply-email/**'

# R7 global @theme block in admin.css (must NOT exist), and admin surfaces missing the scope wrapper
rg -n '@theme' artifacts/cpap-fitter/src/admin.css

# Conventions: direct pg outside the db package, drizzle-orm in the domain pkg
rg -nP "from\s+['\"]pg['\"]|require\(\s*['\"]pg['\"]\s*\)" artifacts lib --glob '!lib/resupply-db/**'
rg -n 'drizzle-orm|drizzle-kit|drizzle-zod' lib/resupply-domain lib/resupply-integrations*

# Service-boot contract: don't kill the process on worker failure; keep the
# Railway health check on liveness (/resupply-api/healthz), never /readyz
rg -nP 'process\.exit' artifacts/resupply-api/src/worker
rg -n '"healthcheckPath"' railway.json   # must read /resupply-api/healthz, not /readyz
```

## Step 2 — the hard rules (verify each touched area)

### R1 — No image logging anywhere in the backend
Camera images/video frames never leave the browser; only **numeric facial
measurements** are transmitted. Never log image bytes, base64, data URLs,
or paths to camera-derived blobs.
- **Fix:** log a count/shape (`{ measurementCount }`), never the payload.

### R2 — No order request bodies in the application logger
Order payloads contain PHI; treat every log line as world-readable.
- **Fix:** log identifiers/status only (`orderId`, `status`), never `req.body`.

### R3 — No new column-level encryption
Migration 0025 stripped pgcrypto PHI encryption and dropped `phone_lookup`.
`RESUPPLY_MASTER_KEY`, `RESUPPLY_DATA_KEY`, `RESUPPLY_PHONE_HMAC_KEY` are
read by no code path. Don't reintroduce them or `pgp_sym_encrypt`.

### R4 — No password pepper
Task #38 removed `AUTH_PASSWORD_PEPPER`; passwords use plain **argon2id**.
Stale pepper values in the environment are ignored — don't re-add reads.

### R5 — No HIPAA / DMEPOS / ACHC compliance machinery
Migration 0156 retired all 11 in-app compliance domains.
`@workspace/resupply-audit` is a **no-op stub** kept only for back-compat
with 150+ callsites — don't write new audit logic against it.
`RESUPPLY_AUDIT_HMAC_KEY` is unread. **New readers must NOT add
`.from("audit_log")`.** The four historical readers short-circuit to
degraded responses (e.g. delivery-failures returns
`auditEventsUnavailable: true`); the `/readyz` DB probe uses
`feature_flags`, not `audit_log`.

### R6 — One From per tenant, through the shared client
Every outbound email funnels through `lib/resupply-email`'s
`createSendgridClient()`; don't construct a second SendGrid client or
hardcode a From. The **platform default From is the CareMetric Breathe
identity `noreply@cmbreathe.com`** (`DEFAULT_SENDGRID_FROM_EMAIL`), NOT the
seed tenant — Penn pins its own `info@pennpaps.com` via
`organizations.from_email` (migration 0377). Patient/user-facing senders
that know their `orgId` use `createTenantSendgridClient(orgId)` /
`resolveTenantSender(orgId)` (tenant From, platform fallback);
internal/ops/auth mail stays on the platform default. Same platform-vs-tenant
split for SMS/voice/fax (`resolveTenantSmsFrom`/`resolveTenantVoiceFrom`/
`resolveTenantFaxFrom`) and for brand copy (`applyCompanyIdentityToText` /
`resolveBrandingByOrgId`). The `company-info.ts` unconfigured fallback and
patient-facing link defaults are the platform (`CareMetric Breathe` /
`https://cmbreathe.com`), never a tenant's.

### R7 — Admin theme stays scoped
Admin tokens (`--penn-navy`, …) live in `artifacts/cpap-fitter/src/admin.css`
under `.admin-root`. Every admin surface must wrap its outer `<div>` with
`className="admin-root"`. **Do NOT add a global `@theme` block to
`admin.css`** — Tailwind v4 emits `@theme` utilities globally and they
clobber the storefront's shadcn tokens (this is what made the PennBot
panel render transparent). Re-point shadcn tokens by overriding the **raw**
`--background` / `--foreground` / … variables under `.admin-root`.
Enforced by `artifacts/cpap-fitter/src/admin.scope.test.ts`.

### R8 — `needs_clinical_review` is an honest record, not a rubber stamp
**Scope changed — read this before applying it.** This flag used to gate
patient-facing confidence: an unreviewed size band could not reach
`high_confidence` until a clinician signed it off. **That gate was removed
on purpose** (`resolveConfidence`, `confidence.ts`) — requiring a human to
hand-approve ~290 seeded bands made the fitter unusable at the scale it
exists for. Confidence is now scan quality × band fit × profile
completeness, and nothing else.

So do NOT "restore" the cap, and do not describe it as live in copy or
docs. What the flag still does is real, though, and still worth
protecting: it drives the admin review queue and prints on the fit report
as "pending clinical review". The platform column
`mask_size_variants.needs_clinical_review` is **never written to `false`
by anything** — a tenant clears it for itself by writing a tenant-scoped
`mask_variant_reviews` row, which `catalog-store.ts` ANDs in:

```ts
needsClinicalReview:
  Boolean(v.needs_clinical_review) && !approvedVariantIds.has(String(v.id)),
```

**Any statement setting that column `false` is still a bug.** It no longer
inflates a confidence score, but it does make the queue claim work that
was never done and the report print a review that never happened. A
falsified audit trail is worse than a missing one.

The source documents are not clean inputs — F&P's REF 620198 prints
"Greater than 5.2 cm (2.95 inches)" when 5.2 cm is 2.05 inches, in every
revision. That is why provenance is recorded honestly, and why nothing
should mark bands reviewed on a clinician's behalf.

Watch for, on any diff touching the fitter:
- Any write of `needs_clinical_review = false`, or a read that drops the
  `approvedVariantIds` half of the AND.
- An in-place rewrite of a `mask_size_variants` row that leaves its
  `mask_variant_reviews` approval in place — the UUID is unchanged, so a
  stale approval would mark new geometry as reviewed.
- A `fit_data_source` / `fit_data_source_ref` set on a row that still
  carries dimensions the cited document is silent on — `fit_data_source`
  is row-level and `scoreVariant` averages every non-NULL band, so the
  citation would cover numbers it does not support.
- Copy or docs (marketing pages, FAQ, PDFs) asserting that an unreviewed
  band cannot reach high confidence. It can, since the gate was removed.

Safety is enforced in the **tier 1-2 hard filters** (`tiers.ts`), which
remove a contraindicated or therapy-incompatible mask from consideration
entirely. Those are the floor; they were never this flag's job and must
not be weakened to compensate for its narrowed scope.

See `.claude/skills/pennfit-migrations/SKILL.md` **M7** for the
import-side rule, and `docs/mask-sizing-data-sources-2026-08-18.md` for
what each manufacturer actually publishes.

### R9 — A tenant brand in shared code must be resolved, not typed
`Penn Home Medical Supply` is ONE TENANT's name (it retired its
storefront-only `PennPaps` DBA in migration 0510 and now trades under
that one name). In shared platform code the literal is only ever
legitimate in two forms:

1. **A placeholder that is normalized at the I/O boundary** — the large
   prose bodies (`chatbotKnowledge.ts`, `customerChatKnowledge.ts`, the
   LLM system prompts, the tool descriptions) keep
   `Penn Home Medical Supply`/`PennBot`/`PennPilot` verbatim, and the
   *route* renames them per tenant via
   `applyCompanyIdentityToText(text, await getCompanyInfo(orgId))` and/or
   `applyPlatformBrandingForOrg(text, orgId)`. CLAUDE.md endorses this so
   the knowledge bases don't need editing. A few files carry their own
   equivalent (`checkin-dispatcher.ts`, `routes/voice/inbound-reorder.ts`
   both do `text.split("Penn Home Medical Supply").join(brandName)`).
2. **Genuinely tenant-scoped data** — the seeded `organizations` row, the
   Penn logo asset, `capacitor.config.ts`'s native app name.

The retired `PennPaps` spelling survives in exactly two places, both
deliberate: the legacy `identityReplacements()` needles in
`company-info.ts` (which rewrite content *persisted* under the old
brand) and the brand-leak guard specs, whose patterns must keep matching
it. Do not reintroduce it as a display name. `pennpaps.com` and
`info@pennpaps.com` are unaffected — they are addresses, not names.

**Settled: the shared placeholder resolves to `legalName`, not to the
storefront brand.** `identityReplacements()` maps
`Penn Home Medical Supply → info.legalName`, so for a tenant that keeps a
DBA distinct from its registered name the chatbot, sleep coach and email
auto-reply speak the *registered* name. This is intended, and confirmed by
the owner. The same in-source string is the placeholder in the
intake-form consent / ABN / notice-of-privacy bodies
(`me-form-acknowledgements.ts` → `applyCompanyIdentityToText`), where
naming a DBA instead of the registered entity is a compliance defect —
one token serves both, so legal correctness wins. Two review bots have
now proposed splitting it into a second storefront-brand token; do not,
without the owner reopening it. Storefront *rendering* is unaffected
either way — the header, hero, footer and order/reminder emails resolve
`resolveBrandingByOrgId(orgId).storefrontName`. If a tenant ever does
need a distinct brand in chat copy, thread `storefrontName` into
`buildChatSystemPrompt()` rather than adding a placeholder.

Anything else is a bug: the literal reaches **every** tenant's users
verbatim. Found in the wild across ~20 callsites — push-notification
titles, return-label sender names, a PHI document footer, invite-attached
PDF guides (filenames included), a public review's anonymous display name,
Zod validation messages, and a "Curated Kit" product manufacturer.

Deciding a hit:
- **Does the string reach a user?** Comments and docstrings don't.
- **Does its route normalize?** Grep the ROUTE, not the helper, for
  `applyCompanyIdentityToText` / `applyPlatformBranding`. A prompt is fine
  because the model's *output* is normalized; a hand-built email body,
  push payload or PDF is not.
- **Which name is right?** Patient/storefront surfaces →
  `resolveBrandingByOrgId(orgId).storefrontName`. Practice/legal contexts
  (carrier labels, documents) → `getCompanyInfo(orgId).name`. Platform
  infrastructure with no tenant in scope (auth mail, operator digests,
  connection tests, first-admin bootstrap) → `PLATFORM_NAME`. If no name
  belongs there at all, drop it — "your provider", "Verified customer".
- **Two channels, one event, one brand.** A push and its email must use
  the same resolver and field, or they will disagree.

Prefer threading a parameter over adding a placeholder: the compiler then
finds every callsite. Watch for spaced TTS variants (`Penn Paps`) that a
`Penn Home Medical Supply` grep misses.

- **Never print a storefront brand and a legal name side by side.** With
  a one-name tenant that renders "X by X". Use `formatBrandSignature()`
  (`lib/tenant-branding.ts`) or `hasDistinctStorefrontName()`
  (`cpap-fitter/src/lib/branding.ts`) to gate the second name.

## Step 3 — convention invariants (also worth checking)

- **Supabase is the only runtime data path.** Read/write through
  `getSupabaseServiceRoleClient()` from `@workspace/resupply-db`. No
  `drizzle-orm`/`drizzle-kit`; no direct `pg` outside `lib/resupply-db`
  (a few legacy worker paths + `migrate.mjs` are the only exceptions).
- **Zod at every HTTP boundary** in `resupply-api`.
- **Don't hand-edit `lib/resupply-db/migrations/meta/_journal.json`** — frozen
  at 52 entries; splicing it can re-apply/skip prod migrations.
- **Service boot is decoupled from the worker.** Don't `process.exit` on
  worker-boot failure and don't point the health check at `/readyz`
  (liveness is `/resupply-api/healthz`). Re-coupling blackholes the whole site.
- **Integration packages import no DB.** `lib/resupply-integrations*` must
  not import `pg` or `@workspace/resupply-db`; they're fail-soft via
  `read…ConfigOrNull()` and never log/persist raw vendor bodies.
- **Admin route gates.** Every admin mutation needs `requireAdmin` or
  `requirePermission("…")` — a gateless admin route is a real bug.
- **Inbound MMS audit emits counts only** — no media URLs, no PHI.

## Step 4 — report

For each finding give: the rule (R1–R9 or convention), `file:line`, why it
violates the invariant, and the minimal fix. If a sweep hit is actually the
rule's own allowed location (e.g. the SendGrid client *inside*
`lib/resupply-email`), note it as a false positive and move on. When asked
to fix, prefer the smallest change that restores the invariant.
