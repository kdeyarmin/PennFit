# Deferred from comprehensive app review (PR #1330)

Items intentionally left out of the insurance-only / tenant-branding /
provider-portal hardening merge. Tracked here so a follow-up PR can pick
them up without re-discovering scope.

## Still open

| Item                                                   | Why deferred                                                                   | Suggested next step                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Episode lifecycle factory has no production writer     | No live enqueue path; analytics read zeros                                     | Wire a single production writer or retire the readers     |
| Provider portal seed-org fallback on platform host     | Intentional for single-tenant Penn; full multi-tenant routing is architectural | Design host→org routing for provider SPA before changing  |
| Due math uses `MAX(shipped_at)` vs queued fulfillments | Needs product decision on “due” vs “dispensed”                                 | Spec + migration if queue time should count               |
| Chatbot PII scrub scope                                | Broader than this review’s surface                                             | Expand scrub allowlist with behavioral tests              |
| Platform billing payment wall                          | SaaS billing for tenants, not patient cash-pay                                 | Separate platform-billing epic                            |
| LTV including insurance claim dollars                  | UI already labeled historical shop-only                                        | New insurance LTV metric once claim dollars are trusted   |
| Back-in-stock auto-dispatch                            | Catalog copy fixed; automated dispatch soft-deferred                           | Opt-in dispatcher behind env flag when stock RPC is ready |

## Started in this follow-up

| Item                                                              | Status                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| Provider RTM roster `setupDate` truncated by PostgREST `max_rows` | Fixed: per-patient first-night lookup in `routes/provider/rtm.ts` |

## Already shipped in #1330 / #1332

- Tenant branding / `storefront-company-info` / `verify:deploy` Penn gate
- Cash-pay copy + redirects + retired feature-flag presets
- Provider portal org-scoped accounts, invite email rebind, auth `uiPathPrefix`
- Review-thread items (CI concurrency, batch NPI cache, CCPA export, reminder dedup release, NPS redirect order)
