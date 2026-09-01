# Runbook — validating inbound voice tenant attribution

**Owner:** the operator who owns the tenants' phone numbers.
**Status: NOT PERFORMED.** No live inbound call has been placed. Nothing
in the product may say "Voice Live Validated".

---

## What is being validated, and why it needs a real call

An inbound call arrives as a Twilio webhook with no session and no tenant
context. Which practice it belongs to is derived, and getting it wrong is
a cross-tenant PHI disclosure: the wrong practice sees the conversation,
the transcript, and the patient.

The derivation is:

1. **The dialled number** (`To`), looked up against
   `organizations.voice_from_number` — **on the voice channel
   specifically.** The partial unique indexes are per column, so nothing
   in the database stops tenant A registering a DID for SMS while tenant
   B registers the same DID for voice. A channel-blind lookup resolved a
   voice call to the SMS owner, silently.
2. Only if that resolves to nothing: **the caller's number**, looked up
   against `patients.phone_e164`. **Ambiguity fails closed** — a number
   that exists in two tenants resolves to nothing at all. Tie-breaking on
   recency is a coin flip dressed as a heuristic: recency of contact is
   not evidence of ownership.
3. If neither resolves, the call is **rejected**. There is no default
   tenant, and a fallback to the seed org would put a stranger's call
   into a real practice's queue.

The logic is covered deterministically by
`src/lib/messaging/inbound-tenant-attribution.test.ts` (16 cases: two
tenants with two DIDs, one DID split across channels, a shared patient
phone, hostile input, a failed directory read). **What tests cannot prove
is the data** — which DID each `organizations` row actually claims, on
which channel, in this database. That is what the live call is for.

---

## Step 1 — check the data before dialling anything

```sql
SELECT id, name, sms_from_number, voice_from_number
  FROM resupply.organizations
 WHERE voice_from_number IS NOT NULL OR sms_from_number IS NOT NULL
 ORDER BY name;
```

- Each tenant that answers calls needs its own `voice_from_number`.
- **Look for a DID appearing in two rows**, in either column. That is the
  configuration the channel-aware lookup exists for, and it is worth
  knowing about before a patient finds it.

---

## Step 2 — simulate first, in a non-production environment

```bash
TWILIO_AUTH_TOKEN=<the token that env is running with> \
pnpm --filter @workspace/scripts voice:simulate-inbound -- \
  --base-url=http://localhost:3000 \
  --to=<tenant A's voice DID> \
  --from=+15550007777
```

Posts a correctly-**signed** inbound webhook at a running API. It
reproduces Twilio's HMAC-SHA1 independently rather than importing the
server's verifier — a shared implementation would pass even if both sides
were wrong together.

**It refuses a production target**, and there is no flag that changes
that: a simulated inbound call creates a real conversation for a real
tenant and can dispatch a real message.

The response cannot show the attribution, so check it:

```sql
SELECT org_id, direction, created_at FROM resupply.voice_calls
 WHERE call_sid = '<the CallSid the tool printed>';
```

Then re-run with `--repeat=3` and the **same** `--call-sid`. That is what
a Twilio retry looks like. There must still be exactly one row.

| Result                             | Meaning                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `403`                              | The signature was rejected. Check the token, and that `--base-url` is the URL the API sees — a proxy that rewrites the host breaks the signature. |
| `<Reject`, or no `voice_calls` row | Fail-closed: no `organizations` row claims that number on the **voice** channel.                                                                  |
| One row, correct `org_id`          | Attribution works against this data.                                                                                                              |

---

## Step 3 — the live calls (two tenants, two calls)

**Two calls to two different tenants' DIDs.** One call proves the number
was found; it cannot prove the call was not attributed to _everyone_.

Use a phone that is **not** in any tenant's patient list, so step 1 of the
derivation is what is being tested rather than step 2.

| #   | Action                                                               | Who      |
| --- | -------------------------------------------------------------------- | -------- |
| 1   | Call **tenant A's** published number. Let the agent answer. Hang up. | Operator |
| 2   | Call **tenant B's** published number. Same.                          | Operator |

### What to verify afterwards

```sql
-- One row per call, each attributed to the tenant whose number rang.
SELECT vc.call_sid, vc.org_id, o.name, vc.direction, vc.created_at
  FROM resupply.voice_calls vc
  JOIN resupply.organizations o ON o.id = vc.org_id
 WHERE vc.created_at > now() - interval '1 hour'
 ORDER BY vc.created_at;

-- No unattributed rows. Every one of these is invisible to every
-- tenant's dashboard.
SELECT count(*) FROM resupply.voice_calls
 WHERE org_id IS NULL AND created_at > now() - interval '1 hour';

-- The conversation carries the same tenant as the call.
SELECT c.org_id AS conversation_org, vc.org_id AS call_org
  FROM resupply.voice_calls vc
  JOIN resupply.conversations c ON c.id = vc.conversation_id
 WHERE vc.created_at > now() - interval '1 hour';
```

| Check                | Where                                  | Expected                                                                     |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| `voice_calls.org_id` | SQL above                              | Set, and equal to the DID's owner                                            |
| Conversation tenant  | SQL above                              | Matches the call's                                                           |
| Admin voice metrics  | `/admin/voice/metrics` **as tenant A** | Shows A's call only                                                          |
|                      | `/admin/voice/metrics` **as tenant B** | Shows B's call only                                                          |
| Channel engagement   | `/admin/analytics/channel-engagement`  | `voice` non-zero for each, and only for its own                              |
| **Cross-tenant**     | A's console                            | **Nothing about B's call anywhere**                                          |
| Metering             | the tenant's usage/metering surface    | The minute is billed to the DID's owner                                      |
| Logs                 | application log                        | Call SIDs and org ids. **No transcript, no caller name, no spoken content.** |

The metering check is not optional. A call attributed to the wrong tenant
is also _billed_ to the wrong tenant, and that is discovered on an invoice
rather than a dashboard.

---

## Evidence required to mark "Voice Live Validated"

All six, in
[`../reviews/external-validation-checklist.md`](../reviews/external-validation-checklist.md):

1. The `voice_calls` query output for both calls, showing two rows with
   two different, correct `org_id` values.
2. The unattributed-rows count, showing **0**.
3. Screenshots of `/admin/voice/metrics` as **each** tenant, each showing
   only its own call.
4. A screenshot or note confirming **no** cross-tenant visibility.
5. The metering line for each tenant.
6. A log excerpt confirming no transcript or caller identity was written.

**Fixture and simulation coverage is not live validation, and this
document does not present it as such.** Until all six exist, the honest
label is "deterministically tested; never validated against a real call".

---

## If attribution is wrong

1. **Do not** add a default tenant. The fail-closed path loses a call; a
   default sends it to the wrong practice.
2. Check `organizations.voice_from_number` for the tenant — the most
   common cause is a DID recorded in `sms_from_number` only.
3. Check for the same DID in two rows. The channel-aware lookup handles
   it correctly, but the configuration is worth deliberately confirming.
4. If a caller's number resolved to nothing, that is likely the
   ambiguity guard working: the same phone exists in two tenants. The fix
   is for the tenant to publish its own DID, not to re-introduce a
   tie-break.

---

## Related

- [`voice-agent-go-live.md`](./voice-agent-go-live.md)
- `src/lib/messaging/tenant-telecom.ts` — the resolver
- `src/lib/voice/voice-call-record.ts` — where `voice_calls.org_id` is written
