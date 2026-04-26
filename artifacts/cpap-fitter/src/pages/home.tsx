import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScanFace, ClipboardList, Zap, Shield } from "lucide-react";

export function Home() {
  return (
    <div className="flex flex-col items-center max-w-5xl mx-auto w-full px-4 py-12 md:py-24">
      <div className="text-center max-w-3xl mb-16 animate-in fade-in slide-in-from-bottom-4 duration-700">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium mb-6">
          <Shield className="w-4 h-4" />
          <span>100% Private On-Device Processing</span>
        </div>
        <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-foreground mb-6">
          Penn Fit — Your Perfect CPAP Mask in Minutes
        </h1>
        <p className="text-lg md:text-xl text-muted-foreground leading-relaxed mb-8">
          From the team at Penn Home Medical Supply. Our clinical-grade fitting tool uses your
          device's camera to measure your facial structure securely, then matches you with the
          ideal mask from our catalog based on your unique needs.
        </p>
        <Link href="/consent">
          <Button size="lg" className="h-14 px-8 text-lg rounded-full shadow-lg hover:shadow-xl transition-all hover:-translate-y-1">
            Start Fitting Process
          </Button>
        </Link>
      </div>

      <div className="grid md:grid-cols-3 gap-8 w-full animate-in fade-in slide-in-from-bottom-8 duration-700 delay-150 fill-mode-both">
        <Card className="border-none shadow-md bg-card/50 backdrop-blur-sm">
          <CardContent className="pt-6 flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
              <ScanFace className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Secure Scan</h3>
            <p className="text-muted-foreground">
              We measure your face using your camera. The image never leaves your device, ensuring total privacy.
            </p>
          </CardContent>
        </Card>
        
        <Card className="border-none shadow-md bg-card/50 backdrop-blur-sm">
          <CardContent className="pt-6 flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
              <ClipboardList className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Quick Assessment</h3>
            <p className="text-muted-foreground">
              Answer a few simple questions about your sleep habits and preferences to narrow down the options.
            </p>
          </CardContent>
        </Card>

        <Card className="border-none shadow-md bg-card/50 backdrop-blur-sm">
          <CardContent className="pt-6 flex flex-col items-center text-center">
            <div className="h-12 w-12 rounded-full bg-primary/10 text-primary flex items-center justify-center mb-4">
              <Zap className="w-6 h-6" />
            </div>
            <h3 className="text-xl font-semibold mb-2">Instant Match</h3>
            <p className="text-muted-foreground">
              Get personalized mask recommendations backed by clinical reasoning and precise measurements.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
