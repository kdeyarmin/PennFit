import React, { useEffect, useRef } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { useGetRecommendation } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { RefreshCcw, Info, CheckCircle2, ChevronRight, AlertCircle } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

export function Results() {
  const [, setLocation] = useLocation();
  const { measurements, answers, reset } = useFitterStore();
  const { mutate, data, isPending, error } = useGetRecommendation();
  
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
        <h2 className="text-xl font-semibold px-2">Top Recommendation</h2>
        {data.topRecommendations.map((mask, idx) => (
          <Card key={mask.maskId} className={`overflow-hidden ${idx === 0 ? 'border-primary/50 shadow-lg ring-1 ring-primary/20' : 'border-border'}`}>
            <div className="flex flex-col md:flex-row">
              <div className="w-full md:w-1/3 bg-muted p-6 flex flex-col items-center justify-center border-b md:border-b-0 md:border-r border-border">
                {/* Fallback image placeholder since we don't have real product images in this mock */}
                <div className="aspect-square w-full max-w-[200px] bg-white rounded-xl shadow-sm border border-border flex items-center justify-center mb-4 text-muted-foreground text-sm p-4 text-center">
                  {mask.name} Image
                </div>
                <div className="flex gap-2 flex-wrap justify-center">
                  <Badge variant="secondary" className="capitalize">{mask.type.replace(/([A-Z])/g, ' $1').trim()}</Badge>
                  <Badge variant="outline">{mask.manufacturer}</Badge>
                </div>
              </div>
              
              <div className="w-full md:w-2/3 p-6 flex flex-col">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    {idx === 0 && <span className="text-xs font-bold uppercase tracking-wider text-primary mb-1 block">Best Match</span>}
                    <CardTitle className="text-2xl mb-1">{mask.name}</CardTitle>
                    <p className="text-sm text-muted-foreground">Match Confidence: {Math.round(mask.confidence * 100)}%</p>
                  </div>
                </div>

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
                </div>
              </div>
            </div>
          </Card>
        ))}
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
