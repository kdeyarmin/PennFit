import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";

export function Privacy() {
  return (
    <div className="container max-w-3xl mx-auto px-4 py-12">
      <Card className="border-border">
        <CardHeader>
          <CardTitle className="text-3xl">Privacy Policy</CardTitle>
          <p className="text-sm text-muted-foreground">Effective Date: [Insert Date]</p>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-foreground/90 leading-relaxed">
          <div className="bg-yellow-50 dark:bg-yellow-950/30 border border-yellow-200 dark:border-yellow-900 rounded-md p-4 flex gap-3 text-yellow-800 dark:text-yellow-200">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <div>
              <strong className="font-semibold">ATTORNEY REVIEW REQUIRED:</strong> This is a placeholder policy and must be reviewed by legal counsel for compliance with HIPAA, BIPA, CCPA, and other applicable privacy regulations.
            </div>
          </div>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">1. Data Processing and Camera Use</h3>
            <p>
              This application uses your device's camera to perform real-time facial measurements required for CPAP mask fitting. 
              <strong> All image and video processing occurs locally on your device.</strong> We do not capture, record, store, or transmit photographs, video streams, or biometric identifiers to our servers.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">2. Data Transmitted</h3>
            <p>
              The only data transmitted from your device to our servers are:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Numerical facial measurements (e.g., nose width in millimeters).</li>
              <li>Responses to the clinical questionnaire (e.g., preferred sleep position).</li>
            </ul>
            <p className="mt-2">
              This data is sent securely to generate a mask recommendation and is not stored or linked to Protected Health Information (PHI) within this specific stateless service.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">3. Third-Party Services</h3>
            <p>
              We utilize Google's MediaPipe technology for on-device landmark detection. This operates entirely within your browser environment.
            </p>
          </section>

          <section>
            <h3 className="text-lg font-semibold text-foreground mb-2">4. Your Rights</h3>
            <p>
              Because this tool does not store your biometric data or measurements beyond the immediate session, there is no ongoing profile data to delete. Simply closing the browser or clicking "Start Over" clears the session data.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
