// pg-boss job: chase the mask-fitter funnel's two silent drop-offs, and
// keep a staff worklist of everyone who went quiet.
//
// WHY THIS EXISTS
// ---------------
// Before migration 0536 NOTHING in the worker tree read
// `resupply.fitter_invites` — `refit-campaign.ts` only writes new ones.
// So a staff-sent fitter link was a single message into the dark, and it
// failed in two directions:
//
//   A. LINK SENT, FIT NEVER DONE. The row sat at 'sent' (never opened)
//      or 'opened' (started, abandoned) until `expires_at` passed, at
//      which point routes/shop/fitter-invite.ts lazily stamped
//      'expired' the next time somebody clicked a dead link. No second
//      message, no signal to the CSR who sent it.
//
//   B. FIT DONE, THEN NOTHING. The patient finished, saw their
//      recommendation, and under `fitter.lead_capture_only` (ON for
//      every tenant) the next move is THEIRS — submit a
//      `fitter_fit_requests` row. Close the tab instead and the
//      fitting is a row nobody acts on. This is the expensive one: the
//      measurements, the questionnaire and a defensible recommendation
//      already exist.
//
// The existing lead nudges do NOT cover either. `fitter-lead-reengage`
// and `fitter-lead-first-day-nudge` scan `resupply.fitter_leads`, the
// ANONYMOUS STOREFRONT funnel — someone who found the site and opted in
// at /consent. A person a CSR deliberately mailed a link to has an
// invite row and may have no lead row at all.
//
// THE STAFF WORKLIST IS NOT THE PATIENT NUDGE
// -------------------------------------------
// `fitter.followup_nudges` gates the PATIENT messages. Alerts are
// recorded whatever it says, and whatever SendGrid/Twilio say, and
// whether or not the tenant has a verified domain — same posture as
// therapy-fleet-alerts-scan. A tenant that would rather phone people
// turns the flag off and still gets the queue. The one outcome that must
// never happen is a patient going quiet with nobody knowing.
//
// A FOURTH ALERT, WHICH IS OURS AND NOT THEIRS
// --------------------------------------------
// `request_unworked` fires when the patient DID ask and the queue row
// has sat past the "within one business day" promise the results page
// makes. It is in the same feed on purpose: from the patient's side,
// "I asked and nobody called" is indistinguishable from "I did the
// fitting and nothing happened", and splitting them across two pages
// hides half the problem. It NEVER sends the patient anything — a
// message saying "we haven't got to you yet" is worse than the silence.
//
// PHI: alert rows carry foreign keys and counts only. Log lines carry
// counts and org ids. Message bodies (composed in lib/fitting/
// followup-notify.ts) carry a first name, a brand and a link.

import type PgBoss from "pg-boss";

import {
  type CommunicationPreferences,
  DEFAULT_COMMUNICATION_PREFERENCES,
  type Database,
  escapePostgRESTFilterValue,
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import {
  isInDndWindow,
  isOutsideSmsSendWindow,
  shouldSendEmail,
  shouldSendSms,
} from "../../lib/comm-prefs.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import {
  type FollowupReason,
  sendFitterFollowup,
} from "../../lib/fitting/followup-notify.js";
import { logger } from "../../lib/logger.js";
import { redactDbErr } from "../../lib/redact-db-err.js";
import { resolveTenantLinkBaseUrl } from "../../lib/tenant-branding.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  VENDOR_SEND_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const FITTER_FOLLOWUP_JOB = "fitter-followup.scan";
/**
 * Hourly at :31 — a free minute in the staggered hourly set the other
 * sweeps use (:07 :13 :19 :22 :23 :29 :37 :43 :47 :52), so this doesn't
 * stack onto another job's SendGrid burst.
 *
 * Hourly rather than daily even though every window below is measured in
 * DAYS, for one reason: SMS is bounded by the patient-local 9am–8pm TCPA
 * window. A daily tick would fire at one UTC hour and permanently
 * exclude whole timezones from ever being texted; an hourly tick simply
 * picks the row up on the next pass inside their window.
 */
const FITTER_FOLLOWUP_CRON = "31 * * * *";

// ── Cohort A: link sent, fitting never done ──────────────────────────
/**
 * First nudge three days after the link went out. Not sooner: a person
 * who was handed a health task on Monday and hasn't done it by Tuesday
 * is normal, and a next-day chase reads as nagging. Not later: the
 * intent that made them agree to a fitting is measured in days.
 */
const UNSTARTED_REMINDER_AGE_MS = 3 * 86_400_000;
/**
 * Last call once the link has three days or less left on it. Expressed
 * as time REMAINING (read off the row's own `expires_at`) rather than as
 * an age, so it stays correct if FITTER_INVITE_TTL_MS is ever retuned —
 * the same reasoning invite-acceptance-reminder uses.
 */
const UNSTARTED_FINAL_REMAINING_MS = 3 * 86_400_000;
/**
 * Never send a link with less than this left. The token is minted with
 * exactly the row's remaining TTL (the ROW is the real gate — see
 * routes/shop/fitter-invite.ts), so a link sent at the last minute
 * dead-ends between the patient reading the message and clicking it.
 * Handing someone a link that expires while they walk to their laptop is
 * worse than not writing.
 */
const MIN_LINK_REMAINING_MS = 6 * 3_600_000;

// ── Cohort B: fitting done, nothing after ────────────────────────────
/** First nudge three days after the fitting, mirroring cohort A. */
const POST_FIT_REMINDER_AGE_MS = 3 * 86_400_000;
/** One more at ten days, then we stop and leave it to the CSR. */
const POST_FIT_FINAL_AGE_MS = 10 * 86_400_000;
/**
 * The backlog guard, and the reason `fitter.followup_nudges` can be
 * seeded ON without a deploy mailing everyone at once. Cohort A is
 * self-limiting (it only touches invites still inside their own
 * expiry); cohort B has no such natural bound, so it gets an explicit
 * one. A fitting older than this is a conversation for a person, not a
 * campaign.
 */
const POST_FIT_MAX_AGE_MS = 30 * 86_400_000;

// ── Staff-only alert ─────────────────────────────────────────────────
/**
 * A fit request still sitting at 'new' after two days. The results page
 * promises "within one business day"; two days clears that with a margin
 * for a request filed late on a Friday. This is a worklist and not a
 * page, so an alert that appears over a weekend simply waits until
 * Monday.
 */
const REQUEST_UNWORKED_AGE_MS = 2 * 86_400_000;
/**
 * A request nobody has touched for a week is a different conversation
 * from one untouched for two days, so it escalates — see the update in
 * `sweepStaleRequests`, which is what actually moves an alert that was
 * already raised.
 */
const REQUEST_UNWORKED_HIGH_DAYS = 7;

/** Rows per candidate page. */
const PAGE_SIZE = 200;
/**
 * Ids per `.in(...)` filter.
 *
 * PostgREST puts every filter in the URI and rejects the request over
 * ~8KB, and a uuid costs ~39 bytes once comma-separated and encoded — so
 * a naive `.in("id", <a full page>)` is most of that budget before the
 * rest of the query, and starts failing as the backlog grows rather than
 * in review. 80 ids is ~3KB, leaving room for the select list and the
 * tenant filter.
 */
const ID_CHUNK = 80;
/** Ceiling on pages walked per cohort per tenant per tick. */
const MAX_PAGES = 10;
/**
 * Per-tick cap on MESSAGES SENT per tenant — not on rows scanned or
 * alerts raised. A backlog drains an hour at a time rather than bursting
 * a vendor in one tick; the worklist is still complete immediately.
 */
const SEND_CAP_PER_ORG = 100;

type AlertInsert =
  Database["resupply"]["Tables"]["fitter_followup_alerts"]["Insert"];
type InviteUpdate = Database["resupply"]["Tables"]["fitter_invites"]["Update"];
type AlertType = NonNullable<AlertInsert["alert_type"]>;
type ResolvedReason = NonNullable<AlertInsert["resolved_reason"]>;

/** The two cohort-A types. One invite raises at most one of them. */
const COHORT_A_TYPES: readonly AlertType[] = [
  "fit_not_started",
  "fit_abandoned",
];

export interface FitterFollowupStats {
  /** Open invites inspected (cohort A). */
  scannedOpenInvites: number;
  /** Completed fittings inspected (cohort B). */
  scannedCompletedInvites: number;
  /** Unworked fit requests inspected. */
  scannedRequests: number;
  alertsRaised: number;
  alertsAutoResolved: number;
  nudgesSent: number;
  /** Eligible rows the tenant's flag suppressed. */
  skippedFlagOff: number;
  /** No consented, reachable channel (or an in-office handover). */
  skippedNoChannel: number;
  /**
   * Cohort-A rows skipped because the tenant has no verified domain, so
   * no invite link can be minted. Counted separately from
   * `skippedNoChannel` because the fix is a different one — verify a
   * domain, not check a patient's consent — and because it is the answer
   * to "why did this tenant send nothing at all?".
   */
  skippedNoLinkBase: number;
  /** Deferred by DND / the TCPA send window — a later tick retries. */
  skippedQuietHours: number;
  /**
   * Deferred because the consent lookup FAILED — also retried on a later
   * tick, but for an entirely different reason.
   *
   * Counted apart from `skippedQuietHours` because the two send an
   * operator to different places: a quiet-hours deferral is a clock and
   * resolves itself, while this one is a database that did not answer
   * and may not resolve itself at all. Folding them together would have
   * somebody checking the time of day while their PostgREST connection
   * was the problem.
   */
  skippedConsentUnknown: number;
  /** Lost a claim race with a concurrent tick. */
  skippedAlreadyClaimed: number;
  /** Vendor or config refused; the stamp is spent either way. */
  sendFailures: number;
  errors: number;
}

function emptyStats(): FitterFollowupStats {
  return {
    scannedOpenInvites: 0,
    scannedCompletedInvites: 0,
    scannedRequests: 0,
    alertsRaised: 0,
    alertsAutoResolved: 0,
    nudgesSent: 0,
    skippedFlagOff: 0,
    skippedNoChannel: 0,
    skippedNoLinkBase: 0,
    skippedQuietHours: 0,
    skippedConsentUnknown: 0,
    skippedAlreadyClaimed: 0,
    sendFailures: 0,
    errors: 0,
  };
}

interface InviteRow {
  id: string;
  patient_id: string | null;
  fit_session_id: string | null;
  recipient_email: string | null;
  recipient_phone_e164: string | null;
  recipient_name: string | null;
  channel: string;
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  expires_at: string;
  fit_reminder_sent_at: string | null;
  fit_final_reminder_sent_at: string | null;
  post_fit_reminder_sent_at: string | null;
  post_fit_final_reminder_sent_at: string | null;
}

const INVITE_SELECT =
  "id, patient_id, fit_session_id, recipient_email, recipient_phone_e164, " +
  "recipient_name, channel, status, sent_at, completed_at, expires_at, " +
  "fit_reminder_sent_at, fit_final_reminder_sent_at, " +
  "post_fit_reminder_sent_at, post_fit_final_reminder_sent_at";

/** Split ids into `.in(...)`-sized batches. See ID_CHUNK. */
function chunkIds(ids: string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    out.push(ids.slice(i, i + ID_CHUNK));
  }
  return out;
}

function msSince(iso: string | null, nowMs: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? nowMs - t : null;
}

/**
 * Has this nudge already been spent for the CURRENT round?
 *
 * A stamp that predates the anchor (`sent_at` for cohort A,
 * `completed_at` for cohort B) is STALE: a staff resend re-stamps
 * `sent_at` on the same row, and a fresh invitation deserves its own
 * follow-up. Nothing ever clears these columns — the same staleness
 * trick migration 0534 plays against a token's `created_at`.
 */
function stampIsSpent(stamp: string | null, anchor: string | null): boolean {
  if (!stamp) return false;
  if (!anchor) return true;
  return new Date(stamp).getTime() >= new Date(anchor).getTime();
}

// ─────────────────────────────────────────────────────────────────────
// Consent
// ─────────────────────────────────────────────────────────────────────

interface ResolvedPrefs {
  prefs: CommunicationPreferences;
  /**
   * True when this person actually HAS a stored preference record.
   *
   * The distinction matters for SMS and only for SMS.
   * `DEFAULT_COMMUNICATION_PREFERENCES.smsTransactional` is `false`, and a
   * prospect invited by text has no `shop_customers` row at all — so
   * treating the absence of a record as a decision would silently make
   * this sweep unable to follow up the single commonest fitter invite
   * there is (a CSR texting somebody a link). "We have never asked them"
   * is not "they said no".
   */
  explicit: boolean;
  /**
   * True when the lookup itself FAILED — as opposed to succeeding and
   * finding nothing. Callers must not send on an unknown: a consent
   * record we could not read might be a refusal, and the next hourly
   * tick will try again at no cost (nothing is stamped yet).
   */
  unknown: boolean;
  /** The chart's own timezone, read on the same round-trip. */
  patientTimezone: string | null;
}

const UNKNOWN_PREFS: ResolvedPrefs = {
  prefs: DEFAULT_COMMUNICATION_PREFERENCES,
  explicit: false,
  unknown: true,
  patientTimezone: null,
};

/**
 * Read this person's stored communication preferences, and say whether
 * they HAVE any.
 *
 * HOW THE TWO TABLES ACTUALLY JOIN
 * --------------------------------
 * `resupply.shop_customers` has NO `patient_id` column. It is keyed by
 * `customer_id`, and reaches a chart one of two ways:
 *   * `shop_customers.auth_user_id` = `patients.portal_auth_user_id` —
 *     the strong link, an actual portal login; or
 *   * `shop_customers.email_lower` = `lower(patients.email)` — the
 *     weaker one, used only when the portal link is absent.
 * Migration 0532 exists precisely because there is no direct column: it
 * backfills `customer_acquisition.patient_id` through exactly this pair
 * of joins, in exactly this order.
 *
 * Filtering on a column that does not exist does not return nothing —
 * PostgREST returns an ERROR. Destructuring only `data` swallows it, and
 * the caller then reads "no stored preference", which for SMS means the
 * same-channel fallback and for email means the opted-in default. In
 * other words the bug is silent and it fails toward SENDING, which is
 * the wrong direction for a consent check: a patient who explicitly
 * turned these messages off would still get them.
 *
 * So the error is now surfaced (`unknown`) and the caller declines to
 * send on it.
 */
async function readPrefs(
  supabase: OrgScopedClient,
  patientId: string | null,
): Promise<ResolvedPrefs> {
  if (!patientId) {
    return {
      prefs: DEFAULT_COMMUNICATION_PREFERENCES,
      explicit: false,
      unknown: false,
      patientTimezone: null,
    };
  }
  try {
    const { data: patient, error: patientErr } = (await supabase
      .from("patients")
      .select("id, email, timezone, portal_auth_user_id")
      .eq("id", patientId)
      .limit(1)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: unknown;
    };
    if (patientErr) return UNKNOWN_PREFS;
    // A chart that has since been deleted is not a refusal — the invite
    // still carries its own contact details.
    if (!patient) {
      return {
        prefs: DEFAULT_COMMUNICATION_PREFERENCES,
        explicit: false,
        unknown: false,
        patientTimezone: null,
      };
    }
    const patientTimezone = (patient.timezone as string | null) ?? null;
    const authUserId = (patient.portal_auth_user_id as string | null) ?? null;
    const email = (patient.email as string | null) ?? null;

    const found = async (
      column: "auth_user_id" | "email_lower",
      value: string,
    ): Promise<{ raw: unknown; failed: boolean }> => {
      const { data, error } = (await supabase
        .from("shop_customers")
        .select("communication_preferences")
        .eq(column, value)
        .limit(1)
        .maybeSingle()) as {
        data: Record<string, unknown> | null;
        error: unknown;
      };
      if (error) return { raw: null, failed: true };
      return { raw: data?.communication_preferences ?? null, failed: false };
    };

    let raw: unknown = null;
    if (authUserId) {
      const byAuth = await found("auth_user_id", authUserId);
      if (byAuth.failed) return UNKNOWN_PREFS;
      raw = byAuth.raw;
    }
    if (!raw && email) {
      const byEmail = await found("email_lower", email.toLowerCase());
      if (byEmail.failed) return UNKNOWN_PREFS;
      raw = byEmail.raw;
    }

    if (!raw || typeof raw !== "object") {
      return {
        prefs: DEFAULT_COMMUNICATION_PREFERENCES,
        explicit: false,
        unknown: false,
        patientTimezone,
      };
    }
    return {
      prefs: {
        ...DEFAULT_COMMUNICATION_PREFERENCES,
        ...(raw as Partial<CommunicationPreferences>),
      },
      explicit: true,
      unknown: false,
      patientTimezone,
    };
  } catch {
    return UNKNOWN_PREFS;
  }
}

interface ChannelPermission {
  allowEmail: boolean;
  allowSms: boolean;
  /** True when a channel was blocked only by a CLOCK — retry later. */
  deferred: boolean;
  /**
   * True when nothing is permitted because the consent lookup itself
   * failed. Also a retry, but the caller tallies it separately — see
   * `skippedConsentUnknown`.
   */
  consentUnknown: boolean;
}

/**
 * Which channels this patient may be reached on right now.
 *
 * EMAIL is filed under `resupplyReminder`, not `marketing`: this is
 * follow-up on equipment the patient is being fitted for, and the
 * message exists because a member of staff already contacted them about
 * it. Classifying it as promotion would silence us toward exactly the
 * patient who agreed to a fitting and then got distracted.
 *
 * SMS uses the `transactional` bucket — what therapy-fleet-alerts-scan
 * and refit-campaign both use for care outreach — but ONLY when a stored
 * preference actually exists. When it does, it decides, in both
 * directions: an explicit `smsTransactional: false` is a refusal and
 * ends it.
 *
 * When it does NOT exist, the fallback is deliberately narrow: text this
 * person only if the invite ITSELF went out by text. That is not an
 * inference from a phone number happening to be on the row — it is the
 * fact that a member of staff chose to text them about this exact thing,
 * days ago, and this message continues that thread inside the lifetime
 * of the link it carried. The alternative — reading "we have never asked
 * them" as "they said no" — would make this sweep structurally unable to
 * follow up an SMS invite, which is the commonest kind there is.
 *
 * DND and the patient-local 9am-8pm TCPA window are applied in EVERY
 * case, stored preference or not.
 */
async function resolveChannels(
  supabase: OrgScopedClient,
  invite: InviteRow,
  now: Date,
): Promise<ChannelPermission> {
  const { prefs, explicit, unknown, patientTimezone } = await readPrefs(
    supabase,
    invite.patient_id,
  );
  // A consent record we could not read is not consent. Decline, and mark
  // it deferred so the caller leaves the stamp unspent and the next tick
  // tries again — a transient blip must not cost the follow-up, and it
  // must not send one either.
  if (unknown) {
    return {
      allowEmail: false,
      allowSms: false,
      deferred: true,
      consentUnknown: true,
    };
  }

  const dnd = isInDndWindow(prefs, now);
  const allowEmail =
    Boolean(invite.recipient_email) &&
    shouldSendEmail(prefs, "resupplyReminder", now) &&
    !dnd;

  let allowSms = false;
  let deferred = false;
  const smsConsented = explicit
    ? shouldSendSms(prefs, "transactional", now)
    : invite.channel === "sms";
  if (invite.recipient_phone_e164 && smsConsented) {
    // Same precedence `resolveTimezone` documents, and the same one
    // `isInDndWindow` already applies internally: the customer's OWN
    // stated timezone first, the chart's only as a fallback.
    //
    // Reading only the chart here is how a Pacific patient who set their
    // timezone in the portal, but whose chart never got one, gets texted
    // at 6:30am: this window would evaluate against the
    // "America/New_York" default while DND used their real zone. The two
    // gates must not disagree about what time it is for this person.
    const outsideWindow = isOutsideSmsSendWindow(now, {
      timezone: prefs.timezone ?? patientTimezone,
      shippingZip: null,
    });
    allowSms = !dnd && !outsideWindow;
    // Only a clock stands between us and this message; say so, so the
    // caller can leave the stamp unspent for a later tick.
    if (!allowSms && (dnd || outsideWindow)) deferred = true;
  }
  if (!allowEmail && dnd && invite.recipient_email) deferred = true;

  return { allowEmail, allowSms, deferred, consentUnknown: false };
}

// ─────────────────────────────────────────────────────────────────────
// Alerts
// ─────────────────────────────────────────────────────────────────────

/**
 * Raise one alert, letting the DATABASE arbitrate duplicates.
 *
 * The partial unique indexes from 0536 are on (org_id, alert_type,
 * subject) for ALL statuses, so this insert is naturally idempotent and
 * — critically — a dismissed alert is never resurrected. Two concurrent
 * ticks both pass any read-then-write check a scan could make, so the
 * index has to be the arbiter; 23505 is the expected outcome, not an
 * error.
 */
/**
 * Every open alert's subject id, for the given types — PAGED.
 *
 * A bare `.limit(1000)` is capped by PostgREST's own configured maximum
 * and silently returns a prefix, so on a tenant with a real backlog the
 * auto-resolve passes would simply never see the rest of the queue. The
 * repo settled this in #1357 ("page all PostgREST .limit(N>1000)
 * aggregation and worklist reads"); this is that pattern.
 */
async function openAlertSubjectIds(
  supabase: OrgScopedClient,
  column: "fitter_invite_id" | "fit_request_id",
  alertTypes: readonly AlertType[],
): Promise<string[]> {
  const PAGE = 1000;
  const out: string[] = [];
  for (let from = 0; from < PAGE * MAX_PAGES; from += PAGE) {
    const { data, error } = await supabase
      .from("fitter_followup_alerts")
      .select(column)
      .eq("status", "open")
      .in("alert_type", alertTypes as AlertType[])
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<Record<string, string | null>>;
    for (const r of rows) {
      const id = r[column];
      if (typeof id === "string") out.push(id);
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function raiseAlert(
  supabase: OrgScopedClient,
  row: AlertInsert,
  stats: FitterFollowupStats,
): Promise<void> {
  const { error } = await supabase.from("fitter_followup_alerts").insert(row);
  if (!error) {
    stats.alertsRaised += 1;
    return;
  }
  // 23505 = unique_violation. The only unique constraints on this table
  // are the two subject indexes, so this means "already raised".
  if ((error as { code?: string }).code === "23505") return;
  stats.errors += 1;
  logger.warn(
    { err: redactDbErr(error), alertType: row.alert_type },
    "fitter-followup: alert insert failed",
  );
}

/** Record what the automated follow-up managed to do, for the worklist. */
async function stampAlertNudge(
  supabase: OrgScopedClient,
  subject: { inviteId?: string; requestId?: string },
  alertTypes: readonly AlertType[],
  channel: string,
  nowIso: string,
): Promise<void> {
  try {
    let q = supabase
      .from("fitter_followup_alerts")
      .update({ last_nudge_at: nowIso, last_nudge_channel: channel })
      .eq("status", "open")
      .in("alert_type", alertTypes as AlertType[]);
    q = subject.inviteId
      ? q.eq("fitter_invite_id", subject.inviteId)
      : q.eq("fit_request_id", subject.requestId ?? "");
    await q;
  } catch (err) {
    // Cosmetic on the worklist; never worth failing a tick that already
    // reached the patient.
    logger.debug(
      { err: redactDbErr(err) },
      "fitter-followup: alert nudge stamp failed",
    );
  }
}

async function resolveAlerts(
  supabase: OrgScopedClient,
  filter: { inviteIds?: string[]; requestIds?: string[] },
  reason: ResolvedReason,
  stats: FitterFollowupStats,
  nowIso: string,
): Promise<void> {
  const ids = filter.inviteIds ?? filter.requestIds ?? [];
  if (ids.length === 0) return;
  for (const chunk of chunkIds(ids)) {
    let q = supabase
      .from("fitter_followup_alerts")
      .update({
        status: "resolved",
        resolved_at: nowIso,
        resolved_reason: reason,
      })
      .eq("status", "open");
    q = filter.inviteIds
      ? q.in("fitter_invite_id", chunk)
      : q.in("fit_request_id", chunk);
    const { data, error } = await q.select("id");
    if (error) {
      stats.errors += 1;
      logger.warn(
        { err: redactDbErr(error), reason },
        "fitter-followup: auto-resolve failed",
      );
      return;
    }
    stats.alertsAutoResolved += (data ?? []).length;
  }
}

/**
 * Which of these invites already carry a cohort-A alert, of EITHER type.
 *
 * The unique index is per (type, invite), so an invite alerted as
 * `fit_not_started` while it sat unopened would raise a SECOND alert the
 * day the patient opened it and stalled. Both rows describe one person
 * who has not been fitted, and a CSR would have to clear the same lead
 * twice. One alert per invite; the type is whatever was true when it was
 * first raised.
 */
async function invitesWithCohortAAlert(
  supabase: OrgScopedClient,
  inviteIds: string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (inviteIds.length === 0) return out;
  for (const chunk of chunkIds(inviteIds)) {
    const { data, error } = await supabase
      .from("fitter_followup_alerts")
      .select("fitter_invite_id")
      .in("fitter_invite_id", chunk)
      .in("alert_type", COHORT_A_TYPES as AlertType[]);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{
      fitter_invite_id: string | null;
    }>) {
      if (r.fitter_invite_id) out.add(r.fitter_invite_id);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Cohort A — the link was sent and the fitting never happened
// ─────────────────────────────────────────────────────────────────────

interface OrgContext {
  orgId: string;
  supabase: OrgScopedClient;
  nudgesEnabled: boolean;
  /** Null when the tenant has no verified domain — alerts still run. */
  linkBase: string | null;
  sendBudget: { remaining: number };
}

async function sweepOpenInvites(
  ctx: OrgContext,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  // Anything sent within the first reminder window cannot be due yet;
  // filtering server-side keeps the page walk proportional to the
  // backlog rather than to today's sends.
  const dueBefore = new Date(nowMs - UNSTARTED_REMINDER_AGE_MS).toISOString();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await ctx.supabase
      .from("fitter_invites")
      .select(INVITE_SELECT)
      .in("status", ["sent", "opened"])
      .not("sent_at", "is", null)
      // Still live. An expired link cannot be followed up on — a nudge
      // pointing at a dead link is worse than no nudge — and expiry is
      // also what keeps this cohort structurally incapable of chasing a
      // historical backlog.
      .gt("expires_at", nowIso)
      .lte("sent_at", dueBefore)
      .order("sent_at", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as InviteRow[];
    if (rows.length === 0) return;

    const alreadyAlerted = await invitesWithCohortAAlert(
      ctx.supabase,
      rows.map((r) => r.id),
    );

    for (const invite of rows) {
      stats.scannedOpenInvites += 1;
      try {
        await handleOpenInvite(ctx, invite, alreadyAlerted, stats, now);
      } catch (err) {
        stats.errors += 1;
        logger.warn(
          { err: redactDbErr(err), orgId: ctx.orgId, inviteId: invite.id },
          "fitter-followup: open-invite row failed",
        );
      }
    }
    if (rows.length < PAGE_SIZE) return;
  }
}

async function handleOpenInvite(
  ctx: OrgContext,
  invite: InviteRow,
  alreadyAlerted: Set<string>,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const age = msSince(invite.sent_at, nowMs);
  if (age === null || age < UNSTARTED_REMINDER_AGE_MS) return;
  const remaining = new Date(invite.expires_at).getTime() - nowMs;

  const opened = invite.status === "opened";
  const alertType: AlertType = opened ? "fit_abandoned" : "fit_not_started";

  // The worklist first, and unconditionally. Everything below this can
  // be declined by a flag, a missing vendor key or a consent setting;
  // none of that changes the fact that this person was sent a link and
  // hasn't been fitted.
  if (!alreadyAlerted.has(invite.id)) {
    await raiseAlert(
      ctx.supabase,
      {
        alert_type: alertType,
        // An abandoned fitting is the stronger signal — they tried, so
        // something stopped them, and that is worth a phone call.
        severity: opened ? "high" : "medium",
        status: "open",
        fitter_invite_id: invite.id,
        fit_session_id: invite.fit_session_id,
        patient_id: invite.patient_id,
        detail: {
          channel: invite.channel,
          days_since_sent: Math.floor(age / 86_400_000),
          days_until_link_expires: Math.max(
            0,
            Math.floor(remaining / 86_400_000),
          ),
          is_prospect: invite.patient_id === null,
        },
      },
      stats,
    );
    alreadyAlerted.add(invite.id);
  }

  if (!ctx.nudgesEnabled) {
    stats.skippedFlagOff += 1;
    return;
  }
  if (ctx.sendBudget.remaining <= 0) return;
  if (invite.channel === "in_office") {
    stats.skippedNoChannel += 1;
    return;
  }
  // This cohort's message IS a link, so a tenant with no verified domain
  // has nothing it can send — and this check has to come BEFORE the
  // claim below, not after.
  //
  // Claiming first would spend the stamp on every outstanding invite the
  // first time the sweep ran for such a tenant, and nothing ever clears a
  // stamp: the day they verified a domain, none of those invites would
  // ever be nudged. It would also burn the shared per-tick send budget on
  // guaranteed non-deliveries, starving the cohort-B follow-ups in the
  // same tick — which need no link and would have gone out fine.
  //
  // Exactly the ordering rationale invite-acceptance-reminder states for
  // resolving its SendGrid client before claiming: a missing domain is a
  // condition that gets FIXED later, so it must cost nothing now.
  if (!ctx.linkBase) {
    stats.skippedNoLinkBase += 1;
    return;
  }
  // Refuse to advertise a link that dies before they can click it.
  if (remaining < MIN_LINK_REMAINING_MS) {
    stats.skippedNoChannel += 1;
    return;
  }

  // Which nudge is due. The final window is evaluated FIRST and, when it
  // fires, spends the first-reminder stamp too. Otherwise a tenant whose
  // invite TTL was retuned below six days would get both messages within
  // hours of each other.
  const finalDue =
    remaining <= UNSTARTED_FINAL_REMAINING_MS &&
    !stampIsSpent(invite.fit_final_reminder_sent_at, invite.sent_at);
  const firstDue =
    !finalDue && !stampIsSpent(invite.fit_reminder_sent_at, invite.sent_at);
  if (!finalDue && !firstDue) return;

  const channels = await resolveChannels(ctx.supabase, invite, now);
  if (!channels.allowEmail && !channels.allowSms) {
    if (channels.consentUnknown) stats.skippedConsentUnknown += 1;
    else if (channels.deferred) stats.skippedQuietHours += 1;
    else stats.skippedNoChannel += 1;
    return;
  }

  const stampPatch = finalDue
    ? {
        fit_final_reminder_sent_at: nowIso,
        // Spending both keeps the two windows mutually exclusive.
        //
        // `?? nowIso` was not enough: after a resend the old first-round
        // stamp is non-null but STALE relative to the new `sent_at`, so
        // it survived — and on the next tick `stampIsSpent` read it as
        // unspent and fired the first reminder immediately after the
        // final one. Keep an existing stamp only while it is still
        // current for THIS round.
        fit_reminder_sent_at: stampIsSpent(
          invite.fit_reminder_sent_at,
          invite.sent_at,
        )
          ? invite.fit_reminder_sent_at
          : nowIso,
      }
    : { fit_reminder_sent_at: nowIso };
  const claimed = await claimStamp(
    ctx.supabase,
    invite.id,
    finalDue ? "fit_final_reminder_sent_at" : "fit_reminder_sent_at",
    finalDue ? invite.fit_final_reminder_sent_at : invite.fit_reminder_sent_at,
    stampPatch,
    {
      // Still un-finished, and still the same send we measured against.
      statuses: ["sent", "opened"],
      anchorColumn: "sent_at",
      anchor: invite.sent_at,
    },
  );
  if (!claimed) {
    stats.skippedAlreadyClaimed += 1;
    return;
  }

  ctx.sendBudget.remaining -= 1;
  const reason: FollowupReason = opened ? "abandoned" : "unstarted";
  const delivery = await sendFitterFollowup(
    {
      orgId: ctx.orgId,
      inviteId: invite.id,
      channel: invite.channel,
      recipientEmail: invite.recipient_email,
      recipientPhoneE164: invite.recipient_phone_e164,
      recipientName: invite.recipient_name,
      allowEmail: channels.allowEmail,
      allowSms: channels.allowSms,
      linkBase: ctx.linkBase,
      linkTtlMs: remaining,
    },
    reason,
  );
  await finishNudge(
    ctx,
    { inviteId: invite.id },
    COHORT_A_TYPES,
    delivery,
    stats,
    nowIso,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Cohort B — the fitting happened and nothing followed
// ─────────────────────────────────────────────────────────────────────

async function sweepCompletedInvites(
  ctx: OrgContext,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const dueBefore = new Date(nowMs - POST_FIT_REMINDER_AGE_MS).toISOString();
  const notBefore = new Date(nowMs - POST_FIT_MAX_AGE_MS).toISOString();

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await ctx.supabase
      .from("fitter_invites")
      .select(INVITE_SELECT)
      .in("status", ["completed", "attached"])
      .not("completed_at", "is", null)
      .lte("completed_at", dueBefore)
      .gte("completed_at", notBefore)
      .order("completed_at", { ascending: false })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as InviteRow[];
    if (rows.length === 0) return;

    // One batched conversion probe per page rather than per row: a
    // fitting counts as "acted on" if the patient asked (a fit request
    // against this fitting or this email address), if the request was
    // closed as fulfilled, or if the fitting itself was stamped
    // dispensed.
    const converted = await findActedOn(ctx.supabase, rows);

    // Anything converted closes its open alerts on the way past — the
    // sweep is the only thing that watches for this, and a CSR should
    // not have to clear a row the patient already resolved.
    const convertedIds = rows
      .filter((r) => converted.has(r.id))
      .map((r) => r.id);
    await resolveAlerts(
      ctx.supabase,
      { inviteIds: convertedIds },
      "request_received",
      stats,
      nowIso,
    );

    for (const invite of rows) {
      stats.scannedCompletedInvites += 1;
      if (converted.has(invite.id)) continue;
      try {
        await handleCompletedInvite(ctx, invite, stats, now);
      } catch (err) {
        stats.errors += 1;
        logger.warn(
          { err: redactDbErr(err), orgId: ctx.orgId, inviteId: invite.id },
          "fitter-followup: completed-invite row failed",
        );
      }
    }
    if (rows.length < PAGE_SIZE) return;
  }
}

/**
 * Invite ids whose fitting has already turned into something.
 *
 * Three independent signals, because there are three ways this can end
 * and missing any one of them means messaging somebody who already did
 * what we are about to ask for:
 *   1. a `fitter_fit_requests` row linked to the fitting, or filed under
 *      the same email address (a patient who re-entered their email
 *      rather than clicking through the fitter's own hand-off);
 *   2. `fit_sessions.dispensed_at`, which is what closing a request as
 *      `fulfilled` stamps (migration 0519);
 *   3. a `public.orders` row for that email, for a tenant that turned
 *      `fitter.lead_capture_only` off and still lets patients file their
 *      own order.
 */
async function findActedOn(
  supabase: OrgScopedClient,
  rows: InviteRow[],
): Promise<Set<string>> {
  const acted = new Set<string>();
  const sessionIds = rows
    .map((r) => r.fit_session_id)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  const emailToInvites = new Map<string, string[]>();
  for (const r of rows) {
    const email = r.recipient_email?.toLowerCase();
    if (!email) continue;
    const list = emailToInvites.get(email) ?? [];
    list.push(r.id);
    emailToInvites.set(email, list);
  }
  const sessionToInvites = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.fit_session_id) continue;
    const list = sessionToInvites.get(r.fit_session_id) ?? [];
    list.push(r.id);
    sessionToInvites.set(r.fit_session_id, list);
  }
  const completionByInvite = new Map<string, string>();
  for (const r of rows) {
    if (r.completed_at) completionByInvite.set(r.id, r.completed_at);
  }

  // 1a — requests linked to the fitting.
  for (const chunk of chunkIds(sessionIds)) {
    const { data, error } = await supabase
      .from("fitter_fit_requests")
      .select("fit_session_id")
      .in("fit_session_id", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ fit_session_id: string | null }>) {
      for (const id of sessionToInvites.get(r.fit_session_id ?? "") ?? []) {
        acted.add(id);
      }
    }

    // 2 — the fitting was dispensed.
    const dispensed = await supabase
      .from("fit_sessions")
      .select("id")
      .in("id", chunk)
      .not("dispensed_at", "is", null);
    if (dispensed.error) throw dispensed.error;
    for (const r of (dispensed.data ?? []) as Array<{ id: string }>) {
      for (const id of sessionToInvites.get(r.id) ?? []) acted.add(id);
    }
  }

  // 1b + 3 — anything filed under the same email.
  //
  // BOUNDED IN TIME, per invite. An unbounded email match answers "has
  // this person EVER asked us for a mask", which is the wrong question:
  // a returning patient whose earlier request was closed months ago
  // would mark today's fitting as acted on, and that new fitting would
  // get neither an alert nor a follow-up. Migration 0519 is explicit
  // that a patient may legitimately come back — its dedupe index is
  // partial on `status <> 'closed'` for exactly that reason — so a
  // correlation that ignores time contradicts the schema.
  //
  // The chunk query is bounded once by the OLDEST fitting on the page
  // (one round-trip), then each row is credited against ITS OWN
  // invite's completion below. `fit_session_id` above remains the
  // precise link; this is only the fallback for a patient who re-typed
  // their email instead of coming through the fitter's own hand-off.
  const emails = [...emailToInvites.keys()];
  const oldestCompletion = rows
    .map((r) => r.completed_at)
    .filter((v): v is string => typeof v === "string")
    .sort()[0];
  const creditIfAfter = (
    email: string | null,
    createdAt: string | null,
  ): void => {
    const key = (email ?? "").toLowerCase();
    const created = createdAt ? new Date(createdAt).getTime() : NaN;
    for (const id of emailToInvites.get(key) ?? []) {
      const completedAt = completionByInvite.get(id);
      // Nothing to compare against: credit it, which errs toward NOT
      // chasing somebody who may already have asked.
      if (!completedAt || !Number.isFinite(created)) {
        acted.add(id);
        continue;
      }
      if (created >= new Date(completedAt).getTime()) acted.add(id);
    }
  };
  const CHUNK = 50;
  for (let i = 0; i < emails.length; i += CHUNK) {
    const chunk = emails.slice(i, i + CHUNK);
    const requestOr = chunk
      .map((e) => `email.ilike.${escapePostgRESTFilterValue(e)}`)
      .join(",");
    const orderOr = chunk
      .map((e) => `patient_email.ilike.${escapePostgRESTFilterValue(e)}`)
      .join(",");
    let requestQuery = supabase
      .from("fitter_fit_requests")
      .select("email, created_at")
      .or(requestOr);
    let orderQuery = supabase
      .raw()
      .schema("public")
      .from("orders")
      .select("patient_email, created_at")
      // Tenant-scoped (migration 0463): an order in another tenant is
      // not this fitting's outcome.
      .eq("org_id", supabase.orgId)
      .or(orderOr);
    if (oldestCompletion) {
      requestQuery = requestQuery.gte("created_at", oldestCompletion);
      orderQuery = orderQuery.gte("created_at", oldestCompletion);
    }
    const [requestRes, orderRes] = await Promise.all([
      requestQuery,
      orderQuery,
    ]);
    if (requestRes.error) throw requestRes.error;
    if (orderRes.error) throw orderRes.error;
    for (const r of (requestRes.data ?? []) as Array<{
      email: string | null;
      created_at: string | null;
    }>) {
      creditIfAfter(r.email, r.created_at);
    }
    for (const r of (orderRes.data ?? []) as Array<{
      patient_email: string | null;
      created_at: string | null;
    }>) {
      creditIfAfter(r.patient_email, r.created_at);
    }
  }
  return acted;
}

async function handleCompletedInvite(
  ctx: OrgContext,
  invite: InviteRow,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const age = msSince(invite.completed_at, nowMs);
  if (age === null || age < POST_FIT_REMINDER_AGE_MS) return;

  await raiseAlert(
    ctx.supabase,
    {
      alert_type: "fit_no_request",
      // The most expensive silence in the funnel: the clinical work is
      // already done and a person is one phone call from a dispense.
      severity: "high",
      status: "open",
      fitter_invite_id: invite.id,
      fit_session_id: invite.fit_session_id,
      patient_id: invite.patient_id,
      detail: {
        channel: invite.channel,
        days_since_fitting: Math.floor(age / 86_400_000),
        is_prospect: invite.patient_id === null,
        has_fit_session: invite.fit_session_id !== null,
      },
    },
    stats,
  );

  if (!ctx.nudgesEnabled) {
    stats.skippedFlagOff += 1;
    return;
  }
  if (ctx.sendBudget.remaining <= 0) return;
  if (invite.channel === "in_office") {
    stats.skippedNoChannel += 1;
    return;
  }

  const finalDue =
    age >= POST_FIT_FINAL_AGE_MS &&
    !stampIsSpent(invite.post_fit_final_reminder_sent_at, invite.completed_at);
  const firstDue =
    !finalDue &&
    !stampIsSpent(invite.post_fit_reminder_sent_at, invite.completed_at);
  if (!finalDue && !firstDue) return;

  const channels = await resolveChannels(ctx.supabase, invite, now);
  if (!channels.allowEmail && !channels.allowSms) {
    if (channels.consentUnknown) stats.skippedConsentUnknown += 1;
    else if (channels.deferred) stats.skippedQuietHours += 1;
    else stats.skippedNoChannel += 1;
    return;
  }

  const stampPatch = finalDue
    ? {
        post_fit_final_reminder_sent_at: nowIso,
        // Same staleness rule as cohort A above.
        post_fit_reminder_sent_at: stampIsSpent(
          invite.post_fit_reminder_sent_at,
          invite.completed_at,
        )
          ? invite.post_fit_reminder_sent_at
          : nowIso,
      }
    : { post_fit_reminder_sent_at: nowIso };
  const claimed = await claimStamp(
    ctx.supabase,
    invite.id,
    finalDue ? "post_fit_final_reminder_sent_at" : "post_fit_reminder_sent_at",
    finalDue
      ? invite.post_fit_final_reminder_sent_at
      : invite.post_fit_reminder_sent_at,
    stampPatch,
    {
      statuses: ["completed", "attached"],
      anchorColumn: "completed_at",
      anchor: invite.completed_at,
    },
  );
  if (!claimed) {
    stats.skippedAlreadyClaimed += 1;
    return;
  }

  ctx.sendBudget.remaining -= 1;
  const delivery = await sendFitterFollowup(
    {
      orgId: ctx.orgId,
      inviteId: invite.id,
      channel: invite.channel,
      recipientEmail: invite.recipient_email,
      recipientPhoneE164: invite.recipient_phone_e164,
      recipientName: invite.recipient_name,
      allowEmail: channels.allowEmail,
      allowSms: channels.allowSms,
    },
    "no_request",
  );
  await finishNudge(
    ctx,
    { inviteId: invite.id },
    ["fit_no_request"],
    delivery,
    stats,
    nowIso,
  );
}

// ─────────────────────────────────────────────────────────────────────
// Staff-only: a request the patient filed that nobody has worked
// ─────────────────────────────────────────────────────────────────────

async function sweepStaleRequests(
  ctx: OrgContext,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const staleBefore = new Date(nowMs - REQUEST_UNWORKED_AGE_MS).toISOString();

  // PAGED, like the two invite sweeps.
  //
  // A single fixed `limit(PAGE_SIZE)` re-reads the same oldest rows every
  // hour: a request stays `status='new'` after its alert is raised (the
  // alert does not work the queue), and the insert then no-ops on the
  // unique index. So with a backlog larger than one page, every request
  // past that prefix would never get an alert at all until enough older
  // ones were worked — the worklist would quietly be incomplete for
  // exactly the tenant most in need of it.
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await ctx.supabase
      .from("fitter_fit_requests")
      .select(
        "id, status, patient_id, fit_session_id, request_type, created_at",
      )
      .eq("status", "new")
      .lte("created_at", staleBefore)
      .order("created_at", { ascending: true })
      .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
    if (error) throw error;
    const rows = (data ?? []) as unknown as Array<{
      id: string;
      patient_id: string | null;
      fit_session_id: string | null;
      request_type: string;
      created_at: string;
    }>;
    if (rows.length === 0) break;

    for (const request of rows) {
      stats.scannedRequests += 1;
      const age = msSince(request.created_at, nowMs) ?? 0;
      const days = Math.floor(age / 86_400_000);
      const severity = days >= REQUEST_UNWORKED_HIGH_DAYS ? "high" : "medium";
      await raiseAlert(
        ctx.supabase,
        {
          alert_type: "request_unworked",
          severity,
          status: "open",
          fit_request_id: request.id,
          fit_session_id: request.fit_session_id,
          patient_id: request.patient_id,
          detail: {
            request_type: request.request_type,
            // Raise-time record. The page shows the LIVE wait computed
            // from the request's own created_at, because this number is
            // frozen the moment the row is inserted.
            days_waiting: days,
          },
        },
        stats,
      );
      // …and escalate the one that was already raised. The insert above
      // is a no-op after the first tick (the unique index is
      // deliberately not scoped to open rows), so without this a request
      // raised at two days would still read 'medium' three weeks later —
      // the opposite of what a severity-sorted queue is for. Scoped to
      // `open` so it can never disturb a row a CSR has dismissed.
      if (severity === "high") {
        await ctx.supabase
          .from("fitter_followup_alerts")
          .update({ severity: "high" })
          .eq("fit_request_id", request.id)
          .eq("alert_type", "request_unworked")
          .eq("status", "open")
          .neq("severity", "high");
      }
    }
    if (rows.length < PAGE_SIZE) break;
  }

  // Auto-resolve: anything a CSR has since picked up.
  //
  // Driven from the ALERT side, not from the request side. Scanning
  // "every request that is no longer new" would grow without bound and
  // put thousands of ids into a PostgREST `.in(...)` filter; the open
  // alerts are the small set, and they are the only rows this could
  // possibly close.
  const alertedRequestIds = await openAlertSubjectIds(
    ctx.supabase,
    "fit_request_id",
    ["request_unworked"],
  );

  const worked: string[] = [];
  for (const chunk of chunkIds(alertedRequestIds)) {
    const { data, error } = await ctx.supabase
      .from("fitter_fit_requests")
      .select("id, status")
      .in("id", chunk);
    if (error) throw error;
    for (const r of (data ?? []) as Array<{ id: string; status: string }>) {
      if (r.status !== "new") worked.push(r.id);
    }
  }
  await resolveAlerts(
    ctx.supabase,
    { requestIds: worked },
    "request_worked",
    stats,
    nowIso,
  );
}

/**
 * Close cohort-A alerts for invites that have since been finished or
 * revoked.
 *
 * Cohort B's conversions are resolved inline (the sweep already batches
 * that probe); this covers the transitions the cohort scans stop seeing,
 * because a completed or revoked invite drops out of their filters
 * entirely.
 */
/**
 * Close `fit_no_request` alerts for fittings the patient has since acted
 * on — at ANY age.
 *
 * Cohort B's scan is bounded to POST_FIT_MAX_AGE_MS so a first deploy
 * cannot chase a backlog, and its conversion probe rides along inside
 * that scan. That is right for RAISING and for SENDING, and wrong for
 * RESOLVING: once an alert passes thirty days, the scan stops looking at
 * that fitting, so a request the patient filed on day thirty-one is
 * never observed and the alert stays open forever. Staff then ring
 * somebody who already asked — the specific outcome an "everyone still
 * waiting" queue must never produce.
 *
 * Driven from the alert side, so the bound on the scan does not apply.
 */
async function resolveActedOnFitNoRequest(
  ctx: OrgContext,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const inviteIds = await openAlertSubjectIds(
    ctx.supabase,
    "fitter_invite_id",
    ["fit_no_request"],
  );
  if (inviteIds.length === 0) return;

  for (const chunk of chunkIds(inviteIds)) {
    const { data, error } = await ctx.supabase
      .from("fitter_invites")
      .select(INVITE_SELECT)
      .in("id", chunk);
    if (error) throw error;
    const rows = (data ?? []) as unknown as InviteRow[];
    if (rows.length === 0) continue;
    const acted = await findActedOn(ctx.supabase, rows);
    await resolveAlerts(
      ctx.supabase,
      { inviteIds: rows.filter((r) => acted.has(r.id)).map((r) => r.id) },
      "request_received",
      stats,
      nowIso,
    );
  }
}

async function resolveFinishedInvites(
  ctx: OrgContext,
  stats: FitterFollowupStats,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const inviteIds = await openAlertSubjectIds(
    ctx.supabase,
    "fitter_invite_id",
    COHORT_A_TYPES,
  );
  if (inviteIds.length === 0) return;

  for (const chunk of chunkIds(inviteIds)) {
    const { data: invites, error: inviteErr } = await ctx.supabase
      .from("fitter_invites")
      .select("id, status")
      .in("id", chunk);
    if (inviteErr) throw inviteErr;
    const done: string[] = [];
    const revoked: string[] = [];
    for (const r of (invites ?? []) as Array<{ id: string; status: string }>) {
      if (r.status === "completed" || r.status === "attached") done.push(r.id);
      else if (r.status === "revoked") revoked.push(r.id);
    }
    await resolveAlerts(
      ctx.supabase,
      { inviteIds: done },
      "fit_completed",
      stats,
      nowIso,
    );
    await resolveAlerts(
      ctx.supabase,
      { inviteIds: revoked },
      "invite_revoked",
      stats,
      nowIso,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────

/**
 * Atomic claim: stamp BEFORE the send, conditional on the column still
 * holding the value we read. That is what stops two ticks racing the
 * same row into a double message. The stamp is NOT released on a send
 * failure — one attempt per window. Re-sending after a transient vendor
 * error would chase the same person hourly for the rest of the window,
 * which is worse than a missed nudge (the other window still gets its
 * own attempt).
 */
async function claimStamp(
  supabase: OrgScopedClient,
  inviteId: string,
  column: string,
  priorValue: string | null,
  patch: InviteUpdate,
  /**
   * The lifecycle the candidate scan actually observed. Re-asserted in
   * the same conditional UPDATE so a state change between the read and
   * the claim LOSES the claim instead of being written straight over.
   *
   * Without it the claim is conditional on the stamp alone, and the
   * stamp does not move when a patient finishes their fitting or a CSR
   * revokes the invite — so somebody who completed the fitter thirty
   * seconds ago could still be sent "finish your mask fitting", and a
   * just-revoked invite could still be advertised.
   */
  expected: {
    statuses: string[];
    anchorColumn: "sent_at" | "completed_at";
    anchor: string | null;
  },
): Promise<boolean> {
  let claim = supabase
    .from("fitter_invites")
    .update(patch)
    .eq("id", inviteId)
    .in("status", expected.statuses);
  // The anchor pins the ROUND: a resend re-stamps `sent_at`, which is
  // exactly what makes an old stamp stale, so a resend landing mid-tick
  // must lose this claim rather than spend the new round's nudge.
  claim = expected.anchor
    ? claim.eq(expected.anchorColumn, expected.anchor)
    : claim.is(expected.anchorColumn, null);
  claim = priorValue ? claim.eq(column, priorValue) : claim.is(column, null);
  const { data, error } = await claim.select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

async function finishNudge(
  ctx: OrgContext,
  subject: { inviteId?: string; requestId?: string },
  alertTypes: readonly AlertType[],
  delivery: Awaited<ReturnType<typeof sendFitterFollowup>>,
  stats: FitterFollowupStats,
  nowIso: string,
): Promise<void> {
  if (delivery.delivered) {
    stats.nudgesSent += 1;
    await stampAlertNudge(
      ctx.supabase,
      subject,
      alertTypes,
      delivery.channel ?? "email",
      nowIso,
    );
    // Bump the counter separately: PostgREST cannot express `x = x + 1`,
    // and reading-then-writing it would need another round-trip for a
    // number the worklist only uses as "have we tried, and how often".
    await bumpNudgeCount(ctx.supabase, subject, alertTypes);
    return;
  }
  stats.sendFailures += 1;
  if (
    delivery.reason === "no_contact" ||
    delivery.reason === "in_office_handoff"
  ) {
    stats.skippedNoChannel += 1;
  } else if (delivery.reason === "link_unavailable") {
    // Unreachable from cohort A now that the guard above runs before the
    // claim, but the sender is callable from elsewhere and the tally
    // should stay honest about which bucket a refusal fell into.
    stats.skippedNoLinkBase += 1;
  }
  logger.info(
    {
      event: "fitter_followup.send_declined",
      orgId: ctx.orgId,
      reason: delivery.reason,
      channel: delivery.channel,
    },
    "fitter-followup: follow-up not delivered",
  );
}

async function bumpNudgeCount(
  supabase: OrgScopedClient,
  subject: { inviteId?: string; requestId?: string },
  alertTypes: readonly AlertType[],
): Promise<void> {
  try {
    let read = supabase
      .from("fitter_followup_alerts")
      .select("id, nudge_count")
      .eq("status", "open")
      .in("alert_type", alertTypes as AlertType[]);
    read = subject.inviteId
      ? read.eq("fitter_invite_id", subject.inviteId)
      : read.eq("fit_request_id", subject.requestId ?? "");
    const { data } = await read;
    for (const row of (data ?? []) as Array<{
      id: string;
      nudge_count: number;
    }>) {
      await supabase
        .from("fitter_followup_alerts")
        .update({ nudge_count: (row.nudge_count ?? 0) + 1 })
        .eq("id", row.id);
    }
  } catch (err) {
    logger.debug(
      { err: redactDbErr(err) },
      "fitter-followup: nudge count bump failed",
    );
  }
}

/** Platform fallback origin, matching the admin fitter-invite route. */
function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : "https://cmbreathe.com")
  ).replace(/\/$/, "");
}

export async function runFitterFollowupSweep(
  now: Date = new Date(),
): Promise<FitterFollowupStats> {
  const stats = emptyStats();

  await forEachActiveOrg(
    async (orgId) => {
      const supabase = getOrgScopedClient(orgId);
      // Read the flag ONCE per tenant. It gates the patient messages
      // only; every alert below is raised regardless of what it says.
      let nudgesEnabled: boolean;
      try {
        nudgesEnabled = await isFeatureEnabled("fitter.followup_nudges", orgId);
      } catch {
        // isFeatureEnabled already absorbs failures into "off"; this
        // catch is belt-and-braces so a flag lookup can never cost the
        // tenant its worklist.
        nudgesEnabled = false;
      }
      // Null for a non-seed tenant with no verified domain: we refuse to
      // mint a platform-host invite link that would resolve against the
      // wrong storefront (same posture as the admin invite route). The
      // no-link cohort-B follow-up and every alert still run.
      const linkBase = await resolveTenantLinkBaseUrl(
        orgId,
        publicBaseUrl(),
      ).catch(() => null);

      const ctx: OrgContext = {
        orgId,
        supabase,
        nudgesEnabled,
        linkBase,
        sendBudget: { remaining: SEND_CAP_PER_ORG },
      };

      // Resolve BEFORE raising, so a tick never reports an alert for
      // something that was settled since the last one.
      await resolveFinishedInvites(ctx, stats, now);
      await resolveActedOnFitNoRequest(ctx, stats, now);
      await sweepOpenInvites(ctx, stats, now);
      await sweepCompletedInvites(ctx, stats, now);
      await sweepStaleRequests(ctx, stats, now);
    },
    { jobName: FITTER_FOLLOWUP_JOB },
  );

  return stats;
}

export async function registerFitterFollowupScanJob(
  boss: PgBoss,
): Promise<void> {
  // Bulk sweep rather than a single vendor send, so two overrides on the
  // vendor preset (same reasoning as invite-acceptance-reminder):
  //   * policy "singleton" — a manual re-trigger or a retry landing near
  //     the next cron tick can't run concurrently with an in-flight
  //     sweep and double-message a row.
  //   * retryLimit 1 — the preset's 5 retries would re-sweep every
  //     tenant up to 5x. Per-row failures are caught inline and never
  //     throw, so the only thing that retries is a DB-level failure.
  await createQueueWithDlq(boss, FITTER_FOLLOWUP_JOB, VENDOR_SEND_QUEUE_OPTS, {
    policy: "singleton",
    retryLimit: 1,
  });
  await boss.work(FITTER_FOLLOWUP_JOB, async () => {
    try {
      const stats = await runFitterFollowupSweep();
      logger.info(
        { event: "fitter_followup.completed", ...stats },
        "fitter-followup: completed",
      );
    } catch (err) {
      logger.error(
        {
          err:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : err,
        },
        "fitter-followup: failed",
      );
      throw err;
    }
  });
  await boss.schedule(FITTER_FOLLOWUP_JOB, FITTER_FOLLOWUP_CRON);
  logger.info({ cron: FITTER_FOLLOWUP_CRON }, "fitter-followup.scan scheduled");
}
