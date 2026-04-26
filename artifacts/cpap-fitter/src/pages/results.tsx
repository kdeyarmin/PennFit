import React, { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useGetRecommendation, useListMasks } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCcw, Info, CheckCircle2, ChevronRight, AlertCircle, Weight, Activity, Wind, Tag, Sparkles } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";

export function Results() {
  const [, setLocation] = useLocation();
  const { measurements, answers, reset } = useFitterStore();
  const { mutate, data, isPending, error } = useGetRecommendation();
  const { data: catalog } = useListMasks();
  const catalogById = React.useMemo(() => {
    const map = new Map<string, NonNullable<typeof catalog>["masks"][number]>();
    catalog?.masks.forEach((m) => map.set(m.id, m));
    return map;
  }, [catalog]);
  
  const hasRequested = useRef(false);

  useEffect(() => {
    if (!measurements) {
      setLocation("/");
      return;
    }

    if (!hasRequested.current) {
      hasRequested.current = true;
      // Provide defaults for any missing answers to satisfy the type
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
      } as any;

      mutate({ data: { measurements, answers: fullAnswers } });
    }
  }, [measurements, answers, mutate, setLocation]);

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

  if (error) {
    return (
      <div className="container max-w-2xl mx-auto px-4 py-12">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Error Generating Recommendations</AlertTitle>
          <AlertDescription>
            {(error as any)?.error || "An unknown error occurred."}
          </AlertDescription>
        </Alert>
        <Button className="mt-6" onClick={() => setLocation("/")}>Start Over</Button>
      </div>
    );
  }

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 animate-in fade-in duration-500">
      <div className="text-center mb-12 space-y-4">
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-green-50 text-green-700 font-medium mb-2 border border-green-200">
          <CheckCircle2 className="w-5 h-5" />
          <span>Analysis Complete</span>
        </div>
        <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground">Your Recommended Masks</h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
          Based on your precise facial measurements and clinical preferences, here are the best fits for you.
        </p>
      </div>

      <div className="space-y-6 mb-12">
        <h2 className="text-xl font-semibold px-2">Top Recommendations</h2>
        {data.topRecommendations.map((mask, idx) => {
          const details = catalogById.get(mask.maskId);
          return (
            <Card key={mask.maskId} className={`overflow-hidden ${idx === 0 ? 'border-primary/50 shadow-lg ring-1 ring-primary/20' : 'border-border'}`}>
              <div className="flex flex-col md:flex-row">
                <div className="w-full md:w-1/3 bg-gradient-to-br from-muted/50 to-muted/10 p-6 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border">
                  <div className="aspect-square w-full max-w-[220px] bg-white rounded-xl shadow-sm border border-border overflow-hidden mb-4">
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
                      {idx === 0 && <span className="text-xs font-bold uppercase tracking-wider text-primary mb-1 block">Best Match</span>}
                      <CardTitle className="text-2xl mb-1">{mask.name}</CardTitle>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                          <Tag className="w-3.5 h-3.5" />
                          Model{" "}
                          <code className="font-mono font-semibold text-foreground bg-muted px-1.5 py-0.5 rounded text-xs">
                            {mask.modelNumber}
                          </code>
                        </span>
                        <span>Match confidence: {Math.round(mask.confidence * 100)}%</span>
                      </div>
                    </div>
                  </div>

                  <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 mb-4">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-primary mb-1.5 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5" />
                      Why this fits you
                    </h4>
                    <p className="text-sm text-foreground leading-relaxed">
                      {mask.summary}
                    </p>
                  </div>

                  {details?.description && (
                    <p className="text-sm text-muted-foreground leading-relaxed mb-4">
                      {details.description}
                    </p>
                  )}

                  {details && (
                    <div className="grid grid-cols-3 gap-3 mb-4 p-3 bg-muted/30 rounded-lg text-xs">
                      <div className="flex items-center gap-2">
                        <Weight className="w-3.5 h-3.5 text-primary" />
                        <div>
                          <div className="text-muted-foreground">Weight</div>
                          <div className="font-medium">{details.weightGrams} g</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Activity className="w-3.5 h-3.5 text-primary" />
                        <div>
                          <div className="text-muted-foreground">Pressure</div>
                          <div className="font-medium">{details.pressureRangeMin}–{details.pressureRangeMax}</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Wind className="w-3.5 h-3.5 text-primary" />
                        <div>
                          <div className="text-muted-foreground">Hose</div>
                          <div className="font-medium capitalize">{details.hoseConnection}</div>
                        </div>
                      </div>
                    </div>
                  )}

                  <div className="space-y-4 flex-1">
                    <div>
                      <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
                        <Info className="w-4 h-4 text-primary" /> Why this fits you:
                      </h4>
                      <ul className="space-y-2">
                        {mask.reasoning.map((reason, i) => (
                          <li key={i} className="text-sm text-muted-foreground flex items-start gap-2">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary/50 mt-1.5 shrink-0" />
                            <span>{reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>

                    {details?.sizesAvailable && details.sizesAvailable.length > 0 && (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                          Available sizes
                        </h4>
                        <div className="flex flex-wrap gap-1.5">
                          {details.sizesAvailable.map((s, i) => (
                            <Badge key={i} variant="outline" className="text-xs font-normal">{s}</Badge>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <div className="bg-muted/30 rounded-2xl p-6 border border-border flex flex-col md:flex-row items-center justify-between gap-6 mb-12">
        <div className="space-y-2">
          <h3 className="font-semibold text-lg">Looking for more options?</h3>
          <p className="text-sm text-muted-foreground">Browse the full catalog to see all available masks.</p>
        </div>
        <Link href="/masks">
          <Button variant="outline" className="shrink-0 group">
            View All Masks
            <ChevronRight className="ml-2 w-4 h-4 group-hover:translate-x-1 transition-transform" />
          </Button>
        </Link>
      </div>

      <div className="text-xs text-muted-foreground/80 text-center max-w-3xl mx-auto p-4 bg-muted/20 rounded-lg">
        <strong>Medical Disclaimer:</strong> {data.disclaimer}
      </div>

      <div className="flex justify-center mt-12">
        <Button variant="ghost" onClick={() => { reset(); setLocation("/"); }} className="text-muted-foreground">
          <RefreshCcw className="mr-2 w-4 h-4" /> Start Over
        </Button>
      </div>
    </div>
  );
}
