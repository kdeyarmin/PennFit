# Auth Credentials Store Outage Runbook

Covers the alert that fires when `GET /auth/me` cannot read
`resupply_auth.password_credentials`. The signal is emitted from
`lib/resupply-auth/src/http/me.ts` and the underlying call is
`findCredentialByUserId` in
`lib/resupply-auth/src/supabase-repository.ts`.

This runbook is the playbook for the alert defined in
`docs/PRODUCTION_READINESS.md` ("Logging + alerting"):
`event=auth_me_credential_lookup_failed`, threshold **>5 occurrences
in any rolling 5-minute window**.

---

## What the alert means

`GET /auth/me` is the request the admin SPA makes immediately after
sign-in to decide whether to render the console or force the
change-password screen. The handler reads the operator's row from
`resupply_auth.password_credentials` to surface the `must_change`
flag.

The handler is deliberately **fail-closed**: if the credential read
throws, it returns HTTP 500 instead of defaulting `mustChangePassword`
to `false`. Defaulting to `false` on a transient DB error would let a
freshly-invited admin slip past the forced-rotation gate with the
operator-typed invite password still on their account. The 500
instead causes the SPA to show its session-error state — the operator
cannot reach the console until the dependency recovers.

So when this alert fires, **affected operators cannot sign in to the
admin console**. Customer-facing surfaces (`/`, `/shop`, the resupply
patient flow) are unaffected — they do not call `/auth/me`.

### The log envelope

```jsonc
{
  "event": "auth_me_credential_lookup_failed",
  "userId": "<uuid of the user whose /me failed>",
  "err": {
    "type": "Error",
    "message": "...", // PostgREST / Supabase error message
    "stack": "...",
  },
  "msg": "auth.me: credential lookup failed; failing closed with 500",
}
```

Paired audit row (written to `audit_events` via `deps.audit`):

```jsonc
{
  "action": "auth.me_credential_lookup_failed",
  "adminEmail": "<email_lower of the affected user>",
  "adminUserId": "<same uuid as userId above>",
  "ip": "<request ip or null>",
  "metadata": { "err": "<error message, no stack>" },
}
```

Use the audit row for after-the-fact reconstruction (who was paged
out, when) — logs are short-retention, the audit table is durable.

---

## Triage in 60 seconds

1. **Read the `err.message` from the log line.** This is the
   PostgREST error verbatim and is the fastest way to distinguish
   the three failure modes below.
2. **Check Supabase status** (project dashboard → Database health,
   or the Supabase status page). If the project is degraded, you are
   in failure mode A.
3. **Try the same query from `psql` / Supabase SQL editor** as the
   service-role user:

   ```sql
   SELECT user_id, must_change, updated_at
   FROM resupply_auth.password_credentials
   LIMIT 1;
   ```

   - 200 with rows → it is not a Supabase outage and not a missing
     role. You are in failure mode C (migration drift / column
     rename).
   - `permission denied for schema resupply_auth` or `relation does
not exist` → failure mode B (role / schema not granted).
   - Connection error / timeout / 5xx from PostgREST → failure
     mode A (Supabase outage).

4. **Decide**: wait it out (A), grant the missing privilege (B), or
   roll the migration forward/back (C). See the per-mode sections
   below.

---

## Failure mode A — Supabase / PostgREST outage

**Symptoms:** `err.message` looks like a fetch failure
(`fetch failed`, `ECONNREFUSED`, `socket hang up`), a PostgREST 5xx,
or a Supabase-side timeout. Multiple unrelated user IDs are affected.
`/readyz` may also be failing.

**What to do:**

- Confirm on the Supabase status page / project dashboard.
- Nothing to fix in app code. The handler is correctly failing
  closed; the SPA's session-error state is the expected UX during a
  DB outage.
- Post status in the on-call channel and wait for Supabase to
  recover. The alert will self-clear when the next `/auth/me` calls
  succeed.
- If Supabase is green and we're still seeing connection errors,
  check whether the API process has lost its PostgREST client
  (worker restart, network egress quota). A workflow restart of the
  `Resupply API` artifact resets the client.

---

## Failure mode B — Missing role grant / schema not exposed

**Symptoms:** `err.message` contains `permission denied for schema
resupply_auth`, `permission denied for table password_credentials`,
or `relation "resupply_auth.password_credentials" does not exist`.
Every affected `userId` fails the same way. The same SQL run as the
`postgres` superuser succeeds.

This usually means a schema deploy went out without the matching
`GRANT` / `ALTER ROLE` for the `service_role` PostgREST role, or
`resupply_auth` was not added to the API's exposed schemas in the
Supabase project settings.

**What to do:**

1. Confirm `resupply_auth` is listed in Supabase project settings →
   API → "Exposed schemas". If not, add it and reload PostgREST
   (the Supabase UI button does this for you).
2. Confirm the `service_role` has read access:
   ```sql
   GRANT USAGE ON SCHEMA resupply_auth TO service_role;
   GRANT SELECT, INSERT, UPDATE, DELETE
     ON ALL TABLES IN SCHEMA resupply_auth TO service_role;
   ```
   These should already be in the migrations; running them again is
   idempotent.
3. Reload the PostgREST schema cache (Supabase dashboard → Database
   → API → "Reload schema cache", or `NOTIFY pgrst, 'reload schema'`).
4. Open a follow-up incident: a missing grant in production means
   the migration story is broken. Do not consider the alert closed
   on the manual fix alone.

---

## Failure mode C — Migration drift / column rename

**Symptoms:** `err.message` contains `column ... does not exist` or
`could not find the 'must_change' column of 'password_credentials' in
the schema cache`. Every affected `userId` fails the same way. SQL
against `password_credentials` succeeds for _some_ columns but not
the ones the repository selects (see `CRED_COLS` in
`supabase-repository.ts`: `user_id, password_hash, algo, must_change,
set_by_admin_at, updated_at`).

This means application code shipped that expects a schema the
production database does not have — typically a migration that
wasn't applied, or a column rename that landed in app code first.

**What to do:**

1. Compare the production `password_credentials` shape to what
   `CRED_COLS` selects:
   ```sql
   SELECT column_name, data_type
   FROM information_schema.columns
   WHERE table_schema = 'resupply_auth'
     AND table_name = 'password_credentials'
   ORDER BY ordinal_position;
   ```
2. Identify which side is wrong:
   - **Missing migration:** roll the migration forward against the
     production database (Supabase SQL editor or the migrator
     workflow). PostgREST will pick up the new columns after a
     schema reload.
   - **App ahead of DB:** roll the API artifact back to the previous
     deploy. Do not hand-edit the production schema to match a
     half-shipped feature.
3. Reload the PostgREST schema cache (as in failure mode B).
4. Open a follow-up incident on the migration story — the
   `event=auth_me_credential_lookup_failed` alert is doing its job,
   but the schema-drift check in CI should have caught this earlier.

---

## Verifying recovery

- Tail logs for `event=auth_me_credential_lookup_failed` — once the
  cause is fixed, the next `/auth/me` calls return 200 and no new
  log lines appear. The alert auto-clears when the rate drops below
  threshold.
- Spot-check from a browser: sign in as a test operator at
  `/admin/sign-in`. A successful console load means the SPA's
  `useGetAdminMe` hook returned 200.
- Query the audit table for the window of the incident:
  ```sql
  SELECT created_at, admin_email, admin_user_id, metadata
  FROM audit_events
  WHERE action = 'auth.me_credential_lookup_failed'
    AND created_at >= now() - interval '1 hour'
  ORDER BY created_at DESC;
  ```
  Useful for the postmortem: how many operators were locked out,
  and for how long.

---

## When to escalate

| Signal                                                            | Action                                                                                                                                                                                                |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Single burst, Supabase status green, single `userId`              | Likely a one-off PostgREST hiccup. Close once the alert clears.                                                                                                                                       |
| Multiple `userId`s, identical `err.message`                       | Treat as a production incident — failure mode B or C. Open an incident, do not just silence the alert.                                                                                                |
| Alert co-fires with `event=resupply_admin_in_house_lookup_failed` | Both auth read paths are failing. Almost certainly a Supabase-wide outage (failure mode A) or a `resupply_auth` schema grant problem (failure mode B) affecting every auth surface. Page the on-call. |
| `/readyz` also failing                                            | Treat as full API outage; follow the deploy/rollback playbook, not this runbook.                                                                                                                      |

---

## Related code

- `lib/resupply-auth/src/http/me.ts` — the handler, the fail-closed
  decision, and the structured log + audit envelope.
- `lib/resupply-auth/src/supabase-repository.ts` —
  `findCredentialByUserId` (the call that throws) and `CRED_COLS`
  (the column list PostgREST is asked for).
- `docs/PRODUCTION_READINESS.md` — alert definition + threshold.
