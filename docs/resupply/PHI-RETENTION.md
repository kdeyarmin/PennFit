# PHI retention — prescription document attachments

Status: living doc. Last reviewed 2026-04-30.

## Background

Admins can attach a single prescription document (PDF or image, ≤10MB) per
prescription row. The bytes live in our default Replit object storage bucket
under the standard `objectStorage.getObjectEntityUploadURL()` prefix; the
database row in `prescriptions` carries the object key plus four pieces of
display metadata. Both layers are PHI under HIPAA — a wet-signed prescription
PDF can include patient name, address, DOB, and clinical detail.

## Lifecycle and orphan analysis

There are four lifecycle events. Only one is asynchronous and not currently
self-cleaning.

### 1. `POST .../upload-url` issued, finalize fired

Normal happy path. The dashboard flow is:

```
POST /upload-url      →  receives presigned PUT URL (bearer token, ~15min)
PUT  to GCS directly  →  bytes land in the bucket
POST /attachment      →  /finalize: re-validates GCS metadata, persists
                          row, sets ACL
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

### 4. **Orphan source still open: upload-url issued, PUT happened, finalize never called**

This is the only remaining unmanaged path. Concrete causes:

- Admin starts an upload, browser closes mid-flight, presigned PUT
  succeeds at GCS but the response never reaches the dashboard's finalize
  call.
- Admin's network drops between PUT and POST.
- Admin opens the file picker, GCS PUT fires, then the admin navigates
  away before the finalize POST is dispatched.

Result: bytes in the bucket with no DB row pointing at them, no audit trail
beyond the `upload_url_issued` entry.

Why not built yet:

- Expected volume: single-digits per week given the three small admin team.
- Detection: `upload_url_issued` audit entries without a matching `upload`
  audit entry within 1h are themselves a forensic indicator — operations
  can grep for them.
- Cost: GCS storage is cheap relative to the engineering time of building,
  testing, and operating a new pg-boss schedule with bucket-list semantics.

## Future sweep job (when volume justifies it)

Sketch — implement as a `lib/resupply-jobs` pg-boss schedule fired daily:

1. List bucket objects under the entity prefix
   (`PRIVATE_OBJECT_DIR/uploads/`).
2. For each object, query `prescriptions` for any row whose
   `attachment_object_key` ends with the object's name. Key format includes
   a UUID so collisions are not a concern.
3. If unreferenced AND object's `timeCreated` is older than 24h (grace
   period for in-flight finalize), `delete()` the object.
4. Emit a per-run audit entry summarizing `objects_scanned`,
   `orphans_deleted`, `errors` so SOC reviewers can see retention is
   actively enforced.

Operationally: run weekly initially, surface counters on the existing
admin dashboard's readiness section. Promote to nightly if the sweep
deletes >10 objects/run.

## Open follow-ups (non-orphan)

- Bucket-side ACL is `visibility:"private"` with `owner: adminClerkId` set
  but downloads are gated only by `requireAdmin` middleware (any allowlisted
  admin can read any prescription scan). This mirrors the existing rule for
  patient `details` PHI in the same dashboard. Tightening to "issuing admin
  or assigned care team only" requires a domain-level access model that does
  not exist yet for any other PHI in the system; out of scope here.
- Encryption-at-rest is GCS-managed (Google's default). For a HIPAA-bound
  launch we will need to either (a) confirm the BAA with Google covers the
  default keys for our project, or (b) move to customer-managed encryption
  keys (CMEK).
