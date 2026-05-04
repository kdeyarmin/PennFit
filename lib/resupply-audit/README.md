# @workspace/resupply-audit

Single, sanctioned writer for `resupply.audit_log`. Every audit row in the
Resupply slice goes through `logAudit()` from this package — direct
`db.insert(auditLog)` and raw `INSERT INTO ... audit_log` calls are banned by
Architecture Rule 8 in `scripts/check-resupply-architecture.sh`.

## Why a dedicated package

Audit-row PHI is a HIPAA-reportable event. Centralizing the write path means
the metadata sanitizer (PHI-key denylist + 8 KiB cap + depth 6 cap +
plain-object enforcement) cannot be bypassed by a stray `.insert()` somewhere
in API or worker code. Rule 8 enforces "logAudit is the only path"; this
package implements the path.

## Public API

```ts
import { logAudit } from "@workspace/resupply-audit";

await logAudit({
  action: "patient.view", // required, free-form verb string
  adminEmail: "ops@…", // optional
  adminUserId: "user_…", // optional
  targetTable: "patients", // optional, e.g. "patients" / "episodes"
  targetId: "pat_abc", // optional
  metadata: { requestId: "…" }, // optional, see "metadata contract"
  ip: "10.0.0.1", // optional
  userAgent: req.get("user-agent"), // optional
});
```

Returns `Promise<void>`. Throws on:

- `AuditMetadataPhiError` — a key matched the PHI denylist
- `AuditMetadataShapeError` — non-plain object, custom `toJSON`, symbol keys, or non-object root
- `AuditMetadataDepthError` — nesting > 6
- `AuditMetadataSizeError` — serialized JSON > 8 KiB
- any underlying `pg` error — connection / constraint / etc.

**Failure semantics: do NOT swallow these.** A thrown sanitizer error
indicates a programmer error (PHI shape leaked into metadata). Surface as 500.
A swallowed error here defeats the entire point of the gate.

## Metadata contract

Metadata is for routing/debugging context — `requestId`, filter shapes,
non-PHI before/after deltas. **Never** put a patient identifier or free-form
clinical text in metadata; put it in the row's `targetId` / `targetTable`
columns instead, or store the actual content in its proper encrypted column
and reference it by ID.

The sanitizer rejects:

- **Strong-token denylist** (any token in the normalized key matches):
  `email`, `phone`, `mobile`, `ssn`, `mrn`, `dob`, `diagnosis`, `transcript`.
  Catches `patientEmail`, `email_address`, `phoneNumber`, `dob`, etc.
- **Joined denylist** (full normalized key matches): `address`, `street`,
  `city`, `zip`, `zipCode`, `postalCode`, `addressLine1`, `addressLine2`,
  `firstName`, `lastName`, `fullName`, `patientName`, `patientNotes`,
  `clinicalNotes`, `dateOfBirth`, `birthDate`, `memberId`, `messageBody`,
  `smsBody`, `emailBody`, `freeText`, `primaryEmail`, `emailAddress`,
  `phoneNumber`.
- **Whole-key denylist** (only when the entire normalized key equals the
  entry — single-token): `name`, `state`, `notes`, `dx`, `condition`.
  `displayName`, `previousState`, `releaseNotes` PASS.

Key normalization runs NFKC unicode normalization, then splits on camelCase /
snake_case / kebab-case / digit boundaries, so unicode confusables and
separator variants all collapse to the same comparison form. When in doubt,
GROW the denylist; do not narrow it.

The sanitizer also refuses any non-plain-JSON shape: class instances, `Map` /
`Set` / `Date` / `Buffer`, objects with a `toJSON` method (which would
silently rewrite the row from a custom serializer), and objects with
symbol-keyed properties.

## Tests

```bash
pnpm --filter @workspace/resupply-audit test
```

- `sanitize.test.ts` — 75 unit cases covering every rejection mode and the
  documented allow-list of compound keys.
- `index.integration.test.ts` — DATABASE_URL-gated; skips cleanly
  when the env is unset. Round-trips a logAudit() call against the
  live DB, asserts the sanitized metadata is what gets stored, and
  cleans up via `DELETE FROM resupply.audit_log WHERE metadata->>'_runTag' = $1`.

## Architecture

See `docs/resupply/adr/006-*.md`. The package depends on `@workspace/resupply-db`
for `getDbPool()` and the `auditLog` schema reference; nothing else in the
resupply tree may write to that table.
