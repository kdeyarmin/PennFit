// POST /shop/fitter-complete — fired by the /results page when the
// patient sees a mask recommendation. Marks the existing
// resupply.fitter_leads row as "completed" and enrolls the patient in
// the multi-touch supply campaign.
//
// What it does:
//   * Looks up the most-recent fitter_leads row by email
//     (lowercased, just like the /shop/fitter-leads insert path).
//   * Stamps completed_at + recommended_mask_* + flips
//     journey_stage='campaign_active' + schedules the first
//     touchpoint 24h out via next_campaign_touch_at.
//   * No-ops if the lead has already converted, unsubscribed, or
//     finished the campaign — those are sticky terminal states.
//
// What it does NOT do:
//   * No email send here. The dispatcher worker is the only place
//     that sends; this route just flips the state machine.
//   * No PHI write. The recommended mask is a product reference
//     (catalog id / name / type), never the patient's measurements.
//   * No 5xx on DB failure. Mirrors /shop/fitter-leads — the patient
//     advances regardless; campaign enrollment is best-effort.
//
// GET /shop/fitter-leads/unsubscribe?t=<token> — one-click unsubscribe
// link rendered in every campaign email footer. HMAC-signed token
// carries the lead_id + an expiry. On verify the row's
// journey_stage flips to 'unsubscribed', terminal forever.

import { Router, type IRouter } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import {
  type Database,
  getSupabaseServiceRoleClient,
} from "@workspace/resupply-db";

import { logger } from "../../lib/logger";

type FitterLeadsUpdate = Database["resupply"]["Tables"]["fitter_leads"]["Update"];

const router: IRouter = Router();

// Pre-purchase cadence — touch_index 1-6, anchored on `completed_at`.
// Goal: convert "fit but haven't ordered" into a first-time buyer.
// The dispatcher worker imports this so it stays the single source
// of truth.
export const TOUCHPOINT_OFFSETS_MS = [
  1 * 86_400_000, //   T1 — day 1: recap of recommendation
  3 * 86_400_000, //   T2 — day 3: social proof
  7 * 86_400_000, //   T3 — day 7: FSA/HSA reminder
  14 * 86_400_000, //  T4 — day 14: one-time discount
  30 * 86_400_000, //  T5 — day 30: educational
  60 * 86_400_000, //  T6 — day 60: final
] as const;

export const TOTAL_TOUCHPOINTS = TOUCHPOINT_OFFSETS_MS.length;

// Re-order cadence — touch_index 7-10, anchored on
// `first_order_placed_at`. Goal: drive recurring supply purchases.
// Schedule mirrors AASM hygiene + manufacturer wear guidance:
//
//   * cushion / pillow seal — replace every 14-30 days; we nudge at
//     30d because anything sooner reads spammy.
//   * disposable inline filter — replace every 30 days; we bundle
//     the cushion-and-filter reminder at 30d (T7) but lead with
//     "filter check" at 60d (T8) so customers running low between
//     T7 and T8 still get a touch.
//   * headgear / chinstrap — replace every 90-180 days; nudge at
//     90d (T9) catches loose-strap complaints early.
//   * full mask refresh — replace at 6-12 months; T10 at 180d sets
//     up the new-mask conversation before the cushion warranty
//     window closes.
//
// Why these numbers and not the existing reminders.ts cadence?
//   reminders.ts is tied to patient_smart_trigger_events which only
//   fires when therapy data is wired up (CPAP modem upload). A
//   cash-pay shop customer who bought a mask without setting up a
//   modem account never hits that path. This dispatcher gives them
//   a re-order nurture independent of therapy-data integration.
export const REORDER_TOUCHPOINT_OFFSETS_MS = [
  30 * 86_400_000, //  T7  — day 30: cushion replacement
  60 * 86_400_000, //  T8  — day 60: filter check
  90 * 86_400_000, //  T9  — day 90: headgear
  180 * 86_400_000, // T10 — day 180: full mask refresh
] as const;

export const TOTAL_REORDER_TOUCHPOINTS = REORDER_TOUCHPOINT_OFFSETS_MS.length;
/** Total touches across both phases, 1-indexed. */
export const TOTAL_ALL_TOUCHPOINTS =
  TOTAL_TOUCHPOINTS + TOTAL_REORDER_TOUCHPOINTS;

// Cold-lead reactivation — mig 0153. T11 is a single final email
// scheduled 90 days after T6 if the lead never converted. Anchored
// on `last_campaign_touch_at` (the T6 send time), not the original
// completed_at.
export const FINAL_CALL_OFFSET_MS = 90 * 86_400_000;
/** 1-based index of the final-call touch. */
export const FINAL_CALL_TOUCH_INDEX = TOTAL_ALL_TOUCHPOINTS + 1; // T11
/** Total touches including the final call. */
export const TOTAL_WITH_FINAL_CALL = TOTAL_ALL_TOUCHPOINTS + 1;

/** Open-tracking — leads with this many recorded opens before
 *  ordering get flipped into the hot-lead queue for CSR outreach. */
export const HOT_LEAD_THRESHOLD = 3;

// ---------------------------------------------------------------
// Subject-line A/B variants (mig 0157).
// ---------------------------------------------------------------
//
// Per-touch registry: touchIndex → list of variant keys offered
// for that touch. The composer module knows what subject string
// to render for each key; this module is the single source of
// truth for "which touches are currently running an A/B test."
//
// To add a variant: bump the array for the relevant touch_index
// AND add the corresponding case in the composer's variant map.
// Variants ship at the next worker tick — no migration needed.
//
// Holding a variant constant per (lead, touch) means a patient
// who got T1-A doesn't get T1-B if they happen to re-open the
// email — the deterministic hash below guarantees same input →
// same variant. Bucket assignment is uniform across the cohort
// because SHA-256 + mod gives ~equal-sized buckets at any non-
// pathological cohort size.
export const SUBJECT_VARIANTS: Record<number, readonly string[]> = {
  // T1: warm recap. Loss-aversion ("on hold") vs. promise-based
  // ("ready when you are"). Both target the day-1 cold-warm
  // mindset; A is the current default.
  1: ["A", "B"],
  // T4: discount touch. Promo-code-first ("WELCOME15: 15% off
  // ...") vs. urgency-first ("15% off ends in 7 days"). The
  // dispatcher's strongest-converting touch — A/B'ing it has the
  // biggest expected revenue impact.
  4: ["A", "B"],
  // Other touches default to single-variant ('A') via the
  // pickVariant fallback.
};

/** Hash-bucket assignment for the A/B variant. Same lead always
 *  gets the same variant for the same touch_index, evenly
 *  distributed across the available variants for that touch.
 *  Exported for tests. */
export function pickSubjectVariant(
  leadId: string,
  touchIndex: number,
): string {
  const variants = SUBJECT_VARIANTS[touchIndex] ?? ["A"];
  if (variants.length === 1) return variants[0];
  // Deterministic hash. SHA-256 → mod variants.length. Using the
  // first 4 bytes is plenty of entropy for bucket count <= 8.
  const hash = createHmac("sha256", "fitter-supply-variant-bucket")
    .update(`${leadId}|${touchIndex}`, "utf8")
    .digest();
  const bucket = hash.readUInt32BE(0) % variants.length;
  return variants[bucket];
}

const MASK_TYPES = ["fullFace", "nasal", "nasalPillow", "hybrid"] as const;

// ---------------------------------------------------------------
// Per-IP rate limit shared by both routes in this file.
// ---------------------------------------------------------------
// Mirrors the in-process bucket used by /shop/fitter-leads,
// /shop/quiz-leads, /shop/insurance-leads. We keep it self-contained
// in this file (rather than reaching for express-rate-limit) so it
// stays a small dependency surface and the test seam below can clear
// state between vitest runs.
//
// Why both routes need it
// -----------------------
//   * POST /shop/fitter-complete   — fires once per finished fitter
//     in normal use, but a refresh / botted /results spam could push
//     it higher. Tight cap stops a script from churning the supply-
//     campaign state machine.
//   * GET /shop/fitter-leads/unsubscribe — performs HMAC-bound
//     authorization. The HMAC-SHA256 key space makes brute force
//     practically impossible, but CodeQL flags any authorizing route
//     that lacks a rate limit (cf. PR #310 review). Adding the cap
//     closes the finding AND slows down enumeration noise in the
//     audit log.
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;
const rateBucket = new Map<string, number[]>();
const RATE_SWEEP_EVERY = 200;
let rateBucketSweepCounter = 0;

function sweepRateBucket(now: number): void {
  for (const [key, timestamps] of rateBucket) {
    if (timestamps.every((t) => now - t >= RATE_WINDOW_MS)) {
      rateBucket.delete(key);
    }
  }
}

function rateLimited(key: string): boolean {
  const now = Date.now();
  if (++rateBucketSweepCounter % RATE_SWEEP_EVERY === 0) {
    sweepRateBucket(now);
  }
  const arr = (rateBucket.get(key) ?? []).filter(
    (t) => now - t < RATE_WINDOW_MS,
  );
  if (arr.length >= RATE_MAX) {
    rateBucket.set(key, arr);
    return true;
  }
  arr.push(now);
  rateBucket.set(key, arr);
  return false;
}

function callerIp(req: { ip?: string; socket?: { remoteAddress?: string }; headers: Record<string, unknown> }): string {
  return (
    req.ip ||
    req.socket?.remoteAddress ||
    (typeof req.headers["x-forwarded-for"] === "string"
      ? req.headers["x-forwarded-for"].split(",")[0]?.trim()
      : null) ||
    "unknown"
  );
}

// Email + recommended mask. Measurements are intentionally NOT in
// the body (HIPAA minimization — they never leave the browser); the
// catalog reference is enough to personalize the campaign copy.
const completeBody = z
  .object({
    email: z.string().trim().toLowerCase().email().max(200),
    recommendedMaskId: z.string().trim().min(1).max(100),
    recommendedMaskName: z.string().trim().min(1).max(200),
    recommendedMaskType: z.enum([...MASK_TYPES] as [
      (typeof MASK_TYPES)[number],
      ...(typeof MASK_TYPES)[number][],
    ]),
  })
  .strict();

router.post("/shop/fitter-complete", async (req, res) => {
  const ipKey = `${callerIp(req)}:fitter-complete`;
  if (rateLimited(ipKey)) {
    res.status(429).json({ error: "rate_limited" });
    return;
  }
  const parse = completeBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parse.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const data = parse.data;

  try {
    const supabase = getSupabaseServiceRoleClient();

    // Find the most-recent lead row for this email. We don't error
    // if there's no row (the patient may have submitted /consent
    // before this column existed, or via a different device) — we
    // just no-op and return 200 so the patient flow keeps moving.
    const { data: rows, error: lookupErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .select("id, journey_stage, marketing_opt_in, completed_at")
      .eq("email", data.email)
      .order("created_at", { ascending: false })
      .limit(1);
    if (lookupErr) throw lookupErr;

    const lead = rows?.[0];
    if (!lead) {
      req.log?.info?.(
        { event: "fitter_complete_no_lead" },
        "shop/fitter-complete: no matching lead",
      );
      res.json({ ok: true, enrolled: false, reason: "no_lead" });
      return;
    }

    // Sticky terminal states — never re-enroll a lead that already
    // converted, unsubscribed, or expired. Idempotent on re-fires
    // (e.g. patient refreshes /results); the second call sees
    // journey_stage='campaign_active' and short-circuits.
    if (
      lead.journey_stage === "converted" ||
      lead.journey_stage === "unsubscribed" ||
      lead.journey_stage === "expired" ||
      lead.journey_stage === "campaign_active"
    ) {
      req.log?.info?.(
        { event: "fitter_complete_skip", stage: lead.journey_stage },
        "shop/fitter-complete: lead already in terminal/active state",
      );
      res.json({
        ok: true,
        enrolled: false,
        reason: lead.journey_stage,
      });
      return;
    }

    // Only enroll opted-in leads into the supply campaign. A lead
    // without marketing_opt_in still gets the recommendation in the
    // browser, but we don't email them.
    if (!lead.marketing_opt_in) {
      // Still stamp completed_at so admin reporting knows the
      // patient finished the fitter, but don't schedule a touch.
      await supabase
        .schema("resupply")
        .from("fitter_leads")
        .update({
          completed_at: new Date().toISOString(),
          recommended_mask_id: data.recommendedMaskId,
          recommended_mask_name: data.recommendedMaskName,
          recommended_mask_type: data.recommendedMaskType,
          journey_stage: "completed",
        })
        .eq("id", lead.id);
      res.json({ ok: true, enrolled: false, reason: "no_marketing_opt_in" });
      return;
    }

    const nowIso = new Date().toISOString();
    const firstTouchAt = new Date(
      Date.now() + TOUCHPOINT_OFFSETS_MS[0],
    ).toISOString();

    const { error: updateErr } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({
        completed_at: nowIso,
        recommended_mask_id: data.recommendedMaskId,
        recommended_mask_name: data.recommendedMaskName,
        recommended_mask_type: data.recommendedMaskType,
        journey_stage: "campaign_active",
        next_campaign_touch_at: firstTouchAt,
      })
      .eq("id", lead.id);
    if (updateErr) throw updateErr;

    req.log?.info?.(
      { event: "fitter_complete_enrolled", leadId: lead.id },
      "shop/fitter-complete: lead enrolled in supply campaign",
    );
    res.json({ ok: true, enrolled: true });
  } catch (err) {
    // Best-effort — never 5xx the /results page.
    logger.warn(
      { err },
      "shop/fitter-complete: enrollment failed (continuing best-effort)",
    );
    res.json({ ok: true, enrolled: false, reason: "error" });
  }
});

// -----------------------------------------------------------------
// Unsubscribe link — one-click GET so it works inline in every
// email client without JS or a POST round-trip.
// -----------------------------------------------------------------
//
// Token format: <base64url(lead_id|expiry_seconds)>.<base64url(sig)>
//   * sig = HMAC-SHA256(payload-bytes, RESUPPLY_LINK_HMAC_KEY)
//   * Distinct from the conversation-token format (which uses a
//     JSON payload) so a confused-deputy can't cross-claim.
//
// Why not reuse signLinkToken from @workspace/resupply-messaging?
//   That helper hard-codes conversationId as the bound principal +
//   has only "confirm/edit/stop" actions. A fitter-lead unsubscribe
//   binds a different principal (lead_id) and is a different action
//   class. Cleaner to keep the two scopes separate than to bend the
//   existing API into doing both.

const UNSUBSCRIBE_TTL_MS = 180 * 86_400_000; // 6 months

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64urlDecode(s: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(s)) return null;
  const pad = (4 - (s.length % 4)) % 4;
  const standard = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  try {
    return Buffer.from(standard, "base64");
  } catch {
    return null;
  }
}

function getLinkHmacKey(): Buffer {
  const raw = process.env.RESUPPLY_LINK_HMAC_KEY;
  if (!raw) {
    throw new Error("RESUPPLY_LINK_HMAC_KEY is not set");
  }
  return Buffer.from(raw, "utf8");
}

/** Build an unsubscribe token bound to a lead_id. Exported so the
 *  dispatcher worker can mint one per outbound email. */
export function signUnsubscribeToken(leadId: string, now: Date = new Date()): string {
  const expiresSec = Math.floor((now.getTime() + UNSUBSCRIBE_TTL_MS) / 1000);
  const payload = `${leadId}|${expiresSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

// -----------------------------------------------------------------
// Open-tracking pixel — mig 0153.
// -----------------------------------------------------------------
//
// Every campaign email embeds a 1x1 transparent GIF whose src URL
// carries an HMAC-signed token (leadId|touchIndex|issuedAt). When
// the recipient's client renders the image, we record the open
// against the lead row + (best-effort) increment engagement_score.
//
// Why pixel vs SendGrid event webhook
//   * Works in any ESP; no per-vendor signature plumbing.
//   * The token is self-validating — no DB round-trip to look up
//     "did we actually send this?" before recording the event.
//   * The risk is image-blocking clients (Outlook desktop, some
//     security-conscious users). That's fine — the signal is
//     ordinal ("more engaged than another lead"), not absolute
//     ("definitely opened").
//
// Token shape mirrors signUnsubscribeToken but is DISTINCT (the
// payload includes the touchIndex segment) so a leaked unsubscribe
// token can't be replayed as an open, and vice versa.

/** Token TTL — long enough that an email opened months later still
 *  records, short enough that a re-mailed coupon code can't be
 *  retroactively counted decades later. 180 days matches the
 *  unsubscribe TTL. */
const OPEN_TOKEN_TTL_MS = 180 * 86_400_000;

/** Mint a per-touch tracking-pixel token. Exported so the
 *  dispatcher worker can embed one URL per outbound email. */
export function signOpenTrackingToken(
  leadId: string,
  touchIndex: number,
  now: Date = new Date(),
): string {
  const issuedSec = Math.floor(now.getTime() / 1000);
  // Distinct payload prefix ('o' for open) means a leaked
  // unsubscribe token (prefix 'u' implied by the lack of segment)
  // can't be replayed as an open and the reverse. The pipe-
  // separated shape stays grep-able.
  const payload = `o|${leadId}|${touchIndex}|${issuedSec}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

type OpenVerifyResult =
  | { valid: true; leadId: string; touchIndex: number }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

function verifyOpenTrackingToken(
  token: string,
  now: Date = new Date(),
): OpenVerifyResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }
  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);
  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false, reason: "malformed" };
  const expected = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  if (sigBuf.length !== expected.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(sigBuf, expected)) {
    return { valid: false, reason: "bad_signature" };
  }
  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  const parts = payloadBuf.toString("utf8").split("|");
  if (parts.length !== 4 || parts[0] !== "o") {
    return { valid: false, reason: "malformed" };
  }
  const leadId = parts[1];
  const touchIndex = Number.parseInt(parts[2], 10);
  const issuedSec = Number.parseInt(parts[3], 10);
  if (
    !leadId ||
    !Number.isFinite(touchIndex) ||
    !Number.isFinite(issuedSec) ||
    touchIndex < 1 ||
    touchIndex > 50
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (issuedSec * 1000 + OPEN_TOKEN_TTL_MS <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, leadId, touchIndex };
}

// 1x1 transparent GIF — the smallest valid GIF that renders as
// "nothing." 43 bytes. Returned with no-cache headers so each open
// gets recorded (otherwise a single load + browser cache would
// suppress subsequent opens from the same client).
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

router.get("/shop/track/o", async (req, res) => {
  // Always return the pixel — even on a bad token. NEVER 4xx /
  // 5xx here: an error response would render as a broken-image
  // icon in the patient's inbox.
  const sendPixel = (): void => {
    res.set({
      "Content-Type": "image/gif",
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
      "Content-Length": String(TRANSPARENT_GIF.length),
    });
    res.status(200).end(TRANSPARENT_GIF);
  };

  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    sendPixel();
    return;
  }

  let verify: OpenVerifyResult;
  try {
    verify = verifyOpenTrackingToken(token);
  } catch (err) {
    logger.warn({ err }, "shop/track/o: verify threw");
    sendPixel();
    return;
  }
  if (!verify.valid) {
    sendPixel();
    return;
  }

  // Best-effort: bump the engagement counter + flip hot_lead_at
  // when crossing the threshold. We do this in a single Supabase
  // RPC-style update to keep the latency low (the patient is
  // waiting for the pixel response).
  recordOpenEvent(verify.leadId, verify.touchIndex).catch((err) => {
    // Async fire-and-forget; never block the pixel response.
    logger.warn({ err, leadId: verify.leadId }, "shop/track/o: record failed");
  });

  sendPixel();
});

async function recordOpenEvent(
  leadId: string,
  touchIndex: number,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // Read → compute → write. PostgREST doesn't expose a server-side
  // increment expression, so we do the read-modify-write here. The
  // tight loop on this code path is tiny (one open per send per
  // recipient), so the lack of an atomic increment is fine. A
  // concurrent open by the same recipient at the same instant might
  // be counted once instead of twice — acceptable for a noisy signal.
  const { data: lead, error: readErr } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select("id, engagement_score, hot_lead_at, journey_stage, first_order_id")
    .eq("id", leadId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!lead) return;
  // Don't bump the engagement score on terminal-state rows — the
  // signal is meant to inform CSR outreach for ACTIVE leads. A
  // re-opened email from a converted/unsubscribed lead is noise.
  if (
    lead.journey_stage === "unsubscribed" ||
    lead.journey_stage === "expired" ||
    lead.journey_stage === "converted"
  ) {
    return;
  }
  const nextScore = (lead.engagement_score ?? 0) + 1;
  // Flip hot_lead_at the first time score crosses HOT_LEAD_THRESHOLD,
  // but ONLY for un-converted leads. A patient who's already in
  // reorder_active shouldn't be flagged "hot" — they already bought.
  const shouldFlipHot =
    !lead.hot_lead_at &&
    !lead.first_order_id &&
    nextScore >= HOT_LEAD_THRESHOLD;
  const nowIso = new Date().toISOString();
  const update: FitterLeadsUpdate = {
    engagement_score: nextScore,
    // Mig 0155 — recency stamp for the admin "last engagement"
    // column + CSR triage. Always bumped on a successful open.
    last_open_at: nowIso,
  };
  if (shouldFlipHot) {
    update.hot_lead_at = nowIso;
  }
  const { error: writeErr } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .update(update)
    .eq("id", leadId);
  if (writeErr) throw writeErr;
  if (shouldFlipHot) {
    logger.info(
      { event: "fitter_lead.hot_lead_flipped", leadId, score: nextScore, touchIndex },
      "shop/track/o: lead crossed hot-lead threshold",
    );
  }

  // Mig 0155 — atomically bump the touch row's open_count +
  // stamp first/last_opened_at. Best-effort: a failure here just
  // means per-touch reporting under-counts, not that the open
  // signal is lost (engagement_score is already bumped above).
  try {
    const { error: rpcErr } = await supabase
      .schema("resupply")
      .rpc("record_fitter_touch_open", {
        p_lead_id: leadId,
        p_touch_index: touchIndex,
      });
    if (rpcErr) {
      logger.warn(
        { err: rpcErr.message, leadId, touchIndex },
        "shop/track/o: touch open-count bump failed",
      );
    }
  } catch (err) {
    logger.warn(
      { err, leadId, touchIndex },
      "shop/track/o: touch open-count bump threw",
    );
  }
}

// -----------------------------------------------------------------
// Click-tracking redirect — mig 0154.
// -----------------------------------------------------------------
//
// Every CTA in a campaign email goes through this redirect so we
// can record which call-to-action the lead actually tapped. A
// click is a dramatically stronger engagement signal than an open
// (opens are noisy — Apple Mail Privacy + image pre-fetch — but a
// click requires deliberate intent), and a single click flips the
// lead into the "hot" CSR-outreach queue immediately.
//
// Open-redirect safety
// --------------------
// The signed token payload carries a closed-enum `link_key`, NOT
// a target URL. The route looks the key up in CTA_DESTINATIONS
// below and 302s to the corresponding path on the same origin.
// An attacker who forged a valid HMAC (they can't — but as a
// defense-in-depth principle) still couldn't redirect anywhere
// outside our own catalog.

/** Closed enum of legitimate CTA destinations. The link_key in
 *  every signed click token MUST be in this map. */
const CTA_DESTINATIONS: Record<string, (baseUrl: string) => string> = {
  results: (b) => `${b}/results`,
  shop: (b) => `${b}/shop`,
  subscribe: (b) => `${b}/shop/subscribe`,
  refer: (b) => `${b}/shop/refer`,
  promo: (b) => `${b}/shop`,
  consent: (b) => `${b}/consent`,
};

const CLICK_TOKEN_TTL_MS = 180 * 86_400_000;

/** Mint a per-CTA click token. Exported so the dispatcher worker
 *  can wrap every outbound HTML CTA.
 *
 *  Mig 0157 adds `variantKey` — carries the subject-line A/B
 *  variant forward into the click endpoint so per-variant CTR can
 *  be attributed without a DB lookup against the touches row.
 *  Default 'A' for callers (incl. tests) that don't run A/B
 *  experiments. */
export function signClickTrackingToken(
  leadId: string,
  touchIndex: number,
  linkKey: string,
  variantKey: string = "A",
  now: Date = new Date(),
): string {
  const issuedSec = Math.floor(now.getTime() / 1000);
  // Distinct payload prefix 'c' so a leaked click token can't be
  // cross-replayed against the open-tracking or unsubscribe
  // endpoints (and vice versa). Pipe-separated shape stays
  // grep-able and matches signOpenTrackingToken's convention.
  // Variant key sits at the end so legacy 5-segment tokens
  // minted before mig 0157 still verify (we treat them as
  // variant 'A' for back-compat).
  const payload = `c|${leadId}|${touchIndex}|${linkKey}|${issuedSec}|${variantKey}`;
  const payloadEncoded = base64urlEncode(Buffer.from(payload, "utf8"));
  const sig = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  return `${payloadEncoded}.${base64urlEncode(sig)}`;
}

type ClickVerifyResult =
  | {
      valid: true;
      leadId: string;
      touchIndex: number;
      linkKey: string;
      variantKey: string;
    }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

function verifyClickTrackingToken(
  token: string,
  now: Date = new Date(),
): ClickVerifyResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }
  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);
  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false, reason: "malformed" };
  const expected = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  if (sigBuf.length !== expected.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(sigBuf, expected)) {
    return { valid: false, reason: "bad_signature" };
  }
  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  const parts = payloadBuf.toString("utf8").split("|");
  // 5-segment legacy + 6-segment with variant_key both accepted.
  // Back-compat: tokens signed before mig 0157 default to 'A'.
  if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== "c") {
    return { valid: false, reason: "malformed" };
  }
  const leadId = parts[1];
  const touchIndex = Number.parseInt(parts[2], 10);
  const linkKey = parts[3];
  const issuedSec = Number.parseInt(parts[4], 10);
  const variantKey = parts.length === 6 ? parts[5] : "A";
  if (
    !leadId ||
    !Number.isFinite(touchIndex) ||
    !Number.isFinite(issuedSec) ||
    !linkKey ||
    !(linkKey in CTA_DESTINATIONS) ||
    touchIndex < 1 ||
    touchIndex > 50 ||
    !variantKey ||
    variantKey.length > 8
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (issuedSec * 1000 + CLICK_TOKEN_TTL_MS <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, leadId, touchIndex, linkKey, variantKey };
}

function publicBaseUrl(): string {
  return (
    process.env.SHOP_PUBLIC_BASE_URL ??
    process.env.RESUPPLY_VOICE_PUBLIC_BASE_URL ??
    (process.env.REPLIT_DEV_DOMAIN
      ? `https://${process.env.REPLIT_DEV_DOMAIN}`
      : "https://pennpaps.com")
  ).replace(/\/$/, "");
}

/** Fallback destination when verification fails — we still 302 the
 *  user somewhere (a broken CTA mid-marketing-email is a worse UX
 *  than a redirect to the storefront), but we don't record the
 *  click. */
function fallbackDestination(): string {
  return `${publicBaseUrl()}/shop`;
}

router.get("/shop/track/c", async (req, res) => {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    res.redirect(302, fallbackDestination());
    return;
  }

  let verify: ClickVerifyResult;
  try {
    verify = verifyClickTrackingToken(token);
  } catch (err) {
    logger.warn({ err }, "shop/track/c: verify threw");
    res.redirect(302, fallbackDestination());
    return;
  }
  if (!verify.valid) {
    res.redirect(302, fallbackDestination());
    return;
  }

  // Compute the destination from our server-side allowlist.
  // CTA_DESTINATIONS has been narrowed by verifyClickTrackingToken
  // (verify.linkKey is guaranteed to be a key), but the optional-
  // chain guard is belt-and-suspenders.
  const dest =
    CTA_DESTINATIONS[verify.linkKey]?.(publicBaseUrl()) ??
    fallbackDestination();

  // Best-effort: record the click + bump engagement_score by 5.
  // We don't await this — the redirect is the patient's primary
  // experience and we don't want to add 50ms of DB latency.
  const submitterIp =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    null;
  recordClickEvent(
    verify.leadId,
    verify.touchIndex,
    verify.linkKey,
    verify.variantKey,
    submitterIp,
  ).catch((err) => {
    logger.warn(
      { err, leadId: verify.leadId },
      "shop/track/c: record failed",
    );
  });

  res.redirect(302, dest);
});

/** Click weighting in engagement_score. A click is dramatically
 *  more meaningful than an open — pumping the score by 5 lets a
 *  single click flip a previously-uninterested lead into the hot
 *  queue without waiting for additional opens. */
const CLICK_SCORE_WEIGHT = 5;

async function recordClickEvent(
  leadId: string,
  touchIndex: number,
  linkKey: string,
  variantKey: string,
  submitterIp: string | null,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  // 1. Read the lead row so we can decide whether to flip hot.
  const { data: lead, error: readErr } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .select(
      "id, engagement_score, click_count, hot_lead_at, journey_stage, first_order_id",
    )
    .eq("id", leadId)
    .maybeSingle();
  if (readErr) throw readErr;
  if (!lead) return;
  // Terminal-state rows shouldn't be re-scored. Differs from open
  // tracking only in that 'converted'/'reorder_active' rows DO
  // get their click counters bumped — a click from a converted
  // patient is signal for "they're engaged, follow up on the
  // re-order touches" rather than noise.
  if (
    lead.journey_stage === "unsubscribed" ||
    lead.journey_stage === "expired"
  ) {
    return;
  }

  // 2. Insert the audit row. Best-effort — a failed audit insert
  // shouldn't block the engagement-score bump.
  try {
    const { error: clickInsertErr } = await supabase
      .schema("resupply")
      .from("fitter_campaign_clicks")
      .insert({
        lead_id: leadId,
        touch_index: touchIndex,
        link_key: linkKey,
        submitter_ip: submitterIp,
        // Mig 0157 — carries the subject-line variant through
        // from the click token. Default 'A' for back-compat with
        // legacy 5-segment tokens.
        subject_variant_key: variantKey,
      });
    if (clickInsertErr) {
      logger.warn(
        { err: clickInsertErr.message, leadId, touchIndex, linkKey },
        "shop/track/c: audit insert failed",
      );
    }
  } catch (err) {
    logger.warn(
      { err, leadId, touchIndex, linkKey },
      "shop/track/c: audit insert threw",
    );
  }

  // 3. Bump the lead's running counters + flip hot if needed.
  // ANY click flips hot_lead_at when the lead hasn't yet ordered
  // (a click is a much stronger signal than the 3-open threshold
  // used for opens).
  const nextScore = (lead.engagement_score ?? 0) + CLICK_SCORE_WEIGHT;
  const nextClickCount = (lead.click_count ?? 0) + 1;
  const shouldFlipHot = !lead.hot_lead_at && !lead.first_order_id;
  const nowIso = new Date().toISOString();
  const update: FitterLeadsUpdate = {
    engagement_score: nextScore,
    click_count: nextClickCount,
    // Mig 0155 — recency stamp for the admin "last engagement"
    // column.
    last_click_at: nowIso,
  };
  if (shouldFlipHot) {
    update.hot_lead_at = nowIso;
  }
  const { error: writeErr } = await supabase
    .schema("resupply")
    .from("fitter_leads")
    .update(update)
    .eq("id", leadId);
  if (writeErr) throw writeErr;
  if (shouldFlipHot) {
    logger.info(
      {
        event: "fitter_lead.hot_lead_flipped",
        leadId,
        touchIndex,
        linkKey,
        via: "click",
      },
      "shop/track/c: lead flipped to hot via click",
    );
  }
}

type UnsubscribeVerifyResult =
  | { valid: true; leadId: string }
  | { valid: false; reason: "malformed" | "bad_signature" | "expired" };

function verifyUnsubscribeToken(
  token: string,
  now: Date = new Date(),
): UnsubscribeVerifyResult {
  const idx = token.indexOf(".");
  if (idx <= 0 || idx === token.length - 1) {
    return { valid: false, reason: "malformed" };
  }
  const payloadEncoded = token.slice(0, idx);
  const sigEncoded = token.slice(idx + 1);

  const sigBuf = base64urlDecode(sigEncoded);
  if (!sigBuf) return { valid: false, reason: "malformed" };

  const expected = createHmac("sha256", getLinkHmacKey())
    .update(payloadEncoded, "utf8")
    .digest();
  if (sigBuf.length !== expected.length) {
    return { valid: false, reason: "bad_signature" };
  }
  if (!timingSafeEqual(sigBuf, expected)) {
    return { valid: false, reason: "bad_signature" };
  }

  const payloadBuf = base64urlDecode(payloadEncoded);
  if (!payloadBuf) return { valid: false, reason: "malformed" };
  const payload = payloadBuf.toString("utf8");
  const sepIdx = payload.indexOf("|");
  if (sepIdx <= 0) return { valid: false, reason: "malformed" };
  const leadId = payload.slice(0, sepIdx);
  const expiresSec = Number.parseInt(payload.slice(sepIdx + 1), 10);
  if (!Number.isFinite(expiresSec)) return { valid: false, reason: "malformed" };
  if (expiresSec * 1000 <= now.getTime()) {
    return { valid: false, reason: "expired" };
  }
  return { valid: true, leadId };
}

router.get("/shop/fitter-leads/unsubscribe", async (req, res) => {
  // Rate limit BEFORE the HMAC verify. The verify is constant-time
  // so it doesn't leak per-attempt info, but capping by IP closes
  // the CodeQL "authorization without rate limiting" finding and
  // keeps an enumeration attacker out of the audit log.
  const ipKey = `${callerIp(req)}:fitter-unsubscribe`;
  if (rateLimited(ipKey)) {
    res.status(429).type("text/html").send(unsubscribeHtml("rate_limited"));
    return;
  }
  const token = typeof req.query.t === "string" ? req.query.t : "";
  if (!token) {
    res.status(400).type("text/html").send(unsubscribeHtml("invalid"));
    return;
  }

  let verify: UnsubscribeVerifyResult;
  try {
    verify = verifyUnsubscribeToken(token);
  } catch (err) {
    // RESUPPLY_LINK_HMAC_KEY missing → service misconfig. Return a
    // friendly page rather than the raw error.
    logger.warn(
      { err },
      "shop/fitter-leads/unsubscribe: verify threw",
    );
    res.status(500).type("text/html").send(unsubscribeHtml("error"));
    return;
  }
  if (!verify.valid) {
    res.status(400).type("text/html").send(unsubscribeHtml("invalid"));
    return;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase
      .schema("resupply")
      .from("fitter_leads")
      .update({
        journey_stage: "unsubscribed",
        unsubscribed_at: new Date().toISOString(),
        next_campaign_touch_at: null,
      })
      .eq("id", verify.leadId);
    if (error) throw error;
    res.type("text/html").send(unsubscribeHtml("ok"));
  } catch (err) {
    logger.warn(
      { err, leadId: verify.leadId },
      "shop/fitter-leads/unsubscribe: db update failed",
    );
    res.status(500).type("text/html").send(unsubscribeHtml("error"));
  }
});

function unsubscribeHtml(
  state: "ok" | "invalid" | "error" | "rate_limited",
): string {
  const headline =
    state === "ok"
      ? "You're unsubscribed."
      : state === "invalid"
        ? "Link no longer valid."
        : state === "rate_limited"
          ? "Too many attempts."
          : "Something went wrong.";
  const body =
    state === "ok"
      ? "We won't send you any more fitting follow-ups. You can still place an order at any time."
      : state === "invalid"
        ? "This unsubscribe link has expired or was already used. If you keep getting emails, reply to one and we'll handle it directly."
        : state === "rate_limited"
          ? "Please wait a few minutes and try this link again. If you keep getting emails, reply to one and we'll handle it directly."
          : "We couldn't complete your unsubscribe. Please reply to the email you received and we'll take care of it.";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${headline}</title>
<style>body{font-family:system-ui,sans-serif;max-width:520px;margin:60px auto;padding:0 20px;line-height:1.5;color:#222;}h1{font-size:20px;}</style>
</head><body><h1>${headline}</h1><p>${body}</p></body></html>`;
}

export default router;

// Test-only seam — clears the in-memory rate bucket between vitest
// runs so a 429 from one test doesn't leak into the next.
export function _resetFitterCompleteRateBucketForTests(): void {
  rateBucket.clear();
  rateBucketSweepCounter = 0;
}
