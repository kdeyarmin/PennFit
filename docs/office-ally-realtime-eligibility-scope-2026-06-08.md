# Scope — real-time eligibility (270/271) transport for Office Ally

> **Update (post-merge):** the transport was reworked from the CAQH CORE
> **SOAP** envelope this doc describes to Office Ally's actual **EDI REST
> API** (`edi.officeally.io`) — `POST /v1/realtime-eligibility/x12` with the
> raw X12 270 as `text/plain` and an API-key `Authorization` header,
> returning the raw 271. The transport boundary (`build270` → POST →
> `parse271`, fail-soft) is unchanged; only the wire protocol differs. The
> CORE/SOAP details below are historical. See the go-live runbook for the
> current shape.

**Status:** Implemented behind optional config — the real-time transport
ships fail-soft, gated on `OFFICE_ALLY_REALTIME_*`. With the env unset,
behavior is unchanged (SFTP submit-and-poll). The remaining work is
**vendor-side certification** (see Blockers). This doc records the original
design; the REST rework is noted above.
**Audience:** Penn Home Medical Supply operator + reviewers.
**Date:** 2026-06-08.

## TL;DR

The one Office Ally capability worth wiring a real-time API for is
**eligibility (270/271)**. Today PennFit submits the 270 over SFTP and a
15-minute worker poll picks up the 271 — so a coverage check takes
**minutes**. Office Ally is CAQH CORE-certified for **real-time** 270/271
over an HTTPS/SOAP web service; calling that instead would return the 271
**in the same request (seconds)**.

This is a **contained, additive** change because the codebase already
cleanly separates the EDI builders/parsers (transport-independent) from
the transport. The 270 builder and 271 parser are reused as-is; we add
one new synchronous transport and one branch in the verifier. **Claims
(837P), remits (835), and the inbound poller are untouched** — batch is
the right shape for those.

The **one true blocker** is vendor-side: we need Office Ally's real-time
eligibility companion guide (endpoint URL, auth scheme, request/response
envelope) and a real-time-enabled account. Without that spec the wire
format can't be written correctly. Everything on our side is ready.

## Why eligibility specifically (and not claims)

What you can exchange with Office Ally is defined by the X12 **transaction
set**, which is identical over SFTP batch or the real-time API. So the API
buys **latency**, not new capabilities — and latency only matters where a
human is waiting:

| Transaction          | Human waiting?                                           | Real-time worth it?                                  |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| 270/271 eligibility  | **Yes** — CSR/intake checks coverage at point of service | **Yes — the whole point of this scope**              |
| 276/277 claim status | Sometimes                                                | Nice-to-have; same transport pattern, easy follow-on |
| 837P claims          | No — fire-and-forget                                     | No. Submission is batch by nature                    |
| 835 remits           | No — arrive when the payer pays                          | No. Intrinsically asynchronous                       |

## Current flow (verified against the code)

1. `POST /admin/patients/:id/insurance-coverages/:coverageId/verify-eligibility`
   → `verifyEligibility()` in
   `artifacts/resupply-api/src/lib/billing/eligibility-verifier.ts`.
2. It builds the 270 (`build270`), uploads it via the **SFTP** transport
   (`createSftpTransport`), and inserts an `eligibility_checks` row with
   `status='submitted'`. **The 271 is not inline.**
3. The 15-minute worker poll
   (`artifacts/resupply-api/src/worker/jobs/office-ally-inbound-poll.ts`)
   lists Office Ally's outbound dir, downloads new files, classifies them,
   and `dispatch271()` matches the 271 back to the check by ISA control
   number, flips the row to `status='parsed'` with the benefit fields, and
   fires an `eligibility.completed` webhook.

> Note: the header comment in `eligibility-verifier.ts` says the 271
> poller dispatch is a "follow-up" — that's **stale**. `dispatch271` is
> fully implemented (`office-ally-inbound-poll.ts`). The verifier comment
> should be corrected in the implementation PR.

End-to-end latency = (Office Ally's batch turnaround) + (up to 15 min of
poll lag). Real-time collapses this to one HTTPS round-trip.

## What's already reusable (the reason this is contained)

The integration package keeps EDI **content** separate from **transport**.
All of this is transport-independent and reused unchanged:

| Piece                                  | Location                                               | Role in the real-time path                   |
| -------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| `build270()`                           | `lib/resupply-integrations-office-ally/src/edi/270.ts` | Builds the exact same 270 payload we'd POST  |
| `parse271()` → `Parsed271`             | `.../edi/parse-271.ts`                                 | Parses the synchronous 271 body — no changes |
| `allocateControlNumbers()`             | `.../edi/control-numbers.ts`                           | ISA13 allocation, unchanged                  |
| 271 → `eligibility_checks` row mapping | currently inline in `dispatch271()`                    | **Extract + share** (see below)              |

The transport contract today is `SubmissionTransport`
(`.../transport/types.ts`): `upload(req) → UploadOutcome`. That's
**fire-and-forget** — it returns a session/path, never a response body.
Real-time eligibility needs a request that **returns the 271**, so it
warrants a sibling contract rather than overloading `upload`.

## Proposed design

### 1. New transport contract (request → response body)

```ts
// transport/types.ts (add)
export interface EligibilityRealtimeTransport {
  readonly kind: "soap" | "https" | "noop";
  /** Send a 270 envelope, get the 271 (or a caller-safe failure). */
  requestEligibility(req: { payload: string }): Promise<
    | { ok: true; payload271: string; sessionId: string | null }
    | {
        ok: false;
        kind: "auth_failed" | "connect_failed" | "rejected" | "unavailable";
        message: string;
      }
  >;
}
```

### 2. New transport implementation

`transport/realtime.ts` — wraps Office Ally's real-time web service
(HTTPS POST of the X12/SOAP envelope, parse the 271 out of the response).
Mirrors the existing fail-soft pattern: missing config → a `"noop"`
transport whose `requestEligibility` returns `{ ok: false, kind:
"unavailable" }`, so a missing key never throws at boot.

**This is the module that needs Office Ally's spec to finish** (see
Blockers).

### 3. Config additions (fail-soft, read-at-call-time)

The SFTP creds don't cover a real-time HTTPS endpoint. Add, alongside the
existing `OFFICE_ALLY_*` env / `clearinghouse_credentials` columns:

- `OFFICE_ALLY_REALTIME_URL` — the real-time eligibility endpoint.
- `OFFICE_ALLY_REALTIME_USERNAME` / `OFFICE_ALLY_REALTIME_PASSWORD` —
  real-time web-service auth (Office Ally's real-time auth is separate
  from the SFTP key; confirm shape against their companion guide).

Extend `readOfficeAllyConfigOrNull()` (or a sibling
`readOfficeAllyRealtimeConfigOrNull()`) with the same "all-or-null"
semantics — partial config → null → fall back to SFTP.

**Implemented:** the real-time fields (URL, username, sender/receiver IDs,
timeout, on/off, **and password**) are stored on `clearinghouse_credentials`
(migrations `0238` + `0239`) and editable in the admin console (Billing →
Config → Clearinghouse). `resolveClearinghouse()` returns a `realtimeConfig`
built from the DB row, with the password preferring the DB value and falling
back to `OFFICE_ALLY_REALTIME_PASSWORD`. The password is **write-only over
the API** (GET exposes only a `realtimePasswordSet` boolean) and never
logged. Note: a DB-stored password is plaintext (service-role readable) —
the env var remains available to keep the secret out of the database.

### 4. Verifier branch (synchronous path)

In `verifyEligibility()`:

```
if (realtime transport is configured) {
  const res = await realtime.requestEligibility({ payload: built.payload });
  if (res.ok) {
    const parsed = parse271(res.payload271);
    // write eligibility_checks row DIRECTLY as status='parsed'
    // with all benefit fields, via the shared mapper (step 5),
    // and fire the same eligibility.completed webhook.
    return { ...parsed-backed result };
  }
  // on failure: fall through to the SFTP submit path (graceful degrade)
}
// existing SFTP submit-and-poll path, unchanged
```

The route handler and its Zod contract don't change shape — the response
just carries the parsed result immediately when the real-time path is
live.

### 5. Refactor: share the 271 → row mapper (DRY)

The mapping from `Parsed271` to the `eligibility_checks` update columns
lives inline in `dispatch271()`
(`office-ally-inbound-poll.ts`). Extract it to a small helper (e.g.
`applyParsed271ToCheck()` in `lib/billing/`) so **both** the poller and
the new synchronous verifier write identical rows and fire the identical
`eligibility.completed` webhook. No behavior change to the poller — just a
shared callee.

## Files touched (estimate)

| File                                                   | Change                                                             |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `.../office-ally/src/transport/types.ts`               | + `EligibilityRealtimeTransport`                                   |
| `.../office-ally/src/transport/realtime.ts`            | **new** transport impl (needs OA spec)                             |
| `.../office-ally/src/config.ts`                        | + real-time config reader                                          |
| `.../office-ally/src/index.ts`                         | export the new transport + types                                   |
| `.../billing/eligibility-verifier.ts`                  | real-time branch + fix stale comment                               |
| `.../billing/` (new helper)                            | shared `applyParsed271ToCheck()`                                   |
| `.../worker/jobs/office-ally-inbound-poll.ts`          | call shared mapper (no behavior change)                            |
| `.env.example`, `docs/runbooks/office-ally-go-live.md` | document the new vars + the real-time toggle                       |
| tests                                                  | unit-test the parser-to-row mapper + a stubbed real-time transport |

Untouched: `build837P`, `parse835`, `parse999`, `parse277CA`, the SFTP
transport, the claims/remit flows, the migration ledger.

## Blockers / what we need from Office Ally

1. **Real-time eligibility companion guide** — endpoint URL, auth scheme,
   and the exact request/response envelope (their real-time service is
   HTTPS/SOAP/MIME, distinct from the SFTP batch channel). The web search
   that motivated this confirms Office Ally supports real-time 270/271 and
   is CAQH CORE-certified for it, but the wire details come from your
   account's companion guide.
2. **A real-time-enabled Office Ally account** + credentials for it.

Until those land, `transport/realtime.ts` can be stubbed against the
CAQH CORE envelope and unit-tested, but it can't be certified live.

## Rollback / feature-gating

Same fail-soft posture as the rest of the integration: the real-time path
is active **only** when its config is present. Unset it (or a mid-call
failure) → the existing SFTP submit-and-poll path runs unchanged. Nothing
to roll back beyond clearing the new vars.

## Effort

Small-to-moderate and well-isolated: one new transport module, one
verifier branch, one extract-and-share refactor, plus tests and docs. The
EDI build/parse layer — the part that's actually hard and risky — is
**reused verbatim**. The schedule risk is entirely the Office Ally
real-time spec/account, not our code.
