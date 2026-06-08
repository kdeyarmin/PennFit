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
  submitFitterComplete,
  submitFitterInviteComplete,
} from "@/lib/shop-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MaskRecommendationCard } from "@/components/mask-recommendation-card";
import { ComfortGuarantee } from "@/components/comfort-guarantee";

export function Results() {
  useDocumentTitle("Your mask matches");
  const [, setLocation] = useLocation();
  // The route-level <ProtectedRoute> in App.tsx already guarantees that
  // `measurements` is non-null by the time Results mounts — no local
  // useEffect+redirect dance needed.
  const {
    measurements,
    answers,
    reset,
    setChosenMask,
    email,
    emailConsent,
    inviteToken,
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
  }) => {
    setChosenMask({
      maskId: mask.maskId,
      name: mask.name,
      modelNumber: mask.modelNumber,
      manufacturer: mask.manufacturer,
    });
    track("mask_chosen", { mask: mask.modelNumber });
    setLocation("/order");
  };

  const { mutate, data, isPending, error } = useGetRecommendation();

  // Fire the campaign-enrollment ping the first time `data` arrives
  // with at least one recommendation. Gated by emailConsent so a
  // patient who somehow reached /results without opting in (the
  // /consent gate normally prevents this) doesn't accidentally
  // enroll. Errors are swallowed — best-effort by design.
  useEffect(() => {
    if (hasPingedComplete.current) return;
    if (!data) return;
    if (!email || !emailConsent) return;
    const top = data.topRecommendations[0];
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
  }, [data, email, emailConsent]);

  // Staff-invite transmission. When the patient reached /results via a
  // staff invite link (/fitter-invite), transmit the COMPLETE fitting
  // — numeric measurements + questionnaire answers + the ranked
  // recommendation — back to PennPaps so it can be reviewed and
  // attached to the patient's chart. (Per the privacy invariant, only
  // the numeric measurements travel; images never left the device.)
  // Fires once, best-effort: a failure must never block the patient
  // from seeing their result.
  const hasTransmittedInvite = useRef(false);
  useEffect(() => {
    if (hasTransmittedInvite.current) return;
    if (!inviteToken || !measurements || !data) return;
    const top = data.topRecommendations[0];
    if (!top) return;
    hasTransmittedInvite.current = true;
    submitFitterInviteComplete({
      token: inviteToken,
      measurements,
      answers: fullAnswers,
      recommendation: {
        maskId: top.maskId,
        name: top.name,
        type: top.type,
        top: data.topRecommendations.map((m) => ({
          maskId: m.maskId,
          name: m.name,
          type: m.type,
          confidence: m.confidence,
        })),
      },
    }).catch((err) => {
      console.warn("fitter-invite transmission failed (continuing)", err);
    });
  }, [inviteToken, measurements, data, fullAnswers]);

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

  const hasRequested = useRef(false);

  useEffect(() => {
    if (!measurements) return;
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
  }, [measurements, fullAnswers, mutate]);

  if (!measurements) return null;

  // Error must be checked BEFORE the loading fallback — otherwise a failed
  // request (where `data` is undefined) would render skeletons forever.
  if (error) {
    // The orval-generated client throws an ApiError with a typed `data`
    // payload of `{ error: string; details?: string[] }` — see
    // api-server's error responses. Falling back to the generic Error
    // message is enough for offline / network failures.
    const apiError = error as ApiError<{ error?: string; details?: string[] }>;
    const message =
      apiError.data?.error ?? apiError.message ?? "An unknown error occurred.";
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Generating Recommendations</AlertTitle>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
        <Button className="mt-6" onClick={() => setLocation("/")}>
          Start Over
        </Button>
      </div>
    );
  }

  if (isPending || !data) {
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

  const topConfidencePct = Math.round(
    (data.topRecommendations[0]?.confidence ?? 0) * 100,
  );
  const topMaskTypeLabel = (
    data.topRecommendations[0]?.type ?? "recommended"
  ).replace("_", " ");
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
              PennPaps · Recommendation
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
        {data.topRecommendations.map((mask, idx) => (
          <MaskRecommendationCard
            key={mask.maskId}
            mask={mask}
            details={catalogById.get(mask.maskId)}
            isTopPick={idx === 0}
            onChoose={() => handleChooseMask(mask)}
          />
        ))}
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
            reset();
            setLocation("/");
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
