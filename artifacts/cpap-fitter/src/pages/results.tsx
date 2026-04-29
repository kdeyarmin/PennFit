import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  useGetRecommendation,
  useListMasks,
  ApiError,
  type QuestionnaireAnswers,
} from "@workspace/api-client-react";
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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { MaskRecommendationCard } from "@/components/mask-recommendation-card";

export function Results() {
  useDocumentTitle("Your mask matches");
  const [, setLocation] = useLocation();
  // The route-level <ProtectedRoute> in App.tsx already guarantees that
  // `measurements` is non-null by the time Results mounts — no local
  // useEffect+redirect dance needed.
  const { measurements, answers, reset, setChosenMask } = useFitterStore();
  const [showMeasurements, setShowMeasurements] = useState(false);

  useEffect(() => {
    track("results_viewed");
  }, []);

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
  const { data: catalog } = useListMasks();
  const catalogById = React.useMemo(() => {
    const map = new Map<string, NonNullable<typeof catalog>["masks"][number]>();
    catalog?.masks.forEach((m) => map.set(m.id, m));
    return map;
  }, [catalog]);

  const hasRequested = useRef(false);

  useEffect(() => {
    if (!measurements) return;
    if (!hasRequested.current) {
      hasRequested.current = true;
      // The questionnaire intentionally lets the user skip questions, so
      // we fill in safe defaults here to satisfy the API contract. The
      // `cpapPressureSetting: "unknown"` value is special-cased server-side
      // (it disables pressure-related scoring rather than penalizing).
      // Typed as QuestionnaireAnswers so any future schema changes break
      // this construction at compile time, not at runtime.
      const fullAnswers: QuestionnaireAnswers = {
        mouthBreather: answers.mouthBreather ?? false,
        claustrophobic: answers.claustrophobic ?? false,
        sideOrStomachSleeper: answers.sideOrStomachSleeper ?? false,
        heavyFacialHair: answers.heavyFacialHair ?? false,
        wearsGlasses: answers.wearsGlasses ?? false,
        frequentCongestion: answers.frequentCongestion ?? false,
        priorMaskExperience: answers.priorMaskExperience ?? "none",
        mobilityLimitations: answers.mobilityLimitations ?? false,
        sensitiveSkin: answers.sensitiveSkin ?? false,
        siliconeSensitivity: answers.siliconeSensitivity ?? false,
        cpapPressureSetting: answers.cpapPressureSetting ?? "unknown",
      };

      mutate({ data: { measurements, answers: fullAnswers } });
    }
  }, [measurements, answers, mutate]);

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
          Based on your precise facial measurements and clinical preferences, here are the best fits for you.
        </p>
      </div>

      {/* Patient measurements panel — collapsible, builds trust by showing exactly what was measured */}
      <Collapsible open={showMeasurements} onOpenChange={setShowMeasurements} className="mb-8">
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
                    Calibrated on-device using your iris diameter (~11.7 mm). Tap to{" "}
                    {showMeasurements ? "hide" : "view"}.
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
              <Measurement label="Nose width" value={measurements.noseWidth} testid="meas-nose-width" />
              <Measurement label="Nose height" value={measurements.noseHeight} testid="meas-nose-height" />
              <Measurement label="Nose to chin" value={measurements.noseToChin} testid="meas-nose-chin" />
              <Measurement label="Mouth width" value={measurements.mouthWidth} testid="meas-mouth-width" />
              <Measurement
                label="Face width"
                value={measurements.faceWidthAtCheekbones}
                testid="meas-face-width"
              />
            </div>
            <p className="px-5 pb-4 text-xs text-muted-foreground italic">
              These dimensions never left your device — only the numeric values were sent to find your match.
            </p>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      <div className="space-y-6 mb-12">
        <h2 className="text-xl font-semibold px-2 tracking-tight">Top Recommendations</h2>
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

      <div className="glass-card rounded-2xl p-6 flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
        <div className="space-y-2">
          <h3 className="font-semibold text-lg tracking-tight">Looking for more options?</h3>
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
    <div className="bg-background border border-border rounded-lg p-3" data-testid={testid}>
      <div className="text-xs text-muted-foreground uppercase tracking-wide mb-1">{label}</div>
      <div className="text-lg font-semibold tabular-nums">
        {value.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">mm</span>
      </div>
    </div>
  );
}
