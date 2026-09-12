# Governed Breathe tenant lifecycle

This adapter lets a currently authorized Hub platform administrator review and
apply an active-to-suspended or suspended-to-active tenant transition. It does
not create a Breathe session. Archived tenants are read-only through this
adapter. The existing native platform routes retain their previous transitions
and now call the same atomic status writer.

Suspension changes the native `organizations.status` value used by active
tenant routing and worker enumeration. It does not revoke every staff session,
cancel in-flight work, alter billing, or guarantee immediate cache eviction on
other instances. Successful writes and confirmed retries invalidate the local
branding/routing caches; other instances retain their existing cache TTL. A
lost database response can likewise leave a cache until its existing TTL.

## Transport and authority

- Fixed native POST: `https://cmbreathe.com/resupply-api/central-admin/tenant-lifecycle`.
- Closed domain: `tenant.lifecycle.v1`; operations: `context`, `preview`, `apply`, `resume`.
- SMS-only `Authorization: Bearer cmh_<43 base64url characters>`; browser Origin
  and Cookie headers, query parameters, and native/legacy JWT sessions are rejected.
- The native server consumes the ticket only at the fixed Hub endpoint
  `https://support-hub-web-production.up.railway.app/api/internal/command/breathe/authorize`.
  The Hub audience is `breathe.command`. The response must contain exactly
  `user_id`, `role`, `method`, `session_id`, `session_started_at`,
  `assurance_expires_at`, and the parsed exact `operation`.
- The explicit existing Hub UUID to native opaque-ID mapping remains required.
  Current native `role=admin`, `status=active`, verified email, and
  `platform_admins` membership are checked before and after the native call and
  inside the transaction. Email equality and submitted role metadata grant nothing.
- Requests are bounded to 16 KiB and the complete handler to 12 seconds.
  Issuer responses are bounded to 32 KiB; projected native results to 128 KiB.
  No credentials, issuer error bodies, reason text, or private rows are logged.

## Review, commit, and recovery

`context {targetId}` returns safe tenant metadata, a SHA-256 revision of the
complete native organization row, and at most 20 saved reviews owned by the
current Hub actor. The current seed organization is resolved from the native
directory's canonical `penn-home-medical` identity and cannot be suspended.

`preview {requestId,targetId,action:'organizations.setSuspension',parameters:{suspended},expectedRevision,reason}`
creates a private review lasting at most five minutes, capped by the current
SMS session expiry. The reason must be 10–500 trimmed,
control-free characters. The request ID is known before dispatch and is
immutable: retrying it returns the same review, while changed parameters,
actor, session, or source revision are rejected. Preview does not change the
tenant. At most 20 new reviews per Hub actor are accepted in 15 minutes.

`apply {commandId,expectedDigest}` locks the saved review and native organization,
compares the complete source revision, checks current native membership and
wall-clock session/review expiry after lock waits, then changes the status and
records an immutable receipt in the same transaction. Concurrent/retried applies
cannot create a second transition. Completed replay still requires current
authority and the original session; it returns the original receipt.

`resume {requestId}` and context permit current same-actor read-only recovery
after a new Hub sign-in. `canApplyThisSession` is false for another session,
expired/stale review, or completed receipt. A recovered receipt is historical
evidence; it is not a claim that the tenant still has the recorded status.

No patients, clinical records, staff invitations, billing actions, impersonation,
or outbound messages are part of this contract.

## Deployment and verification

Migration `0545_governed_tenant_lifecycle.sql` belongs to Breathe's sequential
`lib/resupply-db` migration system. It creates private intents/immutable receipts
and the shared native writer. Only service_role may execute the two exposed
native RPCs; private tables/helpers are not exposed to browser database roles.
The standard migrator must complete before deploying the route refactor.

The new endpoint and advertised lifecycle capabilities stay off unless
`CAREMETRIC_ADMIN_TENANT_COMMANDS_ENABLED=true`, in addition to the existing
`CAREMETRIC_ADMIN_ENABLED` and explicit identity-map configuration. Enable it
only after the paired Hub audience, exact operation parser, current-session
issuer, and deployment feature gate are reviewed and released. Flags and schema
presence do not establish a successful production tenant transition.

Required CI exercises migration replay, real PostgreSQL privilege/CAS/concurrency
and post-lock expiry, plus actual HTTP handler → single-use issuer fixture →
service-role PostgREST → native SQL. Those fixtures only accept the local
disposable `resupply_ci` database. Unit tests cover transport, revoked authority,
closed projections, ingress limits, and existing platform-route compatibility.
Production verification must not suspend or reactivate a real tenant as a smoke test.
