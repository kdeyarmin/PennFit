// Assignable-staff resolution for the company calendar.
//
// "Assignable" mirrors the team UI's EFFECTIVE-active status so the calendar's
// "Assign to" picker and the server-side validation agree: a staff member is
// assignable when their `admin_users` row is NOT revoked AND the linked
// `resupply_auth.users` row has verified its email (i.e. the invite was
// accepted). See routes/admin/team.ts:effectiveStatus — revoked → revoked;
// email_verified_at set → active; else → pending.
//
// Keyed by auth_user_id, which lines up with company_calendar_events
// `created_by_user_id` / `req.adminUserId` and the "assigned to me" dashboard
// read. Lives here (not in the team route) because the calendar is gated by
// `requireAdmin` (admins AND agents), while /admin/team is requireAdminOnly —
// agents who can edit the calendar must still be able to load + validate
// assignees.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface AssignableStaff {
  /** resupply_auth.users.id — equals req.adminUserId / created_by_user_id. */
  userId: string;
  email: string;
  displayName: string | null;
}

/** Auth-user ids (subset of the input) whose email is verified. */
async function emailVerifiedSet(
  supabase: SupabaseClient,
  authUserIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (authUserIds.length === 0) return out;
  const { data, error } = await supabase
    .schema("resupply_auth")
    .from("users")
    .select("id, email_verified_at")
    .in("id", authUserIds);
  if (error) throw error;
  for (const r of data ?? []) {
    if (r.email_verified_at) out.add(r.id);
  }
  return out;
}

/** Every effectively-active staff member, for the assignee picker. */
export async function listAssignableStaff(
  supabase: SupabaseClient,
): Promise<AssignableStaff[]> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("auth_user_id, email_lower, display_name, status")
    .neq("status", "revoked")
    .not("auth_user_id", "is", null)
    .order("display_name", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []).filter(
    (r): r is typeof r & { auth_user_id: string } => r.auth_user_id != null,
  );
  const verified = await emailVerifiedSet(
    supabase,
    rows.map((r) => r.auth_user_id),
  );
  return rows
    .filter((r) => verified.has(r.auth_user_id))
    .map((r) => ({
      userId: r.auth_user_id,
      email: r.email_lower,
      displayName: r.display_name,
    }));
}

/**
 * Validate a single assignee by auth-user id, returning their email + display
 * name when they are effectively active, else null (so the route can reject
 * the assignment rather than email an arbitrary / revoked address).
 */
export async function resolveAssignableStaff(
  supabase: SupabaseClient,
  authUserId: string,
): Promise<AssignableStaff | null> {
  const { data, error } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("auth_user_id, email_lower, display_name, status")
    .eq("auth_user_id", authUserId)
    .neq("status", "revoked")
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data || !data.auth_user_id) return null;
  const verified = await emailVerifiedSet(supabase, [data.auth_user_id]);
  if (!verified.has(data.auth_user_id)) return null;
  return {
    userId: data.auth_user_id,
    email: data.email_lower,
    displayName: data.display_name,
  };
}
