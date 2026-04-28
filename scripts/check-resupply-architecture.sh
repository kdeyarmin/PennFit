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

# Rule 2: resupply-domain must be pure — no I/O packages, no vendor SDKs,
# and no testing utilities.
forbid_imports_in lib/resupply-domain/src \
  "lib/resupply-domain must not import I/O packages (db/telecom/ai/audit) or testing utilities" \
  '@workspace/resupply-db' \
  '@workspace/resupply-telecom' \
  '@workspace/resupply-ai' \
  '@workspace/resupply-audit' \
  '@workspace/resupply-testing' \
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

# Rule 5: resupply-testing must not be imported by production code (api,
# worker, dashboard, or any non-test file in libs).
for prod in artifacts/resupply-api/src artifacts/resupply-worker/src artifacts/resupply-dashboard/src; do
  forbid_imports_in "$prod" \
    "$prod must not import @workspace/resupply-testing (testing helpers are devDeps only)" \
    '@workspace/resupply-testing'
done
for libdir in lib/resupply-contracts/src lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src; do
  if [[ -d "$libdir" ]]; then
    bad="$(rg --no-messages -l "${RG_TYPES[@]}" \
      -e '@workspace/resupply-testing' "$libdir" 2>/dev/null \
      | rg -v '\.test\.|__tests__|/test/' || true)"
    if [[ -n "$bad" ]]; then
      fail "$libdir: non-test files import @workspace/resupply-testing"
      echo "$bad" | sed 's/^/    /' >&2
    fi
  fi
done

# Rule 6: resupply packages must not import Penn Fit's lib/db, lib/api-zod,
# or lib/api-client-react. Different product, different schema. The
# dashboard now ships @workspace/resupply-api-client and is included in
# this sweep — the Phase 0 carve-out documented in earlier revisions of
# docs/resupply/ARCHITECTURE.md was retired in Phase 4.
# Quote-agnostic: forbid both single- and double-quoted forms.
for resdir in lib/resupply-contracts/src lib/resupply-domain/src lib/resupply-db/src lib/resupply-audit/src lib/resupply-telecom/src lib/resupply-ai/src lib/resupply-testing/src artifacts/resupply-api/src artifacts/resupply-worker/src artifacts/resupply-dashboard/src; do
  forbid_imports_in "$resdir" \
    "$resdir must not import Penn Fit packages (use the resupply-* equivalents)" \
    "@workspace/db['\"]" \
    "@workspace/api-zod['\"]" \
    "@workspace/api-client-react['\"]"
done

# Rule 7: only @workspace/resupply-db is allowed to construct a pg Pool
# or import the `pg` package directly. Every other resupply package —
# API, worker, dashboard, future query helpers — must consume the
# shared pool via getDbPool(). This locks in the "exactly one Postgres
# pool per process" invariant from ADR 003 (and Task #7). pg-boss
# inside the worker stays untouched because it instantiates its pool
# internally via `new PgBoss(...)`, never `new Pool(`.
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
for nopool in artifacts/resupply-api/src artifacts/resupply-worker/src \
              artifacts/resupply-dashboard/src \
              lib/resupply-contracts/src lib/resupply-domain/src \
              lib/resupply-audit/src lib/resupply-telecom/src \
              lib/resupply-ai/src lib/resupply-testing/src \
              lib/resupply-api-client/src; do
  if [[ -d "$nopool" ]]; then
    bad="$(rg --no-messages -n "${RG_TYPES[@]}" \
      -e 'new\s+([A-Za-z_$][\w$]*\.)?(Pool|PgPool)\(' \
      -e "from ['\"]pg['\"]" \
      -e "require\(['\"]pg['\"]\)" \
      "$nopool" 2>/dev/null \
      | rg -v '\.test\.' || true)"
    if [[ -n "$bad" ]]; then
      fail "$nopool: must not construct its own Postgres pool or import 'pg' directly — import getDbPool from @workspace/resupply-db"
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
for noaudit in artifacts/resupply-api/src artifacts/resupply-worker/src \
               artifacts/resupply-dashboard/src \
               lib/resupply-contracts/src lib/resupply-domain/src \
               lib/resupply-db/src lib/resupply-telecom/src \
               lib/resupply-ai/src lib/resupply-testing/src \
               lib/resupply-api-client/src; do
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

if [[ "$errors" -gt 0 ]]; then
  echo "" >&2
  echo "$errors architecture rule violation(s). See docs/resupply/ARCHITECTURE.md for the full ruleset." >&2
  exit 1
fi

echo "Resupply architecture check passed."
