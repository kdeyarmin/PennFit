# Progress

## 2026-08-26 — NEW storefront bug hunt (post already-fixed set)

### Done
- Parallel greps for `/shop|/cart|/checkout|/account/orders` CTAs,
  cash-pay copy, provider portal, footer/nav, email/SMS templates,
  SPA Accept
- Verified drift guards (`storefront-shop-links`, `storefront-cash-pay-copy`)
  catch many hrefs but miss campaign emails + comfort-guarantee wording
- Wrote 6 prioritized findings to `findings.md`

### Top findings (see findings.md)
1. Fitter campaign resume → gated `/results` (dead cold click)
2. Quarterly summary email → auth-gated API 401
3. Comfort-guarantee bought/purchased/from payment wording
4. Campaign “30-night” vs site 60-day guarantee
5. WELCOME15/LAST20 promo-code framing in nurture emails
6. Home + patient-invite “past/view your orders” after Orders tab gone

### Not found / skipped
- Accept `*/*` already fixed
- Soft-deferred: cost-transparency-callout, back-in-stock,
  subscription-billing-notice
- Already-fixed list from user query skipped
