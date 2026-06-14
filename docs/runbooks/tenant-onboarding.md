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

The admin then opens the set-password link, signs in at
`/admin/sign-in`, and goes to **Settings → Storefront branding** to set
their name / tagline / logo and wire up a custom domain (see
[`tenant-custom-domain.md`](./tenant-custom-domain.md)).

## Arguments

| Flag                  | Required | Notes                                                                                 |
| --------------------- | -------- | ------------------------------------------------------------------------------------- |
| `--org-slug`          | yes      | URL-safe lowercase tenant key (a-z/0-9/hyphen, ≤ 63). Stable; used for host routing.   |
| `--org-name`          | yes      | The tenant's legal/display name (footer, copyright, the "by …" line).                 |
| `--admin-email`       | yes      | The first admin's email. Gets the set-password link.                                  |
| `--storefront-name`   | no       | Short brand shown in the header/hero. Falls back to `--org-name` when omitted.        |
| `--status`            | no       | `active` (default) / `suspended` / `archived`.                                        |
| `--base-url`          | no       | Base for the set-password link. Defaults to `SHOP_PUBLIC_BASE_URL` or localhost.      |
| `--no-email`          | no       | Skip the SendGrid send; use the printed link only.                                    |
| `--force`             | no       | Required to: re-issue a link for an existing user, promote a non-admin, or move an admin who already belongs to a **different** org. |

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
