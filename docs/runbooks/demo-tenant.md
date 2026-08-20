# Demo tenant — a real, password-protected environment for sales and training

## What this is (and what it is not)

There are **two** things called "demo" in this product. They solve
different problems and are not interchangeable.

|                              | Public demo                                                               | **Demo tenant** (this runbook)   |
| ---------------------------- | ------------------------------------------------------------------------- | -------------------------------- |
| Where                        | `artifacts/cpap-fitter/src/demo/`                                         | The real database                |
| Who                          | Anyone, signed out, from the marketing site                               | Whoever you give the password to |
| Data                         | In-browser fixtures                                                       | Real rows in a real tenant       |
| Can it actually do anything? | No — a `window.fetch` interceptor answers every call and nothing persists | **Yes — everything works**       |

The public demo is a brochure that clicks: it exists so a stranger can
look around without an account, and by design nothing in it can send,
save, or bill. That makes it useless for the two jobs this runbook covers:

- **Selling.** Walking a prospect through a workflow that visibly does
  nothing is worse than not demoing at all.
- **Training.** A new hire has to make real mistakes and see real
  consequences somewhere that isn't a live patient's chart.

The demo tenant is a normal tenant. Every feature flag is on, the
worklists advance, the assistants answer, the fitter writes reports, and
the data survives a refresh.

## Credentials

|          |                                                            |
| -------- | ---------------------------------------------------------- |
| URL      | `/admin/sign-in`                                           |
| Email    | `demo@cmbreathe.com`                                       |
| Password | `Demo123`                                                  |
| Tenant   | `CareMetric Demo DME` (slug `demo`)                        |
| Role     | `admin` → effective **super_admin** within the demo tenant |

### Why the login is an email and not just `demo`

There is no username column and no username sign-in path. `sign-in` runs
whatever you type through `normalizeEmail()`
(`lib/resupply-auth/src/email.ts`), which throws on anything without an
`@`; the handler folds that into the generic "invalid email or password".
A bare `demo` therefore cannot authenticate no matter what is in the
database. `demo@cmbreathe.com` is the platform-domain spelling of the
same name — you type "demo", the domain is the constant part.

### Why the password is shorter than the policy allows

`PASSWORD_MIN_LENGTH` is 12; `Demo123` is 7. The policy is enforced on
sign-**up**, reset and change — never on sign-**in**, which only verifies
the argon2id hash. The seeder writes the hash directly, so the account
signs in normally and indefinitely.

The one consequence: **the reset-password flow will refuse to set this
same value again.** If you ever rotate the password through the UI you
must choose 12+ characters. To seed a compliant one instead:

```bash
pnpm --filter @workspace/scripts demo:seed -- --password='DemoDemo2026!'
```

> This account is a real super-admin inside its tenant. Tenant scoping is
> what keeps it away from other tenants' data — not the password. Treat
> the password as public and never widen this account's reach.

## The onboarding agreements gate

Every tenant must execute the BAA and platform terms before the console
opens — `AgreementsGate` replaces the **entire** admin console while
`/me` reports anything in `pendingAgreements`. Left alone, a sales demo
would therefore open on a legal document instead of the product.

The seeder pre-records both acceptances so the demo lands straight in the
console. That is defensible here only because of who the parties are: this
is CareMetric's own tenant, so the BAA has the platform on both sides and
no third party's PHI behind it. The rows are labelled
`CareMetric Demo (seeded by demo:seed)` rather than dressed up as a
signature, so an audit of `organization_agreements` can tell them apart at
a glance.

Two things follow:

- Pass `--no-accept-agreements` to leave the gate up — useful when the
  onboarding flow is itself what you want to demo.
- `AGREEMENT_VERSION` in the seeder mirrors the versions in
  `artifacts/resupply-api/src/lib/agreements/index.ts`. **If those are
  bumped, this constant goes stale and the demo tenant is gated again on
  next sign-in.** That is the correct failure direction — a re-prompt,
  never a forged acceptance of text nobody has seen. Update the constant
  and re-run to clear it.

## Re-seeding and resetting

The seeder is idempotent — every row has a fixed id under the `0dec0de0`
prefix, so re-running resets the tenant to a known-good state. Do this
before a demo if a previous session left it messy.

```bash
ALLOW_DEMO_SEED=1 \
SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... \
pnpm --filter @workspace/scripts demo:seed
```

Useful flags:

| Flag                          | Effect                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--dry-run`                   | Print what would be written. No connection needed.                                                                                                                                                           |
| `--emit-sql`                  | Print the `INSERT … ON CONFLICT` statements instead of writing. No connection and no service-role key needed — pair with `--org-id=` or substitute the `:ORG_ID` placeholder. **Fixtures only** — see below. |
| `--clean`                     | Remove the tenant and every row it owns.                                                                                                                                                                     |
| `--password=` / `--email=`    | Override the credentials.                                                                                                                                                                                    |
| `--org-slug=` / `--org-name=` | Stand up a second, separate demo tenant.                                                                                                                                                                     |
| `--flags=all\|preset\|copy`   | Feature-flag posture. Default `all`.                                                                                                                                                                         |
| `--no-accept-agreements`      | Leave the BAA / platform-terms gate in place. On a tenant already seeded normally, this also **revokes** the seeded acceptances so the gate genuinely comes back.                                            |
| `--force-clean`               | Allow `--clean` to proceed against an org holding no demo-prefixed rows. See [Removing it](#removing-it) — you should almost never need this.                                                                |
| `--adopt-existing-identity`   | Allow `--email=` to point at an auth user that already exists outside this tenant, overwriting its password and role. See below.                                                                             |
| `--plan=`                     | Assign a billing plan (e.g. `growth`).                                                                                                                                                                       |

`--emit-sql` is the path to use when you don't have the service-role key
to hand, or when you want to read exactly what will land before it does.
Both sinks are fed by one row-builder, so the SQL and the live write are
the same data by construction.

### `--emit-sql` covers fixtures only

The SQL is rendered from the same row builders that feed the live write, so
the two cannot drift — but only for the rows those builders own: the login,
agreements, providers, patients and inbox threads.

The organization itself, its feature flags, its formulary and any billing
subscription are provisioned by live queries instead (the flags are _copied_
from the seed tenant, so there is nothing to render offline). **The tenant
must already exist** — via `tenant:onboard` or an earlier live run — or the
emitted statements fail on their `org_id` foreign keys.

### Pointing `--email=` at an address that already exists

The identity writes are not additive: they overwrite `password_credentials`,
force the coarse role to `admin`, mark the address verified and attach the
user to the demo tenant. Aimed at an address belonging to a real shopper or
a real staff member, that is an account takeover performed by a seeding
script.

So the seeder refuses when `--email=` resolves to an existing auth user that
isn't already this tenant's admin, and writes nothing. Pick another address,
or pass `--adopt-existing-identity` if the overwrite is genuinely intended.

### A second demo tenant

`--org-slug=` gives you one. Fixture ids are derived from the slug, so two
demo tenants never share a row — without that, the second run would upsert
onto the first tenant's ids and _move_ its patients rather than create new
ones. The default slug (`demo`) maps to the original id set, so the existing
tenant is unaffected.

One caveat: `providers` is a **global** directory keyed by NPI (migration
0342), not tenant-scoped. Two demo tenants therefore share the same six
prescribers, and `--clean` on either removes them. Re-run the other tenant's
seed to put them back.

## What gets seeded

- **1 organization** — `CareMetric Demo DME`, all 87 feature flags on, its
  own default formulary.
- **6 providers** — prescribers with practices, NPIs, fax numbers.
- **12 patients** — each with a prescription (linked to a provider), an
  insurance coverage, a CPAP/BiPAP device, a resupply episode, a delivered
  fulfillment, and (for most) a chart note.
- **3 inbox threads** — 9 messages across SMS and email, one awaiting a
  reply, one awaiting the patient, one resolved.

The people are fictional but deliberately not labelled "test" — a console
full of `Test Patient 1` undersells the product to a prospect.

## Why this cannot spam anyone

The recurring reminder worker sweeps **every active org**, so the demo
tenant is swept too. Three independent guards make that harmless:

1. **Unreachable contact details.** Every phone number is in the
   `+1 (215) 555-01XX` range reserved for fiction; every address is on
   `example.com`, which RFC 2606 guarantees can never be registered.
2. **Nobody is due.** Reminder eligibility is
   `daysBetween(lastFulfilled ?? rxCreated, now) >= cadenceDays`. Every
   patient has a recent `fulfillments` row, so the baseline is fresh. The
   two patients in a live funnel status are 8 and 12 days into a 90-day
   cadence.
3. **Most episodes aren't in the funnel at all.** Only
   `outreach_pending` / `awaiting_response` are scanned; the rest are
   `confirmed` / `fulfilled`.

`scripts/src/demo-tenant-data.test.ts` pins guards 1 and 2, including a
margin check that fails if any in-funnel patient gets within half a
cadence of due. **If you edit the dataset, keep those tests passing** —
they are the only thing standing between a dataset tweak and a real
outbound message.

## Removing it

```bash
ALLOW_DEMO_SEED=1 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
pnpm --filter @workspace/scripts demo:seed -- --clean
```

This deletes the demo rows (by their `0dec0de0` ids), the tenant's flags,
formulary, billing subscription and agreements, its `fit_sessions`, the
`admin_users` link, and the organization.

**Only the fixture deletes are self-limiting.** They name exact demo ids, so
they cannot touch a row this script didn't write. The tenant-wide deletes
that follow key on `org_id` alone — pointed at a real tenant, they would take
its entire configuration, and because the deletes are not one transaction a
later failure does not roll the earlier ones back.

What stands between a mistyped `--org-slug` and that outcome is an ownership
check: the seeder refuses to clean an org that holds no demo-prefixed patient
rows, and refuses the seed tenant outright. `--force-clean` overrides the
first check; there is no override for the second.

If the organization row itself cannot be deleted — some other tenant-scoped
table still references it — the seeder says so explicitly rather than
failing after the fixtures are already gone. The login is revoked either way,
so the leftover tenant is inert.

The auth user row itself is kept (identity rows stay for audit), but the
login is **revoked**: `--clean` sets `resupply_auth.users.status` to
`revoked` and kills any live session.

That revoke is load-bearing, not tidiness. Deleting the `admin_users` row
does not disarm the login — `requireAdmin` reads a missing `admin_users`
row as a _legacy pre-RBAC account_, keeps the coarse `admin` role, and
falls back to `resolveSeedOrgId()` for the tenant. A demo login left
active after `--clean` would therefore not lose access; it would **gain**
it, landing in the seed tenant — real patients — with effective
`super_admin`. Revoking the user row is checked before any of that
fallback runs.

Re-running `demo:seed` reactivates the login, so `--clean` is a
reversible off switch rather than a one-way delete.

## Related

- [`tenant-onboarding.md`](./tenant-onboarding.md) — standing up a real
  paying tenant (`tenant:onboard`).
- `scripts/src/seed-sample-data.ts` — the older `seed:sample`, which seeds
  storefront/shop rows into the **seed** tenant. Different job.
