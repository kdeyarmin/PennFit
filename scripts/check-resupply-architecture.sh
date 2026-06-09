#!/usr/bin/env bash
# Enforces the dependency rules documented in docs/resupply/ARCHITECTURE.md.
#
# Each rule is a forbidden import edge expressed as a ripgrep pattern. If
# any matches, we exit non-zero and the validation step fails.
#
# This is intentionally cheap to read — when a rule fires, the developer
# should be able to see exactly why their commit was rejected without
# digging into a parser.
#
# Usage:
#   bash scripts/check-resupply-architecture.sh
#       Run against the repo root (default).
#
#   bash scripts/check-resupply-architecture.sh --self-test
#       Run the negative-test harness: build a fixture tree with known
#       violations, point the check at it, and assert it fails. Then
#       remove the violations and assert it passes. Used by the
#       resupply-check validation step to prevent regressions in the
#       checker itself (the architect review caught a bug where Rule 1
#       computed offending matches but never failed on them).
#
#   RESUPPLY_CHECK_ROOT=/some/dir bash scripts/check-resupply-architecture.sh
#       Run against an arbitrary tree (used by --self-test).

set -euo pipefail

if [[ "${1:-}" == "--self-test" ]]; then
  exec bash "$0.test"
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT="${RESUPPLY_CHECK_ROOT:-$REPO_ROOT}"
cd "$ROOT"

# Hard dependency: every rule below is a ripgrep query. If `rg` is not on
# PATH, each query errors to stderr and matches nothing — which would make
# this checker report "passed" while enforcing absolutely nothing. That is
# exactly how the architecture gate silently became a no-op on CI runners
# that ship without ripgrep (the .sh.test harness, once wired into CI,
# caught it). Fail loudly so a missing rg can never again turn the gate
# into a rubber stamp.
if ! command -v rg >/dev/null 2>&1; then
  echo "check-resupply-architecture: ripgrep (rg) is required but not on PATH." >&2
  echo "  Install it (e.g. 'apt-get install -y ripgrep' or 'brew install ripgrep')," >&2
  echo "  then re-run. Refusing to pass vacuously without it." >&2
  exit 2
fi

errors=0

fail() {
  echo "ARCHITECTURE VIOLATION: $1" >&2
  errors=$((errors + 1))
}

# Defensive ripgrep type coverage: include .ts/.tsx (default) plus .mts/.cts
# so future contributors can't bypass the gate by renaming a file.
RG_TYPES=(--type-add 'tsall:*.ts' --type-add 'tsall:*.tsx' \
          --type-add 'tsall:*.mts' --type-add 'tsall:*.cts' --type tsall)

# Helper: scan one source dir for forbidden import strings.
# Args: <source dir> <human description> <regex>...
# Each regex is matched against TS/TSX/MTS/CTS files. Patterns should be
# quote-agnostic (use ['\"]) so single- and double-quoted imports both fail.
forbid_imports_in() {
  local dir="$1"; shift
  local desc="$1"; shift
  if [[ ! -d "$dir" ]]; then
    return 0
  fi
  for pat in "$@"; do
    if rg --no-messages -l "${RG_TYPES[@]}" -e "$pat" "$dir" >/dev/null 2>&1; then
      local matches
      matches="$(rg --no-messages "${RG_TYPES[@]}" -n -e "$pat" "$dir" | head -20 || true)"
      fail "$desc — pattern: $pat"
      if [[ -n "$matches" ]]; then
        echo "$matches" | sed 's/^/    /' >&2
      fi
    fi
  done
}

# Rule 1: resupply-contracts may only import zod (or relative paths).
# Positive whitelist instead of negative lookahead because ripgrep's
# default regex (RE2) does not support lookaheads. We grep every
# non-relative import and subtract zod; whatever is left is a violation.
if [[ -d lib/resupply-contracts/src ]]; then
  # Capture every `from "X"` / `from 'X'` where X does NOT start with '.'.
  bad="$(rg --no-messages -n "${RG_TYPES[@]}" \
    -e "from ['\"]([^.'\"][^'\"]*)['\"]" \
    lib/resupply-contracts/src 2>/dev/null \
    | grep -Ev "from ['\"]zod['\"]" \
    || true)"
  if [[ -n "$bad" ]]; then
    fail "lib/resupply-contracts may only import 'zod' or relative paths"
    echo "$bad" | sed 's/^/    /' >&2
  fi
fi

# Rule 2: resupply-domain must be pure — no I/O packages and no vendor SDKs.
forbid_imports_in lib/resupply-domain/src \
  "lib/resupply-domain must not import I/O packages (db/telecom/ai/audit)" \
  '@workspace/resupply-db' \
  '@workspace/resupply-telecom' \
  '@workspace/resupply-ai' \
  '@workspace/resupply-audit' \
  "['\"]drizzle-orm" \
  "['\"]pg['\"]" \
  "['\"]@anthropic-ai/sdk['\"]" \
  "['\"]twilio['\"]" \
  "['\"]@sendgrid/mail['\"]"

# Rule 3: resupply-db may not import vendor adapters.
# Patterns are quote-anchored so a code COMMENT mentioning the package
# name (e.g. "see @workspace/resupply-telecom") does not trip the gate.
# Only an actual import statement — which always closes with `'` or
# `"` — counts.
forbid_imports_in lib/resupply-db/src \
  "lib/resupply-db must not import vendor adapters (telecom/ai)" \
  "@workspace/resupply-telecom['\"]" \
  "@workspace/resupply-ai['\"]"

# Rule 4: telecom and ai must not import each other. Quote-anchored
# for the same reason as Rule 3.
forbid_imports_in lib/resupply-telecom/src \
  "lib/resupply-telecom must not import lib/resupply-ai (factor shared logic into resupply-domain)" \
  "@workspace/resupply-ai['\"]"
forbid_imports_in lib/resupply-ai/src \
  "lib/resupply-ai must not import lib/resupply-telecom (factor shared logic into resupply-domain)" \
  "@workspace/resupply-telecom['\"]"

# Rule 9: lib/resupply-ai must NEVER import the DB layer or a telephony
# vendor SDK. The AI lib is a pure OpenAI Realtime adapter — it owns
# the model conversation state machine and tool schemas, nothing more.
# Pulling in `pg`, `@workspace/resupply-db`, or the `twilio` SDK from
# this layer would turn an "AI question" into a "DB-and-telecom
# question" and erase the API's hexagonal boundary. (The Realtime
# session itself uses the `ws` package; that one is allowed.)
forbid_imports_in lib/resupply-ai/src \
  "lib/resupply-ai must not import the DB layer or telephony SDKs (keep it a pure OpenAI Realtime adapter)" \
  "@workspace/resupply-db['\"]" \
  "['\"]pg['\"]" \
  "['\"]twilio['\"]"

# Rule 10: lib/resupply-telecom must NEVER import the DB layer or any
# AI/LLM SDK. The telecom lib is a pure Twilio adapter — it owns the
# Media Stream protocol, signature validation, and the REST client.
# Pulling in `pg`, `@workspace/resupply-db`, `openai`, or
# `@anthropic-ai/sdk` from this layer would couple call routing to
# both PHI storage and model selection in one place — exactly the
# blast radius hexagonal architecture is meant to prevent.
forbid_imports_in lib/resupply-telecom/src \
  "lib/resupply-telecom must not import the DB layer or AI SDKs (keep it a pure Twilio adapter)" \
  "@workspace/resupply-db['\"]" \
  "['\"]pg['\"]" \
  "['\"]openai['\"]" \
  "@anthropic-ai/sdk['\"]"

# Rule 5: removed in Task #37 — @workspace/resupply-testing was deleted as
# part of the consolidation sweep (it had zero importers).

# Rule 6: the resupply-* libraries, the dashboard/worker artifacts, AND
# the resupply-api server itself must not import the storefront's UI
# client (`@workspace/api-client-react`). That client is generated from
# the storefront OpenAPI spec and is meant for the customer-facing
# cpap-fitter SPA only — it is React-Query React code, not server code.
#
# The storefront's Zod SCHEMAS (`@workspace/api-zod`) are a different
# package and are not banned anywhere; resupply-api's storefront router
# (folded in by Task #37) imports them directly to validate request /
# response bodies. There is no need for an explicit "carve-out" because
# Rule 6 only enumerates packages that ARE forbidden — not listing
# `@workspace/api-zod` already permits it everywhere.
#
# Quote-agnostic: forbid both single- and double-quoted forms.
for resdir in lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src artifacts/resupply-api/src; do
  forbid_imports_in "$resdir" \
    "$resdir must not import the storefront UI client (@workspace/api-client-react is for cpap-fitter only)" \
    "@workspace/api-client-react['\"]"
done

# Rule 7: only @workspace/resupply-db is allowed to construct a pg Pool
# or import the `pg` package directly. Every other resupply package —
# API, worker, dashboard, future query helpers — must read/write
# through the Supabase service-role client exported from
# @workspace/resupply-db (`getSupabaseServiceRoleClient()`). The few
# legacy callers that still consume `getDbPool()` are shrinking and
# the rule below tolerates that for now; the goal is that `pg`
# itself stays sequestered to lib/resupply-db. pg-boss inside the
# worker stays untouched because it instantiates its pool internally
# via `new PgBoss(...)`, never `new Pool(`.
#
# Two patterns are checked:
#   (a) `new <maybe-namespace>.Pool(` / `new PgPool(` — catches the
#       common forms. The optional namespace prefix handles
#       `new pg.Pool(`; the `Pool|PgPool` alternation handles the
#       common renamed-import alias.
#   (b) Any import from the `pg` package. This closes the renamed-
#       alias bypass entirely (`import { Pool as Whatever } from "pg"`)
#       — if you can't import `pg`, you can't construct a pool.
# Test files (`*.test.*`) are exempt because they may legitimately
# stand up throwaway pools against test databases.
for nopool in artifacts/resupply-api/src \
              lib/resupply-domain/src \
              lib/resupply-audit/src lib/resupply-telecom/src \
              lib/resupply-ai/src; do
  if [[ -d "$nopool" ]]; then
    bad="$(rg --no-messages -n "${RG_TYPES[@]}" \
      -e 'new\s+([A-Za-z_$][\w$]*\.)?(Pool|PgPool)\(' \
      -e "from ['\"]pg['\"]" \
      -e "require\(['\"]pg['\"]\)" \
      "$nopool" 2>/dev/null \
      | rg -v '\.(test|spec)\.[mc]?tsx?:' || true)"
    if [[ -n "$bad" ]]; then
      fail "$nopool: must not construct its own Postgres pool or import 'pg' directly — use getSupabaseServiceRoleClient() from @workspace/resupply-db (or, for legacy paths, getDbPool from the same package)"
      echo "$bad" | sed 's/^/    /' >&2
    fi
  fi
done

# Rule 8: every audit_log INSERT must go through @workspace/resupply-audit.
# logAudit() in lib/resupply-audit/src/ is the only allowed write site;
# direct Drizzle `.insert(auditLog)` and raw `INSERT INTO ... audit_log`
# from anywhere else are forbidden so the metadata sanitizer (PHI
# denylist + size + depth caps in lib/resupply-audit/src/sanitize.ts)
# cannot be bypassed. A bypassed audit row that contains PHI is a
# HIPAA-reportable event, so this gate is worth its own architecture
# rule.
#
# Scope is INSERTS ONLY. SELECT / UPDATE / DELETE against audit_log
# remain allowed — audit-log reads are legitimate, and integration
# tests need DELETE to clean up after themselves.
#
# Allowed location: lib/resupply-audit/src/ (the helper and its tests).
# Test files elsewhere are NOT exempt — a test that needs an audit row
# should call logAudit(), not bypass it. Bypassing in tests would
# defeat the "logAudit is the only path" invariant the moment a future
# refactor copy/pastes the test fixture into production code.
for noaudit in artifacts/resupply-api/src \
               lib/resupply-domain/src \
               lib/resupply-db/src lib/resupply-telecom/src \
               lib/resupply-ai/src; do
  if [[ -d "$noaudit" ]]; then
    # Patterns (multi-line `-U` mode so a regex can span newlines —
    # without it, a developer can split `import { auditLog,\n} from`
    # or `db.insert(\n  schema.auditLog\n)` across lines and slip
    # past every line-oriented pattern we write):
    #
    #   1. `.insert(<anyIdent>?.audit*)` — Drizzle insert call.
    #      Matches the bare `.insert(auditLog)` form AND the
    #      namespaced `.insert(schema.auditLog)` /
    #      `.insert(tables.AuditLog)` form. The identifier-name
    #      capture is permissive on case so a custom alias like
    #      `MyAuditLog` is also caught. With `-U` the whitespace
    #      after `(` may include newlines.
    #   2. `import { ... auditLog ... }` — ANY import that brings
    #      the `auditLog` schema symbol into scope, whether bare
    #      (`import { auditLog }`), aliased (`import { auditLog as
    #      al }`), or wrapped in a multi-line braced clause. By
    #      banning the import itself we also kill the indirect
    #      two-step alias bypass `import { auditLog }; const al =
    #      auditLog; db.insert(al)` — without an import, `auditLog`
    #      simply isn't in scope. `[^}]*` already crosses newlines
    #      under `-U` because newlines aren't `}`.
    #   3. `INSERT ... audit_log` (case-insensitive) — catches every
    #      raw SQL writer including template-literal interpolations
    #      like `INSERT INTO ${schema}.audit_log`. The gap matcher
    #      excludes `;` (SQL statement terminator) AND string-literal
    #      boundaries (backtick, `"`, `'`). Excluding the quotes is
    #      what stops the previous version's false positive: a code
    #      comment like `// INSERT is restricted to the helper.`
    #      followed by a legal `await pool.query("DELETE FROM
    #      audit_log…")` had no `;` between the comment-INSERT and
    #      the DELETE's audit_log token, so under `-U` the match
    #      bridged the gap. With `"` excluded, the matcher stops at
    #      the DELETE's opening quote and the false positive
    #      vanishes. Real raw-SQL violations stay caught because the
    #      INSERT and `audit_log` token live INSIDE the same string
    #      literal — no quote between them.
    #
    # KNOWN LIMITATION (regex-only static check): an attacker who
    # actively wants to evade Rule 8 can assemble the SQL across
    # string-literal boundaries, e.g.
    #   await pool.query("INSERT INTO " + "resupply.audit_log …")
    # The gap-character exclusion that fixes the comment-INSERT
    # false positive also breaks this case — the closing `"` of the
    # first literal stops the matcher before it reaches `audit_log`.
    # Tightening the regex to catch this would require giving up
    # the false-positive fix, which has higher day-to-day value
    # (legitimate code commonly puts the word "INSERT" near
    # legitimate `audit_log` SELECT/DELETE; legitimate code rarely
    # if ever splits the same SQL statement across string
    # boundaries). The proper fix for adversarial resistance is an
    # AST-based check on raw SQL sinks; until that lands, the
    # `lib/resupply-audit/src/` chokepoint plus code review for any
    # added `pool.query`/`db.execute` call site remains the
    # mitigating control. See `scripts/check-resupply-architecture.sh.test`
    # for the self-test that pins this expected gap so it cannot
    # silently widen.
    bad="$(rg --no-messages -n -U "${RG_TYPES[@]}" \
      -e '\.insert\(\s*([A-Za-z_$][\w$]*\.)?[Aa]udit[A-Za-z]*\b' \
      -e 'import\s*\{[^}]*\bauditLog\b[^}]*\}\s*from\s*["'\''](@workspace/resupply-db|\.\.?/)' \
      -e '(?i)\bINSERT\b[^;`"'\'']*\baudit_log\b' \
      "$noaudit" 2>/dev/null || true)"
    if [[ -n "$bad" ]]; then
      fail "$noaudit: must not write to audit_log directly — call logAudit() from @workspace/resupply-audit"
      echo "$bad" | sed 's/^/    /' >&2
    fi
  fi
done

# Rule 11: lib/resupply-messaging is a PURE semantic layer. It owns
# the keyword router, intent enum, link-token signing, and email
# templates — all of which are vendor-agnostic by design. Pulling in
# `pg`, `@workspace/resupply-db`, `twilio`, `@sendgrid/mail`, `openai`,
# `@anthropic-ai/sdk`, or `ws` from this layer would couple semantic
# parsing to a specific vendor and re-create the exact "rendering
# shouldn't know how it ships" mistake we've avoided in the API.
# Quote-anchored so a comment mentioning a package name doesn't trip.
forbid_imports_in lib/resupply-messaging/src \
  "lib/resupply-messaging must not import any vendor SDK or the DB layer (keep it a pure semantic layer)" \
  "@workspace/resupply-db['\"]" \
  "['\"]pg['\"]" \
  "['\"]twilio['\"]" \
  "@sendgrid/mail['\"]" \
  "['\"]openai['\"]" \
  "@anthropic-ai/sdk['\"]" \
  "['\"]ws['\"]"

# Rule 12: lib/resupply-email is the pure SendGrid adapter. Symmetric
# with Rule 10 (telecom) — it OWNS `@sendgrid/mail` (only sanctioned
# place to import it) but must NEVER reach into the DB layer or any
# AI/telecom vendor SDK. PHI lives encrypted in resupply.* and
# arrives at this lib already-decrypted as plain strings; the lib
# itself does not — and must not — know about pg/drizzle. Same
# blast-radius reasoning as Rule 10.
forbid_imports_in lib/resupply-email/src \
  "lib/resupply-email must not import the DB layer or non-SendGrid vendor SDKs (keep it a pure SendGrid adapter)" \
  "@workspace/resupply-db['\"]" \
  "['\"]pg['\"]" \
  "['\"]twilio['\"]" \
  "['\"]openai['\"]" \
  "@anthropic-ai/sdk['\"]" \
  "['\"]ws['\"]"

# Rule 13: lib/resupply-reminders is the SHARED outbound-reminder code
# path, called by both the admin-facing API routes and the worker's
# pg-boss handlers. It IS allowed to import db/telecom/email/messaging/
# audit (that is its entire job — composing them into a send pipeline)
# and it IS allowed to import `pg` directly because the helpers receive
# a Pool and need its TYPE in their signatures. It must NOT reach for
# vendor SDKs directly — Twilio goes through resupply-telecom,
# SendGrid goes through resupply-email, never inline. Inlining a
# vendor SDK here would re-create the exact split-import problem the
# resupply-{telecom,email} libs were built to prevent.
forbid_imports_in lib/resupply-reminders/src \
  "lib/resupply-reminders must not import vendor SDKs directly (use resupply-telecom / resupply-email wrappers)" \
  "['\"]twilio['\"]" \
  "@sendgrid/mail['\"]" \
  "['\"]openai['\"]" \
  "@anthropic-ai/sdk['\"]" \
  "['\"]ws['\"]"

# Rule 14: PennFit's DB does NOT own inventory / warehousing.
#
# Pacware is the inventory system of record. PennFit's DB tracks the
# patient-facing side of the resupply pipeline (prescriptions,
# episodes, fulfillments — the *intent* to ship, plus the tracking
# echo back from Pacware) but does NOT model on-hand counts, lots,
# serial numbers, purchase orders, receiving, transfers, or
# warehouses. Reintroducing any of those concerns turns PennFit into
# a half-WMS that competes with Pacware, splits the source of truth
# for stock, and immediately becomes a reconciliation problem.
#
# This rule is enforced at the schema-file level: any new TS file
# under lib/resupply-db/src/schema/ whose name matches one of the
# forbidden patterns fails the gate. Adjust the catalog only with an
# explicit ADR — the boundary is intentional, not accidental.
#
# Out-of-scope (allowed): existing `shop_inventory` ADMIN UI that
# reads stock counts from Stripe metadata. That is a thin mirror,
# not a system of record, and it lives in the API/SPA — not in this
# schema directory.
if [[ -d lib/resupply-db/src/schema ]]; then
  forbidden_inventory_files="$(find lib/resupply-db/src/schema -maxdepth 1 -type f \( \
      -name 'inventory*.ts' \
      -o -name 'inventory_*.ts' \
      -o -name 'lots.ts' -o -name 'lots-*.ts' -o -name 'lots_*.ts' \
      -o -name 'purchase-orders*.ts' -o -name 'purchase_orders*.ts' \
      -o -name 'receiving*.ts' \
      -o -name 'warehouses*.ts' \
      -o -name 'stock-transfers*.ts' -o -name 'stock_transfers*.ts' \
    \) 2>/dev/null || true)"
  if [[ -n "$forbidden_inventory_files" ]]; then
    fail "lib/resupply-db/src/schema may not own inventory/warehousing — Pacware is the system of record. Move these to Pacware integration code, or open an ADR to change the boundary."
    echo "$forbidden_inventory_files" | sed 's/^/    /' >&2
  fi
fi

# Rule 14b: SQL-migration counterpart to Rule 14. A contributor might
# bypass the schema-file rule by writing a hand-rolled migration. This
# catches that by grepping for `CREATE TABLE resupply.<name>` patterns
# matching the same forbidden vocabulary. Same Pacware-boundary
# rationale — change only via ADR.
if [[ -d lib/resupply-db/drizzle ]]; then
  forbidden_inventory_sql="$(find lib/resupply-db/drizzle -maxdepth 1 -type f -name '*.sql' \
    -exec grep -liE '(CREATE|ALTER)[[:space:]]+TABLE[[:space:]]+(IF[[:space:]]+NOT[[:space:]]+EXISTS[[:space:]]+)?"?resupply"?\."?(inventory_items|inventory_lots|purchase_orders|receiving_events|receiving_receipts|warehouses|stock_transfers)"?' {} \; 2>/dev/null || true)"
  if [[ -n "$forbidden_inventory_sql" ]]; then
    fail "SQL migrations may not own inventory/warehousing tables — Pacware is the system of record."
    echo "$forbidden_inventory_sql" | sed 's/^/    /' >&2
  fi
fi

# Rule 15: every pg-boss queue in the worker MUST be created through
# createQueueWithDlq() in artifacts/resupply-api/src/worker/lib/queue-options.ts.
#
# pg-boss v10 enforces a self-referential FK on `queue.dead_letter`:
# the DLQ row must exist BEFORE the main queue can be inserted with
# that reference. buildQueueConfig() always sets deadLetter to
# `${name}.dlq`, so any direct `boss.createQueue(NAME, buildQueueConfig(...))`
# in a register function crashes the API on first boot of a newly-
# added queue with "queue_dead_letter_fkey" violation. Existing
# queues survive via ON CONFLICT DO NOTHING — which made this trap
# invisible until two new queues landed in May 2026 and took down
# the API on boot.
#
# The fix is the createQueueWithDlq helper, which pre-creates the
# DLQ before the main queue. This rule prevents regression: any new
# `boss.createQueue(` or `buildQueueConfig(` call in
# artifacts/resupply-api/src/worker/jobs/ must go through the helper
# instead. Test files (`*.test.*`) are exempt because they mock the
# helper. The helper definition itself in queue-options.ts is also
# exempt — that's the ONE allowed call site.
if [[ -d artifacts/resupply-api/src/worker/jobs ]]; then
  bad="$(rg --no-messages -n "${RG_TYPES[@]}" \
    -e 'boss\.createQueue\(' \
    -e '\bbuildQueueConfig\(' \
    artifacts/resupply-api/src/worker/jobs 2>/dev/null \
    | rg -v '\.test\.' || true)"
  if [[ -n "$bad" ]]; then
    fail "artifacts/resupply-api/src/worker/jobs/ must create queues via createQueueWithDlq() from ../lib/queue-options — direct boss.createQueue() / buildQueueConfig() calls skip DLQ pre-creation and will crash on first boot (pg-boss self-FK on queue.dead_letter)"
    echo "$bad" | sed 's/^/    /' >&2
  fi
fi

if [[ "$errors" -gt 0 ]]; then
  echo "" >&2
  echo "$errors architecture rule violation(s). See docs/resupply/ARCHITECTURE.md for the full ruleset." >&2
  exit 1
fi

echo "Resupply architecture check passed."
