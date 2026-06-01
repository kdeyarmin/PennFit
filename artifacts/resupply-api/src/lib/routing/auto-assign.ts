// Auto-assign a conversation to the top-ranked admin per the
// skill-based scoreCandidates helper.
//
// Behavior:
//   * Reads the conversation; refuses to overwrite an existing
//     assignment (returns { assigned: false, reason: "already_assigned" }).
//   * If required_skills is empty, returns { assigned: false,
//     reason: "no_required_skills" } — auto-assignment is opt-in
//     per conversation. A supervisor / template still has to mark
//     the skills required.
//   * Pulls active admin_users + their open-queue depth; calls
//     the pure scoreCandidates helper.
//   * Refuses to assign when the top candidate has zero matched
//     skills — there's nobody on staff who fits. We don't want
//     to pick a random admin and pretend it's a routing decision.
//
// Returns the assigned admin id when the move went through.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { scoreCandidates } from "./skill-score";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export type AutoAssignResult =
  | { assigned: true; adminUserId: string; matchedSkillCount: number }
  | {
      assigned: false;
      reason:
        | "conversation_not_found"
        | "already_assigned"
        | "no_required_skills"
        | "no_eligible_candidate";
    };

export async function maybeAutoAssignConversation(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<AutoAssignResult> {
  const { data: convo, error: convoErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("id, assigned_admin_user_id, required_skills")
    .eq("id", conversationId)
    .limit(1)
    .maybeSingle();
  if (convoErr) throw convoErr;
  if (!convo) return { assigned: false, reason: "conversation_not_found" };

  if (convo.assigned_admin_user_id) {
    return { assigned: false, reason: "already_assigned" };
  }
  const required = Array.isArray(convo.required_skills)
    ? (convo.required_skills as string[])
    : [];
  if (required.length === 0) {
    return { assigned: false, reason: "no_required_skills" };
  }

  const { data: admins, error: adminErr } = await supabase
    .schema("resupply")
    .from("admin_users")
    .select("id, skills, availability")
    .eq("status", "active");
  if (adminErr) throw adminErr;
  // Skip reps who've flipped themselves away / do-not-assign (CSR #16).
  // Anything else (incl. a missing value) counts as available, so the
  // pre-availability behavior is preserved.
  const adminList = (admins ?? []).filter(
    (a) => a.availability !== "away" && a.availability !== "do_not_assign",
  );
  if (adminList.length === 0) {
    return { assigned: false, reason: "no_eligible_candidate" };
  }
  const adminIds = adminList.map((a) => a.id);

  const { data: openConvos, error: openErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .select("assigned_admin_user_id")
    .in("assigned_admin_user_id", adminIds)
    .in("status", ["open", "awaiting_admin", "awaiting_patient"]);
  if (openErr) throw openErr;
  const queueSize = new Map<string, number>();
  for (const r of openConvos ?? []) {
    const id = r.assigned_admin_user_id;
    if (!id) continue;
    queueSize.set(id, (queueSize.get(id) ?? 0) + 1);
  }

  const scored = scoreCandidates({
    requiredSkills: required,
    candidates: adminList.map((a) => ({
      adminUserId: a.id,
      skills: Array.isArray(a.skills) ? (a.skills as string[]) : [],
      openQueueSize: queueSize.get(a.id) ?? 0,
    })),
  });

  const top = scored[0];
  if (!top || top.matchedSkillCount === 0) {
    return { assigned: false, reason: "no_eligible_candidate" };
  }

  // Atomic assign: only stamp the row when assigned_admin_user_id
  // is still null. A second concurrent caller losing the race will
  // match 0 rows and we return "already_assigned" via the post-
  // write re-read.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .schema("resupply")
    .from("conversations")
    .update({
      assigned_admin_user_id: top.adminUserId,
      assigned_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", conversationId)
    .is("assigned_admin_user_id", null)
    .select("id");
  if (claimErr) throw claimErr;
  if (!claimed || claimed.length === 0) {
    return { assigned: false, reason: "already_assigned" };
  }
  return {
    assigned: true,
    adminUserId: top.adminUserId,
    matchedSkillCount: top.matchedSkillCount,
  };
}
