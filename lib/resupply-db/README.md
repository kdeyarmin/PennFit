# @workspace/resupply-db

Drizzle schema + Postgres connection for the CPAP resupply system. Owns the patients, equipment, supplies, orders, consents, suppression, audit, outbound-message, and conversation tables. Patient fields are stored as plaintext `text`/`jsonb`; column-level pgcrypto encryption was removed in migration `0025_strip_phi_encryption.sql`. ADR 003's hand-authored migration contract still applies.

## Status

Phase 0 — scaffolding only. No exports yet. See `docs/resupply/adr/` for the
architectural decisions that govern this package.
