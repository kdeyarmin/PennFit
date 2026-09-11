# Customer support identity proof

`support.identity.resolve` adds an exact-account read to the existing central administration endpoint. It accepts only an operation-bound Hub SMS delegation, and the mapped current in-house native administrator must retain its protected `platform_admins` membership.

The requested native staff user must be active with verified email. An active, unrevoked `admin_users` row must match that exact in-house user ID and organization ID, and the organization must be active. Missing or duplicated memberships fail closed. Native TEXT user IDs preserve their case; there is no seed-organization fallback, impersonation or email-based matching.

Only IDs, account kind, relationship and an opaque revision are returned to the Hub. The Hub shows the pairing for operator review and resolves the native evidence again before creating customer-only, own-case access with intake off. The native operation never writes any record. Existing platform rollout flags and mapping are unchanged; no migration is required.
