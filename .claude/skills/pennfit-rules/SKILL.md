---
name: pennfit-rules
description: PennFit-specific invariants and "hard rules" to check when writing, reviewing, or committing changes in this repo — PHI/image logging, Supabase-only data path, admin theme scoping, no column encryption, no password pepper, no compliance/audit_log machinery, single email From address, and the decoupled service-boot contract. Use when editing code under artifacts/ or lib/, reviewing a diff or PR, or before committing. These are correctness invariants, not style — a violation is a real bug.
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

# Conventions: direct pg outside the db package, drizzle in the domain pkg
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

### R6 — One From address
Every outbound email funnels through `lib/resupply-email`'s
`createSendgridClient()`; `SENDGRID_FROM_EMAIL` is `info@pennpaps.com`.
Don't construct a second SendGrid client or hardcode a different From.

### R7 — Admin theme stays scoped
Admin tokens (`--penn-navy`, …) live in `artifacts/cpap-fitter/src/admin.css`
under `.admin-root`. Every admin surface must wrap its outer `<div>` with
`className="admin-root"`. **Do NOT add a global `@theme` block to
`admin.css`** — Tailwind v4 emits `@theme` utilities globally and they
clobber the storefront's shadcn tokens (this is what made the PennBot
panel render transparent). Re-point shadcn tokens by overriding the **raw**
`--background` / `--foreground` / … variables under `.admin-root`.
Enforced by `artifacts/cpap-fitter/src/admin.scope.test.ts`.

## Step 3 — convention invariants (also worth checking)

- **Supabase is the only runtime data path.** Read/write through
  `getSupabaseServiceRoleClient()` from `@workspace/resupply-db`. No
  `drizzle-orm`/`drizzle-kit`; no direct `pg` outside `lib/resupply-db`
  (a few legacy worker paths + `migrate.mjs` are the only exceptions).
- **Zod at every HTTP boundary** in `resupply-api`.
- **Don't hand-edit `lib/resupply-db/drizzle/meta/_journal.json`** — frozen
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

For each finding give: the rule (R1–R7 or convention), `file:line`, why it
violates the invariant, and the minimal fix. If a sweep hit is actually the
rule's own allowed location (e.g. the SendGrid client *inside*
`lib/resupply-email`), note it as a false positive and move on. When asked
to fix, prefer the smallest change that restores the invariant.
