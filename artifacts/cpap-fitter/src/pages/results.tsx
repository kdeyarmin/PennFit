import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  useGetRecommendation,
  useListMasks,
  ApiError,
  type QuestionnaireAnswers,
} from "@workspace/api-client-react/storefront";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  RefreshCcw,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Ruler,
} from "lucide-react";
import { track } from "@/lib/track";
import {
  fetchShopProducts,
  formatMoneyCents,
  submitFitterComplete,
  submitFitterInviteComplete,
  type ShopProductView,
} from "@/lib/shop-api";
import { useCart } from "@/hooks/use-cart";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MaskRecommendationCard } from "@/components/mask-recommendation-card";
import { ComfortGuarantee } from "@/components/comfort-guarantee";
import { BrandName } from "@/components/company-contact";
import {
  requestFitAssessment,
  isWithheld,
  toLegacyMaskType,
  type FitAssessment,
  type FitCandidate,
  type SafetyScreenPrompt,
} from "@/lib/fit-assess-api";
import {
  SafetyScreen,
  type SafetyScreenSubmission,
} from "@/components/safety-screen";
import { toProfilePayload } from "@/lib/fit-profile";
import { ClinicalResults, FitWithheld } from "@/components/clinical-results";
import { rememberFitCheckoutContext } from "@/lib/fit-checkout-context";

export function Results() {
  useDocumentTitle("Your mask matches");
  const [, setLocation] = useLocation();
  // The route-level <ProtectedRoute> in App.tsx already guarantees that
  // `measurements` is non-null by the time Results mounts — no local
  // useEffect+redirect dance needed.
  const {
    measurements,
    scanSignals,
    answers,
    fitAnswers,
    fitProfileV2,
    resetForNewFitting,
    setChosenMask,
    email,
    emailConsent,
    inviteToken,
    entryPoint,
  } = useFitterStore();
  const [showMeasurements, setShowMeasurements] = useState(false);

  // Normalize the questionnaire once — used both for the
  // recommendation request and the staff-invite transmission so the
  // null/sentinel handling stays in one place.
  const fullAnswers = React.useMemo<QuestionnaireAnswers>(
    () => ({
      mouthBreather: answers.mouthBreather ?? null,
      claustrophobic: answers.claustrophobic ?? null,
      sideOrStomachSleeper: answers.sideOrStomachSleeper ?? null,
      heavyFacialHair: answers.heavyFacialHair ?? null,
      wearsGlasses: answers.wearsGlasses ?? null,
      frequentCongestion: answers.frequentCongestion ?? null,
      priorMaskExperience: answers.priorMaskExperience ?? "none",
      mobilityLimitations: answers.mobilityLimitations ?? null,
      sensitiveSkin: answers.sensitiveSkin ?? null,
      siliconeSensitivity: answers.siliconeSensitivity ?? null,
      cpapPressureSetting: answers.cpapPressureSetting ?? "unknown",
    }),
    [answers],
  );

  useEffect(() => {
    track("results_viewed");
  }, []);

  // The v2 Patient Fit Profile payload, when the tenant runs the v2
  // questionnaire and the patient answered it. Sent ALONGSIDE the legacy
  // answers: the route's buildProfile merges the v2 block over the
  // legacy mapping, so an in-flight patient can finish on either path.
  const profilePayload = React.useMemo(
    () =>
      fitProfileV2 && Object.keys(fitAnswers).length > 0
        ? toProfilePayload(fitAnswers)
        : null,
    [fitProfileV2, fitAnswers],
  );

  // Best-effort campaign-enrollment ping. Fires once when the
  // recommendation lands, telling the backend "this lead saw a
  // recommendation" — the API flips the fitter_leads row to
  // journey_stage='campaign_active' and schedules the first
  // multi-touch nurture email 24h out. NEVER blocks the UI on the
  // request: a network failure here just means the campaign won't
  // start; the patient still sees the recommendation immediately.
  // Re-firing on the same email is a no-op server-side (sticky
  // terminal states + the "already in campaign" short-circuit).
  const hasPingedComplete = useRef(false);

  const handleChooseMask = (mask: {
    maskId: string;
    name: string;
    modelNumber: string;
    manufacturer: string;
    size?: string | null;
  }) => {
    setChosenMask({
      maskId: mask.maskId,
      name: mask.name,
      modelNumber: mask.modelNumber,
      manufacturer: mask.manufacturer,
      size: mask.size ?? null,
    });
    track("mask_chosen", { mask: mask.modelNumber });
    setLocation("/order");
  };

  // Cash-pay bridge: when a recommended mask is also sold in the shop
  // (matched by manufacturer model number) and checkout is live, each
  // card gets a secondary "buy without insurance" CTA that drops the
  // shop product into the cart. Strictly best-effort — a failed or
  // preview-mode catalog load just hides the CTAs, never blocks the
  // recommendations the patient came for.
  const { addItem } = useCart();
  const [shopByModelNumber, setShopByModelNumber] = useState<Map<
    string,
    ShopProductView
  > | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchShopProducts()
      .then((result) => {
        if (cancelled || "unavailable" in result) return;
        if (!result.purchasingEnabled) return;
        const byModel = new Map<string, ShopProductView>();
        for (const p of result.products) {
          // Untracked inventory (null) is always purchasable; a tracked
          // count is in stock only when strictly positive. Match the rest
          // of the shop's `<= 0` out-of-stock rule so negative (oversold)
          // inventory isn't mistaken for available.
          const outOfStock =
            typeof p.stockCount === "number" && p.stockCount <= 0;
          if (p.modelNumber && !outOfStock) {
            byModel.set(p.modelNumber, p);
          }
        }
        setShopByModelNumber(byModel);
      })
      .catch(() => {
        // Catalog unreachable — cash-pay CTAs simply don't render.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleCashPayAdd = (
    mask: { maskId: string; modelNumber: string },
    product: ShopProductView,
    /**
     * Present only on the clinical path, where the order can be linked
     * back to the fitting that produced it. The LEGACY path records no
     * fit session, so there is genuinely nothing to attribute.
     */
    fitLink?: {
      fitSessionId: string;
      orderedMaskSlug: string;
      orderedVariantId: string | null;
    },
  ) => {
    const added = addItem({
      productId: product.id,
      priceId: product.price.id,
      name: product.name,
      unitAmountCents: product.price.unitAmount,
      currency: product.price.currency,
      imageUrl: product.imageUrl,
      isBundle: product.isBundle,
      mode: "one_time",
      recurringPriceId: product.recurringPrice?.id ?? null,
      recurringIntervalLabel: product.recurringPrice?.intervalLabel ?? null,
      stockCount: product.stockCount,
    });
    if (!added.ok) return; // sold out between load and click — leave the page as-is
    // Hand the fitting off to checkout. Written only on success so a
    // rejected add (sold out) doesn't leave a link pointing at an order
    // that was never placed.
    if (fitLink) {
      rememberFitCheckoutContext({
        fitSessionId: fitLink.fitSessionId,
        orderedMaskSlug: fitLink.orderedMaskSlug,
        orderedVariantId: fitLink.orderedVariantId,
      });
    }
    track("mask_cashpay_added", { mask: mask.modelNumber });
    setLocation("/shop/cart");
  };

  // The mask fitter is invitation-only: the recommendation endpoint
  // requires the signed invite token (set by /fitter-invite) in a
  // request header. Without it the server returns 403, mirroring the
  // client-side route guard in App.tsx.
  const { mutate, data, isPending, error } = useGetRecommendation(
    inviteToken
      ? { request: { headers: { "x-fitter-invite-token": inviteToken } } }
      : undefined,
  );

  // ── Clinical assessment path ──────────────────────────────────────
  //
  // When the tenant has `fitter.clinical_assessment` on, /api/fit/assess
  // answers instead: it fits against that DME's own catalog and formulary,
  // returns a per-size recommendation, and can DECLINE to name a mask when
  // the evidence doesn't support one. Every other case — flag off, network
  // failure, unresolvable tenant — falls through to /api/recommend below,
  // so a tenant that never turns the flag on sees no change at all.
  const [assessment, setAssessment] = useState<FitAssessment | null>(null);
  const [clinicalState, setClinicalState] = useState<
    | "probing"
    | "clinical"
    | "legacy"
    | "safety_screen"
    | "invite_invalid"
    | "unavailable"
  >("probing");
  const [inviteInvalidReason, setInviteInvalidReason] = useState<
    "revoked" | "expired" | "invite_not_found" | null
  >(null);
  const hasProbedClinical = useRef(false);
  // The magnetic-component screen, when the tenant runs it. Held here
  // rather than in the assessment because it is a PRE-condition of one:
  // the route will not assess until it is answered.
  const [safetyScreen, setSafetyScreen] = useState<SafetyScreenPrompt | null>(
    null,
  );
  const [safetySubmitting, setSafetySubmitting] = useState(false);
  const [safetyError, setSafetyError] = useState<string | null>(null);
  // Kept so a re-ask (a screen revised mid-session) can be re-submitted
  // without making the patient answer from scratch where the keys match.
  const safetyAnswersRef = useRef<SafetyScreenSubmission | null>(null);

  /**
   * Ask for an assessment, carrying the safety answers when we have them.
   *
   * The critical branch is `safety_screen`: the route is telling us it
   * will not assess until the magnetic-component questions are answered.
   * Falling through to the legacy engine there — which is what this page
   * used to do — hands the patient a recommendation from an engine with
   * NO safety filter, so an implant patient could be sent a mask with
   * magnetic clips. Show the screen instead, and keep showing it until it
   * is answered.
   */
  const runAssessment = React.useCallback(
    async (safety: SafetyScreenSubmission | null, signal?: AbortSignal) => {
      if (!measurements || !inviteToken) return;
      const result = await requestFitAssessment({
        inviteToken,
        measurements,
        answers: { ...fullAnswers },
        // The v2 Patient Fit Profile, when the tenant runs it. The
        // route merges it over the legacy answers.
        ...(profilePayload ? { profile: profilePayload } : {}),
        // Real per-frame quality from /measure. Omitted only when the
        // probe failed, in which case the route applies its neutral
        // default.
        ...(scanSignals ? { scan: scanSignals } : {}),
        ...(safety ? { safety } : {}),
        // Set from the referral link's `entry` param; omitted for an
        // ordinary invite, where the server's `remote_link` default is
        // correct.
        ...(entryPoint ? { entryPoint } : {}),
        ...(signal ? { signal } : {}),
      });
      if (signal?.aborted) return;

      if (result.kind === "assessment") {
        setAssessment(result.assessment);
        setSafetyScreen(null);
        setClinicalState("clinical");
        track("fit_assessment_completed", {
          outcome: result.assessment.outcome,
          degraded: result.assessment.provenance.degraded,
        });
        return;
      }

      if (result.kind === "safety_screen") {
        // Never fall through to the legacy engine from here.
        setSafetyScreen(result.screen);
        setSafetyError(
          safety
            ? "Those answers were for an earlier version of this form. Please confirm them once more."
            : null,
        );
        setClinicalState("safety_screen");
        track("fit_safety_screen_shown", { version: result.screen.version });
        return;
      }

      // The invite itself is dead — staff revoked it, or it expired.
      // The legacy fallback would hand the patient a recommendation
      // anyway (its gate is a stateless HMAC that cannot see
      // revocation), which un-does the revoke. Dead-end honestly
      // instead.
      if (result.kind === "invite_invalid") {
        setInviteInvalidReason(result.reason);
        setClinicalState("invite_invalid");
        track("fit_invite_invalid", { reason: result.reason });
        return;
      }

      // Flag off is the only remaining honest reason to use the legacy
      // engine: that tenant does not run clinical assessment or magnet
      // screening. Every other miss — network blip, 5xx, malformed
      // payload — used to fall through here too, which undid
      // migration 0500 (clinical + magnet screening ON for every
      // tenant) whenever /api/fit/assess was briefly unreachable.
      if (result.kind === "not_enabled") {
        setClinicalState("legacy");
        return;
      }

      // A transient failure ON the safety-answer submission itself must
      // not fall through to the legacy engine: we already know this
      // tenant screens for magnets, and the legacy engine has no filter.
      // Keep the screen up and let the patient retry.
      if (result.kind === "unavailable" && safety) {
        setSafetyError(
          "We couldn't check that just now. Please try again in a moment.",
        );
        setClinicalState("safety_screen");
        return;
      }

      setClinicalState("unavailable");
    },
    [
      measurements,
      inviteToken,
      fullAnswers,
      profilePayload,
      scanSignals,
      entryPoint,
    ],
  );

  const handleSafetySubmit = React.useCallback(
    (submission: SafetyScreenSubmission) => {
      safetyAnswersRef.current = submission;
      setSafetySubmitting(true);
      setSafetyError(null);
      void runAssessment(submission)
        .catch(() => {
          setSafetyError(
            "We couldn't check that just now. Please try again in a moment.",
          );
        })
        .finally(() => setSafetySubmitting(false));
    },
    [runAssessment],
  );

  useEffect(() => {
    if (hasProbedClinical.current) return;
    if (!measurements) return;
    // No invite token means the legacy route would 403 too; let its own
    // error handling say so rather than duplicating the message here.
    if (!inviteToken) {
      hasProbedClinical.current = true;
      setClinicalState("legacy");
      return;
    }
    hasProbedClinical.current = true;
    const controller = new AbortController();
    // `requestFitAssessment` never rejects, but anything else inside
    // `runAssessment` throwing would otherwise strand the page on the
    // "probing" skeletons with no request in flight. Do not fall
    // through to the legacy engine: it has no magnet filter.
    void runAssessment(null, controller.signal).catch(() => {
      setClinicalState("unavailable");
    });
    return () => controller.abort();
    // `runAssessment` is stable for the life of the page (it only reads
    // refs and state setters), and re-running this probe on every render
    // would re-POST the assessment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measurements, scanSignals, inviteToken, fullAnswers, entryPoint]);

  const { data: catalog } = useListMasks();
  const catalogById = React.useMemo(() => {
    const map = new Map<string, NonNullable<typeof catalog>["masks"][number]>();
    // Defensive: `catalog?.masks.forEach` only short-circuits on a
    // null/undefined `catalog`. If a transient failure on /api/masks
    // (e.g. mid-deploy, the proxy serves the SPA shell instead of the
    // resupply-api JSON) lands `catalog` as a string or `{}`, the
    // unguarded `.masks.forEach` crashes the page and trips the
    // ErrorBoundary. Guard both hops.
    if (!catalog || !Array.isArray(catalog.masks)) return map;
    catalog.masks.forEach((m) => map.set(m.id, m));
    return map;
  }, [catalog]);

  // Cash-pay on the CLINICAL path.
  //
  // Two different identifier spaces meet here, and conflating them is
  // what broke this. `shopByModelNumber` is keyed on the TENANT's own
  // SKU — `model_number` in the Stripe product's metadata, e.g.
  // "PHM-RM-F20". `mask_size_variants.manufacturer_part_number` is the
  // MANUFACTURER's part number. They are not the same string, and every
  // variant the 0486 seed writes leaves the part number NULL besides, so
  // resolving on it alone matched nothing: the CTA never rendered on the
  // clinical path, and because this resolver is the only caller that
  // supplies `fitLink`, `fit_checkout_context` was never written either
  // — so `fit_sessions.shop_order_id` and `dispensed_at` stayed NULL and
  // the fitter-outcome dispense rate was structurally zero.
  //
  // So try the part number first (correct when a tenant does key its shop
  // on manufacturer part numbers), then fall back to the legacy catalog's
  // `modelNumber` for the same slug. 0481 deliberately keeps the slug
  // space identical across both catalogs, which is what makes that
  // fallback exact rather than a guess. A mask in neither still hides the
  // CTA, which remains the right failure: a mask we can't price is a mask
  // we can't sell.
  //
  // This also carries the fit-session link into the cart, which is the
  // only way a paid order ever gets attributed back to the fitting that
  // produced it.
  //
  // Deliberately a plain function, not a memo: it is called once per
  // candidate per render and does a Map lookup, and `ClinicalResults` is
  // not memoized, so a stable identity would buy nothing.
  const clinicalCashPayFor = (c: FitCandidate) => {
    const partNumber =
      c.cushion?.manufacturerPartNumber ?? c.frame?.manufacturerPartNumber;
    const legacyModelNumber = catalogById.get(c.maskSlug)?.modelNumber;
    const shopKey =
      (partNumber && shopByModelNumber?.has(partNumber)
        ? partNumber
        : undefined) ??
      (legacyModelNumber && shopByModelNumber?.has(legacyModelNumber)
        ? legacyModelNumber
        : undefined);
    if (!shopKey) return undefined;
    const product = shopByModelNumber?.get(shopKey);
    if (!product) return undefined;
    const fitSessionId = assessment?.fitSessionId;
    return {
      priceLabel: formatMoneyCents(
        product.price.unitAmount,
        product.price.currency,
      ),
      onAddToCart: () =>
        handleCashPayAdd(
          { maskId: c.maskId, modelNumber: shopKey },
          product,
          fitSessionId
            ? {
                fitSessionId,
                orderedMaskSlug: c.maskSlug,
                orderedVariantId:
                  c.cushion?.variantId ?? c.frame?.variantId ?? null,
              }
            : undefined,
        ),
    };
  };

  // Fire the campaign-enrollment ping the first time `data` arrives
  // with at least one recommendation. Gated by emailConsent so a
  // patient who somehow reached /results without opting in (the
  // /consent gate normally prevents this) doesn't accidentally
  // enroll. Errors are swallowed — best-effort by design.
  // The completion and staff-transmission pings need "the top mask" from
  // whichever engine answered. Deriving it once keeps both effects, and
  // the invite record they feed, identical across the two paths — the
  // clinical path must not quietly stop populating the staff worklist.
  const topPick = React.useMemo(() => {
    if (assessment?.primary) {
      const c = assessment.primary;
      return {
        maskId: c.maskSlug,
        name: c.name,
        type: toLegacyMaskType(c.interfaceType),
        ranked: [c, ...assessment.alternatives].map((a) => ({
          maskId: a.maskSlug,
          name: a.name,
          type: toLegacyMaskType(a.interfaceType),
          confidence: a.confidence,
        })),
      };
    }
    const top = data?.topRecommendations[0];
    if (!top || !data) return null;
    return {
      maskId: top.maskId,
      name: top.name,
      type: top.type,
      ranked: data.topRecommendations.map((m) => ({
        maskId: m.maskId,
        name: m.name,
        type: m.type,
        confidence: m.confidence,
      })),
    };
  }, [assessment, data]);

  useEffect(() => {
    if (hasPingedComplete.current) return;
    if (!email || !emailConsent) return;
    const top = topPick;
    if (!top) return;
    hasPingedComplete.current = true;
    submitFitterComplete({
      email,
      recommendedMaskId: top.maskId,
      recommendedMaskName: top.name,
      recommendedMaskType: top.type,
    }).catch((err) => {
      // Console-only — the campaign-enrollment failure should never
      // surface to the patient. The backend's own log line captures
      // the ops-side trace.
      console.warn("fitter-complete enrollment failed (continuing)", err);
    });
  }, [topPick, email, emailConsent]);

  // Staff-invite transmission. When the patient reached /results via a
  // staff invite link (/fitter-invite), transmit the COMPLETE fitting
  // — numeric measurements + questionnaire answers + the ranked
  // recommendation — back to the DME so it can be reviewed and attached
  // to the patient's chart. (Per the privacy invariant, only the numeric
  // measurements travel; images never left the device.)
  // Fires once, best-effort: a failure must never block the patient
  // from seeing their result.
  //
  // A fitting is finished when an ENGINE HAS ANSWERED — and "no mask" is
  // an answer. This used to require a `topPick`, so every fitting the
  // clinical engine declined to name a mask for (contraindicated,
  // outside the validated range, everything excluded) transmitted
  // NOTHING: the invite stayed at "opened" with no measurements and no
  // completion time, and the fittings that most needed a human were the
  // ones staff never saw. The server now records the clinical path
  // itself, at the moment it decides; this stays as the safety net for
  // the legacy engine and for a failed session write.
  const fittingAnswered =
    (clinicalState === "clinical" && assessment !== null) || topPick !== null;
  const hasTransmittedInvite = useRef(false);
  useEffect(() => {
    if (hasTransmittedInvite.current) return;
    if (!inviteToken || !measurements || !fittingAnswered) return;
    hasTransmittedInvite.current = true;
    submitFitterInviteComplete({
      token: inviteToken,
      measurements,
      answers: fullAnswers,
      // Null when the engine named no mask. The server reads that as
      // "completed, nothing recommended" and leaves the ranked list it
      // already stored alone.
      recommendation: topPick
        ? {
            maskId: topPick.maskId,
            name: topPick.name,
            type: topPick.type,
            top: topPick.ranked,
          }
        : null,
    }).catch((err) => {
      console.warn("fitter-invite transmission failed (continuing)", err);
    });
  }, [inviteToken, measurements, topPick, fullAnswers, fittingAnswered]);

  const hasRequested = useRef(false);

  useEffect(() => {
    if (!measurements) return;
    // Wait for the clinical probe to resolve. Firing both would double
    // every fitting's request volume and could show the patient the
    // legacy answer first, then swap it — a worse experience than a
    // slightly longer skeleton.
    if (clinicalState !== "legacy") return;
    if (!hasRequested.current) {
      hasRequested.current = true;
      // P4 — the questionnaire intentionally lets the user skip questions
      // and offers an explicit "I'm not sure" option. `fullAnswers`
      // (memoized above) forwards `null` for un-answered booleans so the
      // recommendation engine can distinguish "the patient said no" from
      // "the patient declined to answer", with "none"/"unknown"
      // sentinels for the two enum fields.
      mutate({ data: { measurements, answers: fullAnswers } });
    }
  }, [measurements, fullAnswers, mutate, clinicalState]);

  if (!measurements) return null;

  // The engine declined to name a mask. This is confidence gating doing
  // its job, not a failure: showing a "best guess" here is exactly what
  // the tiered engine exists to prevent. The flow ends here — no retake
  // loop — and the patient is referred to the DME company by name (see
  // FitWithheld for the reasoning).
  if (assessment && isWithheld(assessment.outcome)) {
    return <FitWithheld assessment={assessment} />;
  }

  // The safety screen outranks every other branch below, including the
  // legacy engine's loading and error states. The route has told us it
  // will not assess this patient until the magnetic-component questions
  // are answered, and the legacy engine has no safety filter — so
  // rendering anything else here is exactly the hole this closes.
  if (clinicalState === "safety_screen" && safetyScreen) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
        <SafetyScreen
          screen={safetyScreen}
          onSubmit={handleSafetySubmit}
          submitting={safetySubmitting}
          error={safetyError}
        />
      </div>
    );
  }

  // Clinical assessment was unreachable. Do NOT fall through to the
  // legacy engine: it has no magnet-implant filter, and after
  // migration 0500 every tenant screens.
  if (clinicalState === "unavailable") {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert data-testid="results-clinical-unavailable">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>We couldn&apos;t finish your fitting just now</AlertTitle>
          <AlertDescription>
            The clinical fitting service didn&apos;t respond, so we held the
            recommendation rather than skipping safety checks. Please try again
            in a moment.
          </AlertDescription>
        </Alert>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            onClick={() => {
              setClinicalState("probing");
              void runAssessment(safetyAnswersRef.current).catch(() => {
                setClinicalState("unavailable");
              });
            }}
          >
            Try again
          </Button>
          <Button variant="outline" onClick={() => setLocation("/capture")}>
            <RefreshCcw className="h-4 w-4 mr-2" />
            Retake photo
          </Button>
        </div>
      </div>
    );
  }

  // The invite is dead — revoked by staff or expired. A friendly
  // dead-end, mirroring /fitter-invite's own invalid-link screen. This
  // must NOT fall through to the legacy engine below: its gate is a
  // stateless HMAC, so it would happily produce a recommendation for a
  // fitting the DME explicitly stopped.
  if (clinicalState === "invite_invalid") {
    const inviteInvalidCopy: Record<string, string> = {
      expired:
        "This fitting link has expired. Ask your DME company to resend it.",
      revoked:
        "This fitting link is no longer active. Ask your DME company for a new one.",
      invite_not_found:
        "We couldn't find this fitting invite. Ask your DME company to resend it.",
    };
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert data-testid="results-invite-invalid">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>This fitting link isn&apos;t active</AlertTitle>
          <AlertDescription>
            {inviteInvalidCopy[inviteInvalidReason ?? ""] ??
              inviteInvalidCopy.invite_not_found}
          </AlertDescription>
        </Alert>
        <div className="mt-6">
          <Button variant="outline" onClick={() => setLocation("/shop")}>
            Browse the shop instead
          </Button>
        </div>
      </div>
    );
  }

  // Error must be checked BEFORE the loading fallback — otherwise a failed
  // request (where `data` is undefined) would render skeletons forever.
  if (error) {
    // The orval-generated client throws an ApiError with a typed `data`
    // payload of `{ error: string; details?: string[] }` — see
    // resupply-api's error responses. Falling back to the generic Error
    // message is enough for offline / network failures.
    const apiError = error as ApiError<{ error?: string; details?: string[] }>;
    const message =
      apiError.data?.error ?? apiError.message ?? "An unknown error occurred.";
    const isPermanent =
      error instanceof ApiError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 429;
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Generating Recommendations</AlertTitle>
          <AlertDescription>
            {isPermanent
              ? message
              : "This looks like a temporary connection problem — your measurements are still saved on this device. Try again in a moment."}
          </AlertDescription>
        </Alert>
        <div className="mt-6 flex flex-wrap gap-3">
          {!isPermanent && (
            <Button
              onClick={() =>
                mutate({ data: { measurements, answers: fullAnswers } })
              }
              data-testid="results-retry"
            >
              <RefreshCcw className="h-4 w-4 mr-2" />
              Try Again
            </Button>
          )}
          <Button
            variant={isPermanent ? "default" : "outline"}
            onClick={() => setLocation("/")}
          >
            Start Over
          </Button>
        </div>
      </div>
    );
  }

  // The clinical path answered with a recommendation. It carries a size,
  // per-alternative ranking reasons, and formulary provenance that the
  // legacy card cannot express, so it gets its own renderer.
  if (assessment?.primary) {
    return (
      <div className="container max-w-4xl mx-auto px-4 py-12 animate-shimmer-in space-y-8">
        <div className="text-center space-y-3">
          <div className="flex justify-center">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-emerald-700 font-medium border border-emerald-200/70 shadow-sm">
              <CheckCircle2 className="w-4 h-4" />
              <span>Fitting complete</span>
            </div>
          </div>
          <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
            Your Recommended Mask
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
            Matched against <BrandName />
            &apos;s mask catalog using your facial measurements, your answers,
            and your provider&apos;s clinical rules.
          </p>
        </div>
        <ClinicalResults
          assessment={assessment}
          cashPayFor={clinicalCashPayFor}
          onChoose={(c) =>
            handleChooseMask({
              maskId: c.maskSlug,
              name: c.name,
              manufacturer: c.manufacturer,
              modelNumber:
                c.cushion?.manufacturerPartNumber ??
                c.frame?.manufacturerPartNumber ??
                c.maskSlug,
              size: c.cushion?.sizeLabel ?? c.frame?.sizeLabel ?? null,
            })
          }
          onRetake={() => {
            track("results_retake_requested", {
              outcome: assessment.outcome,
            });
            setLocation("/capture");
          }}
        />
      </div>
    );
  }

  if (clinicalState === "probing" || isPending || !data) {
    return (
      <div className="container max-w-4xl mx-auto px-4 py-12 space-y-8">
        <div className="text-center space-y-4">
          <Skeleton className="h-10 w-3/4 mx-auto rounded-lg" />
          <Skeleton className="h-6 w-1/2 mx-auto rounded-lg" />
        </div>
        <div className="grid gap-6">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </div>
    );
  }

  if (data.topRecommendations.length === 0) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <div className="glass-card rounded-2xl p-8 text-center space-y-4">
          <AlertCircle className="h-8 w-8 mx-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold">No matches found</h1>
          <p className="text-sm text-muted-foreground">
            We weren't able to rank masks for these measurements. This can
            happen when the facial dimensions are outside our current model
            range. Try retaking the photo or browsing the full catalog.
          </p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <Button onClick={() => setLocation("/capture")}>
              <RefreshCcw className="h-4 w-4 mr-2" />
              Retake photo
            </Button>
            <Button variant="outline" onClick={() => setLocation("/masks")}>
              Browse all masks
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const topConfidencePct = Math.round(
    (data.topRecommendations[0]?.confidence ?? 0) * 100,
  );
  const topMaskTypeLabel = (
    data.topRecommendations[0]?.type ?? "recommended"
  ).replace(/_/g, " ");
  const confidenceBand =
    topConfidencePct >= 85
      ? "strong"
      : topConfidencePct >= 70
        ? "moderate"
        : "low";

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="text-center mb-10 space-y-4">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-emerald-700 font-medium border border-emerald-200/70 shadow-sm">
            <CheckCircle2 className="w-4 h-4" />
            <span>Analysis Complete</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              <BrandName /> · Recommendation
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-3xl md:text-5xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Your Recommended Masks
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Based on your precise facial measurements and clinical preferences,
          here are the best fits for you.
        </p>
        <div className="text-sm text-muted-foreground">
          Recommendation confidence:{" "}
          <span className="font-semibold text-foreground">
            {confidenceBand} ({topConfidencePct}%)
          </span>
        </div>
        {confidenceBand !== "strong" && (
          // Offer a retake for any match that isn't already "strong" (i.e.
          // "low" AND "moderate"). A moderate result is still labelled as
          // such to the customer, so leaving them no way to improve it is a
          // dead end — a better scan means a better seal and fewer returns.
          <div className="pt-1 space-y-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                track("results_retake_requested", { topConfidencePct });
                setLocation("/capture");
              }}
              data-testid="results-retake-photo"
            >
              Retake photo for a stronger match
            </Button>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              Optional — these recommendations are solid and you can order with
              confidence below. A retake can sharpen the fit if you have a
              moment.
            </p>
          </div>
        )}
        <p className="text-sm text-muted-foreground max-w-2xl mx-auto">
          Why this match: your top recommendation is a{" "}
          <span className="font-medium text-foreground">
            {topMaskTypeLabel}
          </span>{" "}
          mask style with the best combined score from your facial measurements
          and sleep preferences.
        </p>
        <div className="flex justify-center pt-2">
          <ComfortGuarantee variant="badge" />
        </div>
      </div>

      {/* Patient measurements panel — collapsible, builds trust by showing exactly what was measured */}
      <Collapsible
        open={showMeasurements}
        onOpenChange={setShowMeasurements}
        className="mb-8"
      >
        <Card className="border-0 glass-card rounded-2xl">
          <CollapsibleTrigger asChild>
            <button
              className="w-full p-5 flex items-center justify-between gap-4 text-left hover:bg-white/30 transition-colors rounded-2xl"
              data-testid="button-toggle-measurements"
            >
              <div className="flex items-center gap-3">
                <div className="w-11 h-11 rounded-xl icon-halo-navy flex items-center justify-center shrink-0">
                  <Ruler className="w-5 h-5" />
                </div>
                <div>
                  <div className="font-semibold">Your facial measurements</div>
                  <div className="text-xs text-muted-foreground">
                    Calibrated on-device using your iris diameter (~11.7 mm).
                    Tap to {showMeasurements ? "hide" : "view"}.
                  </div>
                </div>
              </div>
              <ChevronDown
                className={`w-5 h-5 text-muted-foreground transition-transform ${
                  showMeasurements ? "rotate-180" : ""
                }`}
              />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="px-5 pb-5 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              <Measurement
                label="Nose width"
                value={measurements.noseWidth}
                testid="meas-nose-width"
              />
              <Measurement
                label="Nose height"
                value={measurements.noseHeight}
                testid="meas-nose-height"
              />
              <Measurement
                label="Nose to chin"
                value={measurements.noseToChin}
                testid="meas-nose-chin"
              />
              <Measurement
                label="Mouth width"
                value={measurements.mouthWidth}
                testid="meas-mouth-width"
              />
              <Measurement
                label="Face width"
                value={measurements.faceWidthAtCheekbones}
                testid="meas-face-width"
              />
            </div>
            <p className="px-5 pb-4 text-xs text-muted-foreground italic">
              These dimensions never left your device — only the numeric values
              were sent to find your match.
            </p>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <div className="space-y-6 mb-12">
        <div className="px-2">
          <h2 className="text-xl font-semibold tracking-tight">
            Top Recommendations
          </h2>
          <p className="text-sm text-muted-foreground mt-1 leading-relaxed max-w-2xl">
            Ranked by fit confidence. Each card explains exactly{" "}
            <span className="font-medium text-foreground/80">
              why it matched
            </span>{" "}
            — your sleep style, breathing, and how your measurements line up
            against each mask's documented size range. Tap{" "}
            <span className="font-medium text-foreground/80">
              Match confidence
            </span>{" "}
            on any card to see the breakdown.
          </p>
        </div>
        {data.topRecommendations.map((mask, idx) => {
          const shopProduct = shopByModelNumber?.get(mask.modelNumber);
          return (
            <MaskRecommendationCard
              key={mask.maskId}
              mask={mask}
              details={catalogById.get(mask.maskId)}
              isTopPick={idx === 0}
              // The legacy engine names a size too (`recommendedSize`,
              // shown on this very card) — carry it onto the order
              // rather than dropping the field on the rename.
              onChoose={() =>
                handleChooseMask({
                  ...mask,
                  size: mask.recommendedSize ?? null,
                })
              }
              measurements={measurements}
              cashPay={
                shopProduct
                  ? {
                      priceLabel: formatMoneyCents(
                        shopProduct.price.unitAmount,
                        shopProduct.price.currency,
                      ),
                      onAddToCart: () => handleCashPayAdd(mask, shopProduct),
                    }
                  : undefined
              }
            />
          );
        })}
      </div>

      <ComfortGuarantee variant="callout" className="mb-8" />

      <div className="glass-card rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
        <div className="space-y-2">
          <h3 className="font-semibold text-lg tracking-tight">
            Looking for more options?
          </h3>
          <p className="text-sm text-muted-foreground">
            Browse the full catalog to see all available masks.
          </p>
        </div>
        <Link href="/masks">
          <Button variant="outline" className="shrink-0 group glass-panel">
            View All Masks
            <ChevronRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </Link>
      </div>

      <div className="text-xs text-muted-foreground/80 text-center max-w-3xl mx-auto p-4 glass-panel rounded-xl">
        <strong>Medical Disclaimer:</strong> {data.disclaimer}
      </div>

      <div className="flex justify-center mt-12">
        <Button
          variant="ghost"
          onClick={() => {
            // Clear the fitting DATA but keep the invite context. A full
            // reset() here also wiped the invite token, and since every
            // fitter route is invite-gated, "Start Over" stranded invited
            // patients on "Invitation required" with no way back in short
            // of re-opening the original link.
            resetForNewFitting();
            setLocation("/capture");
          }}
          className="text-muted-foreground"
        >
          <RefreshCcw className="mr-2 w-4 h-4" /> Start Over
        </Button>
      </div>
    </div>
  );
}

function Measurement({
  label,
  value,
  testid,
}: {
  label: string;
  value: number;
  testid: string;
}) {
  return (
    <div
      className="bg-background border border-border rounded-lg p-3"
      data-testid={testid}
    >
      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">
        {label}
      </div>
      <div className="text-lg font-semibold tabular-nums">
        {value.toFixed(1)}{" "}
        <span className="text-xs font-normal text-muted-foreground">mm</span>
      </div>
    </div>
  );
}
