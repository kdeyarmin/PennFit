# RESUPPLY_LINK_HMAC_KEY Rotation Runbook

The HMAC key that signs short-lived tokens embedded in patient
communications. CLAUDE.md flags this as the only resupply-specific
secret that's required at boot (per `lib/resupply-secrets/src/index.ts`
and `lib/resupply-api/src/lib/env-check.ts`).

This runbook covers when to rotate, the impact of rotation under the
current single-key implementation, and the safe procedure.

---

## What the key signs

Two unrelated token types share the key (intentionally — neither carries
enough secrecy budget to justify a second key, and ops only has one
secret to rotate when something goes wrong).

| Caller | TTL | What in-flight rotation breaks |
| --- | --- | --- |
| `lib/resupply-messaging/src/signed-link-tokens.ts` — email CTA tokens (`confirm` / `edit` / `stop` actions on reminder emails) | 7 days | Every reminder email sent in the rolling 7-day window: the patient clicking "Confirm order" or "Stop reminders" lands on a "this link is no longer valid" page. They CAN re-request via the storefront. |
| `artifacts/resupply-api/src/lib/fax-document-token.ts` — fax cover-letter document URLs that Twilio fetches when dispatching `physician_fax_outreach` rows | 1 hour | Any `physician_fax_outreach` job scheduled before the rotation but dispatched after will fail to fetch the cover sheet from `/fax/document/:token`. The retry queue surfaces this; the operator re-dispatches after rotation. |

Both readers go through `getLinkHmacKey()` in `lib/resupply-secrets`.
The function THROWS on missing key (`refusing to sign or verify
resupply links`) — there is no graceful-degraded mode. Any process
that boots with `RESUPPLY_LINK_HMAC_KEY` unset will fail at first
use, NOT at boot. The boot env check (`env-check.ts:19`) requires
the var to be set.

## When to rotate

Three triggers warrant rotation:

1. **Suspected compromise.** The key was committed to git, leaked
   in a log, exposed in a third-party dashboard, or the deployment
   secret store was breached. Rotate **immediately**; the cost of the
   in-flight breakage is bounded (max 7 days of email tokens) and
   the alternative is forging unsubscribe / confirm clicks.
2. **Scheduled rotation.** No regulatory requirement today, but a
   rolling annual rotation is reasonable hygiene. Schedule into a
   known low-traffic window (Saturday 06:00–07:00 UTC: outside the
   daily reminder cron at 07:00 UTC and the weekly attachment sweep
   at 03:13 UTC Sunday — see `docs/runbooks/worker-recovery.md`).
3. **Personnel change.** Anyone who handled the secret leaves the
   team. Rotate within the offboarding window.

## What rotation breaks (single-key reality)

The codebase today is **single-key only** — `getLinkHmacKey()`
returns a single `Buffer`; `verify` paths call `timingSafeEqual`
against the HMAC of `getLinkHmacKey()`. There is no overlap window,
no key-id, no "accept the previous key for N days" logic.

Concretely, at the moment the new key takes effect on a process:

- Every `reminders.send-{email,sms}` job that already enqueued a
  link with the old key will deliver tokens that the new process
  rejects with `valid: false, reason: "bad-signature"`. The patient
  sees the generic "this link is no longer valid" page (handled in
  `routes/email/click.ts`).
- Any fax outreach job whose cover-letter URL was issued with the
  old key but fetched after rotation gets a 401 from
  `routes/fax/document/:token`. Twilio retries on 5xx but not 4xx,
  so the dispatch fails terminally. The pgboss `failed` count
  ticks up; operator re-dispatches.
- Tokens issued by the new process verify normally on every other
  process running the new key.

## Safe rotation procedure

### Pre-rotation checks (5 minutes)

1. **Confirm the new key is 32+ random bytes.** Generate with:
   ```
   openssl rand -base64 48
   ```
   The `getLinkHmacKey()` reader trims the value before use and
   refuses empty strings; pass exactly the openssl output.
2. **Inspect outstanding fax dispatches.** A fax job has a 1h
   token TTL; if any are queued or in-flight, defer rotation
   until they drain or accept the failures.
   ```sql
   SELECT count(*)
   FROM resupply.physician_fax_outreach
   WHERE status IN ('pending', 'sent')
     AND updated_at > now() - interval '1 hour';
   ```
   If non-zero, decide: (a) wait for natural drain (≤1h), (b)
   accept the failures and re-dispatch after, or (c) cancel the
   pending rows pre-rotation and re-create after.
3. **Decide post-rotation patient comms.** A "you may have
   received a reminder email this week — please re-request from
   your account" notice is appropriate for compromise rotations.
   For scheduled rotations, the breakage is small enough that
   no proactive comms are needed.

### Rotation (3 minutes, atomic across all processes)

1. **Set the new value in the secret store** — Replit Secrets,
   Doppler, AWS Secrets Manager, etc. (whichever is wired up).
2. **Restart every process that runs the API artifact.** The key
   is read at first call, not at boot, but a restart guarantees
   no in-process cached old key persists. The
   `Resupply API: Resupply API` workflow restart is the supported
   path (it bounces all replicas atomically).
3. **Verify boot:** `/readyz` returns 200. Tail the boot log for
   any `RESUPPLY_LINK_HMAC_KEY is not set` errors — none should
   appear if the secret store is correctly wired.

### Post-rotation verification

1. **Issue a test token.** From any process console:
   ```
   node -e 'const m=require("@workspace/resupply-messaging");const t=m.signLinkToken({conversationId:"test-rotation",action:"confirm"});console.log(t);console.log(m.verifyLinkToken(t));'
   ```
   Should print a token and `{valid: true, ...}`. If it prints
   `bad-signature`, the new key wasn't picked up; recheck the
   secret store + restart.
2. **Watch the dead-letter alert** (`event: "pgboss_jobs_failed"`,
   queue: `reminders.send-email` / `reminders.send-sms` /
   `physician_fax_outreach.dispatch`) for ~10 minutes. A small
   bump is expected from in-flight pre-rotation tokens.
3. **Spot-check real patient flow.** Send yourself a test
   reminder; confirm the email link works.

### Failure modes

- **Secret-store value contains whitespace or quotes** —
  `getLinkHmacKey()` calls `Buffer.from(trimmedValue, "utf8")`.
  Stray newlines or wrapping quotes change the byte sequence and
  every verify fails. Re-store the value carefully (`echo -n
  "<value>"` to suppress the trailing newline).
- **One replica missed the restart** — that replica still uses
  the old key; tokens it issues won't verify on the new replicas
  and vice versa. Force-restart all replicas; the workflow
  restart should do this atomically.
- **Old value is still set in a `.env.local` file** — for local
  dev, update `.env.example` if the rotation changes the
  per-developer value (it shouldn't — devs use a stable local
  random key). For prod / preview, the secret store is the
  source of truth and `.env*` files are not read.

---

## Future enhancement: dual-key support

The cleanest hardening would be a `RESUPPLY_LINK_HMAC_KEY` +
`RESUPPLY_LINK_HMAC_KEY_PREVIOUS` pair, with the verifier accepting
either and the signer always using the current. That gives an
overlap window (default 7 days, matching the longest token TTL)
where rotation has zero in-flight breakage.

The cost is small (~30 LoC across `lib/resupply-secrets`,
`lib/resupply-messaging/src/signed-link-tokens.ts`, and
`lib/fax-document-token.ts`). Not done today because we haven't
needed to rotate; if a real rotation surfaces this gap, file a
follow-up to add the overlap before the next rotation.

The current single-key reality is documented honestly here so the
on-call doesn't reach for an "overlap window" that doesn't exist
in code.

---

## Related code

- `lib/resupply-secrets/src/index.ts` — single point of access
  (`getLinkHmacKey`, `hasLinkHmacKey`).
- `lib/resupply-messaging/src/signed-link-tokens.ts` — email CTA
  tokens; 7-day TTL.
- `artifacts/resupply-api/src/lib/fax-document-token.ts` — fax
  cover-letter URL tokens; 1-hour TTL.
- `artifacts/resupply-api/src/lib/env-check.ts` — boot-time
  validation that the var is set.
- `docs/runbooks/worker-recovery.md` — what to do with the failed
  jobs that surface during the rotation window.
