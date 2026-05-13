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

/** Return the active closure as of `asOf`, or null when none.
 *  Checks both one-off (office_closures) and recurring weekly
 *  patterns (office_recurring_closures). One-offs win on ties so
 *  a recorded "Christmas Day" closure overrides a generic "every
 *  Sunday" rule if both happen to overlap. */
export async function findActiveClosure(
  supabase: SupabaseClient,
  asOf: Date = new Date(),
): Promise<ActiveClosure | null> {
  const iso = asOf.toISOString();
  // One-off check first.
  const { data: oneOff, error: oneOffErr } = await supabase
    .schema("resupply")
    .from("office_closures")
    .select("id, label, starts_at, ends_at, auto_reply_message")
    .lte("starts_at", iso)
    .gt("ends_at", iso)
    .order("ends_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (oneOffErr) throw oneOffErr;
  if (oneOff) {
    return {
      id: oneOff.id,
      label: oneOff.label,
      startsAt: oneOff.starts_at,
      endsAt: oneOff.ends_at,
      autoReplyMessage: oneOff.auto_reply_message,
    };
  }

  // Recurring check.
  const day = asOf.getUTCDay();
  const hh = String(asOf.getUTCHours()).padStart(2, "0");
  const mm = String(asOf.getUTCMinutes()).padStart(2, "0");
  const ss = String(asOf.getUTCSeconds()).padStart(2, "0");
  const nowTimeUtc = `${hh}:${mm}:${ss}`;
  const { data: recurring, error: recErr } = await supabase
    .schema("resupply")
    .from("office_recurring_closures")
    .select(
      "id, label, day_of_week, start_time_utc, end_time_utc, auto_reply_message, active",
    )
    .eq("day_of_week", day)
    .eq("active", 1)
    .lte("start_time_utc", nowTimeUtc)
    .gt("end_time_utc", nowTimeUtc)
    .limit(1)
    .maybeSingle();
  if (recErr) throw recErr;
  if (!recurring) return null;
  return {
    id: recurring.id,
    label: recurring.label,
    // For consistency with the one-off response shape, synthesize
    // a starts/ends from the recurring pattern applied to today.
    startsAt: synthDateTime(asOf, recurring.start_time_utc),
    endsAt: synthDateTime(asOf, recurring.end_time_utc),
    autoReplyMessage: recurring.auto_reply_message,
  };
}

function synthDateTime(day: Date, hhmmss: string): string {
  const d = new Date(day);
  const [h, m, s] = hhmmss.split(":").map(Number);
  d.setUTCHours(h ?? 0, m ?? 0, s ?? 0, 0);
  return d.toISOString();
}
