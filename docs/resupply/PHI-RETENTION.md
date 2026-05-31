# PHI retention — prescription document attachments

Status: living doc. Last reviewed 2026-04-30 (sweep job shipped).

## Background

Admins can attach a single prescription document (PDF or image, ≤10MB) per
prescription row. The bytes live in our private Supabase Storage bucket
(named by `SUPABASE_STORAGE_BUCKET_PRIVATE`) under the standard
`objectStorage.getObjectEntityUploadURL()` prefix; the database row in
`prescriptions` carries the object key plus four pieces of display
metadata, and per-object ACLs live in `resupply.object_storage_acls`
(added by migration 0165 — the legacy GCS-custom-metadata ACL approach
is gone). Both the bytes and the row are PHI under HIPAA — a wet-signed
prescription PDF can include patient name, address, DOB, and clinical
detail.

## Lifecycle and orphan analysis

There are four lifecycle events. Only one is asynchronous and not currently
self-cleaning.

### 1. `POST .../upload-url` issued, finalize fired

Normal happy path. The dashboard flow is:

```
POST /upload-url        →  receives presigned PUT URL (bearer token, ~15min)
PUT to Supabase Storage →  bytes land in the bucket
POST /attachment        →  /finalize: re-validates the Supabase Storage
                            object metadata, persists row, inserts the
                            ACL row in resupply.object_storage_acls
```

No orphan possible — every upload produces a row pointer.

### 2. Replacement (existing attachment overwritten by a new one)

Handled by `prescriptions-attachment.ts` finalize handler. After the row
update commits to the new `attachmentObjectKey`, the previous object's bytes
are deleted best-effort. The audit row records the outcome
(`previous_object_deleted: true | "errored"`). On `errored` the new pointer
is correct; the old bytes need a sweep.

### 3. Removal (admin clicks "Remove")

Handled by the DELETE handler. Bytes are deleted before the columns clear so
the audit row can capture `bytes_deleted: true | "errored"`. On `"errored"`
the row is correctly cleared but the bytes need a sweep.

### 4. Orphan source: upload-url issued, PUT happened, finalize never called

Concrete causes:

- Admin starts an upload, browser closes mid-flight, the presigned
  Supabase Storage PUT succeeds but the response never reaches the
  dashboard's finalize call.
- Admin's network drops between PUT and POST.
- Admin opens the file picker, the Supabase Storage PUT fires, then
  the admin navigates away before the finalize POST is dispatched.

Result: bytes in the bucket with no DB row pointing at them, no audit trail
beyond the `upload_url_issued` entry.

This path is now reaped by the **weekly sweep job** described below.
Until that job runs (worst case: 7 days), forensic detection still
works the same way it did before the job shipped: `upload_url_issued`
audit entries without a matching `attachment.upload` entry within 1h
are the indicator.

## Sweep job — shipped, weekly

Implementation: `artifacts/resupply-worker/src/jobs/prescription-attachment-sweep.ts`.

- pg-boss schedule `prescriptions.attachment.sweep`, cron
  `13 3 * * 0` (Sunday 03:13 UTC). Off-hours, doesn't stack with the
  hourly reminders scan that runs at minute 7.
- Algorithm:
  1. SELECT every non-null `attachment_object_key` from
     `prescriptions` (column shape: `/objects/uploads/<uuid>`) into
     a Set.
  2. List bucket objects under `<entity-prefix>/uploads/` in the
     private bucket.
  3. Per bucket object: derive its expected
     `/objects/uploads/<uuid>` shape and look it up in the Set.
     Referenced → leave alone. Unreferenced AND `created_at`
     missing → skip-and-warn (rare Supabase Storage anomaly, safer
     than blind delete; counter alerts operator if persistent).
     Unreferenced
     AND younger than 24h → leave for next run (in-flight finalize
     grace). Unreferenced AND older than 24h → **per-candidate DB
     recheck** (`SELECT 1 FROM prescriptions WHERE
attachment_object_key = $1 LIMIT 1`); if the recheck still
     says unreferenced, delete the bytes. The recheck closes the
     race window between bulk Set-build and per-object delete.
  4. A delete that returns 404 is treated as idempotent success
     (mirrors the api's `ObjectNotFoundError` policy on the user-
     facing DELETE handler).
- Audit row per run via `logAudit({ action:
"prescription.attachment.sweep" })` with counters
  `objects_scanned`, `references_loaded`, `orphans_deleted`,
  `orphans_too_young`, `orphans_no_time_created`, `delete_errors`,
  `delete_404_idempotent`, `recheck_saved`,
  `non_attachment_skipped`. **No object names are persisted** —
  the `/objects/uploads/<uuid>` shape uses an opaque random upload
  id, but the value is durable in `attachment_object_key` and
  one-hop joinable to the patient row, making it a pseudo-identifier
  that must not appear in logs or audit metadata.
- Per-object decisions go to the worker's structured logs (info /
  warn / error) — also counters / classes / age-buckets only.
  `object_name` is **never** logged anywhere; the redaction policy
  is enforced at the log call sites in
  `prescription-attachment-sweep.ts`.
- Boot-time check: `getPrivateObjectLocation()` is called during
  `registerPrescriptionAttachmentSweepJob`, so a missing or
  malformed `SUPABASE_STORAGE_BUCKET_PRIVATE` fails the worker boot
  rather than silently no-op'ing the sweep for the lifetime of the
  deploy.

Operational follow-ups:

- Surface the counters on the admin dashboard's readiness section —
  **reverted**. This shipped as a `PhiSweepStatusCard` tile fed by a
  `prescriptionAttachmentSweep` field on `GET /dashboard/summary`, but
  the tile was removed (it carried no actionable signal for day-to-day
  operators). The durable record of each run is the
  `resupply.worker_run_summary` row
  (`worker_kind = 'prescription_attachment_sweep'`), which operators
  can query directly.
- Promote to nightly cron if any single weekly run deletes >10
  objects, indicating volume has grown past the cheap-to-leave
  threshold.

## Open follow-ups (non-orphan)

- The `resupply.object_storage_acls` row carries `visibility:"private"`
  plus `owner: adminUserId`, but downloads are gated only by
  `requireAdmin` middleware (any allowlisted admin can read any
  prescription scan). This mirrors the existing rule for patient
  `details` PHI in the same dashboard. Tightening to "issuing admin
  or assigned care team only" requires a domain-level access model
  that does not exist yet for any other PHI in the system; out of
  scope here.
- Encryption-at-rest is Supabase-managed (AES-256 on the underlying
  S3-compatible storage). The BAA Supabase signs with PennPaps covers
  the default keys; revisit if compliance later requires
  customer-managed encryption keys (CMEK).
