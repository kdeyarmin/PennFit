# Function Review Recommendations — 2026-05-06

This review maps the four requested areas to concrete code paths and prioritized improvements.

## 1) Conversion instrumentation and iteration speed

### Current strengths
- Core funnel events already exist around store interactions and checkout funnel transitions.
- Admin and storefront routes are reasonably modular, making targeted instrumentation feasible.

### Gaps observed
- Funnel events are not consistently correlated with backend outcomes (e.g., reorder intent vs. reorder completion).
- Some failure modes (archived pricing, auth expiry during cart sync) reduce conversion but are not surfaced as explicit product analytics signals.

### Recommended improvements
1. **Adopt a canonical conversion event schema** shared across frontend + API.
   - Include: `event_name`, `session_id`, `user_id?`, `correlation_id`, `route`, `sku_ids`, `order_id?`, `error_code?`, `latency_ms`.
2. **Instrument “intent → outcome” pairs for reorder flows**.
   - Track: `reorder_clicked`, `reorder_quote_loaded`, `reorder_checkout_started`, `reorder_paid`, `reorder_failed`.
3. **Emit structured drop-off reasons** for known reliability edges.
   - Example codes: `price_unavailable`, `session_expired`, `cart_sync_conflict`, `payment_intent_failed`.
4. **Add one-click experiment toggles** via config for copy/pricing/UX tests so changes can ship without redeploying analytics code.
5. **Create a weekly “iteration speed” dashboard** with PR-to-prod cycle time, experiment runtime, and conversion delta confidence.

## 2) Security/reliability consistency on critical mutation/auth paths

### Gaps observed
- Missing/uneven rate limiting on auth recovery endpoints.
- CSRF constant-time comparison edge-case previously identified.
- Idempotency middleware coverage is incomplete for non-JSON response paths.
- Some admin write paths lack abuse throttles and blast-radius controls.

### Recommended improvements
1. **Standardize a “critical mutation policy” middleware stack** for all write endpoints:
   - authn/authz check
   - CSRF validation
   - per-user + per-IP rate limits
   - idempotency key support
   - audit log with actor/resource/action/result
2. **Apply same throttling semantics across auth endpoints** (`sign-in`, `forgot-password`, `verify-email`, `reset-password`).
3. **Require idempotency keys for external side effects** (Stripe, email/SMS dispatch, reorder submissions).
4. **Implement explicit null/ownership guards** before database mutations or scoped reads (especially customer/account routes).
5. **Add mutation contract tests** that assert:
   - duplicate request handling,
   - CSRF rejection behavior,
   - rate-limit behavior,
   - deterministic error envelopes.

## 3) Lifecycle retention automation (reorder and reminder outcomes)

### Gaps observed
- Reminder scheduling has known invalid-date edge cases.
- Reorder experiences can silently degrade (e.g., archived prices disappearing) without clear user feedback.
- Outcome metrics are not fully closed-loop from reminder send → click → reorder completion.

### Recommended improvements
1. **Enforce defensive date validation before reminder eligibility math**.
   - Invalid or missing baseline dates should be quarantined with explicit reason codes.
2. **Surface reorder blockers explicitly to users and analytics**.
   - Return actionable conflict responses (e.g., unavailable items) instead of silently dropping line items.
3. **Introduce lifecycle state machine fields** for each patient/order cohort:
   - `eligible`, `notified`, `engaged`, `checkout_started`, `reordered`, `dropped`, `suppressed`.
4. **Add reminder orchestration guardrails**:
   - per-channel daily caps,
   - cool-down windows,
   - dedupe keys to avoid repeated sends on retries.
5. **Build a retention outcome scoreboard** by cohort and channel.
   - KPIs: reminder delivery, click-through, reorder conversion, median time-to-reorder, suppression reasons.

## 4) Operational safety and observability for admin-heavy workflows

### Gaps observed
- Admin mutation paths are high-power and need stronger abuse/safety controls.
- UI failure handling in admin areas can be brittle without consistent boundaries.
- Alerting and SLO-like visibility for admin operations is not uniformly defined.

### Recommended improvements
1. **Apply role-scoped rate limits and quotas on admin writes**.
   - Separate controls by operation class: patient data edits, outreach dispatches, billing/reorder actions.
2. **Require step-up confirmation for high-risk actions**.
   - Examples: bulk sends, reorder-on-behalf, status overrides, exports.
3. **Harden admin UX runtime safety**.
   - Wrap all admin route trees with error boundaries and resilient fallback states.
4. **Expand structured audit events into an ops timeline**.
   - Capture actor, target, previous/new values (where safe), request_id, outcome, and latency.
5. **Define operational SLOs + alerts**:
   - auth failure spikes,
   - reminder send failure rate,
   - webhook parse failures,
   - admin 5xx rate,
   - duplicate mutation detection rate.

## Suggested sequencing
1. **Week 1–2**: security/reliability baseline hardening on auth + mutation policies.
2. **Week 2–3**: lifecycle and reorder correctness fixes with explicit user-facing errors.
3. **Week 3–4**: conversion instrumentation unification and admin observability dashboards.
4. **Ongoing**: experiment cadence with measurable conversion and retention deltas.
