# ADR 007 — pgcrypto (not AWS KMS) for PHI encryption in dev

> **Status: Superseded.** Migration `0025_strip_phi_encryption`
> removed column-level pgcrypto encryption from the resupply schema
> entirely. PHI is now stored as plaintext `text` / `jsonb` and
> protected by Postgres authn + storage-layer encryption-at-rest
> instead. The `RESUPPLY_DATA_KEY` env var is no longer read by any
> code path. This ADR is preserved as historical record only — see
> `docs/PRODUCTION_READINESS.md` and `ARCHITECTURE.md` for the
> current model.

## Context

The original plan called for AWS KMS-backed envelope encryption on
high-sensitivity PHI columns (DOB, phone, email, address, SSN, insurance
member id). KMS handles key rotation, access auditing, and HSM-backed key
storage.

Replit does not provide a managed KMS. We still need PHI encryption at rest
for prototyping so that:

- A leaked DB dump from the dev environment is not a leak of plaintext PHI.
- The encryption interface in `lib/resupply-db` is identical in dev and
  prod, so swapping the backing store at migration time is mechanical.

## Decision

For Phase 0 through Phase 8 (prototyping), use pgcrypto symmetric
encryption with a single key-encryption-key supplied via the
`RESUPPLY_DATA_KEY` Replit secret.

- Encrypted columns are declared in the Drizzle schema using a
  `encryptedText()` / `encryptedJson()` column helper. Reads transparently
  decrypt; writes transparently encrypt.
- Key is a 32-byte random value, generated once and stored as a Replit
  secret. Never committed.
- pgcrypto uses `pgp_sym_encrypt(plaintext, key)` / `pgp_sym_decrypt`.
- Rotation in the prototype phase is done manually by writing a one-off
  migration that re-encrypts every row with a new key. Rotation cadence
  documented but not yet enforced.

## Migration trigger

**Before any real patient PHI is loaded, rotate to a managed KMS.**
Acceptable migration targets:

- AWS KMS with envelope encryption — the original plan.
- GCP KMS or Azure Key Vault if we host on those clouds.
- HashiCorp Vault Transit secrets engine if we self-host.

The migration is: replace the `encryptedText()` helper's implementation
with a KMS-backed envelope-encryption call; back-fill DEKs per row;
zeroize the old `RESUPPLY_DATA_KEY`. The schema and the route handlers do
not change.

## Consequences

- Dev encryption is real (not a no-op stub) — a stolen dev DB is not a
  plaintext leak.
- Dev encryption is NOT HIPAA-grade — the KEK lives in a Replit secret,
  not an HSM, and there is no key-access audit trail.
- The interface boundary is preserved: production migration is a small
  surgical change.

## Alternatives Considered

- **No encryption in dev, encrypt only in prod** — rejected; the
  development encryption path needs to be exercised by tests so we know
  it works on day one.
- **Application-side AES-GCM in app code** — equivalent security to
  pgcrypto but harder to query (no `WHERE encrypted_phone = ...` even
  with deterministic encryption). pgcrypto in the DB lets us at least
  index hashes of identifiers when needed.
- **Skip encryption until Phase 9** — rejected; would require a schema
  migration to add encryption later, and would normalize the bad habit
  of storing PHI in plaintext.

## TODO

- [ATTORNEY REVIEW] Confirm that prototyping with synthetic PHI and the
  pgcrypto KEK approach in this dev environment is acceptable until the
  KMS migration ships.
- [BUSINESS REVIEW] Pick the production KMS target before Phase 9.
