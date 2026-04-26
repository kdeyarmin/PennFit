import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useGetRecommendation, useListMasks } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  RefreshCcw,
  Info,
  CheckCircle2,
  ChevronRight,
  ChevronDown,
  AlertCircle,
  Weight,
  Activity,
  Wind,
  Tag,
  Sparkles,
  ShoppingCart,
  Ruler,
  Layers,
  HardHat,
  HelpCircle,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";

export function Results() {
  const [, setLocation] = useLocation();
  const { measurements, answers, reset, setChosenMask } = useFitterStore();
  const [showMeasurements, setShowMeasurements] = useState(false);

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

  // Redirect to home if measurements are missing — must run as an effect, not during render
  useEffect(() => {
    if (!measurements) {
      setLocation("/");
    }
  }, [measurements, setLocation]);

  useEffect(() => {
    if (!measurements) return;
    if (!hasRequested.current) {
      hasRequested.current = true;
      // Provide defaults for any missing answers to satisfy the API contract
      const fullAnswers = {
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
      } as any;

      mutate({ data: { measurements, answers: fullAnswers } });
    }
  }, [measurements, answers, mutate]);

  if (!measurements) return null;

  // Error must be checked BEFORE loading fallback — otherwise a failed request
  // (where data is undefined) would render skeletons forever.
  if (error) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Generating Recommendations</AlertTitle>
          <AlertDescription>{(error as any)?.error || "An unknown error occurred."}</AlertDescription>
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
              Penn Fit · Recommendation
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
        {data.topRecommendations.map((mask, idx) => {
          const details = catalogById.get(mask.maskId);
          const confidencePct = Math.round(mask.confidence * 100);
          return (
            <Card
              key={mask.maskId}
              className={`overflow-hidden border-0 glass-card lift-on-hover rounded-2xl ${
                idx === 0
                  ? "ring-2 ring-[hsl(var(--penn-gold)/0.50)] shadow-[0_0_0_4px_hsl(var(--penn-gold)/0.10),0_24px_48px_hsl(var(--penn-navy)/0.12)]"
                  : ""
              }`}
            >
              <div className="flex flex-col md:flex-row">
                <div className="w-full md:w-1/3 bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/30 p-6 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border/40">
                  <div className="aspect-square w-full max-w-[220px] bg-white rounded-xl shadow-md border border-border/40 overflow-hidden mb-4">
                    <img
                      src={getMaskImage(mask.type)}
                      alt={`${mask.manufacturer} ${mask.name}`}
                      className="w-full h-full object-contain p-3"
                    />
                  </div>
                  <div className="flex gap-2 flex-wrap justify-center">
                    <Badge variant="secondary">{formatMaskType(mask.type)}</Badge>
                    <Badge variant="outline">{mask.manufacturer}</Badge>
                  </div>
                </div>

                <div className="w-full md:w-2/3 p-6 flex flex-col">
                  <div className="flex justify-between items-start mb-4 gap-4">
                    <div className="min-w-0">
                      {idx === 0 && (
                        <span className="text-xs font-bold uppercase tracking-wider text-primary mb-1 block">
                          Best Match
                        </span>
                      )}
                      <CardTitle className="text-2xl mb-1">{mask.name}</CardTitle>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Tag className="w-3.5 h-3.5" />
                          Model{" "}
                          <code className="font-mono font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">
                            {mask.modelNumber}
                          </code>
                        </span>
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              className="inline-flex items-center gap-1 text-sm hover:text-foreground transition-colors group"
                              data-testid={`confidence-explainer-${mask.maskId}`}
                            >
                              Match confidence:{" "}
                              <span className="font-semibold text-foreground">{confidencePct}%</span>
                              <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/60 group-hover:text-primary transition-colors" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-80 text-sm space-y-2" align="start">
                            <div className="font-semibold">How we calculated {confidencePct}%</div>
                            <p className="text-muted-foreground text-xs leading-relaxed">
                              Confidence blends two signals:
                            </p>
                            <ul className="text-xs space-y-1.5 text-muted-foreground">
                              <li className="flex gap-2">
                                <span className="font-semibold text-primary shrink-0">60%</span>
                                <span>
                                  <strong className="text-foreground">Mask type fit</strong> — how well this
                                  type matches your sleep style, breathing, facial hair, congestion, prior
                                  experience, and CPAP pressure.
                                </span>
                              </li>
                              <li className="flex gap-2">
                                <span className="font-semibold text-primary shrink-0">40%</span>
                                <span>
                                  <strong className="text-foreground">Physical fit</strong> — how your nose
                                  width, height, mouth width, and nose-to-chin distance line up with this
                                  mask's documented size range.
                                </span>
                              </li>
                            </ul>
                            <p className="text-xs text-muted-foreground italic pt-1">
                              Penalties apply for contraindications and pressure mismatches. The score is
                              guidance — the final fitting confirmation happens with Penn Home Medical Supply.
                            </p>
                          </PopoverContent>
                        </Popover>
                      </div>
                    </div>
                  </div>

                  <div
                    className="rounded-xl p-4 mb-4 border border-[hsl(var(--penn-navy)/0.15)] relative overflow-hidden"
                    style={{
                      background:
                        "linear-gradient(135deg, hsl(var(--penn-navy) / 0.06) 0%, hsl(var(--penn-gold) / 0.06) 100%)",
                    }}
                  >
                    <h4 className="text-xs font-bold uppercase tracking-wider text-primary mb-1.5 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-[hsl(var(--penn-gold))]" />
                      Why this fits you
                    </h4>
                    <p className="text-sm text-foreground leading-relaxed">{mask.summary}</p>
                  </div>

                  {details?.description && (
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                      {details.description}
                    </p>
                  )}

                  {details && (
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 p-3 glass-panel rounded-xl text-xs">
                      <Spec icon={<Weight className="w-3.5 h-3.5 text-primary" />} label="Weight">
                        {details.weightGrams} g
                      </Spec>
                      <Spec icon={<Activity className="w-3.5 h-3.5 text-primary" />} label="Pressure">
                        {details.pressureRangeMin}–{details.pressureRangeMax} cmH₂O
                      </Spec>
                      <Spec icon={<Wind className="w-3.5 h-3.5 text-primary" />} label="Hose">
                        <span className="capitalize">{details.hoseConnection}</span>
                      </Spec>
                      <Spec icon={<Layers className="w-3.5 h-3.5 text-primary" />} label="Cushion">
                        {details.cushionMaterial}
                      </Spec>
                      <Spec
                        icon={<HardHat className="w-3.5 h-3.5 text-primary" />}
                        label="Headgear"
                        className="col-span-2 md:col-span-1"
                      >
                        {details.headgearStyle}
                      </Spec>
                    </div>
                  )}

                  <div className="space-y-4 flex-1">
                    <div>
                      <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                        <Info className="w-4 h-4 text-primary" /> Reasoning
                      </h4>
                      <ul className="space-y-2">
                        {mask.reasoning.map((reason, i) => (
                          <li
                            key={i}
                            className="text-sm text-muted-foreground flex items-start gap-2"
                          >
                            <div className="w-1.5 h-1.5 rounded-full bg-primary/50 mt-1.5 shrink-0" />
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {mask.contraindications && mask.contraindications.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-amber-700 mb-1.5">
                          Things to consider
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {mask.contraindications.map((c, i) => (
                            <Badge
                              key={i}
                              variant="outline"
                              className="text-xs font-normal bg-amber-50 border-amber-200 text-amber-800"
                            >
                              {c}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}

                    {details?.sizesAvailable && details.sizesAvailable.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Available sizes
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {details.sizesAvailable.map((s, i) => (
                            <Badge key={i} variant="outline" className="text-xs font-normal">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-5 pt-5 border-t border-border/50">
                    <Button
                      onClick={() => handleChooseMask(mask)}
                      size="lg"
                      variant={idx === 0 ? "default" : "outline"}
                      className={`w-full ${idx === 0 ? "btn-primary-glow" : "glass-panel"}`}
                      data-testid={`button-choose-${mask.maskId}`}
                    >
                      <ShoppingCart className="w-4 h-4 mr-2" />
                      Order This Mask
                    </Button>
                    <p className="text-xs text-muted-foreground text-center mt-2">
                      We'll collect your insurance and shipping info, then send your order to Penn Home Medical Supply.
                    </p>
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
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

function Spec({
  icon,
  label,
  children,
  className,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 ${className ?? ""}`}>
      <div className="shrink-0">{icon}</div>
      <div className="min-w-0">
        <div className="text-muted-foreground">{label}</div>
        <div className="font-medium truncate">{children}</div>
      </div>
    </div>
  );
}
