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
    body: "Use your device's front-facing camera to take a clear, well-lit photo of your face. PennPaps will guide you through framing.",
  },
  {
    icon: Ruler,
    title: "3. Generate Measurements",
    body: "PennPaps's on-device facial landmark engine derives numerical measurements (such as nose width and face height in millimeters) from the captured image, then immediately discards the image.",
  },
  {
    icon: ClipboardList,
    title: "4. Answer Quick Questions",
    body: "Tell us about your sleep position, breathing habits, facial hair, and any sensitivities so we can refine the match.",
  },
  {
    icon: Sparkles,
    title: "5. See Your Recommendations",
    body: "PennPaps ranks masks from our catalog using your measurements and questionnaire — with a clear explanation of why each one fits.",
  },
  {
    icon: PackageCheck,
    title: "6. Place Your Order",
    body: "Pick a mask, fill in your shipping, insurance, and prescription details, and submit. PennPaps receives the order and follows up directly.",
  },
];

const captureTips = [
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
    q: "Does PennPaps work on a phone, tablet, and computer?",
    a: "Yes — anything with a front-facing camera and a modern browser (Chrome, Safari, Edge, or Firefox) works. Phones tend to give the best results because it's easier to hold the camera at eye level.",
  },
  {
    q: "Is my photo stored or sent anywhere?",
    a: "No. The image is processed entirely in your browser by Google's MediaPipe library. Only the resulting numerical measurements (in millimeters) are sent to PennPaps's recommendation server. The photo itself is discarded the moment the measurements are extracted.",
  },
  {
    q: "What if I don't like any of the recommended masks?",
    a: "You can browse the full catalog from the header at any time, or contact PennPaps directly — our team can help you find alternatives based on your insurance coverage and clinical needs.",
  },
  {
    q: "Do I need a prescription to order a CPAP mask?",
    a: "Yes. CPAP masks are prescription medical devices. The order form lets you indicate that you have an existing prescription on file with PennPaps, or our team will reach out to coordinate getting one from your provider.",
  },
];

export function HowItWorks() {
  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-14 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <HelpCircle className="w-4 h-4" />
            <span>Getting the Best Results</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Virtual Mask Fitter
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Virtual Mask Fitter
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          A short guide to everything PennPaps does — the on-device mask fitter,
          the supply shop, customer accounts, and how resupply works.
        </p>
      </header>

      {/* Tutorial video */}
      <section className="space-y-4">
        <div className="space-y-1 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            Watch the 30-Second Tutorial
          </h2>
          <p className="text-muted-foreground">
            A quick visual walkthrough of the entire PennPaps experience.
          </p>
        </div>
        {/* Aspect ratio is portrait on phones (where the tutorial scenes
            stack vertically and need room to breathe) and 16:9 from sm+
            up where the scenes lay out side-by-side. */}
        <div className="relative w-full overflow-hidden rounded-2xl border border-border/60 shadow-lg bg-black aspect-[3/5] sm:aspect-video">
          <iframe
            src="/penn-fit-tutorial/"
            title="PennPaps — How To Use"
            className="absolute inset-0 w-full h-full"
            sandbox="allow-scripts allow-same-origin"
            allow="autoplay; fullscreen"
            loading="lazy"
          />
        </div>
      </section>

      {/* Step-by-step */}
      <section className="space-y-4">
        <h2 className="text-2xl font-semibold tracking-tight">
          The Six-Step Fitting Flow
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {steps.map(({ icon: Icon, title, body }) => (
            <Card key={title} className="border-0 glass-card lift-on-hover rounded-2xl">
              <CardContent className="pt-6 flex gap-4">
                <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold tracking-tight">{title}</h3>
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
            <Card key={title} className="border-0 glass-card lift-on-hover rounded-2xl">
              <CardContent className="pt-6 flex gap-4">
                <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
                  <Icon className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="font-semibold tracking-tight">{title}</h3>
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
        <Card className="border-0 glass-card rounded-2xl">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
                <ClipboardList className="w-5 h-5" />
              </div>
              <CardTitle className="text-xl tracking-tight">
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
                  These factors steer PennPaps toward minimal-contact pillow
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
        <Card className="border-0 glass-card rounded-2xl relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 0% 0%, hsl(var(--penn-navy) / 0.10), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <CardContent className="pt-6 flex gap-4 relative">
            <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div className="space-y-2">
              <h3 className="font-semibold tracking-tight text-primary">
                A Quick Privacy Reminder
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Your photo is processed entirely in your browser and is never
                uploaded. The only information sent to PennPaps
                is your numerical face measurements, your questionnaire answers,
                and — if you place an order — the contact, insurance, and
                prescription details you submit on the order form.
              </p>
              <Link
                href="/privacy"
                className="text-sm font-medium text-primary hover:underline"
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
            <Card key={q} className="border-0 glass-card lift-on-hover rounded-2xl">
              <CardContent className="pt-6 space-y-2">
                <h3 className="font-semibold text-foreground flex gap-2 tracking-tight">
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
        <Card className="border-0 glass-card rounded-2xl relative overflow-hidden">
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              background:
                "radial-gradient(ellipse 60% 80% at 100% 0%, hsl(var(--penn-gold) / 0.18), transparent 60%)",
            }}
            aria-hidden="true"
          />
          <CardContent className="pt-6 flex gap-4 relative">
            <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" />
            </div>
            <div className="space-y-1">
              <h3 className="font-semibold tracking-tight text-foreground">
                When to Call PennPaps Directly
              </h3>
              <p className="text-sm text-muted-foreground leading-relaxed">
                Our online fitter and shop are convenient, but they're not a
                substitute for clinical advice. If you have severe pressure
                sores, an open facial wound, a recent facial injury, or you're
                a pediatric patient, please contact our team directly so a
                respiratory therapist can fit you in person.
              </p>
            </div>
          </CardContent>
        </Card>
      </section>

      {/* CTA */}
      <section className="text-center space-y-4 pt-4">
        <h2 className="text-display text-3xl md:text-4xl font-bold tracking-tight text-gradient-brand">
          Ready to get started?
        </h2>
        <p className="text-muted-foreground max-w-xl mx-auto">
          New mask? The fitter takes about 3 minutes and your camera image
          never leaves your device. Already know what you need? Skip straight
          to the shop.
        </p>
        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <Link href="/consent">
            <Button size="lg" className="w-full sm:w-auto h-12 px-8 rounded-full btn-primary-glow">
              Get fitted for a mask
            </Button>
          </Link>
          <Link href="/shop">
            <Button
              size="lg"
              variant="outline"
              className="w-full sm:w-auto h-12 px-8 rounded-full glass-panel border-border/60"
            >
              Shop CPAP supplies
            </Button>
          </Link>
        </div>
      </section>
    </div>
  );
}
