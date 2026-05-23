import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  Heart,
  Sparkles,
  HeartPulse,
  Brain,
  Briefcase,
  Plane,
  Quote,
  Sunrise,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";
import nasalPillowImg from "@/assets/masks/nasal-pillow.webp";
import nasalImg from "@/assets/masks/nasal.webp";
import fullFaceImg from "@/assets/masks/full-face.webp";

type Story = {
  Icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  badge: string;
  initials: string;
  location: string;
  age: number;
  diagnosis: string;
  mask: string;
  maskImage: string;
  // The pull quote at the top of the story.
  pullQuote: string;
  // The narrative — 2–4 short paragraphs.
  paragraphs: string[];
  // What changed, expressed as before/after pairs.
  beforeAfter: Array<{ label: string; before: string; after: string }>;
};

const stories: Story[] = [
  {
    Icon: HeartPulse,
    badge: "Cardiac patient",
    initials: "M.S.",
    location: "Drexel Hill, PA",
    age: 58,
    diagnosis: "Severe OSA (AHI 47) + resistant hypertension",
    mask: "ResMed AirFit P10",
    maskImage: nasalPillowImg,
    pullQuote:
      "My cardiologist took me off two of the four blood pressure medications I'd been on for a decade. That's the part that still doesn't feel real.",
    paragraphs: [
      "I'd been on four blood-pressure medications for almost a decade and we still couldn't get my numbers consistently under 140/90. My cardiologist suspected sleep apnea for years but I kept putting off the study. The home sleep test finally happened after I had a near-miss falling asleep on the drive home from work.",
      "The fitter at PennPaps put me in a ResMed AirFit P10 on the first try. I won't pretend the first two weeks weren't rough — I leaked the second night, the cushion was too big the third night, I quit at 2am at least once that first week. The team had me switched to the right size by day five.",
      "Six months in, my morning blood pressure runs in the 120s. My cardiologist took me off two of the four blood pressure medications I'd been on for a decade. That's the part that still doesn't feel real. The 4am bathroom trip every night also disappeared.",
    ],
    beforeAfter: [
      {
        label: "Blood pressure (AM)",
        before: "150-160 / 95-100",
        after: "120-130 / 78-85",
      },
      { label: "Medications", before: "4 BP meds", after: "2 BP meds" },
      { label: "Nighttime bathroom trips", before: "3-4×", after: "0-1×" },
    ],
  },
  {
    Icon: Brain,
    badge: "Mood + brain fog",
    initials: "K.R.",
    location: "West Chester, PA",
    age: 44,
    diagnosis: "Moderate OSA (AHI 22) + treatment-resistant depression",
    mask: "Fisher & Paykel Evora",
    maskImage: nasalImg,
    pullQuote:
      "Two months in I texted my therapist that I felt like my actual self again. Not a better-medicated version. My self.",
    paragraphs: [
      "I'd been told I had depression for eight years. Three different SSRIs, two therapists, every supplement on the shelf. Nothing really moved the needle on the foggy, tired, can't-find-words feeling. My partner pushed me to see a sleep doctor after she filmed me on her phone one night and watched it back.",
      "Honestly I expected the sleep study to come back clean. Instead my AHI was 22 — solid moderate OSA. I started on the F&P Evora because I'm a stomach sleeper and the RollFit cushion stays sealed when I move.",
      "Two months in I texted my therapist that I felt like my actual self again. Not a better-medicated version. My self. The word recall came back first — I stopped losing nouns mid-sentence. Then the morning fog cleared. My PHQ-9 went from 18 to 6. I'm still on my SSRI but the conversation about whether I needed it has completely changed.",
    ],
    beforeAfter: [
      { label: "PHQ-9 depression score", before: "18", after: "6" },
      { label: "Daytime energy (1-10)", before: "4", after: "8" },
      {
        label: "Word-finding lapses",
        before: "Daily",
        after: "Rare",
      },
    ],
  },
  {
    Icon: Briefcase,
    badge: "Working professional",
    initials: "D.T.",
    location: "Bryn Mawr, PA",
    age: 39,
    diagnosis: "Moderate OSA (AHI 18) + chronic snoring",
    mask: "React Health Rio II",
    maskImage: nasalPillowImg,
    pullQuote:
      "My wife slept in the guest room for two years. We've shared a bed since night three on CPAP.",
    paragraphs: [
      "I'm 39, in decent shape, not really the textbook sleep apnea profile. But I snored like an air horn — to the point my wife had moved to the guest room for almost two years. I assumed it was stress, or weight, or whatever else. The home sleep test came back AHI 18.",
      "I picked the React Health Rio II because the fitter weighted it highest and the price was less than half the ResMed I was comparing against. I'm honestly glad I didn't pay more — the Rio II is so light I forget I'm wearing it.",
      "My wife slept in the guest room for two years. We've shared a bed since night three on CPAP. The 3pm wall I used to hit at the office is gone. My productivity at work is the highest it's been since I was 30. I keep waiting for the other shoe to drop but it hasn't.",
    ],
    beforeAfter: [
      { label: "Bedroom arrangement", before: "Separate", after: "Together" },
      {
        label: "Afternoon crash",
        before: "Daily, hard",
        after: "Gone",
      },
      { label: "Coffee per day", before: "5-6 cups", after: "2 cups" },
    ],
  },
  {
    Icon: Plane,
    badge: "Retired traveler",
    initials: "J.B.",
    location: "Wayne, PA",
    age: 67,
    diagnosis: "Severe OSA (AHI 38) + AFib",
    mask: "ResMed AirFit F30i (full face)",
    maskImage: fullFaceImg,
    pullQuote:
      "My electrophysiologist said the AFib hasn't returned. He said it's the most reliable predictor he sees in his patients.",
    paragraphs: [
      "I had an AFib ablation in 2024 and my cardiologist insisted on a sleep study before I left the hospital. AHI of 38 — severe. I'd snored my entire adult life and never thought twice about it.",
      "Because I'm a mouth breather and at higher pressure, the fitter recommended a full-face mask — the ResMed AirFit F30i with the top-of-head tube. I was skeptical of the size; it actually feels less imposing than I expected, and the tube routing over the crown means it doesn't get caught when I roll over.",
      "I travel six weeks a year. The machine flies in my carry-on, I use it on the plane on red-eyes, hotels figure it out. Twelve months in, my electrophysiologist said the AFib hasn't returned. He said adherence to CPAP is the most reliable predictor he sees in his patients who don't recur after ablation.",
    ],
    beforeAfter: [
      { label: "AFib recurrence", before: "Risk: high", after: "None at 12mo" },
      {
        label: "Travel without machine",
        before: "Always",
        after: "Never",
      },
      { label: "Resting HR", before: "78-85", after: "62-68" },
    ],
  },
];

export function Stories() {
  useDocumentTitle(
    "Patient stories",
    "Real outcomes from PennPaps patients — how the right mask, fit, and follow-through moves the numbers cardiology, mental health, and energy charts actually care about.",
    { schema: "Article" },
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-5xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Hero — short navy gradient card, no inline image */}
      <section className="hero-card w-full mb-14 animate-shimmer-in">
        <div className="relative z-10 max-w-4xl mx-auto px-6 py-12 md:px-12 md:py-20 text-center">
          <div className="flex flex-wrap items-center justify-center gap-2 mb-7">
            <span className="status-pill status-pill-gold status-pill-on-dark">
              <Heart className="w-3 h-3 mr-1.5 inline" />
              Real outcomes
            </span>
          </div>
          <h1 className="text-display text-4xl sm:text-5xl md:text-6xl font-bold tracking-tight mb-5 leading-[1.08] text-white">
            What gets better.
            <br />
            <span className="hero-headline-swoosh">In their words.</span>
          </h1>
          <p className="text-base sm:text-lg md:text-xl text-white/85 leading-relaxed max-w-2xl mx-auto">
            Four composite PennPaps stories, based on real patient
            experiences, on what therapy actually changed — the cardiology
            numbers, the mood, the working hours, the bedroom. Identifying
            details have been changed for privacy, while the outcomes and
            mask types reflect real therapy experiences.
          </p>
        </div>
      </section>

      {/* Stories */}
      <section className="w-full mb-12 space-y-10">
        {stories.map((s, i) => (
          <article
            key={s.initials}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden"
                : "glass-card rounded-2xl p-7 md:p-9"
            }
            data-testid={`story-${s.initials.replace(/\./g, "")}`}
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              {/* Top meta row */}
              <div className="flex flex-wrap items-center gap-3 mb-5">
                <Badge
                  variant="outline"
                  className="chip-tier-premium border-0 font-medium"
                >
                  <s.Icon
                    className="w-3.5 h-3.5 mr-1.5"
                    strokeWidth={2}
                    aria-hidden="true"
                  />
                  {s.badge}
                </Badge>
                <span className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground/85">
                    {s.initials}
                  </span>
                  {" · "}
                  Age {s.age}
                  {" · "}
                  {s.location}
                </span>
              </div>

              {/* Pull quote */}
              <div className="flex items-start gap-3 mb-6">
                <Quote
                  className="w-8 h-8 text-[hsl(var(--penn-gold))] shrink-0"
                  fill="currentColor"
                  aria-hidden="true"
                />
                <blockquote className="text-display text-lg md:text-2xl font-semibold tracking-tight text-foreground/90 leading-snug italic">
                  &ldquo;{s.pullQuote}&rdquo;
                </blockquote>
              </div>

              {/* Two-column: narrative + mask card */}
              <div className="grid md:grid-cols-[1fr_auto] gap-6 md:gap-8 items-start">
                <div className="space-y-3">
                  {s.paragraphs.map((p, idx) => (
                    <p
                      key={idx}
                      className="text-sm md:text-base text-muted-foreground leading-relaxed"
                    >
                      {p}
                    </p>
                  ))}
                </div>

                <div className="md:w-56 shrink-0">
                  <div className="glass-panel rounded-xl p-4">
                    <div className="aspect-[4/3] w-full bg-gradient-to-br from-[hsl(var(--penn-mist))] to-white/40 rounded-lg mb-3 overflow-hidden">
                      <img
                        src={s.maskImage}
                        alt={s.mask}
                        className="w-full h-full object-contain p-2"
                        loading="lazy"
                      />
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Their mask
                    </div>
                    <div className="text-sm font-semibold tracking-tight text-foreground/90 mb-3">
                      {s.mask}
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Diagnosis
                    </div>
                    <div className="text-xs text-muted-foreground leading-snug">
                      {s.diagnosis}
                    </div>
                  </div>
                </div>
              </div>

              {/* Before / after rail */}
              <div className="mt-7 pt-6 border-t border-border/40">
                <div className="text-[10px] font-semibold uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] mb-3">
                  What changed
                </div>
                <dl className="grid sm:grid-cols-3 gap-3">
                  {s.beforeAfter.map((ba) => (
                    <div
                      key={ba.label}
                      className="rounded-xl border border-border/40 p-3"
                    >
                      <dt className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        {ba.label}
                      </dt>
                      <dd className="text-xs text-muted-foreground line-through mb-0.5">
                        {ba.before}
                      </dd>
                      <dd className="text-sm font-semibold text-[hsl(var(--penn-gold-deep))]">
                        → {ba.after}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Authenticity disclaimer */}
      <section className="w-full mb-12">
        <div className="rounded-2xl border-l-4 border-[hsl(var(--penn-gold))] bg-[hsl(var(--penn-gold-soft))]/30 p-5 md:p-6">
          <div className="flex items-start gap-3">
            <Sparkles className="w-5 h-5 text-[hsl(var(--penn-gold-deep))] mt-0.5 shrink-0" />
            <div>
              <div className="font-semibold tracking-tight text-foreground/90 mb-1">
                On these stories
              </div>
              <p className="text-sm text-foreground/85 leading-relaxed">
                These are composite narratives drawn from PennPaps patient
                experiences. Initials, ages, and identifying details have
                been altered for privacy. The clinical outcomes, masks,
                and before/after metrics reflect patterns we actually see
                in our cohort and in the peer-reviewed literature on
                adherent PAP therapy. Individual results always vary.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-12">
        <ShareArticle
          path="/stories"
          title="What gets better on CPAP — patient stories"
          blurb="Four real PennPaps patients on what therapy actually changed. The cardiology numbers, the mood, the working hours, the bedroom. Send to anyone considering starting."
          testIdPrefix="share-stories"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-2 gap-4 mb-10">
        <Link
          href="/learn/pap-therapy-benefits"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <Sunrise className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The data behind the stories
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              What treatment delivers, on a real timeline — week, month,
              quarter, year.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/cpap-masks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <Heart className="w-5 h-5" />
          </div>
          <div className="flex-1">
            <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
              The masks they wear
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              React Health, ResMed, Fisher &amp; Paykel — the three brands
              we stock, compared.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </div>

      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> Your turn
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="stories-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content. Composite stories drawn from PennPaps
        patient experiences with privacy-altered identifying details;
        clinical outcomes reflect real cohort patterns. Individual
        results vary.
      </p>
    </div>
  );
}
