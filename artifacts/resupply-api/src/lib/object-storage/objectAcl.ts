// Object-level ACL helpers. Policies live in
// `resupply.object_storage_acls` (migration 0165) — Supabase Storage's
// JS API doesn't expose per-object custom metadata, so we lift the
// policy into Postgres. The in-process TypeScript surface
// (ObjectAclPolicy, ObjectPermission, canAccessObject, set/get) is
// unchanged so callers don't need to move.

import {
  getOrgScopedClient,
  resolveSeedOrgId,
  type Json,
} from "@workspace/resupply-db";

// Can be flexibly defined according to the use case.
//
// Examples:
// - USER_LIST: the users from a list stored in the database;
// - EMAIL_DOMAIN: the users whose email is in a specific domain;
// - GROUP_MEMBER: the users who are members of a specific group;
// - SUBSCRIBER: the users who are subscribers of a specific service / content
//   creator.
export enum ObjectAccessGroupType {}

export interface ObjectAccessGroup {
  type: ObjectAccessGroupType;
  // The logic id that identifies qualified group members. Format depends on the
  // ObjectAccessGroupType — e.g. a user-list DB id, an email domain, a group id.
  id: string;
}

export enum ObjectPermission {
  READ = "read",
  WRITE = "write",
}

export interface ObjectAclRule {
  group: ObjectAccessGroup;
  permission: ObjectPermission;
}

// Persisted as a JSONB row in resupply.object_storage_acls, keyed by
// (bucket, path).
export interface ObjectAclPolicy {
  owner: string;
  visibility: "public" | "private";
  aclRules?: Array<ObjectAclRule>;
}

/**
 * Stable handle for a stored object. The previous codebase passed
 * `@google-cloud/storage`'s `File` around; we replace it with a
 * lightweight identity record so callers don't need to import any
 * vendor-specific type. Storage I/O always goes through
 * `ObjectStorageService` — this type is identity-only.
 */
export interface StoredObject {
  bucket: string;
  path: string;
}

function isPermissionAllowed(
  requested: ObjectPermission,
  granted: ObjectPermission,
): boolean {
  if (requested === ObjectPermission.READ) {
    return [ObjectPermission.READ, ObjectPermission.WRITE].includes(granted);
  }
  return granted === ObjectPermission.WRITE;
}

abstract class BaseObjectAccessGroup implements ObjectAccessGroup {
  constructor(
    public readonly type: ObjectAccessGroupType,
    public readonly id: string,
  ) {}

  public abstract hasMember(userId: string): Promise<boolean>;
}

function createObjectAccessGroup(
  group: ObjectAccessGroup,
): BaseObjectAccessGroup {
  switch (group.type) {
    // Implement per access group type, e.g.:
    // case "USER_LIST":
    //   return new UserListAccessGroup(group.id);
    default:
      throw new Error(`Unknown access group type: ${group.type}`);
  }
}

export class ObjectAlreadyOwnedError extends Error {
  constructor() {
    super("Object is already claimed by another owner");
    this.name = "ObjectAlreadyOwnedError";
  }
}

export async function setObjectAclPolicy(
  obj: StoredObject,
  aclPolicy: ObjectAclPolicy,
): Promise<void> {
  const orgId = await resolveSeedOrgId();
  if (!orgId) {
    throw new Error("tenant context missing");
  }
  const supabase = getOrgScopedClient(orgId);

  // Reject if an owner is already set and it differs from the incoming
  // owner. This prevents a customer from supplying a previously-issued
  // objectPath that belongs to another customer and hijacking its
  // ownership.
  // `object_storage_acls` is a GLOBAL (non-org-scoped) table — use the
  // unscoped client via `.raw()`.
  const { data: existing, error: readErr } = await supabase
    .raw()
    .schema("resupply")
    .from("object_storage_acls")
    .select("owner_id")
    .eq("bucket", obj.bucket)
    .eq("path", obj.path)
    .maybeSingle();
  if (readErr) {
    throw new Error(
      `Failed to read existing ACL for ${obj.bucket}/${obj.path}: ${readErr.message}`,
    );
  }
  if (existing?.owner_id && existing.owner_id !== aclPolicy.owner) {
    throw new ObjectAlreadyOwnedError();
  }

  const { error: writeErr } = await supabase
    .raw()
    .schema("resupply")
    .from("object_storage_acls")
    .upsert(
      {
        bucket: obj.bucket,
        path: obj.path,
        policy: aclPolicy as unknown as Json,
        owner_id: aclPolicy.owner,
        visibility: aclPolicy.visibility,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "bucket,path" },
    );
  if (writeErr) {
    throw new Error(
      `Failed to write ACL for ${obj.bucket}/${obj.path}: ${writeErr.message}`,
    );
  }
}

export async function getObjectAclPolicy(
  obj: StoredObject,
): Promise<ObjectAclPolicy | null> {
  const orgId = await resolveSeedOrgId();
  if (!orgId) return null;
  const supabase = getOrgScopedClient(orgId);
  // `object_storage_acls` is a GLOBAL (non-org-scoped) table — use the
  // unscoped client via `.raw()`.
  const { data, error } = await supabase
    .raw()
    .schema("resupply")
    .from("object_storage_acls")
    .select("policy")
    .eq("bucket", obj.bucket)
    .eq("path", obj.path)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to read ACL for ${obj.bucket}/${obj.path}: ${error.message}`,
    );
  }
  if (!data?.policy) return null;
  return data.policy as unknown as ObjectAclPolicy;
}

export async function canAccessObject({
  userId,
  objectFile,
  requestedPermission,
}: {
  userId?: string;
  objectFile: StoredObject;
  requestedPermission: ObjectPermission;
}): Promise<boolean> {
  const aclPolicy = await getObjectAclPolicy(objectFile);
  if (!aclPolicy) {
    return false;
  }

  if (
    aclPolicy.visibility === "public" &&
    requestedPermission === ObjectPermission.READ
  ) {
    return true;
  }

  if (!userId) {
    return false;
  }

  if (aclPolicy.owner === userId) {
    return true;
  }

  for (const rule of aclPolicy.aclRules || []) {
    const accessGroup = createObjectAccessGroup(rule.group);
    if (
      (await accessGroup.hasMember(userId)) &&
      isPermissionAllowed(requestedPermission, rule.permission)
    ) {
      return true;
    }
  }

  return false;
}
