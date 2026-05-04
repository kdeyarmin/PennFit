import React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollText } from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function Terms() {
  useDocumentTitle(
    "Terms of service",
    "Terms of service for PennPaps and Penn Home Medical Supply.",
  );
  return (
    <div className="container max-w-3xl mx-auto px-4 py-12 animate-shimmer-in">
      <Card className="border-0 glass-card rounded-2xl">
        <CardHeader className="space-y-4 pb-2">
          <div className="flex items-center justify-center w-16 h-16 rounded-2xl icon-halo-navy mx-auto mb-1">
            <ScrollText className="w-7 h-7" />
          </div>
          <div className="text-center space-y-3">
            <div className="inline-flex items-center gap-3">
              <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
              <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
                PennPaps · Terms
              </span>
              <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
            </div>
            <CardTitle className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
              Terms of Service
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              PennPaps.com — operated by Penn Home Medical Supply
            </p>
          </div>
        </CardHeader>
        <CardContent className="space-y-6 text-sm text-foreground/90 leading-relaxed pt-6">
          <p>
            These Terms of Service ("Terms") govern your use of the PennPaps
            website, mask-fitting tool, ordering system, and SMS/text-messaging
            notifications (collectively, the "Service") operated by Penn Home
            Medical Supply ("Penn Home Medical Supply," "we," "us," or "our") at
            PennPaps.com. By using the Service, you agree to these Terms. If you
            do not agree, please do not use the Service.
          </p>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                01
              </span>
              Eligibility
            </h3>
            <p>
              You must be 18 years of age or older, or the parent/legal guardian
              of the patient, to place an order or consent to receive text
              messages from PennPaps. By using the Service you represent that
              the information you provide is accurate and that you have the
              authority to provide it.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                02
              </span>
              Mask Recommendation Tool
            </h3>
            <p>
              Penn Home Medical Supply uses on-device facial measurements and
              your questionnaire responses to suggest a CPAP mask.
              Recommendations are informational only and do not constitute
              medical advice or a prescription. Final mask selection, sizing,
              and fitting are subject to your prescriber's orders and PennPaps's
              clinical review.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                03
              </span>
              Orders, Insurance, and Prescriptions
            </h3>
            <p>
              By submitting an order you authorize PennPaps to verify your
              insurance benefits, obtain or verify your CPAP prescription, ship
              supplies to the address on file, and bill your insurance and any
              patient responsibility. Coverage, eligibility, copays, and
              replacement schedules are determined by your insurance plan and
              are subject to change. PennPaps will not knowingly ship supplies
              that are not eligible for coverage under your plan without first
              contacting you.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                04
              </span>
              SMS / Text Messaging Program
            </h3>
            <p>
              When you opt in to be contacted at the phone number you provide,
              PennPaps will send you transactional SMS text messages relating to
              your account, your order, and your CPAP resupply schedule. By
              providing your mobile number and checking the contact consent box
              at checkout you expressly consent to receive these messages from
              PennPaps at the number provided, including via automated systems.
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1">
              <li>
                <strong>Program name:</strong> PennPaps CPAP Resupply
                Notifications.
              </li>
              <li>
                <strong>Message types:</strong> Order confirmations, shipping
                updates, insurance and prescription follow-ups, resupply
                reminders, and replies to your messages.
              </li>
              <li>
                <strong>Message frequency:</strong> Approximately 1 to 2
                messages per resupply cycle (typically every 30 to 90 days),
                plus transactional confirmations and follow-ups if you do not
                reply. We do not send marketing or promotional texts.
              </li>
              <li>
                <strong>Carrier charges:</strong>{" "}
                <em>Message and data rates may apply.</em> Carriers are not
                liable for delayed or undelivered messages.
              </li>
              <li>
                <strong>HELP:</strong> Reply HELP to any message to receive a
                brief description of the program and contact information for
                support.
              </li>
              <li>
                <strong>STOP / opt-out:</strong> Reply STOP, END, CANCEL,
                UNSUBSCRIBE, QUIT, or OPTOUT to any PennPaps message at any time
                to stop all PennPaps texts. You will receive one final
                confirmation message and then no further texts. Reply START to
                resume.
              </li>
              <li>
                <strong>Eligible carriers:</strong> Major U.S. wireless
                carriers.
              </li>
              <li>
                <strong>No third-party marketing:</strong> PennPaps will not
                sell, rent, or share your mobile phone number or SMS opt-in
                consent with any third party for their marketing purposes. We
                share your phone number only with the telecommunications
                providers required to deliver the messages you have asked us to
                send.
              </li>
            </ul>
            <p className="mt-2">
              For SMS support contact{" "}
              <a
                href="mailto:info@pennpaps.com"
                className="underline hover:text-primary"
              >
                info@pennpaps.com
              </a>
              . See our{" "}
              <a href="/privacy" className="underline hover:text-primary">
                Privacy Policy
              </a>{" "}
              for how PennPaps handles the personal information you provide.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                05
              </span>
              Acceptable Use
            </h3>
            <p>
              You agree not to (i) use the Service for any unlawful purpose or
              in a manner that could damage, disable, or impair PennPaps's
              systems; (ii) submit false or misleading patient, insurance, or
              prescription information; (iii) attempt to access another
              patient's records or PennPaps's internal systems without
              authorization; or (iv) use the Service to send unsolicited
              messages or for any commercial purpose other than your own CPAP
              supply needs.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                06
              </span>
              Disclaimers and Limitation of Liability
            </h3>
            <p>
              The Service is provided on an "as is" and "as available" basis.
              PennPaps makes no warranties, express or implied, regarding the
              Service, including the accuracy of mask recommendations, the
              timeliness of insurance verification, or the delivery of text
              messages. To the fullest extent permitted by law, PennPaps will
              not be liable for any indirect, incidental, special,
              consequential, or punitive damages arising out of or relating to
              your use of the Service.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                07
              </span>
              Changes to These Terms
            </h3>
            <p>
              PennPaps may update these Terms from time to time. Material
              changes will be posted to this page with a revised effective date.
              Your continued use of the Service after changes are posted
              constitutes your acceptance of the updated Terms.
            </p>
          </section>

          <section className="space-y-2">
            <h3 className="text-lg font-semibold text-foreground tracking-tight">
              <span className="text-[hsl(var(--penn-gold))] mr-2 font-mono text-sm align-middle">
                08
              </span>
              Contact
            </h3>
            <p>
              Questions about these Terms or the SMS program may be sent to{" "}
              <a
                href="mailto:info@pennpaps.com"
                className="underline hover:text-primary"
              >
                info@pennpaps.com
              </a>
              .
            </p>
          </section>
        </CardContent>
      </Card>
    </div>
  );
}
