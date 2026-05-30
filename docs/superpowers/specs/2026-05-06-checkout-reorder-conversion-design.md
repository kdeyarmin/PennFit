# Checkout/Reorder Conversion Improvement Design

## Goal

Improve checkout/reorder completion conversion, prioritizing returning users on the reorder flow.

## Success Metrics

- Primary: checkout/reorder completion rate.
- Secondary: step drop-off rate, form error rate, and time-to-complete checkout.
- Guardrails: no increase in refund/cancellation rates; no mobile performance regressions.

## Selected Approach

Combine:

1. Friction-first checkout optimization (primary)
2. Thin-slice smart reorder acceleration via prefill (secondary)

## Product Behavior Changes

1. Checkout step simplification
   - Keep required fields prominent and sequential.
   - Collapse optional details behind toggles.
2. Reorder prefill
   - For returning authenticated users, prefill cart from last eligible order.
   - Provide “Review previous order” UI with edit/remove controls.
3. Error prevention and recovery
   - Inline validation at field level.
   - Preserve state through transient failures.
   - Explicit retry for checkout session creation failures.
4. Trust cues near conversion CTA
   - Shipping ETA, return policy microcopy, secure payment reassurance.
5. Mobile conversion polish
   - Sticky CTA, clearer progress indicators, reduced scroll friction.

## Technical Design

### Frontend

- Introduce checkout flow state model: current step, field validity, pending/submitting, recoverable error states.
- Add reusable validation helpers and field-level error UI primitives.
- Add reorder-prefill adapter to map prior order payloads into current cart schema.
- Add SKU availability/fallback checks during prefill.

### Backend/API

- Preserve idempotent checkout session creation semantics for retries.
- Return structured, typed error codes to support deterministic client recovery UX.

### Analytics

Track:

- `checkout_started`
- `checkout_step_viewed`
- `checkout_error` (with error type/code)
- `reorder_prefill_applied`
- `checkout_completed`

## Testing Strategy

- Unit: validation helpers, prefill mapping logic, SKU fallback handling.
- Integration: checkout session retry behavior; backend error code mapping.
- E2E: returning-user reorder completion and mobile checkout completion scenarios.

## Rollout Plan

- Ship behind feature flag.
- Ramp exposure gradually.
- Compare KPI deltas against control cohort.
- Roll back flag on guardrail breach.

## Scope Boundaries (YAGNI)

- No broad redesign of unrelated pages.
- No new promotions/discount engine in this phase.
- No deep account system refactor.

## Risks and Mitigations

- Risk: stale or unavailable prior SKUs.
  - Mitigation: fallback substitutions + explicit user review state.
- Risk: over-validation causing friction.
  - Mitigation: validate early but keep messages concise and non-blocking until submit.
- Risk: analytics noise.
  - Mitigation: strict event naming and schema validation.
