// reminders.escalation-scan — multi-channel escalation for unanswered
// resupply reminders (#7).
//
// The hourly reminders.scan does the FIRST touch on a single text channel
// (sms OR email, per resolveOutreachPlan). It never follows up on a
// different channel. This job is the additive second half: a daily sweep
// that, for episodes still unresolved after their first reminder, walks them
// up a channel ladder — and once every channel has been tried, raises a CSR
// "call them" alert.
//
// The ladder
// ----------
//   sms → email → voice → CSR alert
//
//   The first two tiers reuse the existing SEND_SMS_JOB / SEND_EMAIL_JOB
//   queues. The "voice" tier is OPT-IN and additive: it is appended to a
//   tenant's ladder only when (a) the per-tenant `reminder_escalation.voice`
//   flag is on AND (b) the voice path is actually configured. When either is
//   false the ladder stays sms → email → CSR alert — the exact pre-voice
//   behavior. The voice tier places an automated AI resupply check-in call
//   via the `reminders.place-call` job (the same agent an admin reaches with
//   the patient "Call" button).
//
// Step spacing (dual anchor)
// --------------------------
//   We measure two ages per episode from its reminder conversations:
//     * firstTouchAge = now − EARLIEST reminder  → the "stop nagging past
//       ESCALATION_MAX_DAYS" cap, anchored on the first touch.
//     * sinceLastTouch = now − LATEST  reminder  → the "wait at least
//       ESCALATION_DELAY_DAYS between steps" gate, anchored on the most
//       recent touch.
//   Anchoring the step gate on the LATEST touch (not the earliest) is what
//   spaces the ladder out: a patient texted on day 0 and emailed on day 3
//   isn't called until ~day 6 and isn't handed to a CSR until ~day 9 —
//   rather than the whole ladder firing on consecutive days.
//
// Why a separate job (not surgery on reminders.scan):
//   The scan is the central, high-traffic loop. Bolting escalation state
//   into it risks the first-touch path. This job is isolated,
//   feature-flagged, and reuses the existing per-channel send queues — so
//   the actual send still runs through the same dedup + business-hours-safe
//   + audit machinery. We only decide WHICH episodes get the next channel
//   and enqueue it.
//
// Resolution signal:
//   We only consider episodes still in `outreach_pending` /
//   `awaiting_response`. The moment a patient confirms / declines (or the
//   episode is fulfilled / canceled) it leaves that set and is never
//   escalated.
//
// Quiet-hours:
//   The job is scheduled at 18:00 UTC (1pm ET / 10am PT), inside 9am–8pm
//   local for every continental-US timezone, so an SMS/voice escalation
//   can't land in a patient's quiet hours. The send jobs re-check the
//   recipient's local window as a backstop (HI/AK).
//
// Idempotency:
//   Escalating to a channel creates a new conversation on that channel
//   (sendReminder* / placeOutboundReorderCall do that), so the next daily
//   run sees that channel tried and moves on. The per-day-per-channel dedup
//   in the send jobs prevents a double-send within a day. The CSR alert is
//   collapsed to one open row per patient by the existing partial unique
//   index.

import type PgBoss from "pg-boss";

import {
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";
import type { ReminderVariant } from "@workspace/resupply-reminders";

import { getTenantConfigValue } from "../../lib/app-config/store";
import { isFeatureEnabled } from "../../lib/feature-flags";
import { logger } from "../../lib/logger";
import { notifyReminderEscalation } from "../../lib/slack/notify";
import { readVoiceConfigOrNull } from "../../lib/voice/voice-config";
import { forEachActiveOrg } from "../lib/for-each-active-org";
import { createQueueWithDlq, CRON_SCAN_QUEUE_OPTS } from "../lib/queue-options";
import { SEND_VOICE_JOB } from "./reminder-voice.js";
import {
  IN_PROGRESS_EPISODE_STATUSES,
  SEND_EMAIL_JOB,
  SEND_SMS_JOB,
} from "./reminders.js";

export const ESCALATION_JOB = "reminders.escalation-scan";
// Daily, mid-day UTC (see quiet-hours note above).
const ESCALATION_CRON = "0 18 * * *";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Minimum days between consecutive escalation steps (anchored on the most
 *  recent reminder touch). Also gates the FIRST escalation, since the first
 *  touch is the only touch at that point. */
export const ESCALATION_DELAY_DAYS = 3;
/** Stop escalating (and stop nagging) past this age from the FIRST touch. */
export const ESCALATION_MAX_DAYS = 21;

// Admin-tunable timing (System Configuration → Resupply reminders). Read per-tick
// per tenant from app_config; a blank/out-of-range value falls back to the
// defaults above and is clamped to these bounds so a typo can never break or
// runaway the ladder.
export const ESCALATION_DELAY_DAYS_KEY = "RESUPPLY_ESCALATION_DELAY_DAYS";
export const ESCALATION_MAX_DAYS_KEY = "RESUPPLY_ESCALATION_MAX_DAYS";
const DELAY_DAYS_MIN = 1;
const DELAY_DAYS_MAX = 30;
const MAX_DAYS_CEIL = 120;

export interface EscalationTiming {
  delayDays: number;
  maxDays: number;
}

/**
 * Parse + clamp the admin-supplied cadence into a safe `{ delayDays, maxDays }`.
 * Pure (no I/O) so the clamping is unit-testable. A blank/unparseable value
 * falls back to the built-in default; `maxDays` is floored at `delayDays` (a
 * max below the step spacing would let nothing escalate) and capped at
 * MAX_DAYS_CEIL.
 */
export function resolveEscalationTiming(
  rawDelay: string | null,
  rawMax: string | null,
): EscalationTiming {
  const delayDays = clampInt(
    rawDelay,
    ESCALATION_DELAY_DAYS,
    DELAY_DAYS_MIN,
    DELAY_DAYS_MAX,
  );
  const maxDays = clampInt(
    rawMax,
    ESCALATION_MAX_DAYS,
    // A max below the step delay would stall every episode — floor it at delay.
    delayDays,
    MAX_DAYS_CEIL,
  );
  return { delayDays, maxDays };
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null) return Math.min(max, Math.max(min, fallback));
  const n = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(n)) return Math.min(max, Math.max(min, fallback));
  return Math.min(max, Math.max(min, n));
}

/** Read + clamp a tenant's escalation cadence from app_config (fail-soft). */
async function resolveEscalationTimingForOrg(
  orgId: string,
): Promise<EscalationTiming> {
  const [rawDelay, rawMax] = await Promise.all([
    getTenantConfigValue(orgId, ESCALATION_DELAY_DAYS_KEY),
    getTenantConfigValue(orgId, ESCALATION_MAX_DAYS_KEY),
  ]);
  return resolveEscalationTiming(rawDelay, rawMax);
}
/** Base text-channel ladder, walked in order. Voice is appended per-tenant
 *  (flag + config) in `escalationScanForOrg` — see the file header. */
export const ESCALATION_LADDER = ["sms", "email"] as const;
/** Ladder with the automated-voice tier appended. */
export const ESCALATION_LADDER_WITH_VOICE = ["sms", "email", "voice"] as const;
/**
 * How many times the automated voice tier may dial before giving up and
 * handing to a CSR. Unlike SMS/email (one touch each), a call that goes
 * unanswered / busy / to voicemail is RETRIED up to this cap (spaced by the
 * step delay). A call that REACHES a live person ends the voice tier
 * immediately regardless of attempt count.
 */
export const MAX_VOICE_ATTEMPTS = 2;

// Single source of truth lives in reminders.ts (this scan already imports
// SEND_*_JOB from there) so the two reminder jobs can't drift on which
// episode statuses are still in the funnel.
const IN_PROGRESS_STATUSES = [...IN_PROGRESS_EPISODE_STATUSES];

// ── Pure planner ────────────────────────────────────────────────────

export interface EscalationEpisodeRow {
  id: string;
  patientId: string;
  /**
   * Whether the patient can be reached on each medium. Channels the patient
   * can't receive are skipped so the ladder always advances to the CSR
   * hand-off instead of stalling forever on an un-deliverable step (an
   * email-only patient would otherwise have the SMS/voice tiers re-enqueued
   * every tick — each failing with patient_missing_phone, creating no
   * conversation, so the ladder never records them "tried"). Optional and
   * default-reachable so callers that don't supply capability (older tests)
   * keep the prior behavior.
   */
  hasPhone?: boolean;
  hasEmail?: boolean;
}
export interface EscalationConvRow {
  episodeId: string;
  channel: string;
  createdAtMs: number;
  /**
   * For a `voice` conversation: did the call reach a LIVE person? Derived
   * upstream from the voice-call telemetry (status `completed` and not an
   * AMD "machine"/"fax" verdict). Ignored for text channels. A voice
   * conversation without this set counts as an unanswered attempt — so a
   * no-answer/busy/voicemail call is retried up to the cap rather than
   * counted as "done".
   */
  voiceConnected?: boolean;
}
export interface EscalationPlanInput {
  /** Episodes still unresolved (status-filtered upstream). */
  episodes: EscalationEpisodeRow[];
  /** Reminder conversations (sms/email/voice) for those episodes. */
  conversations: EscalationConvRow[];
  nowMs: number;
  /** Min ms between steps, anchored on the latest touch (see header). */
  delayMs: number;
  /** Max ms from the first touch before we stop escalating. */
  maxMs: number;
  ladder: readonly string[];
  /** Voice dial cap before the CSR hand-off. Defaults to MAX_VOICE_ATTEMPTS. */
  maxVoiceAttempts?: number;
}

interface EpisodeProgress {
  channels: Set<string>;
  earliestMs: number;
  /**
   * Earliest touch on EACH channel, keyed by channel. The step-spacing gate
   * anchors on the most recent of these values — i.e. the last time a NEW
   * channel was first introduced — NOT the latest touch overall. The hourly
   * first-touch scan independently re-pings a still-open episode on its
   * first channel every ~48h (QUIET_PERIOD_MS); counting those re-pings as
   * "the latest touch" kept resetting the spacing gate below the (default
   * 72h) window, stalling the ladder so it never advanced past the first
   * channel to email → voice → CSR. Keying on each channel's FIRST touch
   * makes a same-channel re-ping a no-op for spacing while preserving the
   * "wait delayMs between distinct steps" intent.
   */
  channelFirstMs: Map<string, number>;
  /** Number of voice conversations (dial attempts) for this episode. */
  voiceAttempts: number;
  /** True once any voice attempt reached a live person. */
  voiceConnected: boolean;
}

/**
 * Did a voice call reach a LIVE person? True only when the call COMPLETED and
 * Twilio's AMD verdict isn't a machine/fax pickup. A null verdict (detection
 * off or unresolved) on a completed call defaults to connected — we reached
 * the line. Non-completed terminals (no-answer / busy / failed / canceled) and
 * a voicemail (machine_*) / fax verdict are NOT connected, so the call is
 * retried up to the attempt cap.
 */
export function isVoiceCallConnected(
  status: string | null,
  answeredBy: string | null,
): boolean {
  if (status !== "completed") return false;
  const ab = (answeredBy ?? "").trim().toLowerCase();
  if (ab.startsWith("machine") || ab === "fax") return false;
  return true;
}

/**
 * Has this channel been satisfied for the episode (no further attempt due)?
 * Text channels are satisfied by a single conversation. Voice is satisfied
 * once a call reaches a live person OR the attempt cap is hit — until then an
 * unanswered call is retried.
 */
function channelSatisfied(
  channel: string,
  info: EpisodeProgress,
  maxVoiceAttempts: number,
): boolean {
  if (channel === "voice") {
    return info.voiceConnected || info.voiceAttempts >= maxVoiceAttempts;
  }
  return info.channels.has(channel);
}
export type EscalationTier =
  | { kind: "send"; channel: string; variant: ReminderVariant }
  | { kind: "csr_exhausted"; triedChannels: string[] };
export interface EscalationAction {
  episodeId: string;
  patientId: string;
  tier: EscalationTier;
}

/**
 * Can the patient receive a touch on this channel? SMS and voice need a
 * phone; email needs an email address. Unknown channels are not blocked.
 */
function channelReachable(
  channel: string,
  hasPhone: boolean,
  hasEmail: boolean,
): boolean {
  if (channel === "email") return hasEmail;
  if (channel === "sms" || channel === "voice") return hasPhone;
  return true;
}

/**
 * Decide, per unresolved episode, whether to escalate to the next channel
 * or (once the ladder is exhausted) hand off to a CSR. Pure: the job
 * supplies the rows it read from Postgres.
 *
 * Dual anchor (see file header): the max-age cap measures from the EARLIEST
 * touch (stop nagging N days after we first reached out); the
 * minimum-spacing gate measures from the LATEST touch (wait N days after the
 * most recent reminder before the next step).
 */
export function planReminderEscalations(
  input: EscalationPlanInput,
): EscalationAction[] {
  const maxVoiceAttempts = input.maxVoiceAttempts ?? MAX_VOICE_ATTEMPTS;
  const byEpisode = new Map<string, EpisodeProgress>();
  for (const c of input.conversations) {
    if (!input.ladder.includes(c.channel)) continue;
    const e = byEpisode.get(c.episodeId) ?? {
      channels: new Set<string>(),
      earliestMs: Number.POSITIVE_INFINITY,
      channelFirstMs: new Map<string, number>(),
      voiceAttempts: 0,
      voiceConnected: false,
    };
    e.channels.add(c.channel);
    e.earliestMs = Math.min(e.earliestMs, c.createdAtMs);
    const channelFirst = e.channelFirstMs.get(c.channel);
    if (channelFirst === undefined || c.createdAtMs < channelFirst) {
      e.channelFirstMs.set(c.channel, c.createdAtMs);
    }
    if (c.channel === "voice") {
      e.voiceAttempts += 1;
      if (c.voiceConnected) e.voiceConnected = true;
    }
    byEpisode.set(c.episodeId, e);
  }

  const actions: EscalationAction[] = [];
  for (const ep of input.episodes) {
    const info = byEpisode.get(ep.id);
    // No prior reminder → first touch is reminders.scan's job, not ours.
    if (!info) continue;
    const firstTouchAge = input.nowMs - info.earliestMs;
    if (firstTouchAge > input.maxMs) continue; // too old — stop nagging
    // Anchor step-spacing on the most recent time a NEW channel was first
    // tried (the max of each channel's first touch), not the latest touch
    // overall — otherwise the hourly scan's ~48h re-pings on the first
    // channel keep resetting this gate and the ladder never advances. With
    // a single touch per channel this equals the old latest-touch anchor,
    // so non-re-pinged episodes are unaffected.
    let lastStepMs = Number.NEGATIVE_INFINITY;
    for (const ms of info.channelFirstMs.values()) {
      if (ms > lastStepMs) lastStepMs = ms;
    }
    const sinceLastTouch = input.nowMs - lastStepMs;
    if (sinceLastTouch < input.delayMs) continue; // space the steps out
    // Only consider channels the patient can actually receive — an
    // unreachable channel (e.g. SMS for an email-only patient) would
    // otherwise stall the ladder forever instead of advancing to the CSR
    // hand-off. Default-reachable when capability is unknown.
    const hasPhone = ep.hasPhone ?? true;
    const hasEmail = ep.hasEmail ?? true;
    const effectiveLadder = input.ladder.filter((ch) =>
      channelReachable(ch, hasPhone, hasEmail),
    );
    const next = effectiveLadder.find(
      (ch) => !channelSatisfied(ch, info, maxVoiceAttempts),
    );
    let tier: EscalationTier;
    if (next) {
      // Copy variant reflects whether MORE automated outreach follows this
      // touch: "followup" when another unsatisfied channel remains after
      // `next`, "final" when `next` is the last automated channel before the
      // CSR hand-off. (The "initial" variant is the scan's first touch, never
      // an escalation.) Voice ignores the variant downstream; it's set
      // uniformly so the type stays simple.
      const moreAfter = effectiveLadder.some(
        (ch) => ch !== next && !channelSatisfied(ch, info, maxVoiceAttempts),
      );
      tier = {
        kind: "send",
        channel: next,
        variant: moreAfter ? "followup" : "final",
      };
    } else {
      tier = {
        kind: "csr_exhausted",
        // Report the channels actually attempted, in ladder order.
        triedChannels: input.ladder.filter((ch) =>
          ch === "voice" ? info.voiceAttempts > 0 : info.channels.has(ch),
        ),
      };
    }
    actions.push({ episodeId: ep.id, patientId: ep.patientId, tier });
  }
  return actions;
}

// ── IO runner ───────────────────────────────────────────────────────

export interface EscalationRunResult {
  skipped: boolean;
  enqueuedSms: number;
  enqueuedEmail: number;
  enqueuedVoice: number;
  csrAlerts: number;
}

export async function runReminderEscalationScan(
  boss: Pick<PgBoss, "send">,
  now: Date = new Date(),
): Promise<EscalationRunResult> {
  const result: EscalationRunResult = {
    skipped: false,
    enqueuedSms: 0,
    enqueuedEmail: 0,
    enqueuedVoice: 0,
    csrAlerts: 0,
  };
  // Fan out across every active tenant. Episodes, reminder conversations,
  // and the CSR no_response alerts are all tenant-scoped, and both
  // reminder_escalation.dispatcher and reminder_escalation.voice are
  // PER-TENANT flags, so each org is swept on its own org-scoped client and
  // an escalation never crosses tenants. Per-tenant failures are isolated by
  // forEachActiveOrg.
  const fan = await forEachActiveOrg(
    (orgId) => escalationScanForOrg(orgId, boss, now, result),
    { jobName: ESCALATION_JOB },
  );
  // Preserve the "did nothing" signal for the no-active-tenant tick.
  if (fan.total === 0) result.skipped = true;
  return result;
}

/**
 * Resolve a tenant's escalation ladder: the base text ladder, plus the
 * automated-voice tier when the tenant has opted in AND the voice path is
 * configured (else dialing it would stall the ladder on an un-completable
 * step). Reading the flag + config here keeps the planner pure.
 */
async function resolveLadderForOrg(orgId: string): Promise<readonly string[]> {
  // "Configured" must agree EXACTLY with the voice send job's guard
  // (`!config.twilioPhoneNumber`): an empty-string TWILIO_PHONE_NUMBER is
  // falsy. A `!= null` check would treat "" as configured and add the voice
  // tier to the ladder, but the send job skips the empty number — stalling
  // the ladder on a voice step that never completes (it creates no
  // conversation, so the ladder never advances to the CSR hand-off).
  const voiceConfigured = Boolean(readVoiceConfigOrNull()?.twilioPhoneNumber);
  if (
    voiceConfigured &&
    (await isFeatureEnabled("reminder_escalation.voice", orgId))
  ) {
    return ESCALATION_LADDER_WITH_VOICE;
  }
  return ESCALATION_LADDER;
}

/**
 * Run the escalation sweep for a SINGLE tenant, accumulating into the
 * shared `result`. The dispatcher flag is checked per-tenant, so one
 * tenant's opt-out never sweeps another's episodes.
 */
async function escalationScanForOrg(
  orgId: string,
  boss: Pick<PgBoss, "send">,
  now: Date,
  result: EscalationRunResult,
): Promise<void> {
  if (!(await isFeatureEnabled("reminder_escalation.dispatcher", orgId))) {
    return;
  }

  const ladder = await resolveLadderForOrg(orgId);
  // Tenant-tunable cadence (Control Center). Falls back to the defaults +
  // clamped, so a blank/typo'd value is safe.
  const { delayDays, maxDays } = await resolveEscalationTimingForOrg(orgId);
  const supabase = getOrgScopedClient(orgId);
  const horizonIso = new Date(
    now.getTime() - (maxDays + 2) * DAY_MS,
  ).toISOString();

  // Unresolved episodes within the escalation horizon. PAGINATED:
  // PostgREST caps a single response at ~1000 rows, so the previous
  // unpaginated read silently truncated once the unresolved backlog
  // exceeded the cap — and any episode whose page was dropped looked
  // "never reminded" to the conversation-stitch below and stopped
  // escalating. Mirror the keyset-paging pattern in reminders.ts.
  const PAGE_SIZE = 1000;
  const episodes: EscalationEpisodeRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("episodes")
      .select("id, patient_id")
      .in("status", IN_PROGRESS_STATUSES)
      .gte("created_at", horizonIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) episodes.push({ id: r.id, patientId: r.patient_id });
    if (data.length < PAGE_SIZE) break;
  }
  if (episodes.length === 0) return;

  // Reminder conversations for THOSE episodes. Fetch by the bounded
  // episode-id set (chunk the IN list ~200 ids, page within each chunk)
  // rather than scanning every conversation in the horizon: the old
  // unpaginated read also truncated at the ~1000-row cap, so episodes whose
  // reminder conversation was dropped looked un-reminded and would
  // re-escalate (or stall), and it scanned far more rows than needed. We
  // query exactly the tenant's active ladder channels so a voice
  // conversation counts only when voice is part of this tenant's ladder.
  const episodeIds = episodes.map((e) => e.id);
  const ladderChannels = [...ladder];
  const conversations: EscalationConvRow[] = [];
  // voice conversation id → its row, so the voice-call disposition read below
  // can stamp `voiceConnected` (only populated when voice is in the ladder).
  const voiceRowById = new Map<string, EscalationConvRow>();
  for (let i = 0; i < episodeIds.length; i += 200) {
    const idChunk = episodeIds.slice(i, i + 200);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("conversations")
        .select("id, episode_id, channel, created_at")
        .in("episode_id", idChunk)
        .in("channel", ladderChannels)
        .gte("created_at", horizonIso)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const c of data) {
        if (c.episode_id && c.created_at) {
          const row: EscalationConvRow = {
            episodeId: c.episode_id,
            channel: c.channel,
            createdAtMs: new Date(c.created_at).getTime(),
          };
          conversations.push(row);
          if (c.channel === "voice" && c.id) voiceRowById.set(c.id, row);
        }
      }
      if (data.length < PAGE_SIZE) break;
    }
  }

  // Voice-call disposition: mark a voice conversation "connected" when its
  // telemetry shows the call reached a LIVE person (status `completed` and not
  // an AMD machine/fax verdict). Unanswered / busy / failed / voicemail leave
  // it false → the planner retries the call up to the attempt cap before the
  // CSR hand-off.
  //
  // raw-org-scope-exempt: read by conversation_id, which is a
  // tenant-private uuid. This used to be a WORKAROUND — the status-callback
  // webhook wrote voice_calls with no org_id at all, so the org-scoped
  // filter matched nothing. It now stamps the call's real tenant, but the
  // `.raw()` read stays: rows written before that fix still carry a NULL
  // org_id, and an org-scoped filter would silently stop resolving voice
  // dispositions for them, quietly re-dialling patients an agent had
  // already spoken to. The conflicting-org skip below is the guard.
  if (ladder.includes("voice") && voiceRowById.size > 0) {
    const voiceConvIds = [...voiceRowById.keys()];
    for (let i = 0; i < voiceConvIds.length; i += 200) {
      const idChunk = voiceConvIds.slice(i, i + 200);
      for (let from = 0; ; from += PAGE_SIZE) {
        const { data, error } = await supabase
          .raw()
          .schema("resupply")
          .from("voice_calls")
          .select("conversation_id, status, answered_by, org_id")
          .in("conversation_id", idChunk)
          .order("conversation_id", { ascending: true })
          .range(from, from + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const vc of data) {
          const cid = (vc as { conversation_id: string | null })
            .conversation_id;
          if (!cid) continue;
          // Skip a row only when it carries a CONFLICTING org_id. A null
          // one is a pre-fix historical row and falls through to the
          // conversation-id match, which is already tenant-scoped.
          const rowOrg = (vc as { org_id?: string | null }).org_id;
          if (rowOrg != null && rowOrg !== orgId) continue;
          const row = voiceRowById.get(cid);
          if (
            row &&
            isVoiceCallConnected(
              (vc as { status: string | null }).status,
              (vc as { answered_by: string | null }).answered_by,
            )
          ) {
            row.voiceConnected = true;
          }
        }
        if (data.length < PAGE_SIZE) break;
      }
    }
  }

  // Patient status + contactability for the candidate episodes. Two uses:
  //   1. STATUS — only escalate ACTIVE patients. A patient who texted STOP is
  //      paused; the send helpers already no-op a non-active patient (no
  //      conversation written), so without this filter the ladder would
  //      re-enqueue a send to an opted-out patient every tick forever (never
  //      reaching CSR) — wasted work AND a failure to respect the opt-out at
  //      the planning layer. The hourly scan already filters `status=active`;
  //      mirror it here.
  //   2. CAPABILITY — skip ladder channels the patient can't receive
  //      (SMS/voice need a phone, email needs an address) so the ladder always
  //      reaches the CSR hand-off instead of stalling on an un-deliverable
  //      step.
  // Chunk the patient-id IN list (~200 ids) and page within each chunk, like
  // the reads above. Default active + reachable on a row miss so a transient
  // read blip never suppresses (or, for status, silently drops) outreach.
  const infoByPatient = new Map<
    string,
    { status: string; hasPhone: boolean; hasEmail: boolean }
  >();
  const patientIds = [...new Set(episodes.map((e) => e.patientId))];
  for (let i = 0; i < patientIds.length; i += 200) {
    const idChunk = patientIds.slice(i, i + 200);
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from("patients")
        .select("id, status, phone_e164, email")
        .in("id", idChunk)
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      if (!data || data.length === 0) break;
      for (const p of data) {
        infoByPatient.set(p.id, {
          status: p.status,
          hasPhone: p.phone_e164 != null && p.phone_e164.length > 0,
          hasEmail: p.email != null && p.email.length > 0,
        });
      }
      if (data.length < PAGE_SIZE) break;
    }
  }
  // Escalate only ACTIVE patients (respect the STOP opt-out), and stamp each
  // surviving episode with its patient's channel capability.
  const activeEpisodes = episodes.filter(
    (ep) => (infoByPatient.get(ep.patientId)?.status ?? "active") === "active",
  );
  if (activeEpisodes.length === 0) return;
  for (const ep of activeEpisodes) {
    const info = infoByPatient.get(ep.patientId);
    // Default-reachable when a patient row wasn't returned (don't suppress
    // outreach on a transient miss).
    ep.hasPhone = info?.hasPhone ?? true;
    ep.hasEmail = info?.hasEmail ?? true;
  }

  const actions = planReminderEscalations({
    episodes: activeEpisodes,
    conversations,
    nowMs: now.getTime(),
    delayMs: delayDays * DAY_MS,
    maxMs: maxDays * DAY_MS,
    ladder,
  });

  for (const action of actions) {
    if (action.tier.kind === "send") {
      // Stamp orgId so the send/dial job runs under the RIGHT tenant
      // (caller-id, From identity, dedup, usage) instead of the seed org.
      const base = {
        patientId: action.patientId,
        episodeId: action.episodeId,
        orgId,
      };
      if (action.tier.channel === "sms") {
        // Carry the escalation copy variant so the follow-up text doesn't
        // read identically to the first touch.
        await boss.send(SEND_SMS_JOB, {
          ...base,
          variant: action.tier.variant,
        });
        result.enqueuedSms += 1;
      } else if (action.tier.channel === "email") {
        await boss.send(SEND_EMAIL_JOB, {
          ...base,
          variant: action.tier.variant,
        });
        result.enqueuedEmail += 1;
      } else {
        // Voice copy is the agent's spoken script, not a templated body —
        // no variant to forward.
        await boss.send(SEND_VOICE_JOB, base);
        result.enqueuedVoice += 1;
      }
    } else {
      await raiseUnresponsiveAlert(
        orgId,
        supabase,
        action.patientId,
        action.episodeId,
        action.tier.triedChannels,
      );
      result.csrAlerts += 1;
    }
  }

  logger.info(
    {
      event: "reminders.escalation.completed",
      org_id: orgId,
      episodes: episodes.length,
      voice_tier: ladder.includes("voice"),
      // Cumulative across tenants swept so far this tick.
      enqueued_sms: result.enqueuedSms,
      enqueued_email: result.enqueuedEmail,
      enqueued_voice: result.enqueuedVoice,
      csr_alerts: result.csrAlerts,
    },
    "reminders.escalation-scan: completed for tenant",
  );
}

/**
 * Human-readable list of the automated channels we exhausted, for the CSR
 * alert copy. e.g. ["sms","email"] → "SMS and email";
 * ["sms","email","voice"] → "SMS, email, and an automated call".
 */
function describeChannelsTried(channels: string[]): string {
  const labels = channels.map((c) =>
    c === "sms"
      ? "SMS"
      : c === "email"
        ? "email"
        : c === "voice"
          ? "an automated call"
          : c,
  );
  if (labels.length === 0) return "automated reminders";
  if (labels.length === 1) return labels[0]!;
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

async function raiseUnresponsiveAlert(
  orgId: string,
  supabase: OrgScopedClient,
  patientId: string,
  episodeId: string,
  triedChannels: string[],
): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from("csr_compliance_alerts")
      .select("id")
      .eq("patient_id", patientId)
      .eq("alert_type", "no_response")
      .eq("status", "open")
      .limit(1)
      .maybeSingle();
    if (existing) return;
    const { error: alertInsertErr } = await supabase
      .from("csr_compliance_alerts")
      .insert({
        patient_id: patientId,
        alert_type: "no_response",
        severity: "warning",
        summary: `Unresponsive after ${describeChannelsTried(
          triedChannels,
        )} refill reminders — recommend a personal call.`,
        metric_snapshot: {
          episodeId,
          escalation: "channels_exhausted",
          channels_tried: triedChannels,
        },
      });
    if (alertInsertErr) {
      // A concurrent escalation tick may have raised the same open alert
      // between our SELECT above and this INSERT. The partial unique index
      // `csr_compliance_alerts_open_unique` (one open alert per
      // patient+alert_type, migration 0065) rejects the duplicate with a
      // 23505 — that IS the desired idempotent outcome, so treat it as a
      // no-op rather than a spurious "alert_failed" warning.
      if (alertInsertErr.code === "23505") return;
      throw alertInsertErr;
    }

    // A NEW alert was raised — ping the CS reps in Slack (best-effort,
    // non-PHI: patient id + channels tried + a deep link). Never throws.
    void notifyReminderEscalation({
      orgId,
      patientId,
      channelsTried: describeChannelsTried(triedChannels),
    });
  } catch (err) {
    logger.warn(
      {
        event: "reminders.escalation.alert_failed",
        errName: err instanceof Error ? err.name : "unknown",
      },
      "reminders.escalation-scan: failed to raise no_response alert",
    );
  }
}

export async function registerReminderEscalationJob(
  boss: PgBoss,
): Promise<void> {
  await createQueueWithDlq(boss, ESCALATION_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(ESCALATION_JOB, async () => {
    try {
      await runReminderEscalationScan(boss);
    } catch (err) {
      logger.error({ err }, "reminders.escalation-scan: job failed");
      throw err;
    }
  });
  await boss.schedule(ESCALATION_JOB, ESCALATION_CRON);
  logger.info({ cron: ESCALATION_CRON }, "reminders.escalation-scan scheduled");
}
