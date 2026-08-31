// open-outreach-episode.ts — the missing producer for the resupply ladder.
//
// Reminders, escalations, SMS/email/voice confirm, and PacWare "ready to
// sync" all CONSUME `resupply.episodes`. Until this helper existed, nothing
// in production code INSERTed them — patient create, prescription create,
// CSV/PacWare import, and workers only read. New patients never entered
// the funnel unless rows were planted out of band.
//
// Contract:
//   * Opens one `outreach_pending` episode for (org, patient, prescription).
//   * Idempotent against OUTREACH-OPEN rows for the same prescription —
//     a double-submit, or a confirm that already opened the next cycle,
//     returns the existing id. That set deliberately EXCLUDES `confirmed`:
//     the confirm path opens the next cycle while the current row is still
//     `confirmed`, and including it would make that a silent no-op — the
//     "automation is one-shot" bug this helper exists to fix.
//   * `due_at` = `from + cadenceDays` (default `from = now`). Matches the
//     reminder algorithm's "daysSince(lastShipped ?? rxCreated) ≥ cadence"
//     when there is no ship history yet.
//   * Never touches PHI columns. Failures throw so callers can decide
//     whether to fail the parent write or log-and-continue.

import { getOrgScopedClient } from "@workspace/resupply-db";
import {
  EPISODE_EXPIRY_DAYS,
  OUTREACH_OPEN_EPISODE_STATUSES,
} from "@workspace/resupply-domain";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface OpenOutreachEpisodeInput {
  orgId: string;
  patientId: string;
  prescriptionId: string;
  /** Cadence in days — usually `prescriptions.cadence_days`. */
  cadenceDays: number;
  /** Anchor for due_at. Defaults to now. */
  from?: Date;
}

export interface OpenOutreachEpisodeResult {
  episodeId: string;
  /** False when an in-progress episode already existed for this Rx. */
  created: boolean;
}

/**
 * Open (or reuse) the in-progress outreach episode for a prescription.
 */
export async function openOutreachEpisode(
  input: OpenOutreachEpisodeInput,
): Promise<OpenOutreachEpisodeResult> {
  const cadenceDays = Math.max(1, Math.floor(input.cadenceDays));
  const supabase = getOrgScopedClient(input.orgId);

  const { data: existing, error: existingErr } = await supabase
    .from("episodes")
    .select("id")
    .eq("prescription_id", input.prescriptionId)
    .eq("patient_id", input.patientId)
    .in("status", [...OUTREACH_OPEN_EPISODE_STATUSES])
    .limit(1)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existing?.id) {
    return { episodeId: existing.id, created: false };
  }

  const from = input.from ?? new Date();
  const dueAt = new Date(from.getTime() + cadenceDays * DAY_MS);

  const { data, error } = await supabase
    .from("episodes")
    .insert({
      patient_id: input.patientId,
      prescription_id: input.prescriptionId,
      status: "outreach_pending",
      due_at: dueAt.toISOString(),
      // Give the expiry sweep something to read. Before this, expires_at
      // had existed since migration 0000 with no writer at all, so the
      // `expired` status and the /admin/episodes?status=expired filter
      // could never match anything.
      expires_at: new Date(
        dueAt.getTime() + EPISODE_EXPIRY_DAYS * DAY_MS,
      ).toISOString(),
    })
    .select("id")
    .single();
  if (error) throw error;
  return { episodeId: data.id, created: true };
}
