import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export function Privacy() {
  return (
    <div className="container max-w-3xl mx-auto px-4 py-12">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-3xl">Penn Fit Privacy Policy</CardTitle>
          <p className="text-sm text-muted-foreground">A service of Penn Home Medical Supply, LLC</p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-foreground/90 leading-relaxed">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-900 rounded-md p-4 flex gap-3 text-yellow-800 dark:text-yellow-200">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <div>
              <strong className="font-semibold">ATTORNEY REVIEW REQUIRED:</strong> This is a placeholder policy and must be reviewed by legal counsel for compliance with HIPAA, BIPA, CCPA, and other applicable privacy regulations.
            </div>
          </div>

          <p>
            This Privacy Policy describes how Penn Home Medical Supply, LLC ("Penn Home Medical Supply," "we," "us," or "our") handles information you provide while using the Penn Fit CPAP mask fitting tool ("Penn Fit").
          </p>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">1. Data Processing and Camera Use</h3>
            <p>
              Penn Fit uses your device's camera to perform real-time facial measurements required for CPAP mask fitting.
              <strong> All image and video processing occurs locally on your device.</strong> Penn Home Medical Supply does not capture, record, store, or transmit photographs, video streams, or biometric identifiers to our servers.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">2. Data Transmitted</h3>
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

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">3. Third-Party Services</h3>
            <p>
              Penn Fit uses Google's MediaPipe technology for on-device landmark detection. This operates entirely within your browser environment. Order emails are delivered to Penn Home Medical Supply through SendGrid, our transactional email provider.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">4. Your Rights</h3>
            <p>
              Because Penn Fit does not store your biometric data or measurements beyond the immediate session, there is no ongoing profile data to delete. Simply closing the browser or clicking "Start Over" clears the session data. For questions about an order you have submitted to Penn Home Medical Supply, contact us directly.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
