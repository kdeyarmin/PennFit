# Runbook: onboarding a new tenant (DME company)

Standing up a second (third, …) DME on the platform is a **data
operation**, not a code change. One command creates the tenant, its first
admin, and the link between them; the admin then self-serves their brand
and domain.

## One command

```bash
SUPABASE_URL=https://… SUPABASE_SERVICE_ROLE_KEY=… \
pnpm --filter @workspace/scripts tenant:onboard \
  --org-slug=acme-dme \
  --org-name="ACME DME Inc." \
  --admin-email=alice@acme.example \
  --storefront-name="AcmeSleep"
```

What it does, in order (all idempotent):

1. **Organization** — inserts a `resupply.organizations` row
   (`slug`, `name`, `status`, optional `storefront_name`). If the slug
   already exists it is reused and reported, not duplicated.
2. **Admin auth user** — creates the `resupply_auth.users` row
   (`role=admin`, `status=invited`) and issues a **1-hour set-password
   link**, printed to stdout and emailed when SendGrid is configured.
3. **Tenant link** — upserts the `resupply.admin_users` row
   (`role=admin`, `status=active`, `auth_user_id` → the auth user,
   **`org_id` → the new organization**). This is the piece `requireAdmin`
   reads to resolve the admin to their tenant.
4. **Feature flags** — provisions the tenant's per-org `feature_flags`
   rows. With `--plan`, only that plan's **preset bundle** defaults ON (see
   **Feature-flag presets** below); without it, the seed tenant's state is
   copied verbatim. Either way the rows exist so the admin can toggle them.
5. **Fax number** (opt-in) — when `--provision-fax` (or `--fax-number`) is
   passed, gives the tenant its **own fax number** so inbound faxes route
   to them and outbound faxes (physician outreach, appeal letters) send
   from their DID. See **Fax number** below. Omit both flags to onboard
   without one — it can be added later from the admin UI.

The admin then opens the set-password link, signs in at `/admin/sign-in`,
and lands on a dashboard whose **"Finish setting up your workspace"** card
links to the guided checklist at **Settings → Set up your workspace**
(`/admin/setup`). The checklist tracks live status for each step and links
straight to the page that completes it. See
**Self-service setup** below.

> **Self-service vs. CLI.** A tenant can also be created entirely
> self-serve from the public **`/breathe/signup`** page (org + first admin +
> verify email, no operator). `tenant:onboard` is the operator path for
> standing up a tenant on someone's behalf (and the only path that can
> auto-provision a fax number at creation time).

## Arguments

| Flag                | Required | Notes                                                                                                                                                                                                                                                 |
| ------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--org-slug`        | yes      | URL-safe lowercase tenant key (a-z/0-9/hyphen, ≤ 63). Stable; used for host routing.                                                                                                                                                                  |
| `--org-name`        | yes      | The tenant's legal/display name (footer, copyright, the "by …" line).                                                                                                                                                                                 |
| `--admin-email`     | yes      | The first admin's email. Gets the set-password link.                                                                                                                                                                                                  |
| `--storefront-name` | no       | Short brand shown in the header/hero. Falls back to `--org-name` when omitted.                                                                                                                                                                        |
| `--plan`            | no       | Billing plan code (`mask_fitter` / `launch` / `growth` / `scale` / `enterprise`). Assigns the subscription **and** the starting feature-flag bundle (see **Feature-flag presets**). Omit to leave no subscription and copy the seed catalog verbatim. |
| `--status`          | no       | `active` (default) / `suspended` / `archived`.                                                                                                                                                                                                        |
| `--base-url`        | no       | Base for the set-password link. Defaults to `SHOP_PUBLIC_BASE_URL` or localhost.                                                                                                                                                                      |
| `--no-email`        | no       | Skip the SendGrid send; use the printed link only.                                                                                                                                                                                                    |
| `--provision-fax`   | no       | Auto-order a fax-capable number from Telnyx and attach it to the tenant. Needs `TELNYX_API_KEY` + `TELNYX_FAX_CONNECTION_ID`.                                                                                                                         |
| `--fax-area-code`   | no       | With `--provision-fax`: preferred 3-digit US area code to keep the fax number local.                                                                                                                                                                  |
| `--fax-number`      | no       | Set a ported / pre-existing fax DID (E.164) directly — no Telnyx order. Mutually exclusive with `--provision-fax`.                                                                                                                                    |
| `--force`           | no       | Required to: re-issue a link for an existing user, promote a non-admin, or move an admin who already belongs to a **different** org.                                                                                                                  |

## Fax number

Twilio retired Programmable Fax, so fax numbers are provisioned through
**Telnyx** (the same vendor that already sends/receives the platform's
faxes). The number is stored on `organizations.fax_from_number`
(migration 0368) and drives both the tenant-aware fax **send** path and
the inbound-fax **routing** (`resolveOrgIdByFaxNumber`).

```bash
# Auto-order a fax-capable DID (local to area code 215):
… tenant:onboard --org-slug=acme-dme … --provision-fax --fax-area-code=215

# Or set a number the tenant already owns / ported in:
… tenant:onboard --org-slug=acme-dme … --fax-number=+12155551212
```

- **Opt-in.** With neither flag the tenant is onboarded **without** a fax
  number and falls back to the platform `TELNYX_FAX_FROM_NUMBER` until one
  is set.
- **Fail-soft.** A provisioning error (no inventory, missing Telnyx creds)
  is **reported** but does **not** fail the rest of onboarding — the tenant
  is already stood up.
- **Idempotent.** A tenant that already has a fax number is left untouched.
- **Self-serve.** The tenant admin can also provision / set / clear their
  fax number any time from **Settings → Fax number** in the admin console
  (`POST /admin/organization/fax-settings/provision`,
  `PATCH /admin/organization/fax-settings`).

## Self-service setup

After sign-in, everything except the deployment-level platform config is
self-serve from the admin console. The **Set up your workspace** checklist
(`/admin/setup`, served by `GET /admin/organization/setup-checklist`) shows
each step's live status and links to its page:

| Step                 | Page (nav: Settings → …)                              | Backed by                                                                     |
| -------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Storefront name/logo | Storefront branding                                   | `organizations.storefront_name` / `logo_url`                                  |
| Custom domain        | Storefront branding                                   | `custom_domain*` (see [`tenant-custom-domain.md`](./tenant-custom-domain.md)) |
| Phone & SMS numbers  | Phone & SMS                                           | `voice_from_number` / `sms_from_number` / `twilio_messaging_service_sid`      |
| Fax number           | Fax number                                            | `fax_from_number` (see **Fax number** above)                                  |
| Email From address   | Email From address                                    | `from_email` / `from_name` (+ live SendGrid domain-auth check)                |
| Payments             | Billing → Config → Organization (Stripe Connect card) | `stripe_account_id` / `stripe_charges_enabled`                                |
| Catalog              | Shop → Inventory                                      | products (Stripe-sourced)                                                     |
| Team                 | Team                                                  | `admin_users` invites                                                         |

**Phone & SMS** (`/admin/phone-settings`) mirrors the fax flow but on
**Twilio**: a tenant can auto-buy a voice+SMS-capable number by area code
(`POST /admin/organization/phone-settings/provision`, points the number's
inbound webhooks at the platform endpoints), or set a ported number /
Messaging Service SID manually (`PATCH /admin/organization/phone-settings`).
Auto-provisioning needs `TWILIO_ACCOUNT_SID` + `TWILIO_AUTH_TOKEN`; without
them the page falls back to manual entry. Numbers flow through
`resolveTenantVoiceFrom` / `resolveTenantSmsFrom` (outbound) and
`resolveOrgIdByCalledNumber` (inbound routing).

**Email From address** (`/admin/email-settings`) sets the tenant's
`from_email` / `from_name` (`PATCH /admin/organization/email-settings`) and
runs a **live SendGrid domain-authentication check** on the address so an
unauthenticated (spam-bound) sender is flagged before it's used. A From
name alone is ignored — only a From address switches a tenant off the
platform default (`resolveTenantSender`). Deliverability still requires the
sending **domain** to be authenticated (SPF/DKIM) in SendGrid out of band.

> **Product catalog (per-tenant).** Stripe Connect runs in _direct-charges_
> mode, so a connected tenant's storefront catalog is read from — and
> checkout routes to — **their own** connected Stripe account
> (`GET /shop/products`, cart validation, and reorder suggestions all pass
> the tenant's `{ stripeAccount }`; the catalog cache is keyed per account so
> one tenant's catalog never serves on another's storefront). A brand-new
> tenant therefore starts empty. **Shop → Inventory → "Load starter
> catalog"** (`POST /admin/shop/catalog/seed`, gated by `admin.tools.manage`)
> one-clicks a tenant-neutral ~27-item CPAP-supply catalog into the tenant's
> own account so the storefront isn't empty; it is **idempotent** (re-running
> only updates existing SKUs by `metadata.shop_sku`). The tenant then edits
> names/prices from the same page. A non-seed tenant must connect Stripe
> first (the seed refuses to write to the shared platform account →
> `409 connect_stripe_first`); the seed tenant (Penn Home Medical Supply)
> keeps its own branded catalog via `scripts/src/seed-stripe-products.ts`.
> The checklist's **catalog** item flips to complete once the tenant has
> products of their own.
>
> Admin **counter orders** (`/admin/shop/counter-orders`, the CSR Front
> Desk) are Connect-aware too: they validate + re-price against the tenant's
> connected account (the same `{ stripeAccount }` the storefront uses). No
> Stripe charge is created at the counter — the lanes are **cash** (collected
> in person) and **insurance** (filed through the existing claims pipeline) —
> so only the catalog reads needed per-tenant scoping.

## Feature-flag presets

The platform ships **66 feature flags**. Historically every new tenant
inherited the seed tenant's catalog with **all of them ON**, which meant an
operator had to review the whole toggle list at signup and a small tenant was
handed the same automation as a large one.

`tenant:onboard --plan=<code>` now applies a **preset bundle** instead: only
the flags appropriate to that plan default ON, the rest default OFF. The
presets mirror the marketed tiers (`billing_plans.features`) and are
cumulative — `launch ⊂ growth ⊂ scale ⊂ enterprise`:

| Plan          | Bundle (defaults ON)                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mask_fitter` | AI mask-fitter outreach + SMS/email fitting links + in-app helper (minimal — the console is already scoped to the fitter).                                                                      |
| `launch`      | Reminders, branded storefront/shop/checkout, support tickets, custom-domain TLS, and the resupply eligibility/usage engine.                                                                     |
| `growth`      | Everything in Launch **plus** bulk campaigns/playbooks, patient packets + inbound fax/referral triage, the full billing/eligibility/prior-auth/collections suite, and therapy-cloud monitoring. |
| `scale`       | Everything in Growth **plus** multi-location, the voice/video agent, live alerts, front-desk counter orders, and Slack.                                                                         |
| `enterprise`  | Same as Scale (custom contracts tune from there).                                                                                                                                               |

Two flags are **never** auto-enabled by a preset and stay OFF until an
operator turns them on deliberately: `email.auto_reply` (seeded OFF by
design) and `voice.breathe_sales` (the platform's own sales agent, not a
tenant feature).

- **Same on self-serve signup.** The public `/breathe/signup` path applies
  the same preset when the signup already carries a plan (e.g. the voice/phone
  flow). The web form, which picks a plan later on the billing page, copies the
  seed catalog verbatim and the tenant adopts the preset from Control Center
  (next bullet) once they choose a plan.
- **One-click adopt / re-baseline (existing tenants).** The admin **Control
  Center** has an **"Apply recommended preset"** button
  (`POST /admin/feature-flags/apply-preset`, `admin.tools.manage`). It previews
  the exact diff — what turns on, what turns off, with a heads-up for any
  high-risk flag — then writes the tenant's flags to the recommended bundle for
  their **current** plan. Useful right after a tenant picks a plan, or after a
  plan switch. 409 `no_plan_preset` when the tenant has no active plan.
- **Defaults, not a gate.** Every flag remains individually toggleable in
  the Control Center — the preset just sets a sensible starting point so
  there's nothing to review in the common case.
- **Source of truth.** The bundles live in
  [`lib/resupply-domain/src/feature-flag-presets.ts`](../../lib/resupply-domain/src/feature-flag-presets.ts).
  To move a flag between tiers, edit that file (the cross-package drift test
  in `@workspace/resupply-api` keeps it honest against the flag catalog).
- **No `--plan`.** Omitting the flag preserves the legacy behavior: the seed
  tenant's enabled state is copied verbatim.

## Safety / idempotency

- **Re-runnable.** Re-running with the same args reuses the org and the
  admin row; it does **not** re-issue a set-password link for an existing
  user unless you pass `--force` (the link is an account-takeover
  credential).
- **No silent tenant moves.** If the admin email already belongs to a
  different organization, the script refuses unless `--force` — a re-run
  can never quietly move someone between tenants.
- **Service-role only.** Needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
  (the production data path). Exits `2` if either is missing.

## Relationship to the existing auth scripts

`tenant:onboard` composes what the two single-purpose scripts do and adds
the tenant link:

- `auth:bootstrap-admin` — creates the auth user + set-password link, but
  no `admin_users` row and **no `org_id`**.
- `auth:grant-super-admin` — upserts the `admin_users` row, but does **not**
  create the org or set `org_id`.

For the **seed** tenant (Penn Home Medical Supply) those two remain the
right tools — its org already exists. Use `tenant:onboard` when standing
up a **new** DME.
