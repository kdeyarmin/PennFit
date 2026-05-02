# Objective
Run a production-scope security scan across the PennPaps monorepo, confirm real vulnerabilities only, and ignore dev-only artifacts unless production reachability is demonstrated.

# Shared Context
- Production entry points: `artifacts/api-server/src/index.ts`, `artifacts/resupply-api/src/index.ts`, `artifacts/resupply-worker/src/index.ts`.
- Main public surfaces:
  - PennPaps API: `/api/recommend`, `/api/orders`, `/api/reminders*`, `/api/usage-events`
  - Resupply/shop: `/resupply-api/shop/*`, `/resupply-api/stripe/webhook`, `/resupply-api/voice/*`, `/resupply-api/sms/*`, `/resupply-api/email/*`
- Main protected/admin surfaces:
  - PennPaps admin: `/api/admin/*`
  - Resupply admin/PHI: `/resupply-api/me`, `/resupply-api/dashboard/*`, `/resupply-api/patients/*`, `/resupply-api/rules/*`, `/resupply-api/conversations/*`, `/resupply-api/episodes/*`, `/resupply-api/audit/*`, `/resupply-api/admin/shop/*`
- Production assumptions:
  - `NODE_ENV=production`
  - Replit deployment provides TLS termination
  - `artifacts/mockup-sandbox/**`, `.agents/**`, `.local/**`, tests, and generated review assets are dev-only unless an import or route proves otherwise
- Deterministic scans produced mostly dev-only noise; validate real issues by tracing production code paths.

# Tasks

### T001: PennPaps API public + admin boundary
- **Blocked By**: []
- **Files / Surfaces**:
  - `artifacts/api-server/src/routes/**`
  - `artifacts/api-server/src/middlewares/requireAdmin.ts`
  - `lib/db/**`
- **Checks**:
  - Broken access control, IDOR, capability-token weaknesses, sensitive data exposure, rate-limit gaps, open redirects, unsafe logging, server/client trust mistakes.
  - Public reminder management token flows and admin team-management/role handling.
- **Acceptance**:
  - Confirm any exploitable authz/data-exposure issues with concrete route/file evidence, or explain why the main surfaces hold.

### T002: Resupply public shop + customer-account + Stripe boundary
- **Blocked By**: []
- **Files / Surfaces**:
  - `artifacts/resupply-api/src/routes/shop/**`
  - `artifacts/resupply-api/src/lib/stripe/**`
  - `artifacts/resupply-api/src/middlewares/requireSignedIn.ts`
  - `artifacts/resupply-api/src/routes/admin/customers.ts`
- **Checks**:
  - IDOR, checkout tampering, open redirect prevention, Stripe webhook trust, customer/account data scoping, reorder-on-behalf abuse, saved-card/customer mapping issues.
- **Acceptance**:
  - Confirm or rule out production-impactful billing/account vulnerabilities with exact paths and exploit story.

### T003: Resupply admin/PHI + upload/document surfaces
- **Blocked By**: []
- **Files / Surfaces**:
  - `artifacts/resupply-api/src/middlewares/requireAdmin.ts`
  - `artifacts/resupply-api/src/routes/{dashboard,patients,rules,conversations,episodes,audit,admin}/**`
  - `artifacts/resupply-api/src/routes/patients/prescriptions-attachment.ts`
  - `lib/resupply-db/**`
- **Checks**:
  - Admin authorization, privilege separation, PHI disclosure, object-level access, signed URL issuance/finalization, file validation, object-storage path safety, destructive action protections.
- **Acceptance**:
  - Confirm or rule out PHI/admin vulnerabilities and update any matching existing findings.

### T004: Resupply vendor callback + voice/ws + worker/external-integration boundary
- **Blocked By**: []
- **Files / Surfaces**:
  - `artifacts/resupply-api/src/routes/{voice,sms,email}/**`
  - `artifacts/resupply-api/src/index.ts`
  - `lib/resupply-telecom/**`
  - `lib/resupply-email/**`
  - `artifacts/resupply-worker/src/**`
  - `lib/resupply-reminders/**`
  - `lib/resupply-ai/**`
- **Checks**:
  - Webhook signature verification, replay exposure, websocket auth bypass, unsafe outbound fetch/use of third-party data, secret/PII leakage, worker-triggered privilege issues, denial-of-service primitives.
- **Acceptance**:
  - Confirm or rule out production-impactful callback/worker issues with specific boundary analysis.
