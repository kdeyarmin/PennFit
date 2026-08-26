# Task Plan: High-Confidence Storefront Bug Hunt

## Goal

Find max 6 NEW high-confidence patient-facing storefront bugs in
`artifacts/cpap-fitter` + `artifacts/resupply-api`. Skip already-fixed
items and soft-deferred items.

## Already fixed (skip)

- company-info caching/brand overlay
- /api/storefront-company-info
- push URLs to /track-order
- help Orders tab lies
- PHM track accept
- education learn links
- /admin/orders redirect
- global lookup PENN refs
- chatbot shop-order-history guidance

## Soft deferred (skip)

- cost-transparency-callout
- back-in-stock
- subscription-billing-notice

## Phases

### Phase 1: Parallel greps for dead paths + cash-pay

- [x] Grep /shop /cart /checkout /account/orders CTAs
- [x] Grep cash-pay / buy / purchase / pay wording patient-facing
- [x] Grep provider portal routes + branding
- **Status:** complete

### Phase 2: Footer/nav/FAQ/learn + templates

- [x] Inventory patient SPA routes vs hrefs
- [x] SMS/email template dead paths
- [x] SPA Accept */*
- **Status:** complete

### Phase 3: Verify + prioritize max 6

- [x] Confirm each finding is live bug with file:line + concrete fix
- [x] Write findings.md; update progress
- **Status:** complete

## Errors Encountered

| Error | Attempt | Resolution |
| ----- | ------- | ---------- |
|       |         |            |
