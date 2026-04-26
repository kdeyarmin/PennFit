import React, { useState } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldCheck, Camera, ServerOff, AlertCircle } from "lucide-react";

export function Consent() {
  const [, setLocation] = useLocation();
  const [agreed, setAgreed] = useState(false);

  const handleContinue = () => {
    if (agreed) {
      setLocation("/capture");
    }
  };

  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto mb-2">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <CardTitle className="text-display text-3xl md:text-4xl text-center font-bold tracking-tight text-gradient-brand">Privacy & Consent</CardTitle>
          <CardDescription className="text-center text-lg max-w-xl mx-auto">
            At Penn Home Medical Supply, your privacy is our absolute priority. Before we begin, please review how Penn Fit protects your data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="flex gap-4 p-5 rounded-xl glass-panel">
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                <ServerOff className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 tracking-tight">On-Device Processing</h3>
                <p className="text-sm text-muted-foreground">
                  All camera processing happens entirely on your device. Images and video <strong>never</strong> leave your phone or computer.
                </p>
              </div>
            </div>

            <div className="flex gap-4 p-5 rounded-xl glass-panel">
              <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                <Camera className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-semibold mb-1 tracking-tight">No Image Storage</h3>
                <p className="text-sm text-muted-foreground">
                  The capture is held temporarily in memory just long enough to extract measurements, then immediately discarded.
                </p>
              </div>
            </div>
          </div>

          <div
            className="rounded-xl p-5 text-sm space-y-4 border border-[hsl(var(--penn-navy)/0.18)] relative overflow-hidden"
            style={{
              background:
                "linear-gradient(135deg, hsl(var(--penn-navy) / 0.05) 0%, hsl(var(--penn-mist) / 0.5) 100%)",
            }}
          >
            <div className="flex items-start gap-3 relative">
              <AlertCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
              <div className="space-y-3">
                <p className="font-medium text-primary tracking-tight">Biometric Information Privacy Disclosure</p>
                <p className="text-foreground/80 leading-relaxed">
                  To provide mask recommendations, Penn Fit uses facial recognition technology to extract numerical measurements (such as the distance between your nose and chin).
                  <strong> No images or biometric identifiers are stored, recorded, or transmitted to Penn Home Medical Supply or any third party.</strong>
                </p>
                <p className="text-foreground/80 leading-relaxed">
                  Only the extracted numerical values (in millimeters) and your questionnaire answers are sent securely to the Penn Fit recommendation engine.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-row items-start space-x-3 space-y-0 rounded-xl border border-border/60 glass-panel p-4 hover:border-primary/40 transition-colors cursor-pointer" onClick={() => setAgreed(!agreed)}>
            <Checkbox 
              id="consent" 
              checked={agreed} 
              onCheckedChange={(checked) => setAgreed(checked as boolean)} 
            />
            <div className="space-y-1 leading-none">
              <label htmlFor="consent" className="font-medium cursor-pointer">
                I understand and consent to the use of my camera for on-device measurement
              </label>
              <p className="text-sm text-muted-foreground">
                I acknowledge that no images will be saved or uploaded.
              </p>
            </div>
          </div>
        </CardContent>
        <CardFooter className="flex justify-between border-t border-border/40 p-6">
          <Link href="/">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button onClick={handleContinue} disabled={!agreed} className="px-8 btn-primary-glow disabled:shadow-none rounded-full">
            I Consent, Continue to Camera
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
