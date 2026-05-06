# Mask Fitter UX + Reliability Design

## Objective
Improve the flagship mask fitter experience with primary goals:
1. Increase end-to-end completion rate.
2. Improve technical stability (camera/scan reliability).

Secondary goal: increase recommendation trust and confidence.

## Chosen Approach
Primary: **Flow compression + reliability guardrails**.
Secondary: selected **pipeline hardening** safeguards where low risk.

## Experience Architecture (4 stages)
1. **Prep check (15–30s)**
   - Camera permission check
   - Environment readiness checklist (lighting, distance, stable hold)
2. **Guided capture**
   - Real-time visual cues for framing/pose
   - Explicit readiness state before capture trigger
3. **Auto-validation + retry lane**
   - Evaluate capture quality and consistency
   - If quality is weak, present reason-specific retry guidance
4. **Results with confidence context**
   - Recommendation + brief “why this was selected” rationale
   - Confidence/status indicator
   - Recovery CTA when recommendation feels off

## Product Changes
- Simplify step language and progression UI to reduce confusion.
- Add “blocking issue” states for camera unavailable, denied permission, model unavailable, and low-confidence capture.
- Add deterministic retry guidance copy mapped to failure reason.
- Add trust microcopy describing how recommendations are derived and confidence limits.

## Technical Changes
### Frontend state model
- Add explicit capture lifecycle states:
  - `idle` → `checking_ready` → `ready` → `capturing` → `validating` → `success` / `retry_required` / `fatal_error`
- Add typed error reasons:
  - `permission_denied`, `camera_unavailable`, `model_not_ready`, `face_not_detected`, `low_confidence`, `unstable_capture`, `unknown`

### Reliability controls
- Require minimum confidence thresholds and frame consistency checks before advancing.
- Debounce transient frame failures to avoid flicker/jank.
- Add timeout + fallback messaging for stalled capture.

### Trust layer
- Emit structured “why recommended” attributes from existing measurement outputs.
- Display concise fit rationale and confidence status to users.

## Analytics
Track stage-level telemetry for completion + stability:
- `fitter_stage_viewed`
- `fitter_capture_started`
- `fitter_capture_retry_required` (with reason)
- `fitter_capture_succeeded`
- `fitter_recommendation_viewed`
- `fitter_recommendation_rejected`
- `fitter_flow_completed`

## Testing Plan
- Unit tests
  - Error-reason classifier mapping
  - State transition guards
  - Confidence threshold behavior
- Integration tests
  - Permission denied → recovery path
  - Model unavailable/stall → fallback messaging
  - Retry-required loop termination behavior
- E2E tests
  - Happy-path completion
  - Camera failure recovery
  - Low-confidence retry then success

## Rollout
- Ship behind a feature flag.
- Ramp traffic in phases and compare completion rate + reliability metrics.
- Roll back on regression in completion or failure-rate guardrails.

## Scope boundaries
- No major recommendation algorithm replacement in this phase.
- No unrelated shop/cart refactor.

