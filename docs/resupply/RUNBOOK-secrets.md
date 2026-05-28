# Secrets runbook

The resupply application reads exactly one application-level secret
that affects in-flight signed artifacts: `RESUPPLY_LINK_HMAC_KEY`.
Everything else (DB credentials, Stripe / SendGrid / Twilio / OpenAI
keys, Supabase service-role JWT used by Supabase Storage) is "rotate,
restart, done" — they don't affect any signed artifacts already in
flight.

This runbook covers `RESUPPLY_LINK_HMAC_KEY` rotation specifically,
because that one is *not* a simple swap.

## What signs links

`RESUPPLY_LINK_HMAC_KEY` is read by `@workspace/resupply-secrets` and
fed to `createHmac("sha256", key)` for every short-lived patient
link the system issues:

- SMS / email reminder links (resupply check-ins, day-3/7/30
  outreach) — TTL ≈ a few hours to a few days.
- Fax-document tokens (`lib/fax-document-token.ts`) — TTL minutes.
- Voice-callback links — TTL minutes.

## Why rotation is non-trivial

Today the lib reads a single key:

```ts
// lib/resupply-secrets/src/index.ts
export function getLinkHmacKey(env = process.env): Buffer {
  const value = readEnv(LINK_HMAC_KEY_ENV, env);
  if (value === undefined) throw new Error("…not set…");
  return Buffer.from(value, "utf8");
}
```

When the key changes, every link signed with the old key fails
verification immediately. Patients with an unread SMS link from
this morning would land on an error page after a "no longer valid"
toast. That's painful UX during a routine rotation.

## Rotation policy (current)

Use the **emergency** procedure below for any rotation while we only
support a single key. The graceful procedure under "Future" needs a
small library change first.

### Emergency rotation (key compromise)

1. Generate a new key:
   ```bash
   openssl rand -base64 48
   ```
2. Set `RESUPPLY_LINK_HMAC_KEY` to the new value in the deploy.
3. Restart the API process (rolling restart in production).
4. **Expect** outstanding signed links to fail. Communicate this in
   #ops if the blast radius matters (mid-outreach campaign, etc.):
   * Reminder emails: re-issue the next scheduled wave; the
     reminder cron will pick up the missed sends.
   * Fax-document tokens: regenerate from the admin UI.
   * Voice-callback links: customers will hit a "session expired"
     screen — they can call back through the IVR root.
5. Audit the access window the old key was exposed in. The HMAC is
   write-only: leakage doesn't expose patient data, but it does
   let an attacker forge a link if they know the patient identifier
   to embed.

### Routine rotation (no compromise)

We don't have one yet. Don't perform an unforced rotation while the
single-key codepath is in place — there's no upside that outweighs
the patient UX cost.

## Future: graceful (zero-downtime) rotation

The codepath needed:

1. Read both `RESUPPLY_LINK_HMAC_KEY` (current) and
   `RESUPPLY_LINK_HMAC_KEY_PREVIOUS` (optional) at startup.
2. Sign with the current key.
3. Verify against the current key first; on mismatch, try the
   previous key. Either match passes.
4. After the longest TTL (≈30 days for the slowest reminder
   cohort), drop `*_PREVIOUS` from the deploy.

A roughly 30-line change in `lib/resupply-secrets/src/index.ts` plus
the four call sites that verify (link-token verification utility,
fax-document token, voice-callback). Tracked in the review backlog
as part of the "secrets rotation policy" item — implement before
the next routine rotation.

## Related env vars

These do **not** require this runbook — they're "rotate, restart,
done":

| Env var | Used for | Notes on rotation |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection | Standard credential rotation. |
| `STRIPE_SECRET_KEY` | Stripe API | Coordinate with the webhook secret swap below. |
| `STRIPE_WEBHOOK_SECRET` | Stripe webhook signature | Set as a comma-separated `secret1,secret2` to verify against either during rollover. |
| `SENDGRID_API_KEY` | Outbound email | Rotate at SendGrid first, then deploy. |
| `TWILIO_AUTH_TOKEN` | Inbound webhook signatures + outbound SMS/voice | Twilio supports token rollover via secondary auth tokens. |
| `OPENAI_API_KEY` | Storefront chat | No signed artifacts in flight — rotate, restart. |
| Object storage credentials | Supabase Storage (service-role JWT) | Same. |

## Documenting another secret

When a new application secret lands, update this file with:
1. What it signs / encrypts.
2. The TTL of the longest in-flight artifact.
3. Whether rotation is single-key (emergency posture) or supports
   key overlap (zero-downtime).
