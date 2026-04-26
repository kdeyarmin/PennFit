import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck } from "lucide-react";

export function Privacy() {
  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="space-y-4 pb-2">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto mb-1">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <div className="text-center space-y-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                Penn Fit · Privacy
              </span>
              <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
            <CardTitle className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
              Privacy Policy
            </CardTitle>
            <p className="text-sm text-muted-foreground">A service of Penn Home Medical Supply, LLC</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-foreground/90 leading-relaxed pt-6">
          <p>
            This Privacy Policy describes how Penn Home Medical Supply, LLC ("Penn Home Medical Supply," "we," "us," or "our") handles information you provide while using the Penn Fit CPAP mask fitting tool ("Penn Fit").
          </p>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">01</span>
              Data Processing and Camera Use
            </h3>
            <p>
              Penn Fit uses your device's camera to perform real-time facial measurements required for CPAP mask fitting.
              <strong> All image and video processing occurs locally on your device.</strong> Penn Home Medical Supply does not capture, record, store, or transmit photographs, video streams, or biometric identifiers to our servers.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">02</span>
              Data Transmitted
            </h3>
            <p>
              The only data transmitted from your device to Penn Home Medical Supply's servers are:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Numerical facial measurements (e.g., nose width in millimeters).</li>
              <li>Responses to the clinical questionnaire (e.g., preferred sleep position).</li>
              <li>If you choose to place an order: the patient, shipping, insurance, and prescription details you submit on the order form.</li>
            </ul>
            <p className="mt-2">
              Measurement and questionnaire data is sent securely to generate a mask recommendation and is not stored or linked to Protected Health Information (PHI) within the stateless recommendation service. Order details you submit are forwarded by email to Penn Home Medical Supply for fulfillment and are not persisted by the Penn Fit application itself.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">03</span>
              Third-Party Services
            </h3>
            <p>
              Penn Fit uses Google's MediaPipe technology for on-device landmark detection. This operates entirely within your browser environment. Order emails are delivered to Penn Home Medical Supply through SendGrid, our transactional email provider.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">04</span>
              Your Rights
            </h3>
            <p>
              Because Penn Fit does not store your biometric data or measurements beyond the immediate session, there is no ongoing profile data to delete. Simply closing the browser or clicking "Start Over" clears the session data. For questions about an order you have submitted to Penn Home Medical Supply, contact us directly.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
