# Help Center coverage checklist

A feature ↔ help-article registry for the patient-facing Help Center
(`/help`). The structural half of this is enforced by
`artifacts/cpap-fitter/src/help.coverage.test.ts` (every routed `/help/*`
article must have an index card, and every index card must have a route);
this file is the editorial half — when a feature ships, decide its row
here and add the article in the same PR.

How to add an article: create `pages/help-<slug>.tsx` (use
`HelpArticleShell`), register the route in `App.tsx`, and add a topic
card in `pages/help.tsx`. The coverage test fails until all three exist.

## Patient-facing features

| Feature                                    | Help article                      | Status                                    |
| ------------------------------------------ | --------------------------------- | ----------------------------------------- |
| Virtual mask fitter                        | `/help/find-your-mask`            | Covered                                   |
| Ordering a recommended mask                | `/help/place-an-order`            | Covered                                   |
| Shop & checkout                            | `/help/shop-and-checkout`         | Covered                                   |
| Order tracking                             | `/help/track-your-order`          | Covered                                   |
| Account creation & sign-in                 | `/help/create-an-account`         | Covered                                   |
| Password reset                             | `/help/reset-password`            | Covered                                   |
| Resupply reminders (signup + manage links) | `/help/resupply-reminders`        | Covered                                   |
| Insurance estimates                        | `/help/insurance-estimate`        | Covered                                   |
| Returns, exchanges & comfort guarantee     | `/help/returns-and-refunds`       | Covered                                   |
| Wishlist & reorder                         | `/help/save-to-wishlist`          | Covered                                   |
| Auto-ship subscriptions                    | `/help/manage-subscriptions`      | Covered                                   |
| Payment methods & billing (Stripe portal)  | `/help/payment-methods`           | Covered                                   |
| Communication preferences, STOP, quiet hrs | `/help/communication-preferences` | Covered                                   |
| Document upload & required e-sign forms    | `/help/documents-and-forms`       | Covered                                   |
| Caregiver / designated contact             | `/help/caregiver-access`          | Covered                                   |
| Equipment registry & recall alerts         | `/help/equipment-and-recalls`     | Covered                                   |
| Phone ordering (AI voice assistant)        | `/help/order-by-phone`            | Covered                                   |
| In-account messages thread                 | —                                 | Gap (low: UI is self-describing)          |
| Referral program                           | —                                 | Gap (add when program is promoted)        |
| Appointment requests                       | —                                 | Gap (low: single form)                    |
| Apple Wallet pass                          | —                                 | Gap (low: feature-gated, self-describing) |
| Data export & privacy rights               | —                                 | Gap (privacy page covers contact path)    |
| NPS / post-delivery survey                 | —                                 | Gap (low: one-tap survey)                 |

Clinical/educational topics (cleaning, troubleshooting, travel, therapy
data) live under `/learn` and the chatbot knowledge base by design — the
Help Center stays task-oriented.

## Staff-facing guidance

| Surface                  | What it covers                                                        | Where                                          |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| PennPilot app map        | Every admin page, grouped as the sidebar                              | `adminAssistantKnowledge.ts` `APP_MAP_SECTION` |
| PennPilot workflows      | Find/work a patient, claims end-to-end, returns, flags, PacWare, KPIs | `WORKFLOWS_SECTION`                            |
| PennPilot best practices | Denial management, rule-tester safety, campaign etiquette, escalation | `BEST_PRACTICES_SECTION`                       |
| PennPilot runbook index  | Which `docs/runbooks/*` manual to use, and when                       | `RUNBOOKS_SECTION`                             |
| PacWare in-app how-to    | Condensed import/export steps on `/admin/pacware`                     | `admin-pacware.tsx` `HowToCard`                |
| Launch checklist         | Required env/integration setup with auto-detection                    | `/admin/account-setup`                         |
| Operator runbooks        | Launch, go-lives, key rotation, outage recovery                       | `docs/runbooks/`                               |

Known staff-side gaps (candidates for future PennPilot sections or
in-app cards): denial appeal letter writing, secondary-claim COB detail,
capped-rental modifier rotation explainer, inventory reorder-point
strategy, per-report interpretation notes on `/admin/reports`.
