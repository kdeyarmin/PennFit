import React from "react";
import { Link } from "wouter";
import { ScanFace } from "lucide-react";
import {
  HelpArticleShell,
  type HelpStep,
} from "@/components/help/help-article-shell";
import {
  Screenshot,
  ConsentShot,
  FitterCaptureShot,
  FitterResultsShot,
} from "@/components/help/help-screens";

const steps: HelpStep[] = [
  {
    title: "Open the Virtual Mask Fitter",
    body: (
      <p>
        From the top menu, choose{" "}
        <Link href="/how-it-works" className="text-primary hover:underline">
          Virtual Mask Fitter
        </Link>{" "}
        and tap <strong>Get fitted for a mask</strong>. The fitter works on any
        phone, tablet, or computer with a front-facing camera and a modern
        browser — no app to install.
      </p>
    ),
    tip: "Use a phone if you can. It's easier to hold the camera at eye level, which gives the most accurate measurements.",
  },
  {
    title: "Agree to the privacy notice",
    body: (
      <p>
        Before the camera turns on, you&apos;ll confirm you understand how your
        data is handled. Your photo is processed{" "}
        <strong>entirely on your device</strong> and is never uploaded — only
        the resulting numerical measurements (in millimeters) and your
        questionnaire answers are sent to our recommendation engine. Check the
        boxes and continue.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/consent"
        caption="The consent screen explains exactly what leaves your device — your photo never does."
      >
        <ConsentShot />
      </Screenshot>
    ),
  },
  {
    title: "Capture your face",
    body: (
      <>
        <p>
          Hold the device at arm&apos;s length with the lens at eye level, and
          line your face up inside the oval guide. When the framing looks good,
          tap the capture button. You can retake the photo as many times as you
          like — nothing is stored.
        </p>
        <p>For the cleanest scan:</p>
        <ul className="list-disc pl-5 space-y-1">
          <li>Remove glasses, hats, and anything covering your face.</li>
          <li>Pull hair away from your forehead, eyebrows, and jawline.</li>
          <li>
            Keep a relaxed, neutral expression — don&apos;t smile or clench.
          </li>
          <li>Look straight ahead in even, front-on lighting.</li>
        </ul>
      </>
    ),
    shot: (
      <Screenshot
        frame="phone"
        caption="Line your face up inside the gold oval; the on-device engine finds your facial landmarks."
      >
        <FitterCaptureShot />
      </Screenshot>
    ),
  },
  {
    title: "Answer a few quick questions",
    body: (
      <p>
        Next you&apos;ll answer a short questionnaire about how you sleep — your
        sleep position, whether you breathe through your mouth, facial hair,
        claustrophobia or skin sensitivities, and your CPAP pressure if you know
        it. Answer for your <em>typical</em> night; these answers fine-tune the
        match alongside your measurements.
      </p>
    ),
    tip: "Be honest about mouth breathing — it's the single biggest factor in choosing between a nasal mask and a full-face mask.",
  },
  {
    title: "Review your ranked recommendations",
    body: (
      <p>
        PennPaps ranks masks from our catalog using your measurements and
        questionnaire, with a clear match score and a plain-English explanation
        of <em>why</em> each one fits you. The strongest match is flagged{" "}
        <strong>Best fit</strong>. Tap any card to see full details, or choose a
        mask to start an order.
      </p>
    ),
    shot: (
      <Screenshot
        url="pennpaps.com/results"
        caption="Each recommendation shows a match score and the reasoning behind it; the top result is badged Best fit."
      >
        <FitterResultsShot />
      </Screenshot>
    ),
  },
];

export function HelpFindYourMask() {
  return (
    <HelpArticleShell
      eyebrow="Getting Started"
      title="Find your mask with the Virtual Fitter"
      Icon={ScanFace}
      minutes="3 min"
      metaDescription="Step-by-step guide to the PennPaps Virtual Mask Fitter: consent, on-device face capture, the questionnaire, and reading your ranked mask recommendations."
      intro="The Virtual Mask Fitter matches you to the right CPAP mask from a quick on-device face scan and a few questions. Here's exactly what to expect, screen by screen."
      steps={steps}
      faqs={[
        {
          q: "Is my photo stored or sent anywhere?",
          a: (
            <>
              No. The image is processed entirely in your browser by
              Google&apos;s MediaPipe library and discarded the moment your
              measurements are extracted. Only the numerical measurements and
              questionnaire answers are sent to our server.
            </>
          ),
        },
        {
          q: "What if my measurements look wrong?",
          a: "Retake the photo as many times as you like. Better lighting, removing anything covering your face, and looking straight ahead at eye level fix almost every off measurement.",
        },
        {
          q: "Do I have to use the fitter to order?",
          a: (
            <>
              No — if you already know what you need, you can{" "}
              <Link href="/shop" className="text-primary hover:underline">
                shop supplies directly
              </Link>
              . The fitter is for finding the right mask when you&apos;re not
              sure.
            </>
          ),
        },
      ]}
      related={[
        {
          href: "/help/place-an-order",
          label: "Order your recommended mask",
          blurb: "Turn a recommendation into a finished order.",
        },
        {
          href: "/help/insurance-estimate",
          label: "Get an insurance estimate",
          blurb: "See what a new mask will cost you first.",
        },
      ]}
    />
  );
}
