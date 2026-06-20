-- 0165_object_storage_acls.sql
--
-- ACL metadata for objects stored in Supabase Storage. Replaces the
-- GCS custom-metadata "custom:aclPolicy" key the old Replit-backed
-- ObjectStorageService used: Supabase Storage doesn't expose
-- per-object custom metadata through the JS API, so we lift the
-- policy into a sibling Postgres table keyed by (bucket, path).
--
-- The policy column mirrors the previous JSON shape
-- ({ owner, visibility, aclRules }) so the in-app TypeScript surface
-- (ObjectAclPolicy, ObjectPermission, ObjectAccessGroup) is unchanged.

CREATE TABLE IF NOT EXISTS resupply.object_storage_acls (
  bucket TEXT NOT NULL,
  path TEXT NOT NULL,
  policy JSONB NOT NULL,
  owner_id TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (bucket, path)
);

-- Owner-id lookup is the only secondary access pattern: the read path
-- joins `auth.users` against `owner_id` when an authenticated request
-- asks "do I own this object?". Visibility is denormalized off the
-- JSONB so a public-object read can SELECT visibility without parsing
-- the policy blob.
CREATE INDEX IF NOT EXISTS object_storage_acls_owner_idx
  ON resupply.object_storage_acls (owner_id)
  WHERE owner_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS object_storage_acls_visibility_idx
  ON resupply.object_storage_acls (visibility);
