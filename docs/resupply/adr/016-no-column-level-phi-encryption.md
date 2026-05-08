# ADR 016 — No column-level PHI encryption (post-0025)

## Context

[ADR 007](./007-encryption-pgcrypto-not-kms.md) is the historical
record of the pgcrypto-based column-level encryption that the
resupply schema launched with. Migration
[`0025_strip_phi_encryption`](../../../lib/resupply-db/drizzle/0025_strip_phi_encryption.sql)
removed it. This ADR documents the *current* posture: we
deliberately do NOT re-introduce column-level encryption, and the
threat-model rationale for that choice.

## Decision

PHI columns in the resupply schema (patient name, phone, email,
DOB, message bodies, prescription metadata) are stored as plaintext
`text` / `jsonb`.

The protection layers we DO rely on:

1. **Postgres authn + storage-layer encryption at rest.** The
   managed Postgres instance encrypts disk and backups
   transparently; only the application's DB role can issue
   `SELECT`.
2. **Application-level access controls.** Every PHI-touching
   route is gated by `requireAdmin` (admin-staff endpoints) or
   `requireSignedIn` (patient-self endpoints). The middleware
   layer is the single chokepoint, and the access patterns are
   audited via `lib/resupply-audit`.
3. **Logging hygiene.** `lib/logger.ts` redacts auth headers,
   cookies, and error details; the audit sanitizer denies
   PHI-shaped metadata keys; CLAUDE.md's hard rule "no order
   request bodies in the application logger" backs the policy.
4. **The link-signing HMAC** for short-lived patient links —
   addressed separately in [`RUNBOOK-secrets.md`](../RUNBOOK-secrets.md).

## Why not column-level encryption today

The pgcrypto setup we removed had three specific costs that
outweighed its incremental security:

1. **Operational opacity.** `LIKE`, `ORDER BY`, and ILIKE
   searches against an encrypted column had to be replaced with
   either full-table decryption (slow and load-bearing during
   support workflows) or a parallel HMAC index column. We
   maintained both for phone search; both leaked timing and key
   material in different ways.
2. **Migration friction.** Every PHI-ish column added to the
   schema needed a custom encrypt/decrypt wrapper at the ORM
   layer. We accumulated three different shapes of wrapper before
   0025 — none of which were testable without a live key, none
   of which composed cleanly with Drizzle's query builder.
3. **No proven threat reduction.** The keys were stored in
   Replit secrets, fetched at boot, held in process memory.
   Anyone with shell on the deploy host could decrypt at will. The
   threat model that pgcrypto actually defended against (DB dump
   leaving the deploy boundary) is the same one Postgres's
   storage-layer encryption defends against — and Postgres's is
   not a project the application owns.

The decision was: lift the layer that wasn't bought us anything
real, accept that the deploy host's storage-layer encryption is
the at-rest control, and put the engineering hours into the
controls that DO move the needle (sanitizer, audit, request-id
propagation, role-scoped routes).

## When to revisit

This ADR should be reopened — not silently overturned — if:

* The application takes a BAA with a signing partner that
  explicitly requires column-level encryption with key custody
  outside the application process. (Common ask from health-system
  partners, less common from device manufacturers.)
* The deploy host stops providing transparent storage-layer
  encryption and we can't migrate to one that does.
* We need to enforce a hard "no employee can ever see column X
  even with full DB shell" boundary. Today the answer is "the
  audit log records every read"; if that becomes insufficient,
  encryption with a key the application can't unilaterally read
  is the next layer.

## What this ADR does NOT cover

* **Image / attachment storage.** Prescription documents and
  message attachments live in object storage and are subject to
  the policy in [`PHI-RETENTION.md`](../PHI-RETENTION.md), not
  this ADR.
* **Transport encryption.** Every external HTTPS endpoint is
  TLS-terminated; that's not in scope here.
* **Audit log retention.** Covered by
  [`AUDIT-RETENTION.md`](../AUDIT-RETENTION.md).

## Related

- ADR 007 (superseded) — historical pgcrypto record.
- Migration 0025 — strip_phi_encryption.
- `lib/resupply-secrets/src/index.ts` — current single-secret
  surface (link-signing HMAC only).
- CLAUDE.md hard rules — the application-layer rules that
  back-stop this decision.
