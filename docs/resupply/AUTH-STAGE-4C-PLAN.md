# Stage 4c — customer cutover (backfill + first-login)

Companion to `docs/resupply/AUTH-MIGRATION-PLAN.md` (Stages 0–4b
already shipped on PR #8). Stage 4c is the only data migration in
the whole rollout. It's also the only step where rollback is
non-trivial, so this doc walks through the design, the
alternatives I considered, and the open questions before any
script runs against a real DB.

## Problem statement

After Stages 1–4b, the in-house auth path runs end-to-end for
brand-new customers who sign up via `/sign-up`. Existing customers
— the ones who signed up via Clerk before cutover — can't sign
in, because:

1. There's no `auth.users` row keyed to their email yet.
2. Even if we mint one, there's no `password_credentials` row, so
   `/auth/sign-in` returns the generic "invalid email or password".
3. Even if they set a password, `req.userClerkId` is now
   `auth.users.id` (UUID), but every shop table — `shop_orders`,
   `shop_subscriptions`, `shop_reviews`, `shop_returns`,
   `shop_order_items`, `shop_abandoned_carts` — still keys off the
   Clerk-shaped `clerk_user_id` (`user_xxx…`). Their order history
   would appear empty.
4. Five `/shop/*` endpoints call `clerkClient.users.getUser(id)`
   to enrich email + display name. Those calls 404 against a UUID.

Stage 4c resolves all four.

## What's already on disk (vs. what 4c adds)

In place from Stage 1:

- `auth.users` schema (id, email_lower, role, status,
  email_verified_at, …).
- `auth.password_credentials` (user_id PK, password_hash, algo,
  must_change, updated_at).
- `resupply.shop_customers.auth_user_id` — nullable, FK to
  `auth.users(id)`, UNIQUE WHERE NOT NULL. Untouched in Stage 1
  besides being added.

In place from Stage 4b:

- `requireSignedIn` / `attachSignedIn` resolve a session and put
  the resolved id in `req.userClerkId`. Today the in-house branch
  returns `auth.users.id`. **This will change in 4c — see
  "Customer-id resolution" below.**

What 4c adds:

- A backfill script (`pnpm auth:backfill-shop-customers`).
- A bcrypt-aware path inside `verifyPassword` so existing Clerk
  password hashes round-trip on first sign-in (transparent rehash).
- A small change to `requireSignedIn` so the session resolves to
  the LEGACY `shop_customers.clerk_user_id` (preserving every
  downstream FK) rather than `auth.users.id` directly.
- Source-aware enrichment in the 5 `/shop` endpoints that today
  hit `clerkClient.users.getUser`.
- An idempotency safety net (re-runs are no-ops; concurrent
  cookie-based sign-ups during the backfill window can't create
  duplicate `auth.users` rows for the same email).

## Decisions to confirm

Each decision has alternatives and a recommendation. Anything
marked **CONFIRM** is what I'd like a thumbs-up on before we
build.

### 1. Schema strategy

Six shop tables key off `clerk_user_id`:

| Table | Column | Cardinality |
|---|---|---|
| `shop_customers` | `clerk_user_id` (PK) | 1 / customer |
| `shop_orders` | `clerk_user_id` (nullable, indexed) | many / customer |
| `shop_order_items` | `clerk_user_id` (denormalized, nullable, indexed) | many / customer |
| `shop_subscriptions` | `clerk_user_id` (notNull, indexed) | few / customer |
| `shop_reviews` | `clerk_user_id` (notNull, UNIQUE per product) | few / customer |
| `shop_returns` | `clerk_user_id` (notNull, indexed) | rare |
| `shop_abandoned_carts` | `clerk_user_id` (notNull, UNIQUE) | 0–1 / customer |

**Option A — add `auth_user_id` to all six tables.** Backfill
populates them; queries learn to read both. Pro: clean, gradual
column rename. Con: 6 nullable columns, 6 indexes, 6 backfill
queries, 6 query-builder edits, every test that uses these tables
needs updating, and we'd carry the dual columns forever (or until
Stage 5 removes `clerk_user_id`).

**Option B (recommended — CONFIRM) — use `shop_customers` as the
join.** Keep `clerk_user_id` on every shop table as the customer
PK; treat the column name as a misnomer that gets renamed in
Stage 5. The middleware resolves `auth.users.id` → look up
`shop_customers WHERE auth_user_id = ?` → return that row's
`clerk_user_id` (which the backfill populated, or which equals
`auth.users.id` for new in-house sign-ups). No schema change to
the 6 child tables.

Why Option B: it minimises the diff, keeps existing queries (and
their tests) unchanged, and the rename in Stage 5 is a single
`ALTER TABLE … RENAME COLUMN` per table after Clerk is gone. The
"clerk_user_id contains a non-Clerk UUID" lie lives only in the
schema column name; every consumer reads it as an opaque string
already.

**Trade-off accepted:** The Stripe Customer's
`metadata.clerk_user_id` field (set in
`artifacts/resupply-api/src/lib/stripe/customer.ts:77`) will also
contain the new UUIDs for in-house sign-ups. Stripe's dashboard
loses its "click through to Clerk" affordance for those rows, but
ops can still pivot via `shop_customers.stripe_customer_id`. The
metadata key is renamed to `customer_id` in Stage 5.

### 2. Backfill source

**Option A — Clerk Backend API `getUserList`.** Pulls live users
500 at a time, rate-limited at 1000 req/10s in production. Returns
id, primary email + verification status, first/last name,
`publicMetadata`, `createdAt`, `lastSignInAt`. **Does NOT return
password hashes.**

**Option B (recommended — CONFIRM) — Clerk Dashboard "Export all
users" CSV** (Settings → User Exports → "Export all users").
Single download from the Dashboard. Columns are fixed:

```
id, first_name, last_name, username,
primary_email_address, primary_phone_number,
verified_email_addresses, unverified_email_addresses,
verified_phone_numbers, unverified_phone_numbers,
totp_secret, password_digest, password_hasher
```

`password_hasher` is just `bcrypt` (no peppered variant — Clerk
applies no application-side pepper, confirmed by the WorkOS,
Better Auth, and PropelAuth migration guides). Verification
status is encoded by which list
(`verified_email_addresses` vs `unverified_…`) the address
appears in. `password_digest` is empty for users who only ever
signed in via OAuth / magic link (see Risk 5 below).

The export is acknowledged to be incomplete — no
`publicMetadata`, no `banned` flag — but it's also the only path
that surfaces password hashes. The complementary
`getUserList({ banned: true })` Backend API call (one extra pass)
covers the remaining gaps.

Why Option B over Option A: we get the bcrypt hashes, which
unlocks Decision 3 (transparent rehash). Backend API alone
doesn't return them.

The CSV is a point-in-time snapshot. Anyone who signs up between
download and backfill run gets handled by the dual-mode safety
net: their Clerk session keeps working, and the next backfill
re-run picks them up (the script is idempotent).

**Hybrid recommendation:** dump the CSV first, then call
`getUserList` once to fetch the `banned` boolean for each row,
joining on `id`. Two operator steps, but both are read-only and
the join happens in our backfill script. (Skip the API pass
entirely if Risk 6 confirms no current customers are banned.)

### 3. Password handling for backfilled customers

**Option X — mass "set your password" email at cutover.** Create
`auth.users` rows with `status='invited'`, no `password_credentials`.
Issue a `password_reset` token per row (TTL bumped to 7 days for
this batch — operators may run the backfill ahead of email
delivery). Send via SendGrid. Customers click the link, set a new
password, are then signed in via in-house mode.

Pros: no algorithm-bridge code; forces password rotation, which
is good security hygiene; works regardless of what hashing
algorithm Clerk used.

Cons: mass email at scale (existing customer count). Customers
who don't reset can't sign in via the in-house path; they'd keep
using Clerk via dual mode until the Clerk side is decommissioned
(Stage 5), at which point they're locked out and need support to
help them reset.

**Option Y (recommended — CONFIRM) — transparent bcrypt rehash on
first sign-in.** Create `auth.users` rows with `status='active'`
and a `password_credentials` row whose `algo='clerk-bcrypt-v1'`
and `password_hash` is the raw bcrypt digest from the CSV.

Extend `verifyPassword` (in `lib/resupply-auth/src/password.ts`)
to dispatch on algo:

- `argon2id-v1` (current path, unchanged).
- `clerk-bcrypt-v1` (new path): call `bcrypt.compare(password,
  storedHash)` directly. **Do NOT pepper.** Clerk's hashes weren't
  peppered, and applying our pepper would invalidate them.

On a successful `clerk-bcrypt-v1` verify, immediately call
`upsertCredential` with a fresh `argon2id-v1` hash (peppered).
Subsequent sign-ins use the new hash and the bcrypt path is never
taken again for that user.

Pros: zero customer-visible disruption. No mass email. No "I
didn't get the email" support tickets. Hashes are upgraded
silently.

Cons: adds the `bcrypt` package as a transitive dependency. The
algorithm bridge lives in `password.ts` until the
`clerk-bcrypt-v1` rows are all consumed (we can monitor via
`SELECT count(*) FROM auth.password_credentials WHERE algo =
'clerk-bcrypt-v1'`). A user who hasn't signed in for, say, 18
months still has a bcrypt hash. We can either keep the bridge
forever (low cost) or run a re-issue-reset job for stale rows.

Recommendation: Option Y. Carry the bridge until the row count
drops below some threshold (e.g. 5%), then a follow-up emails the
remaining users.

**Edge case — unverified emails:** the CSV's
`unverified_email_addresses` column contains addresses the
customer added but never verified. We should NOT mint
`auth.users` rows for those. Only the `primary_email_address`
field is reliable; even then, we should ONLY treat it as verified
if it appears in `verified_email_addresses` too. Backfill rule:
`auth.users.email_verified_at` set when the primary email is
present in `verified_email_addresses`; otherwise NULL +
`status='invited'`.

### 4. Customer-id resolution in `requireSignedIn`

Today (Stage 4b):

```ts
// in resolveCustomerId(req)
const user = await deps.repo.findUserById(session.userId);
return user.id; // auth.users.id (UUID)
```

Stage 4c rewrites this to:

```ts
const user = await deps.repo.findUserById(session.userId);
// New: shop_customers lookup.
const customer = await deps.repo.findShopCustomerByAuthUserId(user.id);
if (customer) return customer.clerk_user_id; // legacy column = customer key
// First sign-in for an in-house user with no shop_customers row yet.
// Mint one keyed by auth.users.id so all the downstream FKs work.
await deps.repo.insertShopCustomer({
  clerkUserId: user.id,        // text PK; UUID is fine
  authUserId: user.id,         // links the row
  emailLower: user.emailLower,
  displayName: user.displayName,
});
return user.id;
```

The `findShopCustomerByAuthUserId` and `insertShopCustomer`
helpers are new repo methods; we'd add them to
`lib/resupply-auth/src/repository.ts`. **Or** — to keep
`lib/resupply-auth` agnostic of `resupply.shop_customers` (which
isn't part of the auth schema) — add the lookup in the api-server
auth-deps wiring instead, so the lib stays pure.

Recommendation: **add a small `customerIdResolver` adapter in
`AuthDeps`** (next to `repo` / `audit` / `email`). The adapter
takes `auth.users.id` and returns the customer key string. The
default impl (used by resupply-dashboard, which has no shop
customers) returns the input unchanged. The cpap-fitter wiring
(`artifacts/api-server/src/lib/auth-deps.ts`) installs an impl
that does the `shop_customers` lookup. **CONFIRM the layering
choice.**

### 5. Source-aware enrichment

Five shop endpoints currently call `clerkClient.users.getUser(req.userClerkId)`:

- `/shop/me` (`me.ts:44`)
- `/shop/me/cart-snapshot` (`cart-snapshot.ts:103`)
- `/shop/checkout` (`checkout.ts:184`)
- `/shop/quick-checkout` (`quick-checkout.ts:126`)
- `/shop/reviews` POST (`reviews.ts:146`)

All five want the same two fields: primary email + display name.

Replace with a small helper:

```ts
// resolveCustomerProfile(req) → { email: string|null, displayName: string|null }
// In-house path (req.authUserId is set by middleware):
//   read auth.users.email_lower / display_name (or hand them through
//   from the resolveCustomerId() call so we don't double-read).
// Clerk path (legacy):
//   clerkClient.users.getUser(req.userClerkId), same logic as today.
```

The middleware can attach `req.customerEmail` / `req.customerDisplayName`
when it resolves the in-house cookie path, so handlers don't need
to branch — they read the request fields and only fall back to a
Clerk lookup if those are absent.

### 6. Cutover order (recommended)

```
[before any flag flip]
  1.  Apply the Stage 4c migration (no schema changes — just adding
      the bcrypt code path + the customer resolver).
  2.  Export users.csv from Clerk Dashboard.
  3.  Run pnpm auth:backfill-shop-customers --csv=users.csv --dry-run
      → prints counts: would-create / would-skip / unverified / errors.
  4.  Spot-check the dry-run output. Re-run without --dry-run.

[flag flips, in order]
  5.  Set AUTH_PROVIDER=dual on resupply-api + api-server.
      Backend now accepts both Clerk JWTs and pf_session cookies.
  6.  Set VITE_AUTH_PROVIDER=in_house on cpap-fitter shop build.
      Customer-facing SPA renders the in-house pages; existing
      Clerk JWTs in long-lived tabs continue to work via the
      backend's dual mode until those tabs reload.
  7.  Wait for telemetry to show no /api/__clerk proxy traffic
      from the shop for ≥7 days (longest reasonable forgotten-tab
      window). The bcrypt-rehash counter on
      auth.password_credentials should also be dropping.
  8.  Set AUTH_PROVIDER=in_house. Clerk SDK no longer mounted
      anywhere.
  9.  Stage 5 starts.
```

Steps 5 and 6 are independently reversible (env-only). Step 7 is
the soak window. Step 8 is the cliff — past it, anyone who hasn't
signed in via the in-house path is locked out and would need a
forgot-password reset.

### 7. Reversibility

| Step | Roll-back | Cost |
|---|---|---|
| Migration (5.1) | None — additive code only | 0 |
| Backfill (5.4) | Truncate `auth.users` + clear `shop_customers.auth_user_id`. Idempotent re-run rebuilds. | minutes |
| AUTH_PROVIDER=dual (5.5) | Set back to clerk | seconds |
| VITE_AUTH_PROVIDER=in_house (5.6) | Set back to clerk + redeploy | minutes |
| AUTH_PROVIDER=in_house (5.8) | Set back to dual | seconds (but Clerk sessions are long expired; rolling back means everyone re-signs-in via Clerk) |

### 8. Risks / open questions

1. **Email collisions.** A customer signs up via in-house mode AT
   THE SAME TIME the backfill is running, with the same email
   that's in the CSV. Two `auth.users` rows would be created for
   the same `email_lower` — but the UNIQUE constraint catches it.
   The backfill must skip emails that already exist in
   `auth.users` (whether linked yet or not). The
   `findUserByEmail` repo method makes this trivial; the dry-run
   reports collisions before any insert.

2. **Stripe-customer drift.** Stripe Customers have
   `metadata.clerk_user_id` set to the original Clerk id. The
   shop_customers row's `stripe_customer_id` doesn't change, so
   the link still works. Stage 5 retitles the metadata key.

3. **Bcrypt cost factor + variant.** Clerk doesn't document the
   cost they use, but bcrypt's `compare()` reads both the cost
   AND the variant (`$2a$` / `$2b$` / `$2y$`) out of the digest
   itself, so we don't need to know either ahead of time. Verify
   is O(2^cost) per call, which is what we'd expect (likely
   cost=10 or 12). Confirmed via WorkOS, Better Auth, and
   PropelAuth Clerk-migration guides — all three pass Clerk's
   `password_digest` through verbatim to a bcrypt library
   (`golang.org/x/crypto/bcrypt`, `bcryptjs`, `passlib`
   respectively).

   The Node `bcrypt` package (the same one used by every other
   Clerk-migration tool) handles all three prefix variants, so we
   don't need a custom parser. Adding it is a small surface
   change to `lib/resupply-auth/package.json`.

4. **HIBP-like blocking on rehash.** When we transparently rehash
   a known-but-old password to argon2id, we're blessing a
   credential that may have been picked up in a breach since the
   user first set it. We're already not running a HIBP check
   (per ADR 014). If we want to in the future, the rehash is a
   natural place to add it: rehash but mark `must_change=true`,
   forcing a reset on next sign-in.

5. **Customers who never had a password (Clerk magic-link / OAuth-
   only).** Their CSV row has an empty `password_digest`. This is
   a known case: the WorkOS, Better Auth, and PropelAuth Clerk-
   migration guides all special-case it (PropelAuth's script does
   `if pd.isnull(password_hash): return None` and falls back to
   "social/magic only" sign-in). We don't have OAuth or magic-link
   in the in-house path, so for us:

   - Mint `auth.users` with `status='invited'`, no credential.
   - Issue a 7-day `password_reset` token (via the existing
     `/auth/forgot-password` machinery).
   - Email a "set your PennPaps password" link. This is exactly
     Option X, but applied only to this subset.

   The dry-run report should split the count by
   "with password / passwordless" so we know how many of these
   emails will go out before the script runs.

   **CONFIRM** whether any current cpap-fitter shop customers are
   passwordless. If sign-up always required a password, the
   subset is empty.

6. **Account locked / banned in Clerk.** The CSV doesn't
   distinguish. If we want to preserve a ban, we'd cross-reference
   the Backend API to fetch each user's `banned` flag (an
   additional `getUserList` pass) and mint them as
   `status='locked'`. **CONFIRM whether any current customers are
   banned** — if not, skip this for simplicity.

7. **Admin user collision.** Some admins may also be shop
   customers (testing). Their `auth.users` row already exists
   from the Stage 3 bootstrap. The backfill should detect this
   (matching `email_lower`) and update — link them to the
   shop_customers row, but DO NOT rewrite their role from
   `admin`/`agent` back to `customer`.

## Tests / acceptance

The backfill is one-shot, but the runtime changes ship behind the
existing AUTH_PROVIDER flag and are testable in isolation.

- `lib/resupply-auth`: new `verifyPassword` test asserting that a
  bcrypt-shaped digest is verified via `bcrypt.compare` and that
  a successful verify triggers a rehash (dispatch is observable
  via the algo on the stored credential).
- `lib/resupply-auth`: `bcrypt.compare` failure path returns false
  without throwing.
- `requireSignedIn-in-house`: when the resolver returns a custom
  `customerKey`, that key is what lands in `req.userClerkId` —
  not the raw `auth.users.id`.
- New backfill script: integration-style test against a real
  Postgres (the existing migration-test harness in
  `lib/resupply-db/scripts/migrate.test.ts` is the pattern).
  Verify idempotency: run twice on the same CSV → second run is a
  no-op.

## What to confirm before I build

1. Schema strategy — Option B (use `shop_customers` as the join,
   carry the column-name lie, rename in Stage 5).
2. Backfill source — Dashboard CSV + a single `getUserList` pass
   for `banned` (skip the API pass if no customers are banned).
3. Password handling — Option Y (transparent rehash) over
   Option X (mass email). Option X applies only to the
   passwordless subset (Risk 5).
4. `customerIdResolver` adapter goes in `AuthDeps` (api-server
   wires it; lib stays auth-schema-pure).
5. Whether any current customers are passwordless / banned
   (Risk 5 + Risk 6).

Once those are confirmed, implementation is ~3 files:

- `scripts/src/auth-backfill-shop-customers.ts` — CSV reader,
  email collision check, batch insert with idempotent
  `ON CONFLICT DO NOTHING`, dry-run mode, summary report.
- `lib/resupply-auth/src/password.ts` + tests — algo dispatch in
  `verifyPassword`, transparent rehash on success, new
  `bcrypt` dependency.
- `artifacts/resupply-api/src/middlewares/requireSignedIn.ts` +
  the 5 enrichment call sites — switch from `req.userClerkId =
  auth.users.id` to the resolver lookup, and from
  `clerkClient.users.getUser` to a request-attached profile
  populated by the same middleware.

Estimated diff size: ~600 LoC across the 3 files, plus tests.
Migration is one new SQL file (no schema changes — purely a code
change since Stage 1 already added the linking column).
