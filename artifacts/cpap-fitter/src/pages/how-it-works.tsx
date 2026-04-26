import React from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  ShieldCheck,
  Camera,
  Ruler,
  ClipboardList,
  Sparkles,
  PackageCheck,
  Sun,
  Glasses,
  Scissors,
  Smile,
  Smartphone,
  CheckCircle2,
  AlertTriangle,
  HelpCircle,
} from "lucide-react";

const steps = [
  {
    icon: ShieldCheck,
    title: "1. Review Privacy & Consent",
    body: "Confirm you understand how your data is handled: your photo is processed entirely on your device and never uploaded — only the resulting numerical measurements and questionnaire answers are sent to the recommendation engine.",
  },
  {
    icon: Camera,
    title: "2. Capture Your Face",
    body: "Use your device's front-facing camera to take a clear, well-lit photo of your face. Penn Fit will guide you through framing.",
  },
  {
    icon: Ruler,
    title: "3. Generate Measurements",
    body: "Penn Fit's on-device facial landmark engine derives numerical measurements (such as nose width and face height in millimeters) from the captured image, then immediately discards the image.",
  },
  {
    icon: ClipboardList,
    title: "4. Answer Quick Questions",
    body: "Tell us about your sleep position, breathing habits, facial hair, and any sensitivities so we can refine the match.",
  },
  {
    icon: Sparkles,
    title: "5. See Your Recommendations",
    body: "Penn Fit ranks masks from our catalog using your measurements and questionnaire — with a clear explanation of why each one fits.",
  },
  {
    icon: PackageCheck,
    title: "6. Place Your Order",
    body: "Pick a mask, fill in your shipping, insurance, and prescription details, and submit. Penn Home Medical Supply receives the order and follows up directly.",
  },
];

const captureTips = [
  {
    icon: Sun,
    title: "Use Soft, Even Lighting",
    body: "Face a window during daylight or sit in front of a soft lamp. Avoid harsh overhead light or strong backlight from a window behind you — both create shadows that confuse the landmark detector.",
  },
  {
    icon: Smartphone,
    title: "Hold the Device at Eye Level",
    body: "Position your phone or laptop at arm's length, screen centered on your face, lens at eye level. Looking up or down distorts the measurements.",
  },
  {
    icon: Glasses,
    title: "Remove Glasses & Face Coverings",
    body: "Take off eyeglasses, sunglasses, hats, masks, and headphones. They block facial landmarks and skew the measurement of your nose bridge and cheekbones.",
  },
  {
    icon: Scissors,
    title: "Pull Hair Away From Your Face",
    body: "Tuck bangs and side hair behind your ears. The detector needs a clear view of your forehead, eyebrows, and jawline.",
  },
  {
    icon: Smile,
    title: "Relax — Don't Smile or Clench",
    body: "Keep your mouth gently closed and your face in a neutral resting position, the way it would be when you sleep. Smiling shortens face height and widens the nose; clenching tightens the jawline.",
  },
  {
    icon: CheckCircle2,
    title: "Look Straight at the Camera",
    body: "Keep your head level — chin not tucked, not raised. Both ears should be roughly visible. A straight-on view is what produces the most accurate fit.",
  },
];

const faqs = [
  {
    q: "I have a beard or mustache. Will the mask still seal?",
    a: "Facial hair can interfere with the silicone seal on most masks. If possible, capture your face freshly trimmed or clean-shaven for the most accurate recommendation. There's also a question in the survey where you can tell us about facial hair so we can prefer mask styles that tolerate it better (such as full-face masks with cushioned seals).",
  },
  {
    q: "What if my measurements look wrong?",
    a: "You can retake the photo as many times as you like — nothing is uploaded. If a measurement looks off, try better lighting, remove anything covering your face, and make sure you're looking straight ahead at eye level.",
  },
  {
    q: "Does Penn Fit work on a phone, tablet, and computer?",
    a: "Yes — anything with a front-facing camera and a modern browser (Chrome, Safari, Edge, or Firefox) works. Phones tend to give the best results because it's easier to hold the camera at eye level.",
  },
  {
    q: "Is my photo stored or sent anywhere?",
    a: "No. The image is processed entirely in your browser by Google's MediaPipe library. Only the resulting numerical measurements (in millimeters) are sent to Penn Home Medical Supply's recommendation server. The photo itself is discarded the moment the measurements are extracted.",
  },
  {
    q: "What if I don't like any of the recommended masks?",
    a: "You can browse the full catalog from the header at any time, or contact Penn Home Medical Supply directly — our team can help you find alternatives based on your insurance coverage and clinical needs.",
  },
  {
    q: "Do I need a prescription to order a CPAP mask?",
    a: "Yes. CPAP masks are prescription medical devices. The order form lets you indicate that you have an existing prescription on file with Penn Home Medical Supply, or our team will reach out to coordinate getting one from your provider.",
  },
];

export function HowItWorks() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Hero */}
      <header className="text-center space-y-4">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-primary/10 text-primary text-sm font-medium">
          <HelpCircle className="w-4 h-4" />
          <span>Getting the Best Results</span>
        </div>
        <h1 className="text-4xl md:text-5xl font-bold tracking-tight">
          How Penn Fit Works
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          A short guide to using Penn Fit and getting the most accurate CPAP mask
          recommendation in just a few minutes — start to finish.
        </p>
      </header>

      {/* Step-by-step */}
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          The Six-Step Fitting Flow
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {steps.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="border-border/60">
              <CardContent className="pt-6 flex gap-4">
                <div className="shrink-0 h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {body}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Best practices */}
      <section className="space-y-4">
        <div className="space-y-1">
          <h2 className="text-2xl font-semibold tracking-tight">
            Best Practices for an Accurate Scan
          </h2>
          <p className="text-muted-foreground">
            The single biggest factor in mask-fit accuracy is the quality of your
            face capture. Follow these tips before you tap "Capture."
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          {captureTips.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="border-border/60 bg-muted/20">
              <CardContent className="pt-6 flex gap-4">
                <div className="shrink-0 h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    {body}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* Questionnaire tips */}
      <section>
        <Card className="border-border/60">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center">
                <ClipboardList className="w-5 h-5" />
              </div>
              <CardTitle className="text-xl">
                Answering the Questionnaire
              </CardTitle>
            </div>
            <CardDescription>
              A few quick tips to make sure the recommendation matches how you
              actually sleep.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm">
              <li className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span>
                  <strong>Answer for your typical night</strong>, not your ideal
                  one. If you mostly sleep on your side, pick "side sleeper" even
                  if you sometimes start on your back.
                </span>
              </li>
              <li className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span>
                  <strong>Be honest about mouth breathing.</strong> If you wake
                  up with a dry mouth or know you breathe through your mouth,
                  say so — it's the difference between a nasal mask and a
                  full-face mask.
                </span>
              </li>
              <li className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span>
                  <strong>Mention claustrophobia or skin sensitivities.</strong>{" "}
                  These factors steer Penn Fit toward minimal-contact pillow
                  styles or hypoallergenic cushion materials.
                </span>
              </li>
              <li className="flex gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                <span>
                  <strong>Note your CPAP pressure</strong> if you know it from a
                  prior titration study — higher pressures favor full-face masks
                  with stronger seals.
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>
      </section>

      {/* Privacy note */}
      <section>
        <Card className="border-border/60 bg-blue-50/50 dark:bg-blue-950/20">
          <CardContent className="pt-6 flex gap-4">
            <ShieldCheck className="w-6 h-6 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="space-y-2">
              <h3 className="font-semibold text-blue-900 dark:text-blue-200">
                A Quick Privacy Reminder
              </h3>
              <p className="text-sm text-blue-900/80 dark:text-blue-200/80 leading-relaxed">
                Your photo is processed entirely in your browser and is never
                uploaded. The only information sent to Penn Home Medical Supply
                is your numerical face measurements, your questionnaire answers,
                and — if you place an order — the contact, insurance, and
                prescription details you submit on the order form.
              </p>
              <Link
                href="/privacy"
                className="text-sm font-medium text-blue-700 dark:text-blue-300 hover:underline"
              >
                Read the full Privacy Policy →
              </Link>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* FAQ */}
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          Common Questions
        </h2>
        <div className="space-y-3">
          {faqs.map(({ q, a }) => (
            <Card key={q} className="border-border/60">
              <CardContent className="pt-6 space-y-2">
                <h3 className="font-semibold text-foreground flex gap-2">
                  <HelpCircle className="w-5 h-5 text-primary shrink-0 mt-0.5" />
                  <span>{q}</span>
                </h3>
                <p className="text-sm text-muted-foreground leading-relaxed pl-7">
                  {a}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      {/* When to call instead */}
      <section>
        <Card className="border-amber-200 dark:border-amber-900 bg-amber-50/50 dark:bg-amber-950/20">
          <CardContent className="pt-6 flex gap-4">
            <AlertTriangle className="w-6 h-6 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <h3 className="font-semibold text-amber-900 dark:text-amber-200">
                When to Call Penn Home Medical Supply Directly
              </h3>
              <p className="text-sm text-amber-900/80 dark:text-amber-200/80 leading-relaxed">
                Penn Fit is a recommendation tool — not a substitute for clinical
                advice. If you have severe pressure sores, an open facial wound,
                a recent facial injury, or you're a pediatric patient, please
                contact our team directly so a respiratory therapist can fit you
                in person.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4 pt-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          Ready to Find Your Mask?
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          The full fitting takes about 3 minutes. Your camera image never leaves
          your device.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <Link href="/consent">
            <Button size="lg" className="w-full sm:w-auto h-12 px-8 rounded-full">
              Start Fitting Process
            </Button>
          </Link>
          <Link href="/masks">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full"
            >
              Browse Mask Catalog
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
