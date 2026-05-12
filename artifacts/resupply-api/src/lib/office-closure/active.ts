// Helper for reading "is the office closed RIGHT NOW?" — used by
// the inbound SMS handler to swap the normal intent dispatcher for
// an auto-reply, and by the admin UI to render a banner.

import type { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

type SupabaseClient = ReturnType<typeof getSupabaseServiceRoleClient>;

export interface ActiveClosure {
  id: string;
  label: string;
  startsAt: string;
  endsAt: string;
  autoReplyMessage: string;
}

/** Return the active closure as of `asOf`, or null when none. When
 *  multiple rows overlap (rare — two closures stacking on the same
 *  day), we pick the one ending soonest so the auto-reply text
 *  matches the user-facing copy that's about to expire. */
export async function findActiveClosure(
  supabase: SupabaseClient,
  asOf: Date = new Date(),
): Promise<ActiveClosure | null> {
  const iso = asOf.toISOString();
  const { data, error } = await supabase
    .schema("resupply")
    .from("office_closures")
    .select("id, label, starts_at, ends_at, auto_reply_message")
    .lte("starts_at", iso)
    .gt("ends_at", iso)
    .order("ends_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id,
    label: data.label,
    startsAt: data.starts_at,
    endsAt: data.ends_at,
    autoReplyMessage: data.auto_reply_message,
  };
}
