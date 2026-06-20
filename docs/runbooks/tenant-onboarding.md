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
4. **Fax number** (opt-in) — when `--provision-fax` (or `--fax-number`) is
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

| Flag                | Required | Notes                                                                                                                                |
| ------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `--org-slug`        | yes      | URL-safe lowercase tenant key (a-z/0-9/hyphen, ≤ 63). Stable; used for host routing.                                                 |
| `--org-name`        | yes      | The tenant's legal/display name (footer, copyright, the "by …" line).                                                                |
| `--admin-email`     | yes      | The first admin's email. Gets the set-password link.                                                                                 |
| `--storefront-name` | no       | Short brand shown in the header/hero. Falls back to `--org-name` when omitted.                                                       |
| `--status`          | no       | `active` (default) / `suspended` / `archived`.                                                                                       |
| `--base-url`        | no       | Base for the set-password link. Defaults to `SHOP_PUBLIC_BASE_URL` or localhost.                                                     |
| `--no-email`        | no       | Skip the SendGrid send; use the printed link only.                                                                                   |
| `--provision-fax`   | no       | Auto-order a fax-capable number from Telnyx and attach it to the tenant. Needs `TELNYX_API_KEY` + `TELNYX_FAX_CONNECTION_ID`.        |
| `--fax-area-code`   | no       | With `--provision-fax`: preferred 3-digit US area code to keep the fax number local.                                                 |
| `--fax-number`      | no       | Set a ported / pre-existing fax DID (E.164) directly — no Telnyx order. Mutually exclusive with `--provision-fax`.                   |
| `--force`           | no       | Required to: re-issue a link for an existing user, promote a non-admin, or move an admin who already belongs to a **different** org. |

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
