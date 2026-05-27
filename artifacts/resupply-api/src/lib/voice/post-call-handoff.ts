// Voice → CSR handoff routing.
//
// When the post-call summarizer flips `recommendsHandoff: true`, the
// audit row alone is not enough — supervisors don't browse audit
// logs in real time. The original review (PR #340) called this out:
// "the post-call summary is great but lives in audit. When the model
// flags `recommendsHandoff: true`, route the summary into a CSR-
// triage queue with the patient pre-bound to a draft reply —
// currently the CSR has to discover the flag."
//
// This helper closes that gap by reusing the existing escalation
// infrastructure on `resupply.conversations`:
//
//   - `escalated_at`         — stamped to NOW if currently NULL
//                              (do NOT overwrite a prior escalation —
//                               a human-set reason carries more
//                               context than a model-set one).
//   - `escalation_reason`    — a short, machine-parseable string
//                              prefixed with `voice_post_call_handoff:`
//                              so a future query can isolate this
//                              source from human-initiated escalations.
//   - `priority`             — bumped to "urgent" when sentiment is
//                              "distressed", otherwise "high". Never
//                              downgraded (we respect a prior bump).
//   - `tags`                 — appends `voice-handoff` if absent so
//                              the supervisor's tag-filter view picks
//                              up these calls without combing the
//                              escalation reason text.
//
// Routing surface (no new UI required):
//   Today the admin SPA's `/conversations?view=escalated` filter
//   shows every row with `escalated_at IS NOT NULL`. The handoff
//   conversations land there immediately. The escalation_reason
//   prefix lets supervisors search/filter by source if they want.
//
// Failure mode:
//   Best-effort. Returns void; any DB error logs a WARN and
//   resolves cleanly. The caller (runPostCallSummary in ws-handler)
//   runs detached after the WS has already closed; a routing failure
//   must not crash the call cleanup path.

import { getSupabaseServiceRoleClient } from "@workspace/resupply-db";

import { logger } from "../logger";

type ConversationPriority = "low" | "normal" | "high" | "urgent";

const PRIORITY_RANK: Record<ConversationPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  urgent: 3,
};

/** Tag we add to handoff-flagged conversations so a tag-filter view
 *  surfaces them without parsing the escalation_reason text. */
export const VOICE_HANDOFF_TAG = "voice-handoff";

/** Stable prefix on escalation_reason so a SQL filter can isolate
 *  voice-initiated escalations from human-initiated ones. Keep this
 *  matching the analytics dashboards once they exist. */
const HANDOFF_REASON_PREFIX = "voice_post_call_handoff";

export interface RouteVoiceHandoffInput {
  conversationId: string;
  /**
   * Post-call summary outcome string. Appears after the reason
   * prefix so a supervisor scanning the queue sees a one-line "why".
   * Sanitised by the summarizer's PHI rules — but we truncate
   * defensively before persisting.
   */
  outcome: string;
  /**
   * Distressed sentiment routes at urgent priority. Anything else
   * (positive / neutral / concerned) routes at high.
   */
  sentiment: "positive" | "neutral" | "concerned" | "distressed";
}

/**
 * Maximum length of the persisted escalation_reason field. Long
 * enough to carry the prefix + sentiment + a substantive outcome
 * sentence; short enough that the column doesn't bloat the row.
 */
const ESCALATION_REASON_MAX = 240;

function buildEscalationReason(input: RouteVoiceHandoffInput): string {
  const head = `${HANDOFF_REASON_PREFIX} (${input.sentiment}): `;
  const body = input.outcome.replace(/\s+/g, " ").trim();
  const total = `${head}${body}`;
  return total.length > ESCALATION_REASON_MAX
    ? total.slice(0, ESCALATION_REASON_MAX - 1) + "…"
    : total;
}

/**
 * Escalate the conversation so a supervisor sees it in the
 * `view=escalated` queue. Idempotent: a conversation that has been
 * escalated by a human (any prior escalated_at) is left alone — the
 * human's reason carries more context than the model's. Tags are
 * deduped on the way in.
 *
 * Resolves cleanly on every code path. Logs structured outcomes for
 * observability dashboards.
 */
export async function routeVoiceHandoffToCsrQueue(
  input: RouteVoiceHandoffInput,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();

  try {
    const { data: row, error: readErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .select("id, priority, tags, escalated_at, escalation_reason")
      .eq("id", input.conversationId)
      .limit(1)
      .maybeSingle();
    if (readErr) throw readErr;
    if (!row) {
      logger.warn(
        {
          event: "voice_handoff_skipped",
          reason: "conversation_not_found",
          conversationId: input.conversationId,
        },
        "voice handoff: conversation row missing — cannot escalate",
      );
      return;
    }

    // If a human already escalated this row, leave their context in
    // place. The audit log still records the model's recommendation
    // alongside their reason, so nothing is lost.
    if (row.escalated_at) {
      logger.info(
        {
          event: "voice_handoff_skipped",
          reason: "already_escalated",
          conversationId: input.conversationId,
          existingReason: row.escalation_reason,
        },
        "voice handoff: conversation already escalated — leaving in place",
      );
      return;
    }

    // Distressed → urgent; everything else → high, but never DOWNGRADE.
    const currentPriority =
      (row.priority as ConversationPriority | null) ?? "normal";
    const targetPriority: ConversationPriority =
      input.sentiment === "distressed" ? "urgent" : "high";
    const nextPriority: ConversationPriority =
      PRIORITY_RANK[currentPriority] < PRIORITY_RANK[targetPriority]
        ? targetPriority
        : currentPriority;

    // Dedup the tag — `tags` is a JSONB array of strings. The set
    // membership check tolerates a row whose tags column is null or
    // a non-array shape (defensive).
    const existingTags = Array.isArray(row.tags)
      ? (row.tags as unknown[]).filter((t): t is string => typeof t === "string")
      : [];
    const nextTags = existingTags.includes(VOICE_HANDOFF_TAG)
      ? existingTags
      : [...existingTags, VOICE_HANDOFF_TAG];

    const nowIso = new Date().toISOString();
    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("conversations")
      .update({
        escalated_at: nowIso,
        escalation_reason: buildEscalationReason(input),
        priority: nextPriority,
        tags: nextTags,
        updated_at: nowIso,
      })
      .eq("id", input.conversationId)
      // Guard against a concurrent human escalation racing us — only
      // write when escalated_at is still NULL. PostgREST's missing-
      // server-side-locking means this is the cheapest equivalent.
      .is("escalated_at", null);
    if (updateErr) throw updateErr;

    logger.info(
      {
        event: "voice_handoff_routed",
        conversationId: input.conversationId,
        sentiment: input.sentiment,
        priorityFrom: currentPriority,
        priorityTo: nextPriority,
        addedTag: !existingTags.includes(VOICE_HANDOFF_TAG),
      },
      "voice handoff: conversation escalated for CSR follow-up",
    );
  } catch (err) {
    logger.warn(
      {
        event: "voice_handoff_failed",
        conversationId: input.conversationId,
        err:
          err instanceof Error
            ? { name: err.name, message: err.message.slice(0, 200) }
            : { name: "unknown" },
      },
      "voice handoff: routing failed (call cleanup unaffected)",
    );
  }
}
