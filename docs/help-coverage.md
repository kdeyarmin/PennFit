# Help Center coverage checklist

There are two Help Centers, with different audiences and different
mechanics:

| Help Center | Audience                     | Lives at           | Content source                          |
| ----------- | ---------------------------- | ------------------ | --------------------------------------- |
| Patient     | Customers on the storefront  | `/help`            | One `pages/help-<slug>.tsx` per article |
| Staff       | Operators inside the console | `/admin/resources` | Data in `src/content/admin-help/`       |

Both are editorially maintained here and structurally enforced by tests.

## Patient Help Center (`/help`)

The structural half is enforced by
`artifacts/cpap-fitter/src/help.coverage.test.ts` (every routed `/help/*`
article must have an index card, and every index card must have a route);
this file is the editorial half — when a feature ships, decide its row
here and add the article in the same PR.

How to add an article: create `pages/help-<slug>.tsx` (use
`HelpArticleShell`), register the route in `App.tsx`, and add a topic
card in `pages/help.tsx`. The coverage test fails until all three exist.

### Patient-facing features

| Feature                                    | Help article                      | Status                                 |
| ------------------------------------------ | --------------------------------- | -------------------------------------- |
| Virtual mask fitter                        | `/help/find-your-mask`            | Covered (guided scan + safety check)   |
| Ordering a recommended mask                | `/help/place-an-order`            | Covered                                |
| Shop & checkout                            | `/help/shop-and-checkout`         | Covered                                |
| Order tracking                             | `/help/track-your-order`          | Covered                                |
| Account creation & sign-in                 | `/help/create-an-account`         | Covered                                |
| Password reset                             | `/help/reset-password`            | Covered                                |
| Resupply reminders (signup + manage links) | `/help/resupply-reminders`        | Covered                                |
| Insurance estimates                        | `/help/insurance-estimate`        | Covered                                |
| Returns, exchanges & comfort guarantee     | `/help/returns-and-refunds`       | Covered                                |
| Wishlist & reorder                         | `/help/save-to-wishlist`          | Covered                                |
| Auto-ship subscriptions                    | `/help/manage-subscriptions`      | Covered                                |
| Payment methods & billing (Stripe portal)  | `/help/payment-methods`           | Covered                                |
| Communication preferences, STOP, quiet hrs | `/help/communication-preferences` | Covered                                |
| Document upload & required e-sign forms    | `/help/documents-and-forms`       | Covered                                |
| Caregiver / designated contact             | `/help/caregiver-access`          | Covered                                |
| Equipment registry & recall alerts         | `/help/equipment-and-recalls`     | Covered                                |
| Phone ordering (AI voice assistant)        | `/help/order-by-phone`            | Covered                                |
| In-account messages thread                 | —                                 | Gap (low: UI is self-describing)       |
| Referral program                           | —                                 | Gap (add when program is promoted)     |
| Data export & privacy rights               | —                                 | Gap (privacy page covers contact path) |
| NPS / post-delivery survey                 | —                                 | Gap (low: one-tap survey)              |

Clinical/educational topics (cleaning, troubleshooting, travel, therapy
data) live under `/learn` and the chatbot knowledge base by design — the
patient Help Center stays task-oriented.

## Staff Help Center (`/admin/resources`)

The operator-facing Help Center. Unlike the patient side, the content is
**data, not pages** — three modules under
`artifacts/cpap-fitter/src/content/admin-help/`, rendered by four thin
pages. That is what lets one search box span all three content types and
lets a test assert things about the prose itself.

| Surface               | Route                                   | Content module  |
| --------------------- | --------------------------------------- | --------------- |
| Hub (search + browse) | `/admin/resources`                      | —               |
| How-to guides         | `/admin/resources/how-to/<slug>`        | `how-tos.ts`    |
| Complete user guide   | `/admin/resources/user-guide#<section>` | `user-guide.ts` |
| FAQ                   | `/admin/resources/faq#<id>`             | `faq.ts`        |

How to add content: append an object to the relevant module. Routes are
already registered (`how-to/:slug` is a single param route), and the hub
and search pick it up automatically — no wiring step, unlike the patient
side.

`src/content/admin-help/admin-help.coverage.test.ts` enforces the
invariants. The important one: **every `/admin/...` path mentioned
anywhere in the content is cross-checked against the console's
`NAV_GROUPS`**, so a help article can never ship pointing at a page that
does not exist. Non-nav destinations go in that test's `NON_NAV_PATHS`
allowlist, which should stay short. It also checks slug/anchor
uniqueness, that `related` and `seeAlso` cross-links resolve, that every
category has at least one how-to, and that the routes are registered in
the order wouter's `<Switch>` needs.

Coverage today: **55 how-tos, 19 guide chapters, 59 FAQ entries.** A
how-to is written per _task_, not per page — many console pages are
covered as a step inside the guide for the workflow they belong to
(shipping labels inside "fulfill and ship", filing deadlines inside
"work the denials worklist", the analytics pages inside "find and read a
report"), so "no how-to whose `primaryPath` is this page" is not the
same as "undocumented".

The assistant knows this index. `adminAssistantKnowledge.ts` carries a
`HELP_CENTER_SECTION` listing every how-to slug and title, with the
instruction to summarize and hand over to the guide rather than retyping
a procedure it already covers — so the two do not become rival sources
of truth. `content/admin-help/assistant-index.sync.test.ts` enforces the
two lists match **in both directions**: a renamed slug there would send
operators to a 404, and a guide missing from it means the assistant
silently keeps improvising. It also fails if the knowledge base grows
past 90% of its system-prompt cap, so a growing index is caught in CI
rather than by every admin chat request failing in production.

Regenerating the index after adding a guide is mechanical — the test
names exactly which slugs are missing or stale.

No staff-help gaps are currently tracked. Two former ones are now
covered at the level the app actually supports: reorder points are
documented as the per-SKU low-stock threshold (`set-inventory-reorder-points`),
and capped-rental modifiers as _how to see which rule fired_
(`check-capped-rental-modifiers`) — deliberately not as a claimed
modifier sequence, since that is payer policy that changes and is not
the app's to assert.

## Other staff-facing guidance

| Surface                  | What it covers                                                        | Where                                          |
| ------------------------ | --------------------------------------------------------------------- | ---------------------------------------------- |
| PennPilot app map        | Every admin page, grouped as the sidebar — enforced, see below        | `adminAssistantKnowledge.ts` `APP_MAP_SECTION` |
| PennPilot workflows      | Find/work a patient, claims end-to-end, returns, flags, PacWare, KPIs | `WORKFLOWS_SECTION`                            |
| PennPilot best practices | Denial management, rule-tester safety, campaign etiquette, escalation | `BEST_PRACTICES_SECTION`                       |
| PennPilot runbook index  | Which `docs/runbooks/*` manual to use, and when                       | `RUNBOOKS_SECTION`                             |
| PacWare in-app how-to    | Condensed import/export steps on `/admin/pacware`                     | `admin-pacware.tsx` `HowToCard`                |
| Launch checklist         | Required env/integration setup with auto-detection                    | `/admin/account-setup`                         |
| Operator runbooks        | Launch, go-lives, key rotation, outage recovery                       | `docs/runbooks/`                               |

The PennPilot app map is now **enforced**, not just editorial:
`artifacts/cpap-fitter/src/components/admin/AppShell.assistant-app-map.test.ts`
fails when a page reachable from `NAV_GROUPS` has no mention in
`APP_MAP_SECTION`. Adding a sidebar entry therefore requires a line in
the knowledge base in the same change. It checks one direction only —
the map may still describe things that aren't nav entries (the
top-header Video visit button, the platform console, the
`/admin/email-inbox` redirect).

That guard exists because the drift was real and silent: 29 pages had
shipped with nav entries the assistant had never heard of — the whole
clinical-fitter suite (Fit review, Mask catalog, Formulary, Safety
screening), Front Desk, the referral reviewer and referral sources,
insurance discovery, ADR / audit response, audit readiness, collections,
chargeback disputes, billing notes, Office Ally, asset recovery, fitter
outcomes, the audit trail, message previews, reorder reminders, shipping
labels, and the per-tenant sending-identity settings pages. An operator
asking PennPilot "where do I review a fit?" was told it didn't exist.

Known staff-side gaps (candidates for future PennPilot sections or
in-app cards): denial appeal letter writing, secondary-claim COB detail,
capped-rental modifier rotation explainer, inventory reorder-point
strategy, per-report interpretation notes on `/admin/reports`.
