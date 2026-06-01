# Enabling automated alert dispatch

How to safely turn on the alert library's **automated** (server-side)
sends, and what to check before and after. Read this before flipping
`alerts.auto_dispatch` in production.

## What this controls

The alert library (`/admin/alerts`) has two modes:

1. **Manual send** — a staff member picks an alert + patient + channel
   on the Alert Library page and clicks send. This is **always on** and
   is **not** gated by the flag below.
2. **Automated send** — a server-side event fires an alert with no human
   in the loop. This is gated, off by default, by the
   **`alerts.auto_dispatch`** feature flag.

This runbook is only about mode 2. Turning the flag on is a policy /
patient-consent decision, not just a config flip — automated messages go
to real patients with no review step.

## What fires when the flag is ON

| Alert key           | Trigger event                                                                 | Channel | Source file                               |
| ------------------- | ----------------------------------------------------------------------------- | ------- | ----------------------------------------- |
| `payment_failed`    | Stripe `invoice.payment_failed` webhook (a Subscribe & Save renewal declines) | email   | `lib/alerts/payment-failed-trigger.ts`    |
| `low_usage_checkin` | The daily compliance scan opens a **new** `low_usage` CSR alert for a patient | email   | `lib/alerts/low-usage-checkin-trigger.ts` |

Notes:

- **`low_usage_checkin` fires once per episode of low usage**, not daily.
  The compliance scanner runs every day and refreshes the open CSR alert
  while the patient stays below target; the patient message goes out only
  the first time the alert is opened. A patient who recovers and dips
  again later gets a fresh alert → a fresh message.
- Both triggers are **fire-and-forget**: they run off the critical path
  (the Stripe webhook ACK, the compliance-scan loop) and never throw, so
  a SendGrid hiccup can't break the webhook or the scan.
- Other seeded alerts (`order_shipped`, `prescription_expiring`,
  `appointment_reminder`, …) are **deliberately not auto-wired** —
  those events already send their own notifications, so an alert there
  would double-send. They remain available for **manual** send.

## Dependencies (check before enabling)

| Requirement                        | Why                                                                                                                                                                   | How to verify                                                                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SendGrid configured                | Both auto-alerts send over email.                                                                                                                                     | `RESUPPLY_*` SendGrid vars set; a manual email-alert send succeeds.                                                                                                                     |
| `RESUPPLY_COACH_PHONE` set         | `low_usage_checkin` copy references `{{coach_phone}}`.                                                                                                                | `echo $RESUPPLY_COACH_PHONE` in the API env. **If unset, that alert is skipped** (logged), and the staff-facing CSR alert still fires.                                                  |
| `payment_failed` email reviewed    | This is the wording that goes to a patient whose card declined.                                                                                                       | Open `/admin/alerts` → `payment_failed` → email; edit copy if needed.                                                                                                                   |
| `low_usage_checkin` email reviewed | Same — clinical-tone check-in copy.                                                                                                                                   | Open `/admin/alerts` → `low_usage_checkin` → email.                                                                                                                                     |
| `update_payment_url` decision      | `payment_failed` email references it; if unset it renders as the literal `{{update_payment_url}}` token and **dispatch refuses to send** (unresolved-variable guard). | Either remove the token from the email body, or wire a billing-portal URL into the trigger. Until then, `payment_failed` auto-sends will no-op with an `unresolved_variables` log line. |

> The unresolved-variable guard is a safety feature: an alert with a
> `{{token}}` the trigger doesn't supply is **not sent** (it would ship a
> raw placeholder to a patient). So a missing variable fails _closed_ —
> nothing goes out — and logs `outcome: "unresolved_variables"`.

## Procedure

1. **Review the copy.** On `/admin/alerts`, open `payment_failed` and
   `low_usage_checkin`, read the **email** message for each, and edit if
   the wording isn't what you want patients to receive. (Editing requires
   the `admin.tools.manage` permission.)

2. **Set `RESUPPLY_COACH_PHONE`** in the deploy target's secret store if
   you want `low_usage_checkin` to send (Railway → service → Variables).
   Redeploy so the API picks it up. Skip this only if you intend to leave
   that alert disabled.

3. **Resolve `payment_failed`'s `update_payment_url`** (see the table
   above) — either drop the token from the email body or wire a URL —
   otherwise that auto-alert will no-op.

4. **Flip the flag.** Admin console → **Control Center**
   (`/admin/control-center`) → find **`alerts.auto_dispatch`** → toggle
   **on**. (Backed by `PATCH /admin/feature-flags/alerts.auto_dispatch`,
   gated by `admin.tools.manage`.) The flag is read with a 5-second cache,
   so the change takes effect within ~5 s across the API.

5. **Verify** (next section).

## Verifying after enable

- **Flag state:** Control Center shows `alerts.auto_dispatch` enabled, and
  the "Recent toggle activity" panel records who flipped it.
- **`payment_failed`:** the next real declined renewal logs
  `event: "payment_failed_alert_dispatched"` with `outcome: "ok"`. To
  force one in a non-prod environment, trigger a Stripe test
  `invoice.payment_failed` for a customer whose email matches a patient.
- **`low_usage_checkin`:** after the daily compliance scan, look for
  `event: "low_usage_checkin_dispatched"`, `outcome: "ok"`. A
  `reason: "no_coach_phone"` line means step 2 was skipped.
- **No-op outcomes are normal and safe** — `unresolved_variables`,
  `patient_not_found`, `messaging_not_configured`, etc. all mean "nothing
  was sent" and are logged, never thrown.

## Rolling back

Flip `alerts.auto_dispatch` **off** in the Control Center. Effect is
immediate (~5 s cache). Manual alert sends are unaffected. No data to
clean up — the flag only gates whether the triggers reach `dispatchAlert`.

## Where this lives in code

- Flag check: `isFeatureEnabled("alerts.auto_dispatch")` —
  `artifacts/resupply-api/src/lib/feature-flags.ts` (fail-closed: a DB
  read error reports the flag **disabled**).
- Triggers: `artifacts/resupply-api/src/lib/alerts/payment-failed-trigger.ts`,
  `…/low-usage-checkin-trigger.ts`.
- Dispatch + per-channel send + the unresolved-variable guard:
  `artifacts/resupply-api/src/lib/alerts/dispatch.ts`.
- Flag seed (off): `lib/resupply-db/drizzle/0181_alerts_auto_dispatch_flag.sql`.
