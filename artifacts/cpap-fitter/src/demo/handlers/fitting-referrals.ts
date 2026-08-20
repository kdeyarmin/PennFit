// Tenant admin handlers for the FITTING and REFERRAL surfaces.
//
// Six admin pages that previously had no demo coverage at all — every
// request fell through to the router's empty fallback, so each rendered
// its empty state and none of its actions could be exercised:
//
//   /admin/mask-catalog      /admin/fitter/catalog*
//   /admin/formulary         /admin/fitter/formulary*
//   /admin/fit-sessions      /admin/fit-sessions*
//   /admin/safety-screens    /admin/fitter/safety-screens*
//   /admin/referrals         /admin/provider-referrals*
//   /admin/referral-reviews  /admin/referral-reviews*
//
// Writes are routed through the session-scoped stores in
// `fixtures/fitting.ts` and `fixtures/referrals.ts`, so the demo is
// genuinely interactive rather than read-only.
//
// Route ORDER matters within this module: static sub-paths are declared
// before the `:id` patterns they would otherwise be swallowed by
// (`/catalog/variants/review-batch` before `/catalog/:id`,
// `/provider-referrals/providers` before `/provider-referrals/:id`,
// `/referral-reviews/upload-url` before `/referral-reviews/:id`).

import { route, type DemoHandler } from "../types";
import { json } from "../respond";
import {
  demoApproveFitSession,
  demoCreateFormularyRule,
  demoCreateSafetyScreenDraft,
  demoDeleteFormularyRule,
  demoDeleteSafetyScreenDraft,
  demoFitSession,
  demoFitSessions,
  demoFormulary,
  demoMaskCatalog,
  demoMaskModel,
  demoOverrideFitSession,
  demoPublishFormulary,
  demoPublishSafetyScreen,
  demoReplaceSafetyScreenQuestions,
  demoRequestRescan,
  demoRetireSafetyScreen,
  demoReviewVariant,
  demoReviewVariantsBatch,
  demoSafetyScreens,
  demoSimulateFormulary,
  demoUpdateFormulary,
  demoUpdateMaskModel,
  demoUpdateSafetyScreenDraft,
  demoUpdateVariantBands,
} from "../fixtures/fitting";
import {
  demoMessagePreviews,
  demoSendMessagePreview,
} from "../fixtures/message-previews";
import {
  demoAcceptReferral,
  demoAcceptReferralReview,
  demoCreateReferralReview,
  demoDeclineReferral,
  demoDismissReferralReview,
  demoExtractReferralReview,
  demoInboundReferral,
  demoInboundReferrals,
  demoInviteProvider,
  demoProviderLinks,
  demoReferralDuplicates,
  demoReferralReview,
  demoReferralReviews,
  demoReferralUploadUrl,
  demoReplyToReferral,
  demoRequestFromProvider,
  demoSetReferralStatus,
  demoUpdateProviderLink,
} from "../fixtures/referrals";

/** 404 in the shape the real admin routes use. */
function notFound(error: string): Response {
  return json({ error }, 404);
}

/** A fixture that returned `{ error }` means "refused", not "missing". */
function resultOr(
  result: { error?: string } | null,
  missing: string,
): Response {
  if (!result) return notFound(missing);
  if (result.error) return json({ error: result.error }, 409);
  return json(result);
}

export const fittingReferralsHandlers: DemoHandler[] = [
  // ── Mask catalog (/admin/mask-catalog) ───────────────────────────
  route(
    "POST",
    "/resupply-api/admin/fitter/catalog/variants/review-batch",
    (req) => json(demoReviewVariantsBatch(req.json())),
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter/catalog/variants/:id/review",
    (req, p) => {
      const updated = demoReviewVariant(p.id, req.json());
      return updated ? json(updated) : notFound("variant_not_found");
    },
  ),
  route(
    "PATCH",
    "/resupply-api/admin/fitter/catalog/variants/:id",
    (req, p) => {
      const updated = demoUpdateVariantBands(p.id, req.json() ?? {});
      return updated ? json(updated) : notFound("variant_not_found");
    },
  ),
  route("GET", "/resupply-api/admin/fitter/catalog", (req) =>
    json(demoMaskCatalog(req.query)),
  ),
  route("GET", "/resupply-api/admin/fitter/catalog/:id", (_req, p) => {
    const found = demoMaskModel(p.id);
    return found ? json(found) : notFound("mask_not_found");
  }),
  route("PATCH", "/resupply-api/admin/fitter/catalog/:id", (req, p) =>
    resultOr(demoUpdateMaskModel(p.id, req.json() ?? {}), "mask_not_found"),
  ),

  // ── Formulary (/admin/formulary) ─────────────────────────────────
  route("GET", "/resupply-api/admin/fitter/formulary", () =>
    json(demoFormulary()),
  ),
  route("PATCH", "/resupply-api/admin/fitter/formulary", (req) =>
    json(demoUpdateFormulary(req.json())),
  ),
  route("POST", "/resupply-api/admin/fitter/formulary/rules", (req) =>
    json(demoCreateFormularyRule(req.json()), 201),
  ),
  route("DELETE", "/resupply-api/admin/fitter/formulary/rules/:id", (_req, p) =>
    json(demoDeleteFormularyRule(p.id)),
  ),
  route("POST", "/resupply-api/admin/fitter/formulary/simulate", (req) =>
    json(demoSimulateFormulary(req.json())),
  ),
  route("POST", "/resupply-api/admin/fitter/formulary/publish", () =>
    json(demoPublishFormulary()),
  ),

  // ── Fit sessions (/admin/fit-sessions) ───────────────────────────
  route("GET", "/resupply-api/admin/fit-sessions", (req) =>
    json(demoFitSessions(req.query)),
  ),
  route("GET", "/resupply-api/admin/fit-sessions/:id", (_req, p) => {
    const found = demoFitSession(p.id);
    return found ? json(found) : notFound("session_not_found");
  }),
  route("POST", "/resupply-api/admin/fit-sessions/:id/approve", (_req, p) => {
    const updated = demoApproveFitSession(p.id);
    return updated ? json(updated) : notFound("session_not_found");
  }),
  route("POST", "/resupply-api/admin/fit-sessions/:id/override", (req, p) => {
    const updated = demoOverrideFitSession(p.id, req.json());
    return updated ? json(updated) : notFound("session_not_found");
  }),
  route(
    "POST",
    "/resupply-api/admin/fit-sessions/:id/request-rescan",
    (_req, p) => {
      const updated = demoRequestRescan(p.id);
      return updated ? json(updated) : notFound("session_not_found");
    },
  ),

  // ── Safety screens (/admin/safety-screens) ───────────────────────
  route("GET", "/resupply-api/admin/fitter/safety-screens", () =>
    json(demoSafetyScreens()),
  ),
  route("POST", "/resupply-api/admin/fitter/safety-screens", (req) =>
    json(demoCreateSafetyScreenDraft(req.json()), 201),
  ),
  route(
    "PUT",
    "/resupply-api/admin/fitter/safety-screens/:id/questions",
    (req, p) =>
      resultOr(
        demoReplaceSafetyScreenQuestions(p.id, req.json()),
        "screen_not_found",
      ),
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter/safety-screens/:id/publish",
    (_req, p) => {
      const updated = demoPublishSafetyScreen(p.id);
      return updated ? json(updated) : notFound("screen_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/fitter/safety-screens/:id/retire",
    (_req, p) => {
      const updated = demoRetireSafetyScreen(p.id);
      return updated ? json(updated) : notFound("screen_not_found");
    },
  ),
  route("PATCH", "/resupply-api/admin/fitter/safety-screens/:id", (req, p) =>
    resultOr(demoUpdateSafetyScreenDraft(p.id, req.json()), "screen_not_found"),
  ),
  route("DELETE", "/resupply-api/admin/fitter/safety-screens/:id", (_req, p) =>
    json(demoDeleteSafetyScreenDraft(p.id)),
  ),

  // ── Provider referrals (/admin/referrals) ────────────────────────
  route("GET", "/resupply-api/admin/provider-referrals/providers", () =>
    json(demoProviderLinks()),
  ),
  route("POST", "/resupply-api/admin/provider-referrals/providers", (req) =>
    json(demoInviteProvider(req.json()), 201),
  ),
  route(
    "PATCH",
    "/resupply-api/admin/provider-referrals/providers/:id",
    (req, p) => {
      const updated = demoUpdateProviderLink(p.id, req.json());
      return updated ? json(updated) : notFound("provider_not_found");
    },
  ),
  route("GET", "/resupply-api/admin/provider-referrals", (req) =>
    json(demoInboundReferrals(req.query)),
  ),
  route("GET", "/resupply-api/admin/provider-referrals/:id", (_req, p) => {
    const found = demoInboundReferral(p.id);
    return found ? json(found) : notFound("referral_not_found");
  }),
  route(
    "POST",
    "/resupply-api/admin/provider-referrals/:id/accept",
    (_req, p) => {
      const updated = demoAcceptReferral(p.id);
      return updated ? json(updated) : notFound("referral_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-referrals/:id/decline",
    (req, p) => {
      const reason = req.json<{ reason?: string }>()?.reason ?? "";
      const updated = demoDeclineReferral(p.id, reason);
      return updated ? json(updated) : notFound("referral_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-referrals/:id/status",
    (req, p) => {
      const status = req.json<{ status?: string }>()?.status ?? "in_progress";
      const updated = demoSetReferralStatus(p.id, status);
      return updated ? json(updated) : notFound("referral_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/provider-referrals/:id/messages",
    (req, p) => {
      const body = req.json<{ body?: string }>()?.body ?? "";
      const updated = demoReplyToReferral(p.id, body);
      return updated ? json(updated) : notFound("referral_not_found");
    },
  ),

  // ── Referral reviews (/admin/referral-reviews) ───────────────────
  // `/:id/report` and `/:id/media` stream a PDF, not JSON — they are left
  // to the router's fallback rather than seeded with a wrong-typed body.
  route("POST", "/resupply-api/admin/referral-reviews/upload-url", () =>
    json(demoReferralUploadUrl()),
  ),
  route("GET", "/resupply-api/admin/referral-reviews", (req) =>
    json(demoReferralReviews(req.query)),
  ),
  route("POST", "/resupply-api/admin/referral-reviews", (req) =>
    json(demoCreateReferralReview(req.json()), 201),
  ),
  route(
    "GET",
    "/resupply-api/admin/referral-reviews/:id/duplicates",
    (_req, p) => json(demoReferralDuplicates(p.id)),
  ),
  route(
    "POST",
    "/resupply-api/admin/referral-reviews/:id/extract",
    (_req, p) => {
      const updated = demoExtractReferralReview(p.id);
      return updated ? json(updated) : notFound("review_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/referral-reviews/:id/accept",
    (_req, p) => {
      const updated = demoAcceptReferralReview(p.id);
      return updated ? json(updated) : notFound("review_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/referral-reviews/:id/dismiss",
    (req, p) => {
      const note = req.json<{ note?: string }>()?.note;
      const updated = demoDismissReferralReview(p.id, note);
      return updated ? json(updated) : notFound("review_not_found");
    },
  ),
  route(
    "POST",
    "/resupply-api/admin/referral-reviews/:id/request-from-provider",
    (_req, p) => {
      const updated = demoRequestFromProvider(p.id);
      return updated ? json(updated) : notFound("review_not_found");
    },
  ),
  route("GET", "/resupply-api/admin/referral-reviews/:id", (_req, p) => {
    const found = demoReferralReview(p.id);
    return found ? json(found) : notFound("review_not_found");
  }),

  // ── Patient message previews (/admin/message-previews) ───────────
  route("GET", "/resupply-api/admin/message-previews", () =>
    json(demoMessagePreviews()),
  ),
  route("POST", "/resupply-api/admin/message-previews/:id/send", (req, p) => {
    const channel =
      req.json<{ channel?: "email" | "sms" }>()?.channel ?? "email";
    return json(demoSendMessagePreview(p.id, channel));
  }),
];
