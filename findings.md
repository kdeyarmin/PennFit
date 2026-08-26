# Findings — NEW high-confidence patient-facing bugs

## Scope

Hunt after already-fixed items (company-info, storefront-company-info,
push→track-order, help Orders tab, PHM track, education learn links,
/admin/orders redirect, global lookup PENN, chatbot shop-order-history).
Soft-deferred skipped (cost-transparency-callout, back-in-stock,
subscription-billing-notice).

## Prioritized findings (max 6)

### 1. P0 — Fitter campaign “resume” CTAs land on gated `/results`

**Where:**
- `artifacts/resupply-api/src/worker/jobs/fitter-supply-campaign.ts:963`
  (`resumeUrl = ${baseUrl}/results`)
- Same file T1/T2/T5/T6/T10 SMS+email bodies (e.g. `:540`, `:568`, `:551`)
- `artifacts/resupply-api/src/routes/shop/fitter-complete.ts:789`
  (`CTA_DESTINATIONS.results → /results`)
- Gate: `artifacts/cpap-fitter/src/App.tsx:790-796` (`GuardedResults`
  requires invite token + camera consent + in-memory measurements)

**Bug:** Email/SMS say “Pick up where you left off” / “Continue: …” but a
cold click (new device, cleared session, days later) hits
`/fitter-invite`, `/consent`, or `/` — never the saved recommendation.

**Fix:** Point `resumeUrl` and `CTA_DESTINATIONS.results` at a living
surface that works without fitter sessionStorage — e.g. `/contact` or
`/insurance` (or mint a signed lead-resume token that restores the fit).
Update SMS/email copy to match (“Contact us about your fit” / “Request
this mask through insurance”).

---

### 2. P0 — Quarterly summary email CTA hits auth-gated API (401 JSON)

**Where:**
- `artifacts/resupply-api/src/lib/order-emails/send-quarterly-summary-email.ts:120`
  (`fullSummaryUrl = …/resupply-api/shop/me/quarterly-summary`)
- Button `:178`
- Route: `artifacts/resupply-api/src/routes/shop/me-quarterly-summary.ts:45`
  (`requireSignedIn` → 401 JSON, no SPA sign-in redirect)

**Bug:** Primary CTA “Open the full summary” fails for anyone opening the
link without an existing `pf_session` cookie (typical from mail apps).

**Fix:** Point the button at `/account#therapy` (signed-in SPA) **or**
issue a short-lived signed token URL that serves the HTML without the
cookie gate. Keep the email body numbers as the offline fallback.

---

### 3. P1 — Comfort guarantee page still uses cash-pay “bought / purchased / payment” wording

**Where:** `artifacts/cpap-fitter/src/pages/comfort-guarantee.tsx:153-157`, `:171`

**Bug:** Patient-facing policy says masks were “bought from”, cushions
“purchased on their own”, and excludes “Returns started after 60 days
**from payment**” — patients are insurance-only; there is no patient
checkout payment to anchor the window.

**Fix:** Rewrite to insurance dispense language, e.g. “masks we supplied
/ dispensed to you”, “cushions ordered as a standalone supply”, and
“Returns started after 60 days from **delivery**” (matches the covered
window copy above on the same page).

---

### 4. P1 — Fitter nurture emails claim a “30-night” guarantee; site is 60-day

**Where:**
- `artifacts/resupply-api/src/worker/jobs/fitter-supply-campaign.ts:558`,
  `:566`, `:578`, SMS `:582`
- Canonical policy: `artifacts/cpap-fitter/src/pages/comfort-guarantee.tsx:28-57`

**Bug:** T2 subject/body/SMS promise a 30-night free swap; `/comfort-guarantee`
and chatbot knowledge promise **60 days**. Patients get conflicting
commitments.

**Fix:** Change campaign copy (and any other “30-night” strings in this
job) to “60-day comfort guarantee” to match the live policy page.

---

### 5. P1 — Fitter campaign still ships WELCOME15 / LAST20 “promo code” framing

**Where:**
- T4: `fitter-supply-campaign.ts:610-631` (default `WELCOME15` in subject,
  body, yellow code chip, SMS)
- T11: `:816-832` (default `LAST20`)

**Bug:** Defaults read as cash-pay discount codes (historical 15%/20% off).
Body says insurance-only, but the subject/SMS/chip still look like a
checkout promo — exactly the class of “promising patients can buy/pay”
confusion.

**Fix:** Drop promo-code UI. Use plain priority language (“Reply and we’ll
prioritize your insurance request”) or rename env defaults to non-discount
tokens (e.g. `FIT-PRIORITY`) and stop putting them in the email subject.

---

### 6. P2 — “Past / view your orders” copy after Orders tab retirement

**Where:**
- Home account card: `artifacts/cpap-fitter/src/pages/home.tsx:273-274`
  (“see past orders in one place”)
- Patient portal invite: `lib/resupply-auth/src/http/email-templates.ts:244`, `:251`
  (“view your orders”)
- Help already documents there is no in-account order list
  (`help-track-your-order.tsx`)

**Bug:** Account no longer has an Orders tab (`/account/orders` →
`/track-order`). Home + invite email still promise in-account order
history.

**Fix:** Replace with “track shipments at /track-order”, “view therapy &
statements”, or “message the care team” — align with current account tabs
(overview / therapy / messages / account).

---

## Explicitly not raised

- SPA `Accept: */*` — already code-fixed in `app.ts` (`starSlashStar` join).
- Footer/nav hrefs vs `App.tsx` routes — paths present (`/stories`,
  `/cpap-masks/*`, `/learn/*`, etc.).
- Soft-deferred items and already-shipped cash-pay CTA retargets.
- Speculative provider branding flash (depends on company-info fetch;
  overlay already fixed).
