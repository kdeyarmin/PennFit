# CPAP Resupply Automation — Onboarding (5 minute tour)

Welcome. This is the second product in the monorepo, separate from Penn
Fit. It will eventually automate the resupply workflow for CPAP patients
(eligibility check → patient outreach across SMS/voice/email → AI
conversation → fulfillment hand-off to Pacware).

**Phase 0 ships scaffolding only — no business logic, no schema, no
real vendor wiring.** This README is the on-ramp for whoever picks up
Phase 1.

## What's already in the repo

```
artifacts/
  resupply-api/          Express + Zod HTTP API (only /healthz today)
  resupply-worker/       pg-boss background worker (no jobs registered yet)
  resupply-dashboard/    React + Vite admin console (Phase 0 placeholder)
lib/
  resupply-contracts/    Zod schemas — empty
  resupply-domain/       Pure business logic — empty
  resupply-db/           Drizzle schema + connection — empty
  resupply-audit/        Append-only audit logger — empty
  resupply-telecom/      Twilio + SendGrid adapters — empty
  resupply-ai/           Anthropic Claude adapter — empty
  resupply-testing/      Fixtures and mock vendors (devDeps only) — empty
docs/resupply/
  README.md              You are here.
  ARCHITECTURE.md        Layout, data flow, dependency rules.
  adr/                   Twelve ADRs (000–007, 009–012).
scripts/
  check-resupply-architecture.sh        Enforces dependency rules.
  check-resupply-architecture.sh.test   Negative-test harness for ↑.
```

## Where the workflows live

The system runs three workflows per service:

| Workflow                                | Where it's defined                                | Auto-start |
|------------------------------------------|----------------------------------------------------|------------|
| `artifacts/resupply-api: Resupply API`   | `artifacts/resupply-api/.replit-artifact/artifact.toml` | yes |
| `artifacts/resupply-dashboard: web`      | `artifacts/resupply-dashboard/.replit-artifact/artifact.toml` | yes |
| `Resupply Worker`                        | `.replit` (workflows section)                       | yes |
| `resupply-check`                         | `.replit` (validation step)                        | manual |

The first two are auto-managed by the artifact system — do **not** add
duplicate entries to `.replit`. The worker has no preview surface so it
lives in `.replit` directly.

## Daily commands

```bash
# Install everything once
pnpm install

# All workflows above auto-start. To run the validation gate yourself:
bash scripts/check-resupply-architecture.sh --self-test    # gate the gate
bash scripts/check-resupply-architecture.sh                 # the gate itself
pnpm -r --filter "@workspace/resupply-*" run typecheck      # TS strict-check
pnpm -r --filter "@workspace/resupply-*" run test           # vitest
pnpm run lint:resupply                                       # ESLint (resupply only)
```

The single `resupply-check` validation step runs all five in order. If
this is green, the Phase 0 deliverable is intact.

## Adding code in Phase 1+

Read `docs/resupply/ARCHITECTURE.md` first — it spells out which package
may import which. The dependency rules are enforced by
`scripts/check-resupply-architecture.sh` and tested by its `.test`
sibling. If you add a new rule, add a fixture for it in the test file
so a future contributor can't silently regress it (the architect review
that produced this scaffold caught exactly that bug class).

The full resupply build plan is twelve phases (0 → scaffold,
1 → schema, 2 → admin auth, 3 → telecom, 4 → admin UI,
5 → conversation engine, 6 → AI, 7 → fulfillment, 8 → analytics,
9 → production hardening, 10 → patient auth, 11 → Pacware automation,
12 → multi-tenant). Each later phase depends on the schema landing in
Phase 1, so that is the next task in the queue (see project tasks).

## Why this isn't on AWS yet

Replit can't host the original plan's AWS-only pieces (KMS, Cognito,
Temporal, Datadog, ECS Fargate). Each substitute we made is documented
in `docs/resupply/adr/000-replit-hosting-deviations.md` along with the
trigger that forces a migration before any real PHI can land. Read ADR
000 if you only have time for one.

## What does not belong here

- **Penn Fit changes.** Different product, different schema. Penn Fit's
  `lib/db`, `lib/api-zod`, and `lib/api-client-react` are off-limits to
  every resupply package (the dashboard's `api-client-react` import is
  an explicit, time-limited exception — see ARCHITECTURE.md).
- **Patient-facing UI.** The dashboard is admin-only. Patient-facing
  flows are SMS/voice/email-only until Phase 10.
- **Real PHI in dev.** Synthetic data only until ADR 007's migration
  triggers fire (managed KMS + signed BAAs).
