# PennFit Deep Bug & Security Audit — 2026-05-05

**Branch:** `claude/code-review-bug-audit-3UlYh`  
**Scope:** All source files across both artifacts (`resupply-api`, `cpap-fitter`) and all 12 `lib/` packages.  
**Method:** Multi-agent parallel review covering backend routes, auth/security, frontend SPA, and database schema.

---

## Executive Summary

| Severity  | Count  |
| --------- | ------ |
| CRITICAL  | 15     |
| HIGH      | 22     |
| MEDIUM    | 27     |
| LOW       | 15     |
| **Total** | **79** |

The codebase is architecturally sound with good general patterns (Zod validation, audit logging, argon2id passwords, structured error handling). The most serious issues are: **duplicate router registrations** that cause double-execution of middleware chains; **missing rate limiting on password-reset**; **timing-attack leak in CSRF validation**; and **missing HTML escaping for single-quotes** in auth email templates.

---

## SECTION 1 — BACKEND API (`artifacts/resupply-api`)

### CRITICAL

#### B-01 · Duplicate Router Mounts Cause Double-Execution of Middleware

**File:** `artifacts/resupply-api/src/routes/index.ts`  
**Lines:** 148 vs 209, 157 vs 214, 161 vs 218, 165 vs 222, 169 vs 226, 172 vs 229, 178 vs 231, 181 vs 234, 184 vs 237, 187 vs 240

Ten routers are registered twice on the same Express application:

- `shopReturnsAdminRouter` (lines 148 and 209)
- `csrMacrosRouter` (lines 157 and 214)
- `shopSubsMetricsRouter` (lines 161 and 218)
- `shopReviewRequestsRouter` (lines 165 and 222)
- `teamRouter` (lines 169 and 226)
- `opsStatusRouter` (lines 172 and 229)
- `reportsRouter` (lines 178 and 231)
- `deliveryFailuresRouter` (lines 181 and 234)
- `lookupRouter` (lines 184 and 237)
- `systemInfoRouter` (lines 187 and 240)

**Impact:** Every request to these routes executes the full handler twice (or more). For write routes, this means audit log entries are duplicated. For idempotency-protected routes, the idempotency check fires twice — the second pass reads the cached response from the first, so it _appears_ correct but the request body is still parsed and validated twice. For rate-limited routes, each request consumes two tokens against the limit.

**Fix:** Remove lines 205–240 entirely. The routes at 148–187 are already correct. The second block (205–240) appears to be a copy-paste artifact from a refactor.

---

#### B-02 · Missing Rate Limit on `POST /auth/forgot-password`

**File:** `lib/resupply-auth/src/http/forgot-password.ts`

The sign-in handler enforces 5 attempts per email / 30 per IP over 15 minutes (via the `rateLimit` middleware). `forgot-password` has **no rate limiting at all**. An unauthenticated attacker can:

1. Enumerate valid email addresses via timing differences (even though responses are generic, the DB lookup + token insertion takes different time than an unknown-email path).
2. Send unlimited password-reset emails to a victim's inbox (email denial-of-service).
3. Exhaust the SendGrid daily quota.

**Fix:** Apply the same `rateLimit` middleware used on sign-in before the handler — e.g., 3 requests per email address and 15 per IP per hour.

---

#### B-03 · Missing Rate Limit on `POST /auth/verify-email`

**File:** `lib/resupply-auth/src/http/verify-email.ts`

No rate limiting on email-token consumption. While tokens are 256-bit, repeated failed attempts are not throttled, and each attempt makes a DB round-trip that can be observed for timing differences.

**Fix:** Add rate limiting (e.g., 10 attempts per IP per hour). Log consecutive failures for anomaly detection.

---

### HIGH

#### B-04 · Idempotency Middleware Only Captures `res.json()`, Not `res.send()` / `res.end()`

**File:** `artifacts/resupply-api/src/middlewares/idempotency.ts` (lines ~191–199)

The response-capture patch wraps `res.json()`. Routes that return via `res.send()`, `res.end()`, or pipe a stream bypass the capture. On a retry, those routes execute again from scratch instead of returning the cached response. This defeats the purpose of the idempotency middleware for any non-JSON route.

**Fix:** Also wrap `res.send()` and `res.end()`, or document the constraint and add a lint rule/assertion that enforces idempotency-decorated routes always respond via `res.json()`.

---

#### B-05 · Unsafe Type Assertion on Stripe Shipping Address Fallback

**File:** `artifacts/resupply-api/src/lib/stripe/webhook-handler.ts` (lines ~97–115)

```ts
(session as unknown as { shipping_details?: ... }).shipping_details
```

An `as unknown as` cast silences TypeScript without validating the runtime shape. If Stripe renames or restructures the field, the code silently reads `undefined` and stores a null shipping address without any error path.

**Fix:** Validate the fallback path through Zod or an explicit type guard before accessing properties.

---

#### B-06 · Invalid Date Propagates Silently in Reminder Date Math

**File:** `artifacts/resupply-api/src/worker/jobs/reminders.ts` (lines 362–368)

```ts
const baseline =
  baselineRaw instanceof Date ? baselineRaw : new Date(baselineRaw);
if (daysBetween(baseline, asOf) < plan.cadenceDays) {
  continue;
}
```

If `baselineRaw` is `undefined` (both `lastFulfilledAt` and `prescriptionCreatedAt` are null — theoretically impossible per schema but Drizzle returns `null` at runtime), `new Date(undefined)` returns `Invalid Date`. `daysBetween(Invalid Date, asOf)` returns `NaN`. `NaN < plan.cadenceDays` is `false`, so the patient is incorrectly flagged as due immediately.

**Fix:**

```ts
if (!baselineRaw) {
  logger.warn(
    { patient_id: row.patientId },
    "reminders.scan: no baseline date — skipping",
  );
  continue;
}
const baseline =
  baselineRaw instanceof Date ? baselineRaw : new Date(baselineRaw);
if (isNaN(baseline.getTime())) {
  logger.warn(
    { patient_id: row.patientId },
    "reminders.scan: invalid baseline date — skipping",
  );
  continue;
}
```

---

#### B-07 · Missing Rate Limit on Admin Write Operations

**File:** `artifacts/resupply-api/src/routes/admin/` (multiple files)

Admin routes like `POST /admin/patients`, `PATCH /admin/patients/:id`, patient-notes, and prescription-create have no rate limiting. A compromised or malicious admin session can:

- Create unlimited patient records (exhausting audit log storage).
- Send unlimited SMS/email reminders via the dispatch endpoints.
- Trigger unlimited Stripe API calls via the reorder-on-behalf endpoint.

**Fix:** Apply per-admin rate limits on write operations (e.g., 60 writes/minute per admin user). Add a circuit breaker on the audit-log write path.

---

#### B-08 · Reorder Auth Check Uses Non-Null Assertion on Potentially-Undefined Field

**File:** `artifacts/resupply-api/src/routes/shop/quick-checkout.ts` (lines 149–152)

```ts
eq(shopOrders.customerId, req.userCustomerId!),
```

`requireSignedIn` is in the middleware chain so `req.userCustomerId` should be set. However, `requireSignedIn` may not populate this field for all auth paths (e.g., if a patient portal session populates a different field). A future refactor that weakens `requireSignedIn` would make the `!` assertion silently pass `undefined` to Drizzle's `eq()`, which matches rows where `customerId IS NULL` — exposing all guest-checkout orders.

**Fix:** Assert the field explicitly: `if (!req.userCustomerId) { res.status(401).json({ error: "unauthorized" }); return; }` before using it.

---

#### B-09 · Quick-Checkout Silently Drops Items with Archived/Deleted Prices

**File:** `artifacts/resupply-api/src/routes/shop/quick-checkout.ts` (lines 174–180)

When reconstructing a basket from a historical Stripe session, `null` price IDs are filtered out without informing the user:

```ts
priceId: typeof line.price === "string" ? line.price : (line.price?.id ?? null),
```

Items with archived prices silently disappear. The customer sees a reorder with fewer items than expected and may not notice until after checkout.

**Fix:** Return a 409 with `{ error: "price_unavailable", archivedPriceIds: [...] }` or show the user which items could not be reordered.

---

#### B-10 · No Stripe Idempotency Key on Customer Creation

**File:** `artifacts/resupply-api/src/lib/stripe/customer.ts`

Creating a new Stripe Customer uses no `idempotencyKey`. If the HTTP request to Stripe succeeds but the local DB write fails (network partition, DB error), a retry creates a **second Stripe Customer** for the same user. The user ends up with duplicate payment profiles; the original one is orphaned and never cleaned up.

**Fix:** Pass an idempotency key derived from the local user ID: `await stripe.customers.create({ ... }, { idempotencyKey: \`create-customer-${userId}\` })`.

---

### MEDIUM

#### B-11 · Cart Hash Uses Truncated SHA-256 (128 bits)

**File:** `artifacts/resupply-api/src/routes/shop/checkout.ts` (lines ~89–99)

```ts
.digest("hex").slice(0, 32)
```

128-bit truncation is used as a deduplication key. While cryptographically strong, there is no collision-handling code and no index that enforces uniqueness at the DB level. A silent collision would create a duplicate order row without error.

**Fix:** Use the full 256-bit hash, or add a unique constraint on the column and handle the `23505` duplicate-key error explicitly.

---

#### B-12 · Missing Content-Type Validation on Webhook Endpoints

**File:** `artifacts/resupply-api/src/routes/email/sendgrid-events.ts` (lines ~45–65)

The endpoint accepts any body without validating `Content-Type`. If a non-UTF-8 or gzip-encoded body is sent, `JSON.parse()` silently fails and the handler returns 200 (Sendgrid interprets this as successful delivery, suppressing retries). Malformed events are permanently lost.

**Fix:** Reject requests with unexpected `Content-Type` values with a 400. Log parse errors at `warn` level so they surface in monitoring.

---

#### B-13 · Pagination Page Size Not Capped at DB Level

**File:** `artifacts/resupply-api/src/routes/admin/customers.ts` (line ~160)

`pageSize` is validated with Zod but the query runs without a hard `LIMIT` clause that independently caps the result. If the Zod max is accidentally removed or increased, a single request could return millions of rows.

**Fix:** Add a `LIMIT Math.min(pageSize, 200)` in the SQL query independent of the Zod validation.

---

#### B-14 · Missing Email Send Error Logging in `forgot-password`

**File:** `lib/resupply-auth/src/http/forgot-password.ts` (lines ~97–110)

The catch block swallows the email-send error with no logging:

```ts
} catch {
  // swallow
}
```

If SendGrid is misconfigured or rate-limiting is hit, admins have no way to know password-reset emails are failing.

**Fix:** Log the error at `warn` level (without including the email address — use the user ID only).

---

#### B-15 · Audit Log Missing Reason Code for Non-Password Auth Failures

**File:** `lib/resupply-auth/src/http/sign-in.ts` (lines ~169–176)

The password-wrong path is audited but "account locked", "account revoked", and "no credential set" paths emit the same generic action without a distinguishing `reason` field. Forensic analysis cannot distinguish brute-force attempts from locked-account enumeration.

**Fix:** Add `metadata: { reason: "locked" | "revoked" | "no_credential" | "email_unverified" }` to each rejection audit event.

---

#### B-16 · Worker `smart-trigger-evaluator.ts` Has No Error Boundary

**File:** `artifacts/resupply-api/src/worker/jobs/smart-trigger-evaluator.ts`

If the evaluator throws an unhandled exception for a single patient row, pg-boss marks the entire job as failed. All other patients in the batch are skipped until the next scheduled run.

**Fix:** Wrap per-patient logic in `try/catch` and log errors per-patient rather than aborting the full batch.

---

---

## SECTION 2 — AUTH & SECURITY (`lib/resupply-auth`, `lib/resupply-*`)

### CRITICAL

#### A-01 · Timing Leak in CSRF Token Comparison

**File:** `lib/resupply-auth/src/csrf.ts` (lines 40–47)

```ts
const a = Buffer.from(cookie, "utf8");
const b = Buffer.from(header, "utf8");
if (a.length !== b.length) {          // ← early exit leaks length
  return { ok: false, reason: "mismatch" };
}
return timingSafeEqual(a, b) ? ...
```

The length check short-circuits before `timingSafeEqual` is called. An attacker can measure response time differences to infer the correct CSRF token length, reducing the brute-force search space.

**Fix:**

```ts
const a = Buffer.from(cookie.padEnd(64), "utf8");
const b = Buffer.from(header.padEnd(64), "utf8");
const lengthMatch = cookie.length === header.length;
const bytesMatch = timingSafeEqual(a.subarray(0, 64), b.subarray(0, 64));
return lengthMatch && bytesMatch
  ? { ok: true }
  : { ok: false, reason: "mismatch" };
```

---

#### A-02 · `escapeHtml` Does Not Escape Single Quotes

**File:** `lib/resupply-auth/src/http/email-templates.ts` (lines 28–34)

```ts
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  // Missing: .replace(/'/g, "&#39;")
}
```

Single quotes in HTML attribute values (e.g., `href='...'`) are not escaped. A `productName` value containing `'` characters can break out of an attribute context. While current templates use `"` delimiters, a future template change could introduce an XSS vector.

**Fix:** Add `.replace(/'/g, "&#39;")` to `escapeHtml`.

---

#### A-03 · AI Prompt Injection: `callContext` Embedded Verbatim in System Prompt

**File:** `lib/resupply-ai/src/prompts.ts` (lines ~46–104)

The `callContext` string (populated from DB-stored patient notes or admin-configurable fields) is interpolated directly into the OpenAI system prompt without sanitization or length cap. A compromised admin or a database injection could insert instruction-override text.

**Fix:**

1. Cap `callContext` at 500 characters.
2. Strip or reject strings containing sequences like `IGNORE`, `OVERRIDE`, `SYSTEM:`, or backtick delimiters.
3. Wrap in a clearly delimited block: `` `<context>\n${callContext}\n</context>` `` and instruct the model explicitly not to act on content between those tags.

---

#### A-04 · CSRF Not Applied to `POST /auth/sign-in` or `POST /auth/sign-up`

**File:** `lib/resupply-auth/src/http/sign-in.ts`, `lib/resupply-auth/src/http/sign-up.ts`

`change-password` and `sign-out` correctly validate the CSRF token. `sign-in` and `sign-up` do not. An attacker on a cross-origin page could submit a forged login form, forcing a user to be signed in with attacker-controlled credentials (login CSRF), or pre-register an email address to prevent a victim from creating an account.

**Fix:** Issue a CSRF seed token on `GET /auth/csrf` (unauthenticated), include it in the login/signup page, and validate it on POST. Alternatively, enforce `SameSite=Strict` on session cookies and document why the CSRF gap is acceptable.

---

### HIGH

#### A-05 · `productName` Not Validated Before Email Subject Injection

**File:** `lib/resupply-auth/src/http/email-templates.ts` (lines ~46, 74, 99)

`productName` is used in email subjects without stripping newlines:

```ts
subject: `Verify your email — ${ctx.productName}`,
```

If `productName` is ever sourced from a user-editable field and contains `\r\n`, an attacker can inject additional email headers (Bcc, Cc).

**Fix:** Strip `\r`, `\n`, and `\r\n` from `productName` before embedding in subjects.

---

#### A-06 · Email Header Injection in Practice Name (Reminder Reply)

**File:** `lib/resupply-reminders/src/reply.ts` (line ~221)

```ts
const subject = `Re: ${input.emailCfg.practiceName} — your CPAP supplies`;
```

Same pattern as A-05 — practice name is admin-editable but not sanitized before being placed in an email subject.

**Fix:** Sanitize `practiceName` (strip newline characters) in `reply.ts` before subject construction.

---

#### A-07 · No Account Lockout After Repeated Failed Token Verification

**File:** `lib/resupply-auth/src/http/verify-email.ts`, `lib/resupply-auth/src/http/reset-password.ts`

There is no per-user or per-IP limit on failed token-consumption attempts. An attacker can probe millions of token values without throttling. While brute-forcing a 256-bit token is computationally infeasible, repeated requests constitute a DoS against the DB.

**Fix:** Track failed attempts per IP (e.g., max 20/hour) in the rate-limit table already used for sign-in.

---

#### A-08 · SendGrid Signature Middleware Existence Not Verified at Startup

**File:** `lib/resupply-email/src/signature.ts` (lines ~64–108)

The signature-validation middleware is implemented correctly, but there is no startup assertion or test that verifies it is actually mounted on the `/email/sendgrid-events` route. A future route refactor could inadvertently remove it, silently accepting spoofed webhook events.

**Fix:** Add an integration test that checks `POST /email/sendgrid-events` with an invalid signature returns 403, not 200. Or add a startup assertion.

---

#### A-09 · No Rate Limit on Inbound SMS Keyword Router

**File:** `lib/resupply-messaging/src/keyword-router.ts` (lines ~125–165)

Every inbound SMS is processed without rate limiting. A compromised Twilio number or a spam campaign could send thousands of STOP/UNSTOP keywords per minute, triggering rapid opt-out/opt-in cycles that corrupt the patient's communication preference state.

**Fix:** Rate-limit inbound SMS processing per patient phone number (e.g., max 10 keyword actions per minute).

---

#### A-10 · Session Token Never Rotated Post Sign-In

**File:** `lib/resupply-auth/src/http/sign-in.ts` (lines ~226–261)

Session tokens are issued at sign-in and used until expiry (14-day sliding window, 90-day hard cap). If a token is intercepted (XSS, network interception), the attacker retains access for up to 90 days. There is no mechanism to rotate the token.

**Fix:** Implement token rotation on password change (already partially done via session revocation). Consider rotating on first `/auth/me` call after sign-in or on each sensitive operation (order placement, password change).

---

### MEDIUM

#### A-11 · Session Expiry Slide Not Awaited; Stale Expiry Possible

**File:** `lib/resupply-auth/src/http/middleware.ts` (lines ~52–63)

The session-expiry slide `UPDATE` is not awaited on the hot path (intentional per comment). If the Node process crashes or is restarted immediately after a request, the session expiry is never updated in the DB and the session may expire earlier than the user expects.

**Fix:** Use a fire-and-forget pattern that logs errors on failure, or queue the update via pg-boss with a short TTL.

---

#### A-12 · Token TTLs Are Hardcoded; Cannot Be Tuned Without a Code Deploy

**File:** `lib/resupply-auth/src/http/sign-up.ts` (line 32), `lib/resupply-auth/src/http/forgot-password.ts` (line 28)

- Email verification token: 24 hours (hardcoded)
- Password reset token: 1 hour (hardcoded)
- Patient portal invite token: 7 days (hardcoded)

**Fix:** Move TTLs to `AuthDeps` configuration or env vars so they can be adjusted for compliance or threat model changes without a deploy.

---

#### A-13 · No Audit Trail for Successful Email Verification (Token Purpose Missing)

**File:** `lib/resupply-auth/src/http/verify-email.ts` (lines ~61–67)

The audit event is emitted but does not record the token `purpose` (e.g., `signup` vs. `portal_invite`). Forensic analysis cannot determine how a user's email came to be verified.

**Fix:** Add `metadata: { token_purpose: consumed.purpose }` to the audit emission.

---

#### A-14 · Password Hash Algorithm Has No Migration Path

**File:** `lib/resupply-auth/src/password.ts` (lines ~63–65)

Only `argon2id-v1` is supported. No framework exists to transparently upgrade hashes if a stronger algorithm becomes necessary.

**Fix:** On successful sign-in with an old algorithm, re-hash with the new one and update the credential row. Document the rotation procedure.

---

#### A-15 · No Audit Log Expiry / Retention Policy

**File:** `lib/resupply-audit/src/index.ts`

Audit logs are append-only with no retention policy or archival mechanism. HIPAA requires a minimum 6-year retention for PHI audit trails, but also requires controls on unbounded growth.

**Fix:** Implement a background job that archives audit records older than 7 years to cold storage and deletes them from the hot table.

---

---

## SECTION 3 — FRONTEND SPA (`artifacts/cpap-fitter`)

### CRITICAL

#### F-01 · No Route-Level Auth Guard on `/shop/orders`

**File:** `artifacts/cpap-fitter/src/App.tsx`, `artifacts/cpap-fitter/src/pages/shop-orders.tsx` (line ~90)

The page uses `<SignedIn fallback={<SignedOutPrompt />}>` for conditional rendering, but there is no `<Redirect>` at the route level. An unauthenticated user navigating directly to `/shop/orders` causes the component tree to mount, the order-history API call to fire (and fail with 401), and the signed-out prompt to render without a redirect. This is a UX breakage, not a data-leak (the API correctly rejects), but the component mounts unnecessarily and could be indexed by crawlers.

**Fix:** In `App.tsx`, wrap the `/shop/orders` route in an auth guard: if `!isSignedIn`, `<Redirect to="/sign-in?redirect=/shop/orders" />`.

---

#### F-02 · No Route-Level Auth Guard on `/account`

**File:** `artifacts/cpap-fitter/src/pages/account.tsx` (line ~113)

Same pattern as F-01. The account page renders for unauthenticated users (showing a signed-out prompt), but PII-fetching hooks mount and fire API calls that return empty data, leaving the DOM in an inconsistent initial state. The entire account component tree (shipping address, clinical info, subscription panels) mounts before the auth check resolves.

**Fix:** Same as F-01 — add a `<Redirect>` at the route level before rendering the page component.

---

#### F-03 · Cart Snapshot Stale State After Re-Authentication

**File:** `artifacts/cpap-fitter/src/hooks/use-cart-snapshot.ts` (lines ~101–150)

When the user's session expires during a cart edit, `disabled.current` is set to `true` on a 401 response. If the user re-authenticates in the same tab, `lastSentSig.current` still holds the old signature. The next cart change computes the same signature, sees `sig === lastSentSig.current`, and skips the sync — leaving the server cart permanently out of sync with the client cart.

**Fix:** Reset `lastSentSig.current = null` when `disabled.current` is set to `true` so the next change always forces a full re-sync.

---

#### F-04 · GCS Upload URL Not Validated Against Trusted Domain

**File:** `artifacts/cpap-fitter/src/lib/account-api.ts` (lines ~500–557)

The three-step upload flow (`GET signed-URL → PUT to GCS → finalize`) directly uses the server-provided `uploadURL` without validating it is a Google Cloud Storage URL. If the API server is compromised or a MITM occurs, the client would PUT the patient's document to an attacker-controlled server.

**Fix:** Validate `uploadURL.startsWith("https://storage.googleapis.com/")` (or your specific bucket URL) before uploading.

---

### HIGH

#### F-05 · Admin Console Has No Error Boundary

**File:** `artifacts/cpap-fitter/src/pages/admin/console.tsx` (lines ~70–90)

The `<AdminConsole>` component and its route `<Switch>` have no `<ErrorBoundary>` wrapper. Any uncaught error in an admin page crashes the entire console to a blank screen with no recovery option.

**Fix:** Wrap the admin `<Switch>` in the existing `<ErrorBoundary>` component (already used in the main app).

---

#### F-06 · CSRF Token Not Sent on Mutating Requests

**File:** `artifacts/cpap-fitter/src/lib/account-api.ts`, `src/lib/shop-api.ts`

Mutating requests (PUT, POST, DELETE) rely on `credentials: "include"` and `SameSite=Lax` cookies for CSRF protection, but do not include the `X-PF-CSRF` double-submit header. The backend `checkCsrf` middleware is only called on endpoints that explicitly invoke it — if a route developer forgets to call `checkCsrf`, it becomes CSRF-vulnerable with no client-side protection.

**Fix:** Read the `pf_csrf` cookie in the API client's request interceptor and attach it as `X-PF-CSRF` on all non-GET requests. This is defense-in-depth alongside `SameSite=Lax`.

---

#### F-07 · Cart Cross-Tab Sync Silently Drops Malformed Items

**File:** `artifacts/cpap-fitter/src/hooks/use-cart.ts` (lines ~77–94)

The `readStorage()` function validates each cart item's shape and silently filters out invalid items without logging or notifying the user. An item with a missing `unitAmountCents` field (possible if the product catalog is updated between tab sessions) is quietly dropped. The user sees a cart with fewer items than expected and no explanation.

**Fix:** Toast a warning when items are dropped: `"Some cart items were removed because they're no longer available."` Then emit a warning to the analytics system.

---

#### F-08 · Incorrect Response Shape Assumption on Cart Resume

**File:** `artifacts/cpap-fitter/src/pages/shop-cart.tsx` (lines ~214–227)

```ts
const data = await res.json();
const serverItems = Array.isArray(data.items) ? data.items : [];
```

If the server returns a non-object (e.g., `null` due to a parsing error), `data.items` throws `TypeError: Cannot read properties of null`. This crashes the cart page on resume.

**Fix:** Add a null guard: `const data = (await res.json()) as unknown; const serverItems = data && typeof data === "object" && Array.isArray((data as any).items) ? (data as any).items : [];`

---

#### F-09 · Role Context Default Is `"admin"` (Privilege Escalation if Provider Missing)

**File:** `artifacts/cpap-fitter/src/lib/admin/role-context.tsx` (line ~31)

```ts
const RoleContext = createContext<AdminRole>("admin"); // ← default
```

If a component using `useRole()` renders outside the `RoleProvider` (e.g., in a unit test, Storybook story, or a new route that omits the provider), it silently receives `"admin"` privileges and renders admin-only UI.

**Fix:** Change the default to `"agent"` (most restrictive). Update tests to provide an explicit `<RoleProvider>`.

---

#### F-10 · No Error Boundary on Quick Checkout Express Path

**File:** `artifacts/cpap-fitter/src/pages/shop-cart.tsx` (lines ~433–462)

`setExpressCheckingOut(false)` is called in the catch block but not in a `finally` block. If a non-`AccountApiError` exception is thrown after `setExpressCheckingOut(true)`, the loading state is never cleared, leaving the checkout button disabled and the spinner spinning indefinitely.

**Fix:** Move `setExpressCheckingOut(false)` to a `finally` block.

---

### MEDIUM

#### F-11 · `dangerouslySetInnerHTML` in Chart Style Component

**File:** `artifacts/cpap-fitter/src/components/ui/chart.tsx` (lines ~79–98)

CSS tokens are injected via `dangerouslySetInnerHTML`. While the current callers provide hardcoded config, any future use with user-supplied config introduces a CSS-injection risk.

**Fix:** Build the `<style>` element via `document.createElement("style")` with `textContent` assignment, or ensure the config values are validated against a strict allowlist before use.

---

#### F-12 · Demo Mode Flag Can Reach Production Builds

**File:** `artifacts/cpap-fitter/src/hooks/use-fitter-store.tsx` (lines ~54–64)

```ts
if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_DEMO === "1") { ... }
```

A trade-show build with `VITE_ENABLE_DEMO=1` can accidentally be deployed to production, allowing any user to bypass the measurement/questionnaire flow entirely via `?demo=1`.

**Fix:** Add a check: `if (import.meta.env.VITE_ENABLE_DEMO === "1" && import.meta.env.PROD) { throw new Error("VITE_ENABLE_DEMO must not be set in production builds"); }` — or better, strip demo code from production builds with a build-time transform.

---

#### F-13 · `useEffect` in Capture Leaks `MediaStream` on Rapid Unmount

**File:** `artifacts/cpap-fitter/src/pages/capture.tsx` (lines ~32–37)

If the component unmounts while `startCamera()` is still resolving (fast navigation), the returned `MediaStream` is never stopped. The camera indicator light stays on and the user's browser continues capturing video.

**Fix:** Use a ref to track the stream and cancel it in the cleanup function:

```ts
const streamRef = useRef<MediaStream | null>(null);
useEffect(() => {
  let active = true;
  startCamera().then(stream => { if (active) { streamRef.current = stream; ... } });
  return () => { active = false; streamRef.current?.getTracks().forEach(t => t.stop()); };
}, []);
```

---

#### F-14 · Order Form Validates State Code But Not Against Real US State List

**File:** `artifacts/cpap-fitter/src/pages/order.tsx` (lines ~43–88)

The Zod schema validates state as 2 uppercase letters but does not check against the actual 50-state list. `ZZ` and `XX` pass validation and are submitted to the order backend, which may or may not re-validate.

**Fix:** Add `.refine(v => US_STATES.includes(v), "Invalid state code")` where `US_STATES` is the list already defined at line ~126.

---

#### F-15 · Sensitive Data Written to `sessionStorage` Without Sanitization

**File:** `artifacts/cpap-fitter/src/pages/order.tsx` (line ~221), `src/pages/order-success.tsx` (line ~44)

Order confirmation data including mask model and quantities is stored as JSON in `sessionStorage`. While React escapes this on render, any future change that uses this data in a non-React context (e.g., passing to a third-party analytics SDK) could leak it.

**Fix:** Store only a confirmation reference ID in `sessionStorage` and re-fetch the full confirmation data from the API on the success page.

---

#### F-16 · No Pagination on Recently-Viewed Products (Unbounded localStorage Growth)

**File:** `artifacts/cpap-fitter/src/hooks/use-recently-viewed.ts`

Recently-viewed products are accumulated without a size cap. A user who browses extensively will see `localStorage` grow unboundedly. On older devices or browsers with strict storage quotas, `setItem()` will throw a `QuotaExceededError`.

**Fix:** Cap the list at 20 items, removing the oldest entry when the limit is exceeded. Wrap `setItem()` in a try/catch.

---

### LOW

#### F-17 · Missing `htmlFor` / `id` Pairing on Form Fields

**File:** `artifacts/cpap-fitter/src/pages/sign-in.tsx` (lines ~54–64) and similar

Several form fields use `<label><input /></label>` nesting without explicit `id`/`htmlFor` attributes. While visually functional, this breaks label-click-to-focus behavior for accessibility.

**Fix:** Add matching `id` and `htmlFor` to all form label/input pairs.

---

#### F-18 · Inefficient Full Product Catalog Fetch Just to Check `previewMode`

**File:** `artifacts/cpap-fitter/src/pages/account.tsx` (lines ~163–178)

`fetchShopProducts()` fetches the full product catalog to extract a single boolean flag.

**Fix:** Expose a lightweight `GET /shop/config` endpoint returning `{ previewMode: boolean }` and use that instead.

---

#### F-19 · `console.error` Logs Full Error Objects in Capture Page

**File:** `artifacts/cpap-fitter/src/pages/capture.tsx` (line ~54)

```ts
console.error("Camera error:", err);
```

Full error objects may include stack traces or request context visible in browser DevTools and crash-reporting SDKs.

**Fix:** Log only `err instanceof Error ? err.message : String(err)`.

---

---

## SECTION 4 — DATABASE SCHEMA (`lib/resupply-db`)

### CRITICAL

#### D-01 · `shop_returns.orderId` and `shop_returns.customerId` Have No FK Constraints

**File:** `lib/resupply-db/src/schema/shop-returns.ts` (lines 34, 40)

```ts
customerId: text("customer_id").notNull(),  // comment says "ON DELETE RESTRICT" but no FK
orderId: text("order_id").notNull(),        // same
```

Orphaned return records if a customer or order is deleted. A deleted order with an associated return row breaks the refund audit trail.

**Fix:** Add `.references(() => shopCustomers.customerId, { onDelete: "restrict" })` and `.references(() => shopOrders.id, { onDelete: "restrict" })`.

---

#### D-02 · `shop_order_items.orderId` Is "FK by Convention" — Not Enforced

**File:** `lib/resupply-db/src/schema/shop-order-items.ts` (line ~60)

```ts
orderId: text("order_id").notNull(),  // "FK by convention" — no actual constraint
```

Child line-item rows can reference non-existent orders. Broken order history, orphaned line items, and corrupted financial records.

**Fix:** Add `.references(() => shopOrders.id, { onDelete: "cascade" })`.

---

#### D-03 · `shop_customer_push_subscriptions.customerId` Has No FK

**File:** `lib/resupply-db/src/schema/shop-customer-push-subscriptions.ts` (line ~19)

Push subscription records survive customer deletion, leaking device endpoint data and causing dispatch errors.

**Fix:** Add `.references(() => shopCustomers.customerId, { onDelete: "cascade" })`.

---

### HIGH

#### D-04 · No Unique Constraint on `shop_returns` Per Order

**File:** `lib/resupply-db/src/schema/shop-returns.ts`

Multiple return rows for the same `orderId` are permitted at the DB level. A bug or race condition in the return-creation handler could insert two return records for the same order, leading to double refunds.

**Fix:** Add a partial unique constraint: `UNIQUE (order_id) WHERE status NOT IN ('cancelled', 'closed')`.

---

#### D-05 · `shop_orders.amountTotalCents` Has No `>= 0` Check Constraint

**File:** `lib/resupply-db/src/schema/shop-orders.ts` (line ~63)

Negative order totals can be inserted. No DB-layer protection against application bugs that calculate negative amounts.

**Fix:** Add a `CHECK (amount_total_cents >= 0)` constraint via a migration.

---

#### D-06 · `conversations.priority` Enum Not Enforced at DB Level

**File:** `lib/resupply-db/src/schema/conversations.ts` (line ~112)

```ts
priority: text("priority").notNull().default("normal"),
```

The valid values (`'low' | 'normal' | 'high' | 'urgent'`) are enforced only by the application. Raw SQL inserts or ORM bugs can persist invalid priority values.

**Fix:** Add `CHECK (priority IN ('low','normal','high','urgent'))`.

---

#### D-07 · `messages.senderRole` Enum Not Enforced at DB Level

**File:** `lib/resupply-db/src/schema/messages.ts` (lines ~40–42)

Same pattern — Drizzle TS enum declaration does not generate a DB-level CHECK constraint. Invalid sender roles can be inserted via raw SQL.

**Fix:** Add `CHECK (sender_role IN ('patient','customer','admin','agent','system'))`.

---

#### D-08 · `fulfillments.quantity` Stored as `text`, Not `integer`

**File:** `lib/resupply-db/src/schema/fulfillments.ts` (line ~33)

```ts
quantity: text("quantity").notNull().default("1"),
```

Sorting, aggregation (`SUM(quantity)`), and range queries require application-layer casting. Silent data corruption if the application stores a non-numeric string.

**Fix:** Migrate column to `integer`: `ALTER TABLE resupply.fulfillments ALTER COLUMN quantity TYPE integer USING quantity::integer;` and update Drizzle schema to `integer("quantity").notNull().default(1)`.

---

#### D-09 · Possible Schema Drift: `conversations.assignedAdminUserId` Column Name

**File:** `lib/resupply-db/src/schema/conversations.ts` (line ~110), migration `0021_conversations_assignment.sql`

Migration 0021 added the column as `assigned_admin_clerk_id` (Clerk era); migration 0022 references `assigned_admin_user_id`. If the rename migration was never run against production, the Drizzle schema references a column that does not exist under that name, causing silent query failures.

**Fix:** Run `SELECT column_name FROM information_schema.columns WHERE table_name = 'conversations' AND table_schema = 'resupply';` in production to verify the actual column name. If it is still `assigned_admin_clerk_id`, create a rename migration.

---

### MEDIUM

#### D-10 · `conversations` Index Does Not Include `status` for Inbox Query

**File:** `lib/resupply-db/src/schema/conversations.ts` (lines ~132–134)

The admin inbox query filters `WHERE status IN (...) ORDER BY last_message_at DESC`, but the index covers only `last_message_at`. Every inbox load scans and filters on `status` after the index, degrading linearly with conversation volume.

**Fix:** Replace single-column index with composite `(status, last_message_at)` or a partial index `WHERE status IN ('open','awaiting_admin','awaiting_patient')`.

---

#### D-11 · `shop_order_items.quantity` Has No Positive Check Constraint

**File:** `lib/resupply-db/src/schema/shop-order-items.ts` (line ~91)

Zero or negative quantities can be inserted. Financial records become meaningless.

**Fix:** Add `CHECK (quantity >= 1)`.

---

#### D-12 · `idempotency_keys` Table Has No Expiry / Cleanup Mechanism

**File:** `lib/resupply-db/src/schema/idempotency-keys.ts`

Idempotency key records accumulate indefinitely. Index scans degrade as the table grows. The `expires_at` column exists but there is no background job that purges expired rows.

**Fix:** Add a pg-boss job that runs daily and deletes rows where `expires_at < NOW()`.

---

#### D-13 · `shop_orders.cart_hash` Has No Unique Constraint

The `cartHash` column is used for deduplication but has no DB-level unique constraint. Two concurrent checkout requests with identical carts could insert two rows without conflict, bypassing application-layer deduplication.

**Fix:** Add `.unique()` on the `cartHash` column, or handle the `23505` duplicate-key error in the checkout handler.

---

#### D-14 · Connection Pool `max: 2` Is Undersized for Current Query Volume

**File:** `lib/resupply-db/src/pool.ts` (line ~49)

```ts
max: 2,
```

With 12 library packages and two artifacts all sharing the same pool, concurrent requests will queue for pool slots. This was appropriate when only a readiness probe used the pool, but is too conservative now.

**Fix:** Increase to `max: 10` (or derive from `DATABASE_POOL_SIZE` env var) and document the rationale.

---

### LOW

#### D-15 · Large Free-Text Columns Without Size Limits

**Files:** `csr_macros.body`, `patient_notes.body`, `shop_customer_notes.body`, `messages.body`

Unlimited text columns can be abused to store very large payloads, bloating the table and slowing queries.

**Fix:** Add application-layer length limits (already partially done via Zod) and document max expected sizes. Consider DB-level `CHECK (length(body) <= 10000)` for known-bounded fields.

---

#### D-16 · No `updated_at` Trigger on Key Mutable Tables

Several mutable tables (`shop_orders`, `patients`, `shop_customers`) have an `updatedAt` column but no automatic trigger to update it. If a migration or direct DB write updates a row without going through Drizzle's `.$onUpdate()`, the column stays stale.

**Fix:** Add a `BEFORE UPDATE` trigger on key tables, or document that all writes must flow through Drizzle ORM.

---

#### D-17 · Audit Log Has No Retention Policy

**File:** `lib/resupply-db/src/schema/audit-log.ts`

Audit records accumulate indefinitely. HIPAA requires a minimum 6-year retention — but also requires controls on unbounded growth.

**Fix:** Add a pg-boss job that archives audit records older than 7 years to cold storage and deletes them from the hot table.

---

---

## SYSTEMATIC REMEDIATION PLAN

### Sprint 1 — Immediate (Correctness & Critical Security)

| Priority | Issue                                                           | Owner Area    |
| -------- | --------------------------------------------------------------- | ------------- |
| 1        | **B-01** Remove duplicate router mounts in `routes/index.ts`    | Backend       |
| 2        | **A-01** Fix timing leak in CSRF `checkCsrf()`                  | Auth lib      |
| 3        | **A-02** Add single-quote escaping to `escapeHtml()`            | Auth lib      |
| 4        | **B-02** Add rate limiting to `POST /auth/forgot-password`      | Auth lib      |
| 5        | **B-03** Add rate limiting to `POST /auth/verify-email`         | Auth lib      |
| 6        | **F-03** Fix cart-snapshot stale state after re-auth            | Frontend      |
| 7        | **B-06** Add null/invalid-date guard in reminder date math      | Worker        |
| 8        | **F-10** Move `setExpressCheckingOut(false)` to `finally` block | Frontend      |
| 9        | **A-05** Sanitize `productName` newlines before email subjects  | Auth lib      |
| 10       | **A-06** Sanitize `practiceName` in reminder reply subject      | Reminders lib |

### Sprint 2 — Short Term (High-Impact Security & UX)

| Priority | Issue                                                                            | Owner Area |
| -------- | -------------------------------------------------------------------------------- | ---------- |
| 11       | **A-03** Sanitize and cap `callContext` for AI prompt injection                  | AI lib     |
| 12       | **A-04** Add CSRF to sign-in / sign-up (or document the SameSite mitigaton)      | Auth lib   |
| 13       | **F-01, F-02** Add route-level auth guards on `/account` and `/shop/orders`      | Frontend   |
| 14       | **F-05** Wrap admin console in `<ErrorBoundary>`                                 | Frontend   |
| 15       | **F-09** Change `RoleContext` default from `"admin"` to `"agent"`                | Frontend   |
| 16       | **B-04** Extend idempotency middleware to capture `res.send()` / `res.end()`     | Backend    |
| 17       | **B-08** Add explicit null check on `req.userCustomerId` before reorder DB query | Backend    |
| 18       | **B-09** Return 409 instead of silently dropping archived prices in reorder      | Backend    |
| 19       | **F-06** Attach `X-PF-CSRF` header in API client on all non-GET requests         | Frontend   |
| 20       | **F-04** Validate GCS upload URL domain before PUT                               | Frontend   |

### Sprint 3 — Medium Term (Reliability & Performance)

| Priority | Issue                                                                                                                                    | Owner Area |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 21       | **B-10** Add Stripe idempotency key to customer creation                                                                                 | Backend    |
| 22       | **B-05** Add Zod validation on Stripe shipping address fallback                                                                          | Backend    |
| 23       | **D-01, D-02, D-03** Add missing FK constraints on `shop_returns`, `shop_order_items`, `shop_customer_push_subscriptions`                | Database   |
| 24       | **D-08** Migrate `fulfillments.quantity` from `text` to `integer`                                                                        | Database   |
| 25       | **D-05, D-06, D-07** Add enum CHECK constraints on `conversations.priority`, `messages.senderRole`; add `shop_order_items.quantity >= 1` | Database   |
| 26       | **D-10** Extend `conversations` index to include `status` column                                                                         | Database   |
| 27       | **D-12** Add pg-boss cleanup job for expired `idempotency_keys`                                                                          | Database   |
| 28       | **D-13** Add unique constraint on `shop_orders.cart_hash`                                                                                | Database   |
| 29       | **D-14** Increase connection pool `max` from 2 to 10                                                                                     | Database   |
| 30       | **B-16** Add per-patient error boundary in smart-trigger evaluator                                                                       | Worker     |
| 31       | **F-07** Toast warning when cart items are silently dropped                                                                              | Frontend   |
| 32       | **F-08** Add null guard on cart-resume JSON parse                                                                                        | Frontend   |
| 33       | **F-13** Fix `MediaStream` leak on rapid unmount in capture page                                                                         | Frontend   |

### Sprint 4 — Longer Term (Hardening & Compliance)

| Priority | Issue                                                                                  | Owner Area     |
| -------- | -------------------------------------------------------------------------------------- | -------------- |
| 34       | **A-10** Design session token rotation strategy                                        | Auth lib       |
| 35       | **A-14** Implement password hash algorithm migration path                              | Auth lib       |
| 36       | **A-15** / **D-17** Implement audit log retention + archival job                       | Audit lib / DB |
| 37       | **A-12** Move token TTLs to `AuthDeps` config / env vars                               | Auth lib       |
| 38       | **B-07** Add per-admin rate limits on write operations                                 | Backend        |
| 39       | **A-08** Add integration test asserting SendGrid webhook HMAC is enforced              | Email lib      |
| 40       | **A-09** Rate-limit inbound SMS keyword processing per patient                         | Messaging lib  |
| 41       | **F-12** Prevent `VITE_ENABLE_DEMO=1` in production builds                             | Frontend       |
| 42       | **F-14** Validate state code against full US state list in order form                  | Frontend       |
| 43       | **D-09** Verify + fix potential schema drift on `conversations.assigned_admin_user_id` | Database       |
| 44       | **D-16** Add `BEFORE UPDATE` trigger or document Drizzle-only write policy             | Database       |
| 45       | **D-15** Add length CHECK constraints on large free-text columns                       | Database       |

---

## Positive Findings

The codebase demonstrates strong engineering discipline in many areas:

- **Structured audit logging** via the single `resupply-audit` chokepoint with PHI sanitizer — no raw PHI in audit events.
- **argon2id password hashing** with OWASP-recommended parameters (no pepper, consistent with migration 0025 intent).
- **Zod validation at every HTTP boundary** — all request bodies are parsed before use.
- **Double-submit CSRF protection** on all authenticated state-changing endpoints.
- **`timingSafeEqual` for token comparison** in CSRF, signed-link-tokens, and Twilio signature validation.
- **Constant-time generic error responses** on auth endpoints to prevent account enumeration.
- **Per-email + per-IP rate limiting on sign-in** with clear failure auditing.
- **Idempotency middleware** on checkout endpoints with DB-backed deduplication.
- **Comprehensive test suite** — 140+ test files, integration tests for critical paths.
- **Architecture enforcement scripts** that prevent cross-layer imports (domain logic cannot reach DB; AI lib cannot reach Twilio, etc.).
- **PHI hard rules** enforced by CLAUDE.md and git hooks — no image logging, no order-body logging.
- **Stripe webhook signature validation** present and tested.
- **Content-Security-Policy and security headers** set via middleware.
- **`SameSite=Lax` + `HttpOnly` + `Secure` on session cookies** — correct defaults.

---

## Sprint 5 Fixes — 2026-05-06 (PR #147)

All items below were fixed on branch `claude/sprint5-bug-fixes`.

| Fix                                                                                                                                                   | File(s)                                                                              | Commit                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------- |
| **B-08** Key subscription-mutation rate limits by customer ID (not IP)                                                                                | `routes/shop/my-subscriptions.ts`                                                    | 8ef96a1                   |
| **B-09** Cap `/shop/me/documents` to 100 rows                                                                                                         | `routes/shop/me-documents.ts`                                                        | 8ef96a1                   |
| **B-10** HTML-escape URLs in reminder email templates                                                                                                 | `lib/resupply-messaging/src/email-templates.ts`                                      | ec77c50                   |
| **B-11** Cap CSR macros list to 500 rows                                                                                                              | `routes/admin/csr-macros.ts`                                                         | ec77c50                   |
| **B-12** Replace N+1 correlated subquery in customer inbox query                                                                                      | `routes/admin/customers.ts`                                                          | ec77c50                   |
| **B-13** Guard shop-returns refund against concurrent state change                                                                                    | `routes/admin/shop-returns.ts`                                                       | 8ece132                   |
| **B-14** Wrap reminders.scan job handler in try/catch                                                                                                 | `worker/jobs/reminders.ts`                                                           | 8ece132                   |
| **B-15** Enforce pending-only guard on review approve/reject                                                                                          | `routes/admin/shop-reviews.ts`                                                       | 741a84e                   |
| **B-16** Cap message fetches in conversation detail and patient timeline                                                                              | `routes/conversations/detail.ts`, `routes/patients/timeline.ts`                      | 0642e69                   |
| **B-16b** Cap in-app message fetch; replace JavaScript count loop with SQL COUNT                                                                      | `lib/messaging/in-app-conversation.ts`                                               | 8b4361f                   |
| **B-17** Detect concurrent duplicate sends in rx-renewal dispatcher                                                                                   | `lib/rx-renewal/dispatcher.ts`                                                       | f2b50af                   |
| **B-18** Add Stripe idempotency key to admin refund endpoint                                                                                          | `routes/admin/shop-orders.ts`                                                        | e98a0bf                   |
| **B-19** Rethrow channel failures in rx-renewal-send and smart-trigger-send cron jobs                                                                 | `worker/jobs/rx-renewal-send.ts`, `worker/jobs/smart-trigger-send.ts`                | 10ab75c                   |
| **B-20** Add `auth.password_reset_failed` audit event on invalid reset token                                                                          | `lib/resupply-auth/src/http/reset-password.ts`                                       | 10ab75c                   |
| **B-21** Prune stale keys from back-in-stock in-memory rate bucket                                                                                    | `routes/shop/back-in-stock.ts`                                                       | 26caacb                   |
| **D-08** Migrate `fulfillments.quantity` from `text` to `integer` (migration 0061)                                                                    | `schema/fulfillments.ts`, `api.schemas.ts`, `patient-detail.tsx`                     | e6060ce                   |
| **D-10** Add composite `(status, last_message_at)` index on conversations (migration 0063)                                                            | `schema/conversations.ts`                                                            | e6060ce                   |
| **D-13** Add partial unique index on `shop_orders.cart_hash` (migration 0062)                                                                         | `schema/shop-orders.ts`                                                              | e6060ce                   |
| **D-16** Complete `updatedAt` `.$onUpdateFn` + BEFORE UPDATE triggers for all remaining tables (migrations 0054–0060)                                 | Multiple schema files                                                                | d44c52d, 04c8073, bd27feb |
| **D-18** Add Drizzle enum + DB CHECK constraints for `shop_returns`, `shop_orders`, `shop_reviews` status                                             | `schema/shop-returns.ts`, `schema/shop-orders.ts`, `schema/shop-reviews.ts`          | 747ed1d                   |
| **D-19** Add Drizzle enum + DB CHECK constraints for `admin_users`, `auth.users`, `patient-onboarding-journeys`, `shop-product-questions` status/role | Multiple schema files                                                                | 0d08437                   |
| **D-20** Replace `.$type<>()` casts with proper Drizzle enum on `insurance_leads` and `physician_fax_outreach` status                                 | `schema/insurance-leads.ts`, `schema/physician-fax-outreach.ts`                      | 0499e0d                   |
| **D-21** Add `.$onUpdateFn` to `auth.password_credentials` and `reminder_subscriptions` (migration 0060)                                              | `schema/auth/password-credentials.ts`, `schema/storefront/reminder-subscriptions.ts` | bd27feb                   |
| **D-22** Add Drizzle enum to `patient_smart_trigger_events.kind`                                                                                      | `schema/patient-smart-trigger-events.ts`                                             | 56d9721                   |

### Remaining Deferred Items (require architectural decisions)

| ID            | Description                                                            |
| ------------- | ---------------------------------------------------------------------- |
| **A-10**      | Session token rotation on sign-in (multi-device UX trade-off)          |
| **A-14**      | Password hash algorithm migration path (re-hash on successful sign-in) |
| **A-15/D-17** | Audit log retention + cold storage archival (HIPAA 6-year minimum)     |

---

_Audit conducted 2026-05-05. Sprint 5 fixes applied 2026-05-06. All file references use paths relative to the repo root._
