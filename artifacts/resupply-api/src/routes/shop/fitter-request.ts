// POST /shop/fitter-requests — what the mask fitter ends with now that
// the patient no longer files their own order.
//
// Two shapes arrive here, and the difference is honest rather than
// cosmetic:
//
//   requestType: "full_details" — the patient filled in what they know
//     (contact details, date of birth, and — optionally — carrier and
//     member ID). A CSR can usually start verifying benefits from this
//     without a phone call.
//   requestType: "callback" — the patient just asked to be contacted.
//     Contact details and nothing else, which is a legitimate outcome:
//     the alternative was making them guess at a member ID.
//
// CONTACT FIELDS. `email` is required because the fitter cannot be
// entered without one — /consent gates on it and the form prefills it —
// and it is what the confirmation goes to. `phone` is required only when
// the patient asked to be reached BY phone or text; someone who picked
// email should not have to invent a number to be allowed to ask for
// help. (An earlier draft's comments promised "one contact channel"
// while the schema demanded both, which is the mismatch this states
// plainly.)
//
// Neither creates an order, a claim, or a shipment. The request lands in
// `resupply.fitter_fit_requests` and a person works it.
//
// GATING
// ------
// Invitation-only, and gated TWICE, exactly like /api/fit/assess.
//
// The signed `x-fitter-invite-token` proves an invite was once issued
// (stateless HMAC + expiry) and resolves the owning tenant, so a request
// always files against the DME whose fitting produced it. But that
// signature stays cryptographically valid for the token's whole lifetime
// and says nothing about whether the invite still STANDS — so this route
// also loads the invite row and refuses a revoked or expired one.
//
// /api/recommend gets away with the stateless check alone because it is
// stateless itself: it writes nothing and sends nothing. This endpoint
// persists PHI and emails the tenant's staff, so accepting a revoked
// token would keep filing patient details (and firing mail) after staff
// explicitly stopped the fitting — easily reachable from a tab left open
// when the revoke happened.
//
// PHI
// ---
// The body carries a name, a date of birth, and possibly an insurance
// member ID. The log line is counts-and-flags only — never the body,
// never the identifiers. That is the same posture as the order route it
// replaces, and it is a hard rule of this repo, not a preference.

import { Router, type IRouter } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";

import { getOrgScopedClient } from "@workspace/resupply-db";

import { verifyFitterInviteToken } from "../../lib/fitter-invite-token";
import { sendFitRequestEmails } from "../../lib/fit-request-email";
import { recordFitRequest } from "../../lib/fit-request-record";
import { resolveOrgIdForSignedRecord } from "../../lib/storefront/signed-link-org";

const router: IRouter = Router();

// Keyed by the VERIFIED invite so the cap is per-invitation: an IP key
// would pool an entire clinic's Wi-Fi (or a carrier NAT) into one bucket
// and 429 unrelated patients. A handful per window covers a patient who
// mistypes their phone number and resubmits; it does not cover a script.
const requestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const token = req.header("x-fitter-invite-token");
    const verified =
      typeof token === "string" ? verifyFitterInviteToken(token) : null;
    return verified?.valid
      ? `invite:${verified.inviteId}`
      : ipKeyGenerator(req.ip ?? "");
  },
});

/** Optional free-text: trimmed, and an empty string becomes null so the
 *  column never holds `""` next to a genuine NULL. */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const requestBody = z
  .object({
    requestType: z.enum(["full_details", "callback"]),
    fullName: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email().max(200),
    phone: z.string().trim().max(40).optional().default(""),
    preferredContactMethod: z
      .enum(["phone", "email", "text"])
      .optional()
      .default("phone"),
    preferredContactTime: optionalText(120),
    // Free-form as the patient typed it. Deliberately NOT date-validated
    // here: this is a follow-up queue, not a claim, and rejecting a
    // request over a date format would be a worse outcome than a CSR
    // reading "March 1959" and asking.
    dateOfBirth: optionalText(40),
    insuranceCarrier: optionalText(120),
    memberId: optionalText(80),
    groupNumber: optionalText(80),
    prescribingPhysician: optionalText(120),
    notes: optionalText(2000),
    population: z.enum(["adult", "pediatric"]).optional().default("adult"),
    // Fitting context. Product references and an id — no measurements,
    // no clinical findings; those already live on the fit session.
    fitSessionId: z.string().uuid().optional(),
    recommendedMaskId: optionalText(200),
    recommendedMaskName: optionalText(300),
    recommendedMaskType: optionalText(40),
    recommendedMaskSize: optionalText(64),
    /** Honeypot. Real patients never see this field. */
    website: z.string().max(200).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // A phone number is only demanded when it is the channel they asked
    // to be reached on. See the CONTACT FIELDS note in the header.
    const wantsCall =
      v.preferredContactMethod === "phone" ||
      v.preferredContactMethod === "text";
    if (wantsCall && v.phone.trim().length < 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["phone"],
        message: "A phone number is required to be reached by phone or text.",
      });
    }
  });

router.post("/shop/fitter-requests", requestLimiter, async (req, res) => {
  const inviteToken = req.header("x-fitter-invite-token");
  const verification =
    typeof inviteToken === "string"
      ? verifyFitterInviteToken(inviteToken)
      : null;
  if (!verification?.valid) {
    res.status(403).json({
      error:
        "The virtual mask fitter is available by invitation only. Ask your local DME company for an invite link or code.",
    });
    return;
  }

  const parsed = requestBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: "invalid_body",
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }
  const data = parsed.data;

  // Honeypot — a bot that filled `website` gets a fake success so it
  // moves on instead of retrying.
  if (data.website && data.website.trim().length > 0) {
    req.log?.info?.({ honeypot: true }, "shop/fitter-requests: honeypot trip");
    res.json({ ok: true });
    return;
  }

  const orgId = await resolveOrgIdForSignedRecord(
    "fitter_invites",
    verification.inviteId,
  ).catch(() => null);
  if (!orgId) {
    res.status(503).json({ error: "tenant_unavailable" });
    return;
  }

  // STATEFUL invite check — see the gating note in the header.
  const invite = await loadInviteState(orgId, verification.inviteId);
  if (invite === "unavailable") {
    // A DB blip, not a dead invite. Retryable, and said so: the patient
    // has typed a form and must not be told their link is dead.
    res.status(503).json({
      error: "invite_lookup_unavailable",
      message:
        "We couldn't send that to the team just now. Please try again in a moment.",
    });
    return;
  }
  if (!invite || invite.status === "revoked" || invite.expired) {
    res.status(403).json({
      error: "invite_invalid",
      message:
        "This fitting link is no longer active. Ask your DME company for a new one.",
    });
    return;
  }

  const ip =
    req.ip ||
    req.socket?.remoteAddress ||
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    null;

  // The FITTING CONTEXT is client-supplied and staff act on it — the
  // queue badge and the notification email both read it — so it is
  // verified, not trusted. A caller holding one valid invite must not be
  // able to attach another tenant's fit session, or a session belonging
  // to a different fitting, to what a CSR sees.
  //
  // `fit_sessions` is read through the ORG-SCOPED client, so a session id
  // from another tenant simply does not resolve. An id that resolves is
  // this tenant's; one that doesn't is dropped rather than rejected —
  // the patient's request is still worth filing, it just carries no
  // session link, which is the same honest state a legacy-path request
  // has.
  const fitSessionId = data.fitSessionId
    ? await resolveOwnedFitSession(orgId, data.fitSessionId, req)
    : null;

  const recorded = await recordFitRequest({
    orgId,
    requestType: data.requestType,
    fullName: data.fullName,
    email: data.email,
    phone: data.phone.trim() || null,
    preferredContactMethod: data.preferredContactMethod,
    preferredContactTime: data.preferredContactTime,
    dateOfBirth: data.dateOfBirth,
    insuranceCarrier: data.insuranceCarrier,
    memberId: data.memberId,
    groupNumber: data.groupNumber,
    prescribingPhysician: data.prescribingPhysician,
    notes: data.notes,
    population: data.population,
    fitSessionId,
    recommendedMaskId: data.recommendedMaskId,
    recommendedMaskName: data.recommendedMaskName,
    recommendedMaskType: data.recommendedMaskType,
    recommendedMaskSize: data.recommendedMaskSize,
    submitterIp: ip,
    userAgent: req.headers["user-agent"]?.toString().slice(0, 500) ?? null,
  });

  // Deliberately NOT best-effort, unlike its marketing-funnel sibling.
  // The fitter no longer produces an order, so a dropped write means
  // nothing at the DME knows this patient is waiting — and the patient
  // has no order number to chase it with. Tell them it failed so they
  // can try again, rather than showing a confirmation over nothing.
  if (!recorded.id) {
    req.log?.warn?.(
      { event: "fit_request_insert_failed" },
      "shop/fitter-requests: could not file request",
    );
    res.status(503).json({
      error: "request_not_recorded",
      message:
        "We couldn't send that to the team just now. Please try again in a moment.",
    });
    return;
  }

  // Email is the fast path, not the record. A SendGrid outage must not
  // fail a request that is already filed and already visible in the
  // queue, so failures are reported in the log line and swallowed.
  const emailed = await sendFitRequestEmails({
    orgId,
    requestType: data.requestType,
    fullName: data.fullName,
    email: data.email,
    phone: data.phone.trim() || null,
    preferredContactMethod: data.preferredContactMethod,
    preferredContactTime: data.preferredContactTime,
    dateOfBirth: data.dateOfBirth,
    insuranceCarrier: data.insuranceCarrier,
    memberId: data.memberId,
    groupNumber: data.groupNumber,
    prescribingPhysician: data.prescribingPhysician,
    notes: data.notes,
    population: data.population,
    recommendedMaskName: data.recommendedMaskName,
    recommendedMaskSize: data.recommendedMaskSize,
  }).catch((err: unknown) => {
    req.log?.warn?.({ err }, "shop/fitter-requests: email send threw");
    return {
      configured: false,
      notificationDelivered: false,
      confirmationDelivered: false,
    };
  });

  // Counts and flags only — no name, no DOB, no member ID.
  req.log?.info?.(
    {
      requestType: data.requestType,
      population: data.population,
      hasInsurance: Boolean(data.insuranceCarrier || data.memberId),
      emailConfigured: emailed.configured,
      notificationDelivered: emailed.notificationDelivered,
      confirmationDelivered: emailed.confirmationDelivered,
    },
    "shop/fitter-requests: request filed",
  );

  res.json({
    ok: true,
    requestType: data.requestType,
    // No reference number by design. This is not an order, and handing
    // the patient an order-shaped identifier for something a human has
    // not yet looked at would set exactly the wrong expectation.
    confirmationEmailed: emailed.confirmationDelivered,
  });
});

/**
 * Confirm a client-claimed fit session actually belongs to this tenant.
 *
 * Returns the id when it resolves through the org-scoped client, null
 * otherwise — including on a lookup failure, because an unverifiable
 * link is worth less than no link: a CSR who follows it expects to land
 * on the fitting this request came from.
 */
async function resolveOwnedFitSession(
  orgId: string,
  fitSessionId: string,
  req: { log?: { warn?: (obj: unknown, msg: string) => void } },
): Promise<string | null> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = (await supabase
      .from("fit_sessions")
      .select("id")
      .eq("id", fitSessionId)
      .limit(1)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    if (error) throw error;
    if (!data) {
      req.log?.warn?.(
        { event: "fit_request_session_not_owned" },
        "shop/fitter-requests: claimed fit session does not belong to this tenant — filing without the link",
      );
      return null;
    }
    return fitSessionId;
  } catch (err) {
    req.log?.warn?.(
      { err },
      "shop/fitter-requests: fit session ownership check failed — filing without the link",
    );
    return null;
  }
}

/**
 * Load just enough of the invite to decide whether it still stands.
 *
 * Distinguishes "couldn't look it up" from "isn't valid": the first is
 * retryable and must not tell a patient their link is dead, the second
 * is a dead end. Mirrors `loadInvite` in routes/storefront/fit-assess.ts,
 * minus the chart joins this route has no use for.
 */
async function loadInviteState(
  orgId: string,
  inviteId: string,
): Promise<{ status: string; expired: boolean } | null | "unavailable"> {
  try {
    const supabase = getOrgScopedClient(orgId);
    const { data, error } = (await supabase
      .from("fitter_invites")
      .select("status, expires_at")
      .eq("id", inviteId)
      .limit(1)
      .maybeSingle()) as {
      data: Record<string, unknown> | null;
      error: { message: string } | null;
    };
    if (error) return "unavailable";
    if (!data) return null;
    const expiresAt = (data.expires_at as string | null) ?? null;
    return {
      status: String(data.status ?? ""),
      expired: expiresAt !== null && Date.parse(expiresAt) < Date.now(),
    };
  } catch {
    return "unavailable";
  }
}

export default router;
