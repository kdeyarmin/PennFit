# Audit log retention and redaction policy

Status: design doc. Living. Last reviewed 2026-05-08.

## What this covers

`resupply.audit_log` and the legacy `admin_audit_log` table.

The PHI-storage rules for these tables, what we treat as
operationally precious, when (if ever) we redact rows, and the
threat model that drives those decisions.

For PHI flowing through _attachment_ storage, see
[`PHI-RETENTION.md`](./PHI-RETENTION.md). This doc is about the
audit channel only.

## The design rule, restated

`resupply.audit_log` is **append-only** by code policy. No
production code path issues `DELETE` or `UPDATE` against it. The
sanitizer in `lib/resupply-audit/src/sanitize.ts` is the single
chokepoint — see the file header for the active denylist plus
size and depth caps.

This isn't a HIPAA _requirement_ (BAAs don't mandate immutability),
but it's how we keep the audit channel trustworthy: a row that can
be silently rewritten by a compromised admin is not a useful
forensic artifact.

## What the rows can and cannot contain

| Allowed                                                         | Forbidden                                           |
| --------------------------------------------------------------- | --------------------------------------------------- |
| Stable identifiers (patient_id, episode_id, conversation_id)    | Bare PHI strings (name, phone, email, address, DOB) |
| Stripe object ids (`cs_…`, `pi_…`, `re_…`)                      | Card numbers, full PAN, security codes              |
| Counts, durations, statuses, enum values                        | Free-text message bodies                            |
| HTTP method, route, status code, error name                     | Stack traces with embedded paths to PHI bytes       |
| Vendor message ids (`twilio_message_sid`, SendGrid `messageId`) | Phone numbers, even hashed                          |
| Operator email                                                  | Patient email                                       |

The sanitizer denylist enforces the right-hand column on a key-name
basis. If a key name _suggests_ PHI (`phone`, `email`, `dob`,
`ssn`, `address`, `name`, `dx`, …), the sanitizer throws
`AuditMetadataPhiError` and the call site sees a 500 instead of a
silent leak. The list is in `sanitize.ts` and is the canonical
source of truth — update both file and this doc together.

## Retention horizon

There is no automated purge today.

The **operational ceiling** is set by:

1. The Postgres instance's storage budget on the deploy plan.
2. The slowest customer support workflow that reads back into the
   table (today: refund / dispute reconciliation, ~90 days).

Audit rows are small (sub-kilobyte each) and the table grows by
roughly the per-day request volume of admin actions and webhooks.
At current traffic the table will stay under 10 GB indefinitely;
there is no scheduled trim.

## When we DO redact

A redaction is the surgical zeroing of a _single_ row (or a small
contiguous batch of rows) — never a `TRUNCATE`. We've not had to
do one in production yet. The supported reasons:

1. **GDPR / CCPA "right to erasure" request from a customer whose
   PII slipped into metadata** (e.g. a free-text note that
   bypassed the sanitizer because the key was `notes`, not
   `comment`). Redaction must:
   - Replace `metadata` with `'{"redacted": "gdpr-2026-NN"}'`
     where `NN` is a ticket number.
   - Leave every other column intact (action, target_table,
     target_id, operator_email) so the operational meaning of the
     row survives.
   - Be itself audited, with a new `audit_log.redaction_applied`
     row that points at the redacted row's id.

2. **Confirmed PHI leak** — a sanitizer gap that allowed PHI past
   the gate. Same procedure as above, plus a sanitizer fix in the
   same PR.

We deliberately do NOT redact for:

- "We changed our mind about retention" — change the policy here
  and apply it forward.
- "An admin's account was deleted" — the operator_email column is
  a denormalized snapshot at write time, not a foreign key. A
  deleted admin doesn't break the row.

## Redaction procedure (manual, infrequent)

1. Open a ticket (`#audit-redaction-NN`). Capture: row id,
   reason, who approved.
2. Run the redaction in a transaction:
   ```sql
   BEGIN;
   UPDATE resupply.audit_log
   SET metadata = '{"redacted": "gdpr-2026-NN"}'::jsonb
   WHERE id = '...';
   INSERT INTO resupply.audit_log
     (operator_email, action, target_table, target_id, metadata)
   VALUES (
     'redaction-bot@pennpaps.com',
     'audit_log.redaction_applied',
     'audit_log',
     '...',
     jsonb_build_object('reason', 'gdpr', 'ticket', 'audit-redaction-NN')
   );
   COMMIT;
   ```
3. Update the ticket with the row id of the redaction marker so
   reviewers can audit the audit-trim.

The "redaction marker" pattern — leave the original row, write a
companion row recording WHY — keeps the audit channel honest.

## What's intentionally out of scope

- **Encryption-at-rest of the metadata column.** The Postgres
  instance is provider-encrypted; column-level encryption was
  removed (see migration 0025) and is not coming back without a
  fresh threat-model review. The trade-off was operational
  visibility — encrypted metadata can't be queried for support.

- **Field-level access controls on the table itself.** Today the
  same DB role that runs the API can read every row. A future
  enhancement (split a read-only `audit_reader` role with no
  ability to issue UPDATE) would harden against an `evil admin
with shell` threat but is not part of the current model.

- **Tamper-evidence (Merkle / hash chain).** Same — out of scope
  until we see a credible threat model that needs it.

## When this policy needs to change

Open a PR that updates this doc _first_, then changes
`sanitize.ts`. Any new sanitizer rule lands with: (1) a denylist
entry, (2) a unit test in `sanitize.test.ts` that asserts the
new key triggers `AuditMetadataPhiError`, (3) a one-line update
to the table above.

## Related docs

- [`PHI-RETENTION.md`](./PHI-RETENTION.md) — attachment lifecycle.
- [`RUNBOOK-secrets.md`](./RUNBOOK-secrets.md) — secret rotation
  procedures (no audit interaction today).
- [`stripe-webhook-events.md`](./stripe-webhook-events.md) —
  which webhook events emit which audit verbs.
