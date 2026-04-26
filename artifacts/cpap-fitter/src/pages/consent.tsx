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
    <div className="container max-w-3xl mx-auto px-4 py-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <Card className="border-border shadow-sm">
        <CardHeader className="space-y-4">
          <div className="flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mx-auto mb-2">
            <ShieldCheck className="w-8 h-8" />
          </div>
          <CardTitle className="text-3xl text-center">Privacy & Consent</CardTitle>
          <CardDescription className="text-center text-lg max-w-xl mx-auto">
            Your privacy is our absolute priority. Before we begin, please review how we protect your data.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-8">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex gap-4 p-4 rounded-xl bg-muted/50 border border-border/50">
              <ServerOff className="w-8 h-8 text-primary shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">On-Device Processing</h3>
                <p className="text-sm text-muted-foreground">
                  All camera processing happens entirely on your device. Images and video <strong>never</strong> leave your phone or computer.
                </p>
              </div>
            </div>
            
            <div className="flex gap-4 p-4 rounded-xl bg-muted/50 border border-border/50">
              <Camera className="w-8 h-8 text-primary shrink-0" />
              <div>
                <h3 className="font-semibold mb-1">No Image Storage</h3>
                <p className="text-sm text-muted-foreground">
                  The capture is held temporarily in memory just long enough to extract measurements, then immediately discarded.
                </p>
              </div>
            </div>
          </div>

          <div className="bg-blue-50/50 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900 rounded-xl p-5 text-sm space-y-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
              <div className="space-y-3">
                <p className="font-medium text-blue-900 dark:text-blue-300">Biometric Information Privacy Disclosure <span className="text-xs text-muted-foreground uppercase tracking-wider ml-2">[ATTORNEY REVIEW]</span></p>
                <p className="text-blue-800/80 dark:text-blue-200/80 leading-relaxed">
                  To provide mask recommendations, this application uses facial recognition technology to extract numerical measurements (such as the distance between your nose and chin). 
                  <strong> No images or biometric identifiers are stored, recorded, or transmitted to our servers.</strong>
                </p>
                <p className="text-blue-800/80 dark:text-blue-200/80 leading-relaxed">
                  Only the extracted numerical values (in millimeters) and your questionnaire answers are sent securely to our recommendation engine.
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-row items-start space-x-3 space-y-0 rounded-md border p-4 hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => setAgreed(!agreed)}>
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
        <CardFooter className="flex justify-between border-t p-6 bg-muted/10">
          <Link href="/">
            <Button variant="ghost">Cancel</Button>
          </Link>
          <Button onClick={handleContinue} disabled={!agreed} className="px-8">
            I Consent, Continue to Camera
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
}
