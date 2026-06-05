# Runbook: Activate the dormant growth & compliance jobs

Operator checklist for turning on the patient-outreach / sales jobs that
ship **built but OFF**. Companion to the analysis in
[`docs/growth-compliance-review-2026-06-05.md`](../growth-compliance-review-2026-06-05.md)
— that doc explains _what_ each lever is; this one is the _how_.

> **Before flipping anything that contacts patients:** confirm (a) the
> patient population's **consent** for the channel (marketing opt-in /
> transactional via `communication_preferences`), and (b) the relevant
> **vendor BAA** (Twilio for SMS, SendGrid for email). The jobs are off
> by design — each is a deliberate go-live. Turn on **one at a time** and
> watch the result before the next.

There are two switch types:

- **Runtime feature flags** — flipped in the admin **Control Center**
  (`/admin/feature-flags`); effective within ~5 s, **no deploy**.
- **Boot env-var gates** — set on **Railway** (Service → Variables);
  effective on the **next deploy** (Railway redeploys on a variable
  change automatically).

---

## A. Already done (no action)

These DB feature flags were set explicitly on 2026-06-05 (consent/BAA
confirmed by the owner): `reminder_escalation.dispatcher`,
`storefront.auto_reminder_enrollment`, `therapy_fleet.auto_outreach` —
all **ON**. The order-time guards `resupply.entitlement_enforcement`,
`resupply.eligibility_enforcement`, and `alerts.auto_dispatch` were set
explicitly **OFF** (their intended default). Nothing to do here unless
you want to change those decisions in the Control Center.

---

## B. Boot env-var gates to flip on Railway

For each: **Railway → the `resupply-api` service → Variables → New
Variable**, set the value, save (Railway redeploys). Verify with the
"check" line after the deploy goes live.

### B1. Failed-order-email recovery digest (pure upside — start here)

Recovers orders whose confirmation email silently failed. Internal email
only (no patient contact) — **no consent/BAA gate**.

- [ ] Set `RESUPPLY_FAILED_EMAIL_DIGEST_ENABLED=1`
- [ ] Set `RESUPPLY_ADMIN_ALERTS_EMAIL=<ops inbox>` (required recipient)
- **Job:** `failed-order-emails-digest` (daily 13:00 UTC)
- **Check:** the ops inbox receives a digest (or a "0 failures" run shows
  in logs as `event: failed_order_email_digest`).

### B2. Cart-abandonment auto-sweep (sales)

Hourly nudge to patients who left a cart. Patient email — **consent-gated
by `communication_preferences.emailMarketing`** (the shared dispatcher
suppresses non-consented + DND + 24 h cooldown).

- [ ] Consent + SendGrid BAA confirmed
- [ ] Set `RESUPPLY_CART_ABANDONMENT_CRON_ENABLED=1`
- **Job:** `cart-abandonment-scan` (hourly :13). (Without it, abandoned
  carts are nudged only when a CSR clicks "send due" in admin.)
- **Check:** `/admin/shop/abandoned-carts` shows `reminded_at` stamps
  advancing.

### B3. Fitter supply campaign (sales)

6-touch post-fitting supply nurture. Patient email — **consent-gated**.
Note: its runtime flag `fitter_supply_campaign.dispatcher` is already ON;
this env gate is the second lock.

- [ ] Consent + SendGrid BAA confirmed
- [ ] Set `RESUPPLY_FITTER_SUPPLY_CAMPAIGN_ENABLED=1`
- **Jobs:** `fitter-supply-campaign` + `fitter-conversion-attribution`.
- **Check:** `/admin/analytics/outreach-attribution` (once #506 ships) or
  the fitter-leads list shows touches advancing.

### B4. Proactive clinical outreach (compliance + nurture)

Non-adherence clinical nudges on a schedule you choose. Patient SMS/email
— **consent-gated**; respects the 14-day `clinical_outreach_log`
cooldown.

- [ ] Consent + Twilio/SendGrid BAA confirmed
- [ ] Set `CLINICAL_OUTREACH_CRON="0 15 * * *"` (example: daily 15:00 UTC;
      any 5-field cron)
- **Job:** `clinical-outreach-batch`.
- **Check:** `clinical_outreach_log` gains `status='sent'` rows.

### B5. Eligibility re-verification batch (compliance + billing)

Emits outbound 270s so coverage lapses surface before denials. No patient
contact, but it sends EDI to the clearinghouse — confirm Office Ally is
configured first.

- [ ] Office Ally credentials configured (not stub mode)
- [ ] Set `ELIGIBILITY_REVERIFY_CRON="0 9 * * 1"` (example: Mondays 09:00
      UTC)
- **Job:** `eligibility-reverify-batch`.

### B6. Prescription-renewal auto-draft (compliance + billing)

Pre-drafts Rx-renewal packets for Rxs expiring ≤ 30 days. **Does not
auto-fax** — a CSR still reviews and sends. No patient contact.

- [ ] Set `RESUPPLY_PRESCRIPTION_AUTO_DRAFT_ENABLED=1`
- **Job:** `prescription-request-auto-draft` (daily 13:43 UTC).
- **Check:** draft `prescription_request_packets` appear for the CSR.

---

## Recommended order

1. **B1** (internal only — zero patient-contact risk).
2. **B6**, **B5** (compliance/billing; no patient messages).
3. **B2**, **B3** (sales email — after consent/BAA sign-off).
4. **B4** (clinical SMS/email — the most sensitive; last).

Flip one, let it run a cycle, confirm the "check" line and that CSR alert
/ unsubscribe volume looks sane, then proceed.

---

## Rollback

Every switch is reversible: blank the env var (Railway redeploys) or flip
the flag off in the Control Center. No data migration is involved; the
jobs simply stop enqueuing new work. In-flight messages already handed to
Twilio/SendGrid are not recalled.
