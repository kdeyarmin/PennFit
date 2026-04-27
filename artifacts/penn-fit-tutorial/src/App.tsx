import { useState } from "react";
import {
  Play,
  ArrowRight,
  Camera,
  ScanFace,
  Ruler,
  ClipboardList,
  Sparkles,
  ShoppingBag,
  Sun,
  Glasses,
  MessageCircleQuestion,
  ShieldCheck,
  Lightbulb,
  Lock,
  Smartphone,
} from "lucide-react";
import VideoWithControls from "@/components/video/VideoWithControls";
import logoSrc from "@assets/IMG_2053_1777233708393.jpeg";

// The cpap-fitter app is mounted at "/" on the same origin, so plain absolute
// paths from the tutorial cleanly leave this artifact and land on the main app.
const APP_HOME = "/";
const APP_START = "/capture";
const APP_HOW_IT_WORKS = "/how-it-works";
const APP_MASKS = "/masks";

// Synchronous on first paint via lazy useState initializer — avoids the
// "flash of standalone landing page" before flipping to the bare-video iframe
// view. The `typeof window` guard keeps us safe under SSR / pre-hydration.
function useIsIframed() {
  const [iframed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.self !== window.top;
    } catch {
      // Cross-origin frame access throws; that itself means we're iframed.
      return true;
    }
  });
  return iframed;
}

export default function App() {
  const isIframed = useIsIframed();

  // When embedded in cpap-fitter's /how-it-works page (or any other host iframe),
  // render only the bare video — the host page already provides navigation,
  // headers, and surrounding context.
  if (isIframed) {
    return (
      <div className="w-full h-screen">
        <VideoWithControls />
      </div>
    );
  }

  // Standalone view: full landing experience with nav, the video player, and a
  // detailed written walkthrough below.
  return <TutorialLandingPage />;
}

function TutorialLandingPage() {
  return (
    <div className="min-h-screen text-[#1F3A5C]">
      <Header />
      <Hero />
      <VideoSection />
      <WrittenGuide />
      <ProTipsSection />
      <PrivacyCallout />
      <FaqSection />
      <FinalCta />
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-40 bg-white/85 backdrop-blur-md border-b border-[#1F3A5C]/10">
      <div className="container mx-auto px-4 sm:px-6 py-3 flex items-center justify-between gap-3">
        <a
          href={APP_HOME}
          className="flex items-center gap-3 hover:opacity-80 transition-opacity"
          aria-label="Penn Fit home"
        >
          <img
            src={logoSrc}
            alt="Penn Home Medical Supply"
            className="h-10 sm:h-12 w-auto rounded-lg shadow-sm"
          />
          <span className="hidden sm:flex flex-col leading-tight">
            <span className="text-base font-bold">Penn Fit</span>
            <span className="text-[10px] tracking-widest uppercase text-[#1F3A5C]/60">
              Tutorial
            </span>
          </span>
        </a>
        <nav className="flex items-center gap-1 sm:gap-2">
          <a
            href={APP_HOW_IT_WORKS}
            className="hidden sm:inline-flex px-3 py-2 text-sm font-medium text-[#1F3A5C]/80 hover:text-[#1F3A5C] hover:bg-[#1F3A5C]/5 rounded-lg transition-colors"
          >
            How It Works
          </a>
          <a
            href={APP_MASKS}
            className="hidden sm:inline-flex px-3 py-2 text-sm font-medium text-[#1F3A5C]/80 hover:text-[#1F3A5C] hover:bg-[#1F3A5C]/5 rounded-lg transition-colors"
          >
            Mask Catalog
          </a>
          <a
            href={APP_START}
            className="inline-flex items-center gap-1.5 px-3 sm:px-4 py-2 text-xs sm:text-sm font-semibold text-white bg-[#1F3A5C] hover:bg-[#142a45] rounded-full transition-colors shadow-md"
          >
            <Play className="w-3.5 h-3.5" fill="currentColor" />
            Start Fitting
          </a>
        </nav>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section className="container mx-auto px-4 sm:px-6 pt-5 sm:pt-14 pb-4 sm:pb-6 text-center">
      <p className="text-xs sm:text-sm uppercase tracking-[0.2em] text-[#F4B942] font-bold">
        Penn Fit · Tutorial
      </p>
      <h1
        className="mt-2 sm:mt-3 text-2xl sm:text-4xl md:text-5xl lg:text-6xl font-extrabold tracking-tight leading-[1.05]"
        style={{ fontFamily: "var(--font-display)" }}
      >
        A 1-minute walkthrough.
      </h1>
      <p className="mt-2 sm:mt-5 text-sm sm:text-lg lg:text-xl text-[#475569] max-w-2xl mx-auto leading-snug sm:leading-relaxed">
        See exactly how Penn Fit goes from one selfie to a confident CPAP mask
        recommendation — then read the full step-by-step guide below.
      </p>
    </section>
  );
}

function VideoSection() {
  return (
    <section className="container mx-auto px-4 sm:px-6 pb-10">
      <div className="mx-auto max-w-5xl aspect-[3/5] sm:aspect-video rounded-2xl sm:rounded-3xl overflow-hidden shadow-2xl border border-[#1F3A5C]/10 bg-white relative">
        <VideoWithControls />
      </div>
      <p className="text-center text-xs sm:text-sm text-[#1F3A5C]/60 mt-3 px-4">
        Tap the loop icon to repeat any scene · click the bar segments to jump
        to a specific step.
      </p>
    </section>
  );
}

interface GuideStep {
  num: number;
  Icon: typeof Camera;
  title: string;
  body: string;
  detail: string[];
}

const guideSteps: GuideStep[] = [
  {
    num: 1,
    Icon: Smartphone,
    title: "Open Penn Fit on your phone",
    body: "On any modern phone, tablet, or laptop with a camera. Nothing to install — Penn Fit runs in your browser.",
    detail: [
      "Works on iPhone (Safari 14+), Android (Chrome 90+), and desktop Chrome / Edge / Safari.",
      "Allow camera access when your browser prompts you — we use it locally and never upload the image.",
    ],
  },
  {
    num: 2,
    Icon: ScanFace,
    title: "Frame your face inside the oval",
    body: "Hold your device at eye level, about an arm's length away, with your whole face visible inside the on-screen guide.",
    detail: [
      "Face a window or bright light — even, indirect lighting gives the best result.",
      "Remove glasses, tie back hair, and trim or part heavy facial hair if possible.",
      "Keep a neutral expression with your mouth closed.",
    ],
  },
  {
    num: 3,
    Icon: Camera,
    title: "Let the 3-second timer take the photo",
    body: "Once you're framed correctly, a 3-second countdown gives you time to settle. The photo is taken hands-free.",
    detail: [
      "If anything looks off, you can retake the photo before measurements are extracted.",
      "The photo never leaves your device — see the privacy section below for details.",
    ],
  },
  {
    num: 4,
    Icon: Ruler,
    title: "AI extracts 5 facial measurements",
    body: "Penn Fit's on-device computer-vision model finds 478 landmarks on your face and converts five of them to millimeter measurements.",
    detail: [
      "Nose width, nose height, nose-to-chin distance, mouth width, and face width at the cheekbones.",
      "We calibrate millimeters per pixel using the diameter of your iris — a biological constant of ~11.7 mm.",
      "All processing runs in your browser via MediaPipe — the model itself is the only thing downloaded.",
    ],
  },
  {
    num: 5,
    Icon: ClipboardList,
    title: "Answer 11 quick clinical questions",
    body: "Tap through a short questionnaire about how you sleep and what your CPAP setup looks like. \"I'm not sure\" is always a valid answer.",
    detail: [
      "Sleep position, mouth-breathing tendency, and claustrophobia preferences.",
      "Glasses, facial hair, and skin or silicone sensitivities.",
      "Your prescribed CPAP pressure (low / medium / high / not sure) — this gates which mask types are safe.",
    ],
  },
  {
    num: 6,
    Icon: Sparkles,
    title: "Review your top 3 mask matches",
    body: "Penn Fit ranks every mask in our catalog against your measurements and answers, then surfaces the three best fits with a confidence score and a plain-English reason for each.",
    detail: [
      "Each card shows the clinical reasoning — which measurements matched and which preferences were honored.",
      "Tap the confidence badge to see how the score breaks down between mask-type fit and physical-measurement fit.",
      "All recommendations come from masks Penn Home Medical Supply actually stocks and ships.",
    ],
  },
  {
    num: 7,
    Icon: ShoppingBag,
    title: "Order direct from Penn Home Medical Supply",
    body: "Pick the mask you'd like to try, share your shipping details, and Penn's fulfillment team takes it from there.",
    detail: [
      "Most orders ship the next business day to addresses in our service area.",
      "Insurance and replacement-supply questions? Reach out to your Penn rep with the order confirmation.",
    ],
  },
];

function WrittenGuide() {
  return (
    <section className="container mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8 sm:mb-12">
          <p className="text-xs uppercase tracking-[0.2em] text-[#F4B942] font-bold">
            The Full Guide
          </p>
          <h2
            className="mt-2 text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Every step, in writing.
          </h2>
          <p className="mt-3 text-base text-[#475569] max-w-2xl mx-auto">
            The video covers the highlights. Here's the unhurried version, in
            case you'd like to read along or share it with someone before they
            try it themselves.
          </p>
        </div>

        <ol className="space-y-4 sm:space-y-5">
          {guideSteps.map((step) => {
            const { Icon } = step;
            return (
              <li
                key={step.num}
                className="bg-white rounded-2xl border border-[#1F3A5C]/10 shadow-sm overflow-hidden"
              >
                <div className="p-5 sm:p-7">
                  <div className="flex items-start gap-4">
                    <div className="shrink-0 flex flex-col items-center gap-2">
                      <div className="w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-[#1F3A5C] text-white font-bold text-lg flex items-center justify-center shadow-md">
                        {step.num}
                      </div>
                      <Icon
                        className="w-5 h-5 text-[#F4B942]"
                        strokeWidth={2.4}
                      />
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-lg sm:text-xl font-bold text-[#1F3A5C] leading-snug">
                        {step.title}
                      </h3>
                      <p className="mt-2 text-sm sm:text-base text-[#475569] leading-relaxed">
                        {step.body}
                      </p>
                      <ul className="mt-3 space-y-1.5">
                        {step.detail.map((d, i) => (
                          <li
                            key={i}
                            className="flex items-start gap-2 text-xs sm:text-sm text-[#1F3A5C]/75 leading-relaxed"
                          >
                            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#F4B942] shrink-0" />
                            <span>{d}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </div>
    </section>
  );
}

const proTips = [
  { Icon: Sun, title: "Light from the front", text: "Face a window or lamp so light hits your face evenly. Avoid backlighting." },
  { Icon: Ruler, title: "Eye level, arm's length", text: "Hold the phone so the camera sits roughly between your eyebrows and chin." },
  { Icon: Glasses, title: "Glasses off, hair back", text: "Anything covering your nose bridge, cheekbones, or chin will skew the measurements." },
  { Icon: MessageCircleQuestion, title: "Honest answers win", text: "If you're unsure of your CPAP pressure, just pick \"I'm not sure\" — Penn Fit handles it." },
];

function ProTipsSection() {
  return (
    <section className="container mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="max-w-4xl mx-auto">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full bg-[#F4B942]/15 border border-[#F4B942]/30 mb-3">
            <Lightbulb className="w-4 h-4 text-[#F4B942]" strokeWidth={2.5} />
            <span className="text-xs font-bold uppercase tracking-[0.18em] text-[#1F3A5C]">
              Pro Tips for Accuracy
            </span>
          </div>
          <h2
            className="text-2xl sm:text-3xl font-extrabold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Get the most accurate fit.
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
          {proTips.map((tip) => {
            const { Icon } = tip;
            return (
              <div
                key={tip.title}
                className="bg-white rounded-xl border border-[#1F3A5C]/10 p-4 sm:p-5 flex items-start gap-3 shadow-sm"
              >
                <div className="shrink-0 w-10 h-10 rounded-lg bg-[#F4B942]/15 border border-[#F4B942]/30 flex items-center justify-center">
                  <Icon className="w-5 h-5 text-[#F4B942]" strokeWidth={2.2} />
                </div>
                <div className="min-w-0">
                  <h3 className="font-bold text-sm sm:text-base text-[#1F3A5C]">
                    {tip.title}
                  </h3>
                  <p className="mt-1 text-xs sm:text-sm text-[#475569] leading-relaxed">
                    {tip.text}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function PrivacyCallout() {
  return (
    <section className="container mx-auto px-4 sm:px-6 py-6 sm:py-10">
      <div className="max-w-4xl mx-auto bg-[#1F3A5C] text-white rounded-2xl sm:rounded-3xl p-6 sm:p-8 lg:p-10 shadow-xl relative overflow-hidden">
        <div className="absolute -top-20 -right-20 w-64 h-64 rounded-full bg-[#F4B942]/15 blur-3xl pointer-events-none" />
        <div className="relative flex flex-col sm:flex-row items-start gap-5">
          <div className="shrink-0 w-14 h-14 rounded-2xl bg-white/10 border border-white/20 flex items-center justify-center">
            <Lock className="w-6 h-6 text-[#F4B942]" strokeWidth={2.2} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-[0.2em] text-[#F4B942] font-bold">
              Privacy promise
            </p>
            <h3
              className="mt-1.5 text-xl sm:text-2xl font-extrabold leading-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              Your photo never leaves your device.
            </h3>
            <p className="mt-3 text-sm sm:text-base text-white/85 leading-relaxed">
              Penn Fit runs the face-mesh model entirely in your browser. The
              photo is converted to five numeric measurements and then{" "}
              <span className="font-semibold text-white">discarded</span>. Only
              those numbers — plus your questionnaire answers — are sent to our
              recommendation API. No image data, no identity, no PHI is stored.
            </p>
            <a
              href="/privacy"
              className="inline-flex items-center gap-1.5 mt-4 text-sm font-semibold text-[#F4B942] hover:text-white transition-colors"
            >
              Read the full privacy policy
              <ArrowRight className="w-4 h-4" />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

const faqs = [
  {
    q: "How long does the whole thing take?",
    a: "About three minutes from opening Penn Fit to seeing your top three mask recommendations.",
  },
  {
    q: "Can I use Penn Fit on my computer?",
    a: "Yes. Any modern laptop or desktop with a webcam works. Phones and tablets generally give the most consistent results because they're easier to hold at eye level.",
  },
  {
    q: "What if I don't know my CPAP pressure?",
    a: "Pick \"I'm not sure\" — the questionnaire handles it. We'll just exclude masks that require a known pressure to be safe (mainly nasal pillows above ~20 cmH2O).",
  },
  {
    q: "Are the recommendations medical advice?",
    a: "No. Penn Fit is a fitting aid, not a clinical diagnosis. Talk to your prescriber or your Penn rep before changing therapy.",
  },
  {
    q: "Can I retake the photo?",
    a: "Yes. If you don't like how the capture looks, you can retake it before measurements are extracted.",
  },
];

function FaqSection() {
  return (
    <section className="container mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="max-w-3xl mx-auto">
        <div className="text-center mb-8">
          <p className="text-xs uppercase tracking-[0.2em] text-[#F4B942] font-bold">
            Common Questions
          </p>
          <h2
            className="mt-2 text-2xl sm:text-3xl font-extrabold tracking-tight"
            style={{ fontFamily: "var(--font-display)" }}
          >
            Frequently asked.
          </h2>
        </div>
        <dl className="space-y-3">
          {faqs.map((f) => (
            <details
              key={f.q}
              className="group bg-white rounded-xl border border-[#1F3A5C]/10 shadow-sm"
            >
              <summary className="flex items-center justify-between gap-3 cursor-pointer list-none p-4 sm:p-5">
                <dt className="font-semibold text-[#1F3A5C] text-sm sm:text-base">
                  {f.q}
                </dt>
                <span className="shrink-0 w-7 h-7 rounded-full bg-[#1F3A5C]/8 flex items-center justify-center text-[#1F3A5C] font-bold transition-transform group-open:rotate-45">
                  +
                </span>
              </summary>
              <dd className="px-4 sm:px-5 pb-4 sm:pb-5 -mt-1 text-sm sm:text-base text-[#475569] leading-relaxed">
                {f.a}
              </dd>
            </details>
          ))}
        </dl>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section className="container mx-auto px-4 sm:px-6 py-10 sm:py-14">
      <div className="max-w-3xl mx-auto bg-white border border-[#1F3A5C]/10 rounded-2xl sm:rounded-3xl p-7 sm:p-10 text-center shadow-lg">
        <ShieldCheck
          className="w-10 h-10 mx-auto text-[#F4B942] mb-3"
          strokeWidth={2.2}
        />
        <h2
          className="text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight"
          style={{ fontFamily: "var(--font-display)" }}
        >
          Ready to find your mask?
        </h2>
        <p className="mt-3 text-base text-[#475569] max-w-xl mx-auto">
          Three minutes from now you'll have a confident, data-backed
          recommendation — and Penn's team can ship it as soon as the next
          business day.
        </p>
        <div className="mt-6 flex flex-col sm:flex-row gap-3 justify-center items-center">
          <a
            href={APP_START}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm sm:text-base font-semibold text-white bg-[#1F3A5C] hover:bg-[#142a45] rounded-full transition-colors shadow-md w-full sm:w-auto"
          >
            <Play className="w-4 h-4" fill="currentColor" />
            Start Fitting Now
          </a>
          <a
            href={APP_MASKS}
            className="inline-flex items-center justify-center gap-2 px-6 py-3 text-sm sm:text-base font-semibold text-[#1F3A5C] bg-white border border-[#1F3A5C]/20 hover:bg-[#1F3A5C]/5 rounded-full transition-colors w-full sm:w-auto"
          >
            Browse the Catalog
            <ArrowRight className="w-4 h-4" />
          </a>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-[#1F3A5C]/10 mt-6">
      <div className="container mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
        <div className="flex items-center gap-3">
          <img
            src={logoSrc}
            alt="Penn Home Medical Supply"
            className="h-9 w-auto rounded-lg"
          />
          <div className="text-xs text-[#1F3A5C]/70 leading-tight">
            <div className="font-semibold text-[#1F3A5C]">
              Penn Home Medical Supply, LLC
            </div>
            <div>Secure &amp; private · Images never leave your device.</div>
          </div>
        </div>
        <nav className="flex items-center gap-4 text-xs text-[#1F3A5C]/70">
          <a href={APP_HOME} className="hover:text-[#1F3A5C] transition-colors">
            Home
          </a>
          <a href="/privacy" className="hover:text-[#1F3A5C] transition-colors">
            Privacy
          </a>
          <a href={APP_HOW_IT_WORKS} className="hover:text-[#1F3A5C] transition-colors">
            How It Works
          </a>
        </nav>
      </div>
    </footer>
  );
}
