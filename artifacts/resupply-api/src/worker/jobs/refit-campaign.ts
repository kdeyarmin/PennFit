// pg-boss job: proactive re-fit outreach to patients already on service.
//
// WHY THIS EXISTS
// ---------------
// Every fitter campaign this platform runs targets NEW leads — the
// first-day nudge, the re-engage sweep, the six-touch supply campaign.
// Nothing ever goes back to a patient who is already on service. Two
// concrete failures follow from that:
//
//   1. A patient answers the post-delivery fit survey WE sent with
//      "leaking" or "uncomfortable". That answer lands in a staff
//      worklist and the patient hears nothing back. They told us the
//      mask we picked doesn't work and we didn't reply.
//   2. A patient keeps wearing a mask the manufacturer has since
//      discontinued, until the day supplies run out.
//
// This scan offers both groups a fresh fitting.
//
// SCOPE — deliberately ONE message, not a drip
// --------------------------------------------
// The competitor pitch this answers is "optimise established patients
// onto ideal newer products", which is a targeted re-fit offer, not a
// nurture sequence. A patient who doesn't take up a re-fit offer has
// given an answer; asking six more times would be harassment dressed as
// a campaign. One message, then a quarter of silence.
//
// NOT COVERED, on purpose: patients whose mask has merely dropped out of
// the tenant's formulary. Deciding that requires resolving the formulary
// per patient against their payer, location and contract — and a rule
// that doesn't fire when the payer is unknown (0482's own semantics).
// Getting that wrong means telling a patient their working mask is
// unavailable when it isn't. It needs its own design pass.
//
// GATES — three of them, and all three must be open
// -------------------------------------------------
//   1. RESUPPLY_REFIT_CAMPAIGN_ENABLED=1 — boot env var controlling
//      registration, so a deploy with live credentials never starts
//      messaging on its own.
//   2. fitter.refit_campaign — runtime flag, seeded OFF (migration
//      0490), flipped per tenant from the Control Center.
//   3. Per patient: consent, do-not-disturb, the hard patient-local
//      9am-8pm window, and a 90-day frequency cap.
//
// PHI: message bodies carry a first name and a link. No measurements, no
// mask name, no clinical detail — patient SMS and email are not
// encrypted channels. Logs carry counts and ids only.

import type PgBoss from "pg-boss";

import {
  type CommunicationPreferences,
  DEFAULT_COMMUNICATION_PREFERENCES,
  getOrgScopedClient,
  type OrgScopedClient,
} from "@workspace/resupply-db";

import { claimDedupKey, releaseDedupKey } from "../../lib/dedup-keys.js";
import {
  isInDndWindow,
  isOutsideSmsSendWindow,
  shouldSendEmail,
  shouldSendSms,
} from "../../lib/comm-prefs.js";
import { isFeatureEnabled } from "../../lib/feature-flags.js";
import {
  sendRescanForInvite,
  type RescanReason,
} from "../../lib/fitting/rescan-notify.js";
import { logger } from "../../lib/logger.js";
import { forEachActiveOrg } from "../lib/for-each-active-org.js";
import {
  createQueueWithDlq,
  CRON_SCAN_QUEUE_OPTS,
} from "../lib/queue-options.js";

export const REFIT_CAMPAIGN_JOB = "refit-campaign.scan";

/**
 * One offer per patient per quarter. A re-fit is a considered decision,
 * not a purchase nudge — re-asking sooner reads as pestering, and the
 * patient's mask situation rarely changes inside 90 days anyway.
 */
const COOLDOWN_DAYS = 90;

/**
 * How far back a survey answer still counts as actionable. Beyond this
 * the patient has either sorted it out themselves or given up, and
 * re-opening it cold is worse than leaving it to staff.
 */
const BAD_FIT_LOOKBACK_DAYS = 120;

/**
 * How many offers to actually send per tenant per night.
 *
 * Deliberately a cap on OFFERS, not on rows fetched. Capping the query
 * meant the scan saw the same newest N rows every night; after the first
 * run those patients were all cooldown-held, so the job spun on a set it
 * could no longer act on and patients further down the window were never
 * reached at all.
 */
const MAX_OFFERS_PER_ORG = 200;

/**
 * How many rows to consider to find those offers. Wider than the offer
 * cap because most candidates on any given night are already held by
 * their cooldown, and a re-answered or already-actioned survey drops out
 * entirely.
 *
 * Capped at 1000 because that is PostgREST's `max_rows`: a larger
 * `.limit()` is silently truncated to 1000 with no error, so the previous
 * value of 2000 promised headroom the read never had. Rows arrive
 * newest-first and the reducers keep the latest per order / per patient,
 * so hitting the cap fails safe (older candidates wait for the next
 * nightly run rather than being messaged twice) — but the constant should
 * state the ceiling that actually applies.
 */
const CANDIDATE_SCAN_LIMIT = 1000;

interface Candidate {
  patientId: string;
  reason: RescanReason;
}

export async function registerRefitCampaignJob(boss: PgBoss): Promise<void> {
  if (process.env.RESUPPLY_REFIT_CAMPAIGN_ENABLED !== "1") {
    logger.info(
      { queue: REFIT_CAMPAIGN_JOB },
      "refit campaign not registered (RESUPPLY_REFIT_CAMPAIGN_ENABLED != 1)",
    );
    return;
  }
  await createQueueWithDlq(boss, REFIT_CAMPAIGN_JOB, CRON_SCAN_QUEUE_OPTS);
  await boss.work(REFIT_CAMPAIGN_JOB, async () => {
    await runRefitCampaignScan();
  });
  // 19:20 UTC. The window has to hold at BOTH ends of the country, and
  // the binding constraint is Hawaii, not the mainland: at the previous
  // 18:40 UTC it was 08:40 in Pacific/Honolulu, i.e. before the hard
  // 9am-8pm patient-local gate opened. Because this is a fixed daily
  // cron, an SMS-only Hawaii patient was rejected at the same local hour
  // every single day and could never be reached — the exact permanent
  // skip `isOutsideSmsSendWindow` warns about. 19:20 UTC is 09:20 HST and
  // 15:20 ET, inside the window everywhere.
  await boss.schedule(REFIT_CAMPAIGN_JOB, "20 19 * * *");
  logger.info(
    { queue: REFIT_CAMPAIGN_JOB },
    "refit campaign worker registered",
  );
}

export async function runRefitCampaignScan(): Promise<void> {
  await forEachActiveOrg(
    async (orgId) => {
      if (!(await isFeatureEnabled("fitter.refit_campaign", orgId))) return;
      await runForOrg(orgId);
    },
    { jobName: REFIT_CAMPAIGN_JOB },
  );
}

async function runForOrg(orgId: string): Promise<void> {
  const supabase = getOrgScopedClient(orgId);
  const candidates = await findCandidates(supabase, orgId);
  if (candidates.length === 0) return;

  let sent = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    if (sent >= MAX_OFFERS_PER_ORG) break;
    const outcome = await offerRefit(supabase, orgId, candidate);
    if (outcome === "sent") sent += 1;
    else skipped += 1;
  }

  logger.info(
    {
      event: "refit_campaign.tick",
      queue: REFIT_CAMPAIGN_JOB,
      orgId,
      candidates: candidates.length,
      sent,
      skipped,
    },
    "refit campaign: tick complete",
  );
}

/**
 * Patients worth offering a re-fit to, most-deserving first.
 *
 * A reported bad fit outranks a discontinued mask: one is a patient
 * actively uncomfortable tonight, the other is a supply problem months
 * out. When a patient qualifies under both, they are contacted once,
 * about the bad fit.
 */
async function findCandidates(
  supabase: OrgScopedClient,
  orgId: string,
): Promise<Candidate[]> {
  const byPatient = new Map<string, Candidate>();

  for (const c of await findReportedBadFits(supabase, orgId)) {
    if (!byPatient.has(c.patientId)) byPatient.set(c.patientId, c);
  }
  for (const c of await findDiscontinuedMasks(supabase, orgId)) {
    if (!byPatient.has(c.patientId)) byPatient.set(c.patientId, c);
  }

  // Not sliced to the offer cap here — `runForOrg` stops once it has made
  // that many OFFERS, so patients held by an existing cooldown fall
  // through to the next eligible one instead of consuming the budget.
  return [...byPatient.values()];
}

/** Patients who told us on the post-delivery survey that it doesn't fit. */
async function findReportedBadFits(
  supabase: OrgScopedClient,
  orgId: string,
): Promise<Candidate[]> {
  const since = new Date(
    Date.now() - BAD_FIT_LOOKBACK_DAYS * 86_400_000,
  ).toISOString();

  // Every verdict, not just the bad ones. 0201 explicitly allows a patient
  // to re-answer, so a later "good" has to be able to cancel an earlier
  // "leaking" — filtering to bad answers in SQL would hide exactly the row
  // that says the problem is over, and we would message someone whose fit
  // is now fine.
  const { data, error } = (await supabase
    .from("mask_fit_outcomes")
    .select("order_id, fit_outcome, status, created_at")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(CANDIDATE_SCAN_LIMIT)) as {
    data: Array<{
      order_id: string;
      fit_outcome: string;
      status: string;
      created_at: string;
    }> | null;
    error: { message: string } | null;
  };
  if (error) {
    logger.warn(
      { event: "refit_campaign.bad_fit_query_failed", orgId, err: error },
      "refit campaign: could not read fit survey responses",
    );
    return [];
  }

  // Rows arrive newest-first, so the first one seen per order IS the
  // latest. Anything already `actioned` is staff's — they have picked this
  // up, and a second automated message would talk over them.
  const latestByOrder = new Map<string, { verdict: string; status: string }>();
  for (const r of data ?? []) {
    if (!latestByOrder.has(r.order_id)) {
      latestByOrder.set(r.order_id, {
        verdict: r.fit_outcome,
        status: r.status,
      });
    }
  }
  const orderIds = [...latestByOrder.entries()]
    .filter(
      ([, v]) =>
        (v.verdict === "leaking" || v.verdict === "uncomfortable") &&
        v.status !== "actioned",
    )
    .map(([orderId]) => orderId);
  if (orderIds.length === 0) return [];

  const { data: orders } = (await supabase
    .from("shop_orders")
    .select("id, patient_id")
    .in("id", orderIds)) as {
    data: Array<{ id: string; patient_id: string | null }> | null;
  };

  const out: Candidate[] = [];
  for (const o of orders ?? []) {
    // A survey answer we cannot tie to a chart has nobody to contact.
    if (o.patient_id) {
      out.push({ patientId: o.patient_id, reason: "reported_bad_fit" });
    }
  }
  return out;
}

/** Patients whose fitted mask the manufacturer has discontinued. */
/**
 * Patients whose CURRENT mask is discontinued.
 *
 * Note this branch is inert until `fit_sessions.ordered_mask_model_id` and
 * `dispensed_at` are actually written — nothing populates them today, so
 * it finds nothing rather than finding the wrong people. It is written to
 * be correct when those writes land.
 */
async function findDiscontinuedMasks(
  supabase: OrgScopedClient,
  orgId: string,
): Promise<Candidate[]> {
  const { data: models, error: modelErr } = (await supabase
    .raw()
    .schema("resupply")
    .from("mask_models")
    .select("id")
    .eq("status", "discontinued")
    .or(`org_id.is.null,org_id.eq.${orgId}`)
    .limit(500)) as {
    data: Array<{ id: string }> | null;
    error: { message: string } | null;
  };
  if (modelErr) {
    logger.warn(
      { event: "refit_campaign.model_query_failed", orgId, err: modelErr },
      "refit campaign: could not read discontinued models",
    );
    return [];
  }
  const modelIds = (models ?? []).map((m) => m.id);
  if (modelIds.length === 0) return [];

  // Deliberately NOT filtered to the discontinued models in SQL. Asking
  // only for sessions on a discontinued mask returns a patient's OLD
  // fitting even when they have since been moved onto a current model —
  // and telling someone their working mask is obsolete is worse than
  // saying nothing. Fetch dispensed sessions newest-first, keep each
  // patient's most recent, and judge that one.
  const { data: sessions } = (await supabase
    .from("fit_sessions")
    .select("patient_id, ordered_mask_model_id, dispensed_at")
    .not("patient_id", "is", null)
    // Only masks actually handed over. A recommendation that never got
    // dispensed is not something the patient is wearing.
    .not("dispensed_at", "is", null)
    .order("dispensed_at", { ascending: false })
    .limit(CANDIDATE_SCAN_LIMIT)) as {
    data: Array<{
      patient_id: string | null;
      ordered_mask_model_id: string | null;
    }> | null;
  };

  const discontinued = new Set(modelIds);
  const currentMaskByPatient = new Map<string, string | null>();
  for (const s of sessions ?? []) {
    if (!s.patient_id) continue;
    if (!currentMaskByPatient.has(s.patient_id)) {
      currentMaskByPatient.set(s.patient_id, s.ordered_mask_model_id);
    }
  }

  const out: Candidate[] = [];
  for (const [patientId, maskModelId] of currentMaskByPatient) {
    if (maskModelId && discontinued.has(maskModelId)) {
      out.push({ patientId, reason: "mask_discontinued" });
    }
  }
  return out;
}

type OfferOutcome = "sent" | "skipped";

/**
 * Run every guard, then offer the re-fit.
 *
 * Ordering matters: the quiet-hours and consent checks run BEFORE the
 * cooldown is claimed, so a patient skipped for being asleep does not
 * burn their 90-day slot and go silent for a quarter.
 */
async function offerRefit(
  supabase: OrgScopedClient,
  orgId: string,
  candidate: Candidate,
): Promise<OfferOutcome> {
  const { patientId, reason } = candidate;

  const { data: patient } = (await supabase
    .from("patients")
    .select(
      "id, email, phone_e164, legal_first_name, legal_last_name, timezone",
    )
    .eq("id", patientId)
    .limit(1)
    .maybeSingle()) as { data: Record<string, unknown> | null };
  if (!patient) return "skipped";

  const email = (patient.email as string | null) ?? null;
  const phone = (patient.phone_e164 as string | null) ?? null;
  if (!email && !phone) return "skipped";

  const prefs = await readPrefs(supabase, patientId);
  const now = new Date();

  // SMS is preferred when we have a number and consent, because a re-fit
  // offer is time-sensitive to the patient's comfort; email is the
  // fallback. If neither channel is consented, we do not contact them.
  const smsOk =
    Boolean(phone) &&
    shouldSendSms(prefs, "transactional", now) &&
    !isInDndWindow(prefs, now) &&
    !isOutsideSmsSendWindow(now, {
      timezone: (patient.timezone as string | null) ?? null,
      shippingZip: null,
    });
  // Consent category, and it is a judgement call worth stating.
  //
  // SMS has a "transactional" bucket and this qualifies — it is the same
  // classification therapy-fleet-alerts-scan uses for adherence nudges,
  // which is the established precedent here for care outreach.
  //
  // Email has no transactional bucket; the choice is between
  // `resupplyReminder` and `marketing`. This is the equipment the patient
  // is on service for — in the bad-fit case it is a direct REPLY to
  // something they told us — so `resupplyReminder` is the honest match.
  // Filing it under `marketing` would classify a clinical reply as
  // promotion and would silence us toward exactly the patient who said
  // their mask hurts.
  const emailOk =
    Boolean(email) &&
    shouldSendEmail(prefs, "resupplyReminder", now) &&
    !isInDndWindow(prefs, now);

  if (!smsOk && !emailOk) return "skipped";

  // Frequency cap, claimed only once the patient is otherwise eligible.
  const capKey = `refit-campaign:${patientId}`;
  const claim = await claimDedupKey(
    supabase.raw(),
    capKey,
    new Date(Date.now() + COOLDOWN_DAYS * 86_400_000).toISOString(),
  );
  if (claim.outcome !== "claimed") return "skipped";

  // Everything past this point can fail AFTER the cap is claimed. The cap
  // is a promise about messages we sent, so any failure here has to give
  // the slot back — otherwise a Twilio outage or a bad insert silently
  // suppresses this patient for a quarter with nothing having reached
  // them, which is the exact failure the pre-claim ordering above exists
  // to avoid.
  const release = async (why: string): Promise<OfferOutcome> => {
    const { released } = await releaseDedupKey(supabase.raw(), capKey);
    logger.warn(
      {
        event: "refit_campaign.offer_failed",
        orgId,
        patientId,
        why,
        capReleased: released,
      },
      released
        ? "refit campaign: offer failed, cooldown released"
        : "refit campaign: offer failed AND cooldown could not be released — this patient is suppressed until it expires",
    );
    return "skipped";
  };

  const inviteId = await createInvite(supabase, orgId, {
    patientId,
    email: smsOk ? null : email,
    phone: smsOk ? phone : null,
    name: [patient.legal_first_name, patient.legal_last_name]
      .filter(Boolean)
      .join(" ")
      .trim(),
    channel: smsOk ? "sms" : "email",
  });
  if (!inviteId) return await release("invite_insert_failed");

  const delivery = await sendRescanForInvite(orgId, inviteId, reason);
  if (!delivery.delivered) {
    return await release(delivery.reason ?? "send_failed");
  }
  return "sent";
}

async function readPrefs(
  supabase: OrgScopedClient,
  patientId: string,
): Promise<CommunicationPreferences> {
  const { data } = (await supabase
    .from("shop_customers")
    .select("communication_preferences")
    .eq("patient_id", patientId)
    .limit(1)
    .maybeSingle()) as { data: Record<string, unknown> | null };
  const raw = data?.communication_preferences;
  if (!raw || typeof raw !== "object") return DEFAULT_COMMUNICATION_PREFERENCES;
  return {
    ...DEFAULT_COMMUNICATION_PREFERENCES,
    ...(raw as Partial<CommunicationPreferences>),
  };
}

/**
 * Mint a fitter invite for the offer.
 *
 * A fresh row rather than reusing an old one, so the re-fit shows up as
 * its own entry in the fitter worklist and counts separately in the
 * outcome reporting instead of overwriting the history of the fitting
 * that led here.
 */
async function createInvite(
  supabase: OrgScopedClient,
  orgId: string,
  input: {
    patientId: string;
    email: string | null;
    phone: string | null;
    name: string;
    channel: "email" | "sms";
  },
): Promise<string | null> {
  const nowIso = new Date().toISOString();
  const { data, error } = (await supabase
    .from("fitter_invites")
    .insert({
      patient_id: input.patientId,
      recipient_email: input.email,
      recipient_phone_e164: input.phone,
      recipient_name: input.name.length > 0 ? input.name : null,
      channel: input.channel,
      status: "sent",
      invited_by_email: null,
      sent_at: nowIso,
      // sendRescanForInvite re-mints the token and re-stamps this; the
      // value here only has to be non-null and in the future.
      expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    })
    .select("id")
    .limit(1)
    .maybeSingle()) as {
    data: { id: string } | null;
    error: { message: string } | null;
  };
  if (error || !data) {
    logger.warn(
      { event: "refit_campaign.invite_insert_failed", orgId, err: error },
      "refit campaign: could not create invite",
    );
    return null;
  }
  return data.id;
}
