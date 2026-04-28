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
                PennPaps · Privacy
              </span>
              <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
            <CardTitle className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
              Privacy Policy
            </CardTitle>
            <p className="text-sm text-muted-foreground">A service of PennPaps</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-foreground/90 leading-relaxed pt-6">
          <p>
            This Privacy Policy describes how PennPaps ("PennPaps," "we," "us," or "our") handles information you provide while using the PennPaps CPAP mask fitting tool ("PennPaps").
          </p>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">01</span>
              Data Processing and Camera Use
            </h3>
            <p>
              PennPaps uses your device's camera to perform real-time facial measurements required for CPAP mask fitting.
              <strong> All image and video processing occurs locally on your device.</strong> PennPaps does not capture, record, store, or transmit photographs, video streams, or biometric identifiers to our servers.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">02</span>
              Data Transmitted
            </h3>
            <p>
              The only data transmitted from your device to PennPaps's servers are:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Numerical facial measurements (e.g., nose width in millimeters).</li>
              <li>Responses to the clinical questionnaire (e.g., preferred sleep position).</li>
              <li>If you choose to place an order: the patient, shipping, insurance, and prescription details you submit on the order form.</li>
              <li>Anonymous funnel-step events (e.g., "consent given," "results viewed") tagged with a random per-tab session identifier. These contain no name, IP address, device fingerprint, or contact information.</li>
            </ul>
            <p className="mt-2">
              Measurement and questionnaire data is sent securely to generate a mask recommendation and is then discarded — the recommendation engine is stateless and does not write your facial measurements to any database.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">03</span>
              Order Data Storage
            </h3>
            <p>
              <strong>If you submit an order</strong>, the contact, shipping, insurance, prescription, and notes
              fields you enter — together with the chosen mask, on-device measurements, and an anonymized
              order reference — are stored in PennPaps's secure HIPAA-aware fulfillment
              database. This information is used by PennPaps staff to:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Ship the mask to your address;</li>
              <li>Bill your insurance and resolve any coverage questions;</li>
              <li>Verify or obtain a CPAP prescription on your behalf;</li>
              <li>Maintain records required by federal, state, and payer regulations.</li>
            </ul>
            <p className="mt-2">
              You re-confirm this storage at checkout via a required consent checkbox. Access to stored
              orders is limited to PennPaps staff who have signed in with an authorized
              email and is recorded in an internal audit log. To request a copy or deletion of your stored
              order information, contact PennPaps directly.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">04</span>
              Third-Party Services
            </h3>
            <p>
              PennPaps uses Google's MediaPipe technology for on-device landmark detection. This operates
              entirely within your browser environment. Order emails are delivered to PennPaps
              through SendGrid, our transactional email provider. Authentication for PennPaps staff
              is provided by Clerk.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">05</span>
              SMS / Text Messaging Notifications
            </h3>
            <p>
              When you place an order and consent to be contacted, PennPaps may send you SMS text
              messages from our toll-free number for the following purposes:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>Order confirmation and shipping updates;</li>
              <li>Insurance verification follow-ups and prescription requests;</li>
              <li>Resupply reminders when you are due for new CPAP supplies (typically every
                30 to 90 days, per your insurance benefit and prescribed replacement schedule);</li>
              <li>Replies to questions you send us by text.</li>
            </ul>
            <p className="mt-2">
              <strong>Frequency:</strong> Approximately 1 to 2 messages per resupply cycle, plus
              transactional confirmations and any follow-ups if you do not respond. You will not
              receive marketing or promotional texts.
            </p>
            <p className="mt-2">
              <strong>Help and opt-out:</strong> Reply <strong>HELP</strong> at any time for assistance,
              or <strong>STOP</strong> to unsubscribe from all PennPaps text messages. After you
              reply STOP we will send one final confirmation and then no further texts; reply
              <strong> START</strong> to resume.
            </p>
            <p className="mt-2">
              <strong>Carrier charges:</strong> <em>Message and data rates may apply.</em> Carriers
              are not liable for delayed or undelivered messages.
            </p>
            <p className="mt-2">
              <strong>No third-party sharing for marketing:</strong> PennPaps will not sell, rent,
              or share your mobile phone number or SMS opt-in consent with any third party for
              their marketing purposes. We share your phone number only with the
              telecommunications providers required to deliver the messages you have asked us to
              send (currently Twilio, our SMS carrier).
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">06</span>
              Your Rights
            </h3>
            <p>
              Camera images and biometric measurements are never stored beyond the immediate browser
              session — closing the browser or clicking "Start Over" clears them. For data you submitted
              with an order (contact, shipping, insurance, prescription), you may contact PennPaps
              directly at <a href="mailto:info@pennpaps.com" className="underline hover:text-primary">info@pennpaps.com</a>{" "}
              to request a copy, correction, or deletion subject to applicable
              recordkeeping requirements. To stop receiving texts at any time, reply STOP to any
              message from PennPaps.
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
