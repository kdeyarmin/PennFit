# Performance Review — PennFit (2026-06-05)

Whole-app performance review covering the Express API
(`artifacts/resupply-api`), the customer/admin SPA (`artifacts/cpap-fitter`),
the in-process pg-boss worker, and the Postgres/Supabase data layer.

## Executive summary

The codebase is, on the whole, **already performance-hardened**. The
request hot paths overwhelmingly use `Promise.all` for independent reads,
`{ count: "exact", head: true }` for counts, bounded `.limit()`/`.range()`,
cached client singletons (Supabase, Stripe, Anthropic/OpenAI), and TTL
in-process caches (product catalog, feature flags, app-config overlay,
chatbot prompt). Many worker jobs are model citizens — keyset pagination,
per-run caps, atomic claim-leases, DLQs.

The real problems are **concentrated and few**, and they cluster in three
places:

1. **Missing indexes on the hottest tables** (`patients`, `messages`,
   `conversations`) — the single largest scalability risk. Several
   high-traffic admin lists sort/filter on **unindexed** columns and pair
   that with `count: "exact"`, doubling the cost into two full scans per
   request.
2. **Worker sweeps that re-walk settled history every tick** — a handful
   of nightly jobs scan the entire active-patient roster with per-row
   N+1 queries and no "already done" watermark. These are the jobs most
   likely to start timing out first as the patient base grows.
3. **A few un-cached / un-batched fetch-everything paths** — the public
   `/shop` catalog (no react-query cache), the signed-in reorder
   suggestions (N+1 Stripe calls), the admin customer directory
   (fetch-all + sort in JS), and per-product review aggregates.

Nothing here is on fire today. Everything here gets **linearly worse** as
patients / messages / orders / reviews grow, so the value is in fixing it
before the volume arrives. None of the fixes are large refactors.

Severity legend: **CRITICAL** (unbounded scan of the largest tables on an
interactive path — fix first), **HIGH**, **MEDIUM**, **LOW**.

---

## 1. Database / indexes (highest leverage)

Index landscape surveyed from `lib/resupply-db/drizzle/*.sql` (378 index
definitions). Hottest tables by `.from()` frequency: `patients` (142),
`insurance_claims` (96), `conversations` (89), `shop_customers` (78),
`shop_orders` (66), `prescriptions` (39), `messages` (22).

> All `CREATE INDEX` below use `CONCURRENTLY` to avoid table locks. Per
> `CLAUDE.md`, `CONCURRENTLY` cannot run inside a transaction, so each must
> be authored as a standalone, non-transactional migration statement
> (there is existing precedent for a concurrent index build on `messages`).
> Confirm `pg_trgm` availability on the Supabase project before the
> trigram indexes (it is a standard extension; the "no extensions" note in
> `CLAUDE.md` is about the migrator's assumptions, not a hard ban).

### CRITICAL

- **`messages.body` leading-wildcard `ILIKE` search** —
  `routes/admin/conversations-search.ts:50` does
  `.ilike("body", '%term%').order("created_at", desc).limit(200)` with **no
  supporting index**. `%term%` can't use a btree → full sequential scan of
  the largest (highest-write) table on an interactive CSR path.
  Fix:
  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE INDEX CONCURRENTLY messages_body_trgm_idx
    ON resupply.messages USING gin (body gin_trgm_ops);
  ```
  (or a `tsvector` column + GIN + `websearch_to_tsquery`).

- **`patients` list orders by `created_at DESC` with no `created_at`
  index** — `routes/patients/list.ts:75`. The most-queried table's primary
  admin landing list does a full scan + top-N sort every page load, and
  `count: "exact"` forces a *second* full scan.
  ```sql
  CREATE INDEX CONCURRENTLY patients_created_at_idx
    ON resupply.patients (created_at DESC);
  CREATE INDEX CONCURRENTLY patients_status_created_idx
    ON resupply.patients (status, created_at DESC);
  ```

### HIGH

- **`messages` delivery-webhook lookups can't use the partial index** —
  `routes/sms/status-callback.ts:97` and `routes/email/sendgrid-events.ts:127`
  filter `vendor_metadata->>'twilio_message_sid'` /
  `...sendgrid_message_id` **without** a `direction='inbound'` predicate,
  but `messages_twilio_sid_inbound_uniq` is partial (`WHERE
  direction='inbound'`). Outbound delivery callbacks (the common, high-volume
  case) seq-scan `messages` on every Twilio/SendGrid webhook.
  ```sql
  CREATE INDEX CONCURRENTLY messages_twilio_sid_idx
    ON resupply.messages ((vendor_metadata->>'twilio_message_sid'));
  CREATE INDEX CONCURRENTLY messages_sendgrid_id_idx
    ON resupply.messages ((vendor_metadata->>'sendgrid_message_id'));
  ```

- **`conversations` queue: stale assignee index + unindexed sort** —
  `routes/conversations/list.ts:103-107` sorts by
  `escalated_at, sla_due_at, last_message_at, created_at` and filters
  `assigned_admin_user_id`, but the existing index is on
  `assigned_admin_clerk_id` (a **renamed/dead column** no query uses).
  ```sql
  CREATE INDEX CONCURRENTLY conversations_assignee_status_idx
    ON resupply.conversations (assigned_admin_user_id, status);
  CREATE INDEX CONCURRENTLY conversations_status_lastmsg_idx
    ON resupply.conversations (status, last_message_at DESC NULLS LAST);
  -- verify unused, then: DROP INDEX CONCURRENTLY conversations_assigned_admin_clerk_id_status_idx;
  ```

- **`inbox-counts` fires 7 `count: "exact"` per badge refresh, 2 on
  unindexed predicates** — `routes/admin/inbox-counts.ts:69-106` (also
  `dashboard/summary.ts`, `episodes/counts.ts`). `patient_documents
  .is("reviewed_at", null)` and `shop_customer_followups
  .is("completed_at", null).lt("due_at", now)` have no partial index.
  Runs on every admin nav.
  ```sql
  CREATE INDEX CONCURRENTLY patient_documents_unreviewed_idx
    ON resupply.patient_documents (created_at) WHERE reviewed_at IS NULL;
  CREATE INDEX CONCURRENTLY shop_customer_followups_open_due_idx
    ON resupply.shop_customer_followups (due_at) WHERE completed_at IS NULL;
  ```
  …and switch the badges to `count: "planned"` / a `head:true`
  `.limit(100)` "99+" style.

- **Pervasive `count: "exact"` + OFFSET pagination on hot lists** —
  `count: "exact"` appears in 60+ spots; the hot paginated lists combine
  it with `.range(offset, …)`: `patients/list.ts:73`,
  `conversations/list.ts:101`, `episodes/list.ts:154`,
  `storefront/admin.ts:99/268/381`, `admin/customers.ts:472`,
  `admin/fitter-leads.ts:119`. `count: "exact"` runs a second full
  aggregate over the *entire filtered set* per request; deep `OFFSET`
  walks+discards skipped rows. Switch list endpoints to
  `count: "planned"`/`"estimated"` ("~N"), reserve `exact` for small
  tables, and prefer keyset pagination for deep pages (the worker jobs
  already do this).

- **`messages` analytics scan** — `routes/admin/analytics.ts:123-127`
  `.eq("direction","inbound").gte("created_at",cutoff).limit(50000)` with
  no `(direction, created_at)` index. Add
  `messages_direction_created_idx (direction, created_at DESC)`; better,
  materialize the daily count.

- **`analytics-outreach-attribution` — leading-column mismatch + 3 exact
  counts** — `routes/admin/analytics-outreach-attribution.ts:82-104`.
  `clinical_outreach_log` filters `(status, created_at)` but is only
  indexed `(patient_id, created_at)`; `fulfillments` filters/sorts
  `created_at` with no such index.
  ```sql
  CREATE INDEX CONCURRENTLY clinical_outreach_log_status_created_idx
    ON resupply.clinical_outreach_log (status, created_at DESC);
  CREATE INDEX CONCURRENTLY fulfillments_created_at_idx
    ON resupply.fulfillments (created_at DESC);
  ```

### MEDIUM

- **Redundant index on `messages(conversation_id)`** —
  `0000_plain_bloodstorm.sql:202-203` defines both
  `messages_conversation_idx (conversation_id)` and
  `messages_conversation_created_idx (conversation_id, created_at)`; the
  single-column one is fully redundant (the composite is a covering
  prefix) and wastes write throughput on the hottest-insert table.
  `DROP INDEX CONCURRENTLY resupply.messages_conversation_idx;`

- **`episodes` overdue view** — `routes/episodes/list.ts:156-171` filters
  `status IN (...) AND due_at <= now` ordered by `due_at` with only
  separate single-column indexes. Add
  `episodes_status_due_idx (status, due_at)`.

- **`patients` search union on 4 unindexed text columns** —
  `patients/list.ts:95-97` `.or(...ilike '%x%'...)` on `pacware_id`,
  `legal_first_name`, `legal_last_name`, `email`. Seq scan per keystroke.
  Add `pg_trgm` GIN indexes (or one combined generated `search_text`
  column + GIN).

- **Per-request message-count over-fetch** — `routes/admin/customers.ts:549-553`
  selects all messages of a conversation to count them in JS; prefer a
  `head:true` count or a denormalized `message_count` on `conversations`.

### LOW

- **Dead/legacy indexes** from retired features (`phone_lookup` hmac index
  dropped in migration 0025; `audit_log_*` indexes whose readers now
  short-circuit per `CLAUDE.md`; the `assigned_admin_clerk_id` index).
  Verify against `pg_stat_user_indexes.idx_scan = 0` in production, then
  drop to reclaim write/storage overhead.

---

## 2. Worker / background jobs

Many jobs are already correctly bounded (`cart-abandonment-scan`,
`webhook-dispatcher`, `low-stock-alerts`, `prior-auth-expiry-sweep`,
`patient-documents-retention-sweep`, `recall-notifications-send`, the
paginated parts of `reminders.ts`). These are the reference patterns the
jobs below should be brought in line with.

### CRITICAL

- **`therapy-milestones.ts:237-295`** — re-scans the **entire** active
  roster (no per-run cap) and issues **2 serial queries per patient per
  night** (`patient_therapy_nights` + existing-milestone-kinds), including
  patients who already hold all 3 milestone rows (pure wasted work that
  grows forever). At 5k active patients that's ~10k serial round-trips in
  one tick — into pg-boss stall/re-claim territory.
  Fix: (a) watermark/skip patients with all 3 kinds; (b) batch the
  existing-kinds lookup with one `.in("patient_id", pageIds)`; (c) add a
  `PER_RUN_MAX` cap with stable ordering (pattern from
  `smart-triggers/evaluator.ts`); (d) bounded `Promise.all` pool for the
  per-patient night reads.

### HIGH

- **`lib/smart-triggers/evaluator.ts:109-208`** — loops up to
  `MAX_PATIENTS_PER_RUN = 5000` patients, 1–2 serial queries each, every
  night, re-evaluating the full 60-night window even when nothing changed.
  Add an incremental `nights.updated_at` watermark (only changed patients)
  + bounded concurrency.

- **`lifecycle-touchpoints.ts:298-308`** — anniversary pass does a per-
  candidate `MIN(night_date)` query (up to ~2000 serial round-trips on
  popular-date days), plus a per-candidate `shop_customers` opt-in lookup.
  Batch the opt-in check with one `.in("email_lower", […])`; denormalize a
  `first_therapy_night_date` column (or batch-fetch nights with one
  `.in()`).

- **`maintenance-nudges.ts:220-251`** — per-patient quiet-period check
  (redundant with the DB pre-filter at `:175`) + per-patient
  `patient_maintenance_log` full read, serially × 200. Drop the redundant
  check; batch the log read with `.in("patient_id", batchIds)`.

- **`therapy-fleet-alerts-scan.ts:226-230`** — selects **all** open
  `therapy_fleet_alerts` with no `.limit()` (grows with the patient base) +
  a per-patient 2-query outreach lookup. Scope the open-alerts read to
  detected/previously-open ids via `.in()`; batch the prefs lookups.

- **`fitter-conversion-attribution.ts:83-92`** — unbounded `public.orders`
  scan every hour (no `.limit()`); PostgREST silently caps at ~1000 →
  truncation *and* a full-window load. Add keyset pagination + a
  `created_at` watermark so attributed orders aren't re-scanned hourly.

### MEDIUM

- **`metrics-snapshot.ts:120-136` + `owner-digest.ts:225-254`** —
  aggregations done in JS over a full fetch. metrics-snapshot sums every
  paid order with **no pagination** → a busy day exceeds the 1000-row cap
  and **silently under-counts revenue** (a correctness bug caused by the
  in-JS approach). Move the sums to a Postgres RPC aggregate (the codebase
  already uses RPCs, e.g. `therapy_fleet_worklist`).

- **`bulk-campaign-tick.ts:351-353`** — `createSendgridClient()` is
  dynamically imported **and reconstructed per recipient**, and sends are
  fully serial. Hoist the client out of the loop; adopt the
  webhook-dispatcher bounded-concurrency pool.

- **`quarterly-therapy-summary.ts`, `deductible-reset-push.ts`,
  `lapsed-customer-winback.ts`, `metric-alerts-evaluator.ts`** — per-
  candidate gating queries (N+1), bounded only by soft caps. Batch the
  prefs/activity lookups via `.in()`.

---

## 3. Frontend SPA (`cpap-fitter`)

The app is **well-architected for code-splitting**: the admin console is
lazy-loaded per page, heavy libs (recharts, framer-motion, `@mediapipe`)
are isolated to their own chunks, the cart uses `useSyncExternalStore` (no
context re-render storms). **No CRITICAL findings** — no admin code leaks
into the storefront bundle, no multi-MB asset is bundled into JS. The
issues cluster in react-query defaults and one page that bypasses
react-query.

### HIGH

- **Global `QueryClient` has no default `staleTime` /
  `refetchOnWindowFocus`** — `src/App.tsx:391` `new QueryClient()`. Every
  query without an override inherits `staleTime: 0` +
  `refetchOnWindowFocus: true` → refetch storms on every remount, route
  revisit, and tab focus. One-line fix:
  ```ts
  new QueryClient({ defaultOptions: { queries: {
    staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 } } });
  ```
  Pages that need fresh-on-focus already opt in explicitly.

- **Near-static mask catalog refetches on every mount** —
  `pages/masks.tsx:40`, `pages/results.tsx:101` call `useListMasks()` with
  no `staleTime`. The Results page is on the critical fitting funnel; the
  redundant catalog refetch competes with the recommendation request.
  Covered by the global default above, or pass `staleTime: 5 * 60_000`.

- **Public `/shop` catalog bypasses react-query** —
  `pages/shop.tsx:161-212` uses `useState`/`useEffect`/`fetchShopProducts()`
  with no cache, re-downloading the full catalog on every `/shop` visit and
  not sharing with product-detail / cart pages. Review aggregates fire as a
  second sequential effect (`:366-379`) — a built-in waterfall. Move both
  into `useQuery` with a shared `["shop-products"]` key + multi-minute
  `staleTime`.

### MEDIUM

- **Grid images lack `loading="lazy"` + intrinsic dimensions** —
  `masks.tsx:137`, `cpap-masks*.tsx`, `stories.tsx:246`,
  `shop-wishlist.tsx:401`, `compare-tray.tsx:91,197` (cf. `shop.tsx:672`
  which does it right). Causes layout shift (CLS) and eager off-screen
  loads. Add `loading="lazy"` (except above-the-fold heroes) + `width`/
  `height` or an `aspect-ratio` wrapper.

- **Multi-MB source PNGs in `attached_assets/`** (3–4MB each). Not bundled
  into JS (only a 17KB logo is imported), but if any are served to users
  (OG/content) they're far too large. Convert to webp/avif at display size;
  confirm none are referenced by raw path.

### LOW

- `order-success.tsx` guard renders `null` during the async check (blank
  frame) — render `<RouteFallback />` instead. Two always-mounted polling
  hooks (`use-shop-messages-unread.ts`, `account-messages-section.tsx`) are
  correctly visibility-gated and cleaned up — no change needed.

---

## 4. Backend API (`resupply-api`)

This backend has clearly been through performance hardening already (see
the "clean" list at the end). The genuine findings are few.

### HIGH

- **N+1 Stripe `products.retrieve` on the signed-in dashboard** —
  `routes/shop/me-reorder-suggestions.ts:145-169` does one Stripe HTTP
  round-trip **per distinct product id** (up to 50), with **no cache** and
  using per-id `retrieve` instead of bulk `list({ ids })`. Worst external-
  latency offender in the request path. Replace with the bulk
  `stripe.products.list({ ids: slice, limit: 100 })` pattern + 60s name/
  category cache that `routes/shop/my-orders.ts:441-447` already uses.
  Collapses up to 50 calls → 1 (mostly cached).

### MEDIUM

- **Admin customer directory fetch-all + JS sort/paginate** —
  `routes/admin/customers.ts:157-176` (then `186-211`, `308-324`). With no
  search term it fetches **every** `shop_customers` row + **every order**
  for all of them, rolls up + sorts + paginates in JS though the client
  renders 25 rows. Push pagination to PostgREST (`.range()`/`.order()`) for
  the common sorts; RPC for the combos PostgREST can't express.

- **Per-product review aggregate re-scanned every page load** —
  `routes/shop/reviews.ts:319-333` fetches the `rating` column for **all**
  approved reviews of a product on every (public) product-page load, no
  `.limit()`, no cache. Cache with a short TTL, or denormalize a rating
  count/sum updated on approval, or use a Postgres aggregate RPC. At
  minimum add `Cache-Control` (the site-aggregate path already does).

- **Sequential independent queries on the reviews page** —
  `routes/shop/reviews.ts:301-324`: the verified-purchaser lookup and the
  aggregate scan are independent but `await` serially. Wrap in
  `Promise.all`.

- **50k-row JS aggregations on analytics routes** —
  `routes/admin/analytics.ts` (`resupply-kpis` `107-136`,
  `csr-productivity` `436`, `compliance-cohorts` `207-243`). Window-bounded
  and low-frequency (so contained), but the clearest candidates for
  Postgres RPC aggregation.

### LOW

- **Redundant full-body `JSON.stringify` + regex on `recommend` /
  `me-chat`** — `routes/storefront/recommend.ts:71-74`,
  `routes/shop/me-chat.ts:389-392` re-serialize the whole body and run two
  regexes *after* Zod already enforced strict shape + `.max()` lengths.
  Run the check only on the specific string fields, or drop it.

### Verified clean (no action)

Cached client singletons (Supabase `supabase-client.ts:32`, Stripe
`lib/stripe/config.ts:73`, Anthropic/OpenAI); TTL caches (product catalog,
feature flags `lib/feature-flags.ts`, chatbot prompt, order-history names);
`Promise.all` batching across `me-dashboard`, `me-export`, `me-chat`,
`admin/today`, `inbox-counts`, `conversations/detail+list`; count-only
paths using `{ count: "exact", head: true }`.

---

## 5. Cross-cutting (HTTP layer)

### MEDIUM

- **Content-hashed assets are served without `immutable` / long max-age** —
  `artifacts/resupply-api/src/app.ts:425`
  `express.static(SPA_DIST, { index: false, fallthrough: true })` sets no
  `maxAge`. Vite emits content-hashed filenames under `/assets/`, so they
  are safe to cache for a year, but with no `Cache-Control` the browser
  falls back to ETag/`Last-Modified` revalidation — a **conditional-GET
  round-trip per asset on every page load** (returns 304, but still a
  network RTT each). Set `immutable` long-cache for hashed assets only,
  keeping `index.html` and other non-hashed files (favicons, the
  `mediapipe/` model) on revalidation:
  ```ts
  app.use(express.static(SPA_DIST, {
    index: false,
    fallthrough: true,
    setHeaders(res, filePath) {
      if (filePath.includes(`${path.sep}assets${path.sep}`)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      }
    },
  }));
  ```
  (The existing history-fallback handler already sends `no-store` for
  `index.html`, so the build can roll forward safely.) On Railway there is
  no CDN in front by default, so the browser eats the full revalidation
  cost today.

---

## Prioritized roadmap

**Tier 1 — do first (small, high impact, low risk):**

1. Add the missing hot-table indexes: `patients(created_at)` +
   `(status, created_at)`; `messages` body trigram; `messages` vendor-sid
   expression indexes; `conversations` assignee/queue indexes;
   `inbox-counts` partial indexes. *(§1 CRITICAL+HIGH)*
2. Switch hot paginated admin lists from `count: "exact"` to
   `count: "planned"`. *(§1 HIGH)*
3. `QueryClient` default `staleTime`/`refetchOnWindowFocus`. *(§3 HIGH —
   one line)*
4. Static-asset `immutable` cache headers. *(§5 — one block)*
5. Fix `metrics-snapshot.ts` revenue under-count (RPC aggregate — this one
   is also a **correctness** bug past 1000 rows). *(§2 MEDIUM)*

**Tier 2 — meaningful, slightly larger:**

6. `therapy-milestones.ts` watermark + batch + cap. *(§2 CRITICAL)*
7. `smart-triggers/evaluator.ts` incremental watermark + concurrency.
   *(§2 HIGH)*
8. `/shop` catalog → react-query shared cache. *(§3 HIGH)*
9. `me-reorder-suggestions.ts` bulk Stripe + cache. *(§4 HIGH)*
10. `lifecycle-touchpoints.ts` / `maintenance-nudges.ts` batch the N+1
    lookups. *(§2 HIGH)*

**Tier 3 — opportunistic / as-convenient:**

11. Admin customer directory pagination to PostgREST/RPC. *(§4 MEDIUM)*
12. Review-aggregate caching + `Promise.all`. *(§4 MEDIUM)*
13. Analytics 50k-row JS aggregations → Postgres RPCs. *(§4 MEDIUM)*
14. Image `loading="lazy"` + dimensions; downsize source PNGs. *(§3 MEDIUM)*
15. Drop redundant/dead indexes after confirming `idx_scan = 0`. *(§1)*

---

*Reviewers: four parallel domain agents (API, DB/indexes, SPA, worker) plus
a manual HTTP-layer pass. All findings are pointed to specific `file:line`;
no files other than this report were modified.*
</content>
</invoke>
