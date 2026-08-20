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
import { BrandName } from "@/components/company-contact";

const steps: HelpStep[] = [
  {
    title: "Open the Virtual Mask Fitter",
    body: (
      <p>
        The fitter works on any phone, tablet, or computer with a front-facing
        camera and a modern browser (Chrome, Safari, Edge, or Firefox) — there
        is no app to install.
      </p>
    ),
    substeps: [
      <>
        Tap{" "}
        <Link href="/how-it-works" className="text-primary hover:underline">
          Virtual Mask Fitter
        </Link>{" "}
        in the top menu.
      </>,
      <>
        Press the <strong>Get fitted for a mask</strong> button.
      </>,
    ],
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
        questionnaire answers are sent to our recommendation engine.
      </p>
    ),
    substeps: [
      <>
        Read the short summary of what does — and doesn&apos;t — leave your
        device.
      </>,
      <>Tick the consent checkboxes.</>,
      <>
        Tap <strong>I agree — continue</strong>.
      </>,
    ],
    shot: (
      <Screenshot caption="The consent screen explains exactly what leaves your device — your photo never does.">
        <ConsentShot />
      </Screenshot>
    ),
    note: (
      <>
        If your browser asks for camera permission, choose{" "}
        <strong>Allow</strong>. You can revoke it anytime in your browser
        settings.
      </>
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
        <p>
          Some accounts use a <strong>guided scan</strong> instead. It works the
          same way, but an on-screen coach checks your lighting, distance, head
          position and stillness as you go, and captures three angles — straight
          ahead, then a slight turn each way — on its own once each pose holds
          steady. Comparing the angles against each other is what lets the
          fitter tell you how confident it is in the measurements. If your
          camera can&apos;t support it, it switches back to the single photo
          automatically.
        </p>
      </>
    ),
    substeps: [
      <>Remove glasses, hats, and anything covering your face.</>,
      <>Pull hair away from your forehead, eyebrows, and jawline.</>,
      <>
        Keep a relaxed, neutral expression — don&apos;t smile or clench your
        jaw.
      </>,
      <>Look straight ahead in even, front-on lighting, then tap capture.</>,
    ],
    shot: (
      <Screenshot
        frame="phone"
        caption="Line your face up inside the gold oval; the on-device engine finds your facial landmarks."
      >
        <FitterCaptureShot />
      </Screenshot>
    ),
    warning:
      "Backlighting (a bright window behind you) throws off the measurements. Face a light source instead, so your face is evenly lit.",
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
    title: "Answer the safety check",
    body: (
      <>
        <p>
          Some masks hold their headgear on with <strong>magnets</strong>, which
          can interfere with implanted medical devices. Before your results are
          finalised you&apos;ll be asked whether you — or anyone who lives with
          you — has a pacemaker, defibrillator (ICD) or other implanted heart
          device, an aneurysm clip, a neurostimulator, or an adjustable shunt.
        </p>
        <p>
          Household members are included on purpose: a mask gets handled at
          close range at home, not just on your face.
        </p>
      </>
    ),
    substeps: [
      <>
        Answer <strong>yes</strong> if you know about a device, even an old one.
      </>,
      <>
        Answer <strong>I&apos;m not sure</strong> if you don&apos;t know — it is
        treated the same as yes, so nothing unsafe is recommended.
      </>,
      <>
        Not sure what your implant is? Choose <em>I&apos;m not sure</em> and
        check with the clinic that placed it — don&apos;t guess.
      </>,
    ],
    warning:
      "A yes or an unsure removes every magnetic-clip mask from your results and shows non-magnetic alternatives instead. This is a hard rule — a magnetic mask can't come back into your list by scoring well on fit.",
  },
  {
    title: "Review your ranked recommendations",
    body: (
      <>
        <p>
          <BrandName /> ranks masks from our catalog using your measurements and
          questionnaire, with a clear match score and a plain-English
          explanation of <em>why</em> each one fits you. The strongest match is
          flagged <strong>Best fit</strong>.
        </p>
        <p>
          Safety comes first: anything ruled out by the safety check, or rated
          below your prescribed pressure, is removed outright rather than just
          scored lower. Your measurements are then matched against each
          mask&apos;s size-by-size fit range.
        </p>
      </>
    ),
    substeps: [
      <>Compare the match scores and the reasoning under each mask.</>,
      <>
        Tap any card&apos;s <strong>View details</strong> to see sizing and
        photos.
      </>,
      <>
        When you&apos;ve decided, tap <strong>Choose this mask</strong> to start
        an order.
      </>,
    ],
    shot: (
      <Screenshot caption="Each recommendation shows a match score and the reasoning behind it; the top result is badged Best fit.">
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
      minutes="4 min"
      metaDescription="Step-by-step guide to the Virtual Mask Fitter: consent, on-device face capture, the questionnaire, the magnetic-implant safety check, and reading your ranked mask recommendations."
      intro="The Virtual Mask Fitter matches you to the right CPAP mask from a quick on-device face scan and a few questions. Here's exactly what to expect, screen by screen."
      summary={
        <>
          Open the fitter from the menu, agree to the privacy notice, take a
          well-lit front-on scan (it never leaves your device), answer a few
          questions about how you sleep, complete a short safety check about
          implanted medical devices, and pick from your ranked, explained
          recommendations.
        </>
      }
      prerequisites={[
        "A device with a front-facing camera (a phone works best).",
        "A modern browser — Chrome, Safari, Edge, or Firefox.",
        "Good, even lighting on your face — and glasses/hats off.",
      ]}
      steps={steps}
      next={{
        href: "/help/place-an-order",
        label: "Order your recommended mask",
        blurb: "Turn your best-fit recommendation into a finished order.",
      }}
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
          q: "Why am I being asked about pacemakers and implants?",
          a: (
            <>
              Some masks use magnets to attach the headgear, and magnets can
              interfere with implanted medical devices. The check covers your
              household as well as you, because a mask is handled at close range
              at home. Answering yes — or <em>I&apos;m not sure</em> — simply
              means we recommend non-magnetic masks instead.
            </>
          ),
        },
        {
          q: "The fitter asked for a better scan instead of recommending a mask. Why?",
          a: "That's deliberate. If the scan quality was poor, or a measurement came back outside the plausible range for a face, the fitter tells you rather than guessing. Retaking it in even, front-on lighting fixes it most of the time — and you can always ask our team for help instead.",
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
