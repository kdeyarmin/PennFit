import React from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowRight,
  X,
  Check,
  Sparkles,
  Brain,
  Heart,
  Moon,
} from "lucide-react";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { ShareArticle } from "@/components/share-article";

type Myth = {
  myth: string;
  reality: string;
};

const myths: Myth[] = [
  {
    myth: "Only overweight men get sleep apnea.",
    reality:
      "Roughly 40% of patients with OSA are women, especially post-menopause. Thin patients can have it too — anatomical risk factors (narrow airway, recessed jaw, large tonsils) drive a meaningful fraction of cases. The 'BMI cutoff' myth is one of the main reasons women are diagnosed years later than men on average.",
  },
  {
    myth: "CPAP is a permanent dependency — once you're on it, you can never stop.",
    reality:
      "Your airway doesn't become dependent on pressure. CPAP treats sleep apnea while you're using it; stop and the original apnea returns — that's the disease, not the device. (Weight loss, oral appliances, or anatomical surgery can reduce underlying severity for some patients.)",
  },
  {
    myth: "Snoring is harmless. It's just annoying.",
    reality:
      "Loud, habitual snoring is the single most reliable predictor of obstructive sleep apnea. Roughly 60-70% of people who snore loudly every night meet criteria for OSA on a sleep study. Snoring without apnea exists, but it shouldn't be assumed without testing.",
  },
  {
    myth: "The mask is unbearable. Nobody actually sleeps with one.",
    reality:
      "Adherence in modern cohorts is roughly 65-75% at one year — comparable to or better than most chronic medications. The biggest predictor of who stays on therapy is mask fit, not willpower. A wearable mask is a solved problem; most quitters had the wrong mask for their face.",
  },
  {
    myth: "If your AHI is borderline, you don't really need treatment.",
    reality:
      "Even mild OSA (AHI 5-15) is associated with elevated cardiovascular risk in patients with hypertension, diabetes, or daytime sleepiness. The decision to treat isn't a pure AHI threshold — it's a function of severity, symptoms, and comorbidities. Discuss with a sleep specialist; don't dismiss a borderline result.",
  },
  {
    myth: "CPAP delivers oxygen, like a hospital cannula.",
    reality:
      "CPAP delivers room air, pressurized. It's a pneumatic splint that keeps your airway open — not oxygen therapy. (Oxygen concentrators are separate devices and can be combined with CPAP only under physician direction.)",
  },
  {
    myth: "You can just buy a CPAP online without a prescription.",
    reality:
      "In the US, CPAP is a Class II prescription medical device. Legitimate sellers — including online — require a current prescription on file. Online marketplaces that don't ask are either selling used machines or operating outside regulation; pressure settings on second-hand units can be wrong for your prescription.",
  },
  {
    myth: "Cleaning machines (ozone or UV) keep your equipment safer.",
    reality:
      "The FDA issued a 2020 public health notification specifically about ozone-based CPAP cleaners and respiratory injury risk. UV cleaners haven't shown meaningful efficacy beyond what soap and water achieve. The honest cleaning routine is a daily wipe and a weekly soap-and-water wash — that's it.",
  },
  {
    myth: "CPAP causes weight gain.",
    reality:
      "The opposite is more commonly observed. Patients with untreated OSA have dysregulated hunger hormones (leptin, ghrelin) that make weight loss difficult. Effective therapy often restores those signals — and most patients find exercise tolerance increases too. A small fraction notice mild weight gain in the first quarter, usually attributed to better appetite signaling that had previously been suppressed.",
  },
  {
    myth: "You'll set off airport security or get held up at TSA.",
    reality:
      "CPAP is a medical device. It doesn't count toward your carry-on limit, you don't need a doctor's note, and TSA agents see hundreds per day. Take it out of the case in its own bin (like a laptop) and you're through in 60 seconds.",
  },
];

export function LearnMythsDebunked() {
  useDocumentTitle(
    "10 CPAP and sleep apnea myths, debunked",
    "The ten things people get wrong about CPAP therapy and sleep apnea — and the honest answer to each. Backed by the data, not the forums.",
  );
  const [, navigate] = useLocation();

  return (
    <div className="relative z-10 flex flex-col items-center max-w-4xl mx-auto w-full px-4 py-8 md:py-14">
      {/* Breadcrumb */}
      <div className="w-full mb-6 text-sm text-muted-foreground">
        <Link href="/learn" className="hover:text-primary transition-colors">
          Learn
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground/85">Myths debunked</span>
      </div>

      {/* Header */}
      <header className="w-full mb-10">
        <div className="inline-flex items-center gap-3 mb-4">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Common concerns · 6 min read
          </span>
        </div>
        <h1 className="text-display text-4xl md:text-5xl font-bold tracking-tight mb-5 leading-[1.08] text-gradient-brand">
          Ten things people get wrong.
        </h1>
        <p className="text-lg text-muted-foreground leading-relaxed">
          The internet has a lot of confidently-stated CPAP advice that isn&apos;t
          quite right — and a few myths that prevent people from getting
          tested for years. Here are the ten we hear most often, and what
          the honest answer is.
        </p>
      </header>

      {/* Myths grid */}
      <section className="w-full mb-12 space-y-4">
        {myths.map((m, i) => (
          <article
            key={m.myth}
            className={
              i === 0
                ? "glass-card-tech rounded-2xl p-6 md:p-7 relative overflow-hidden"
                : "glass-card rounded-2xl p-6 md:p-7"
            }
          >
            {i === 0 && <span className="scan-line" aria-hidden="true" />}
            <div className="relative z-10">
              <div className="flex items-baseline gap-3 mb-3">
                <span className="text-[10px] font-mono uppercase tracking-[0.22em] text-[hsl(var(--penn-gold-deep))] shrink-0">
                  Myth 0{i + 1}
                </span>
              </div>
              <div className="grid gap-4">
                <div className="flex items-start gap-3 p-4 rounded-xl bg-[hsl(var(--penn-mist))]/40 border border-border/40">
                  <div className="shrink-0 h-7 w-7 rounded-lg bg-muted/60 flex items-center justify-center">
                    <X
                      className="w-4 h-4 text-muted-foreground"
                      strokeWidth={2.5}
                    />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      The claim
                    </div>
                    <p className="text-base font-semibold tracking-tight text-foreground/85 leading-snug line-through decoration-muted-foreground/40">
                      {m.myth}
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-4 rounded-xl bg-[hsl(var(--penn-gold-soft))]/30 border-l-4 border-[hsl(var(--penn-gold))]">
                  <div className="shrink-0 h-7 w-7 rounded-lg bg-[hsl(var(--penn-gold))]/20 flex items-center justify-center">
                    <Check
                      className="w-4 h-4 text-[hsl(var(--penn-gold-deep))]"
                      strokeWidth={2.5}
                    />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-[hsl(var(--penn-gold-deep))] mb-1">
                      The reality
                    </div>
                    <p className="text-sm text-foreground/85 leading-relaxed">
                      {m.reality}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </article>
        ))}
      </section>

      {/* Closing reframe */}
      <section className="w-full mb-12">
        <div className="glass-card-tech rounded-2xl p-7 md:p-9 relative overflow-hidden">
          <span className="scan-line" aria-hidden="true" />
          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-4">
              <div className="relative h-10 w-10 rounded-xl flex items-center justify-center shrink-0 icon-halo-gold">
                <Sparkles className="w-5 h-5" strokeWidth={2} />
              </div>
              <h2 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground/90">
                The honest summary.
              </h2>
            </div>
            <p className="text-muted-foreground leading-relaxed">
              Most of these myths persist because the truth is slightly more
              nuanced than a Reddit one-liner. Sleep apnea is more common
              and more dangerous than most people think; the therapy is
              more tolerable and more effective than most people assume.
              The single biggest gap is between knowing you should get
              tested and actually doing it.
            </p>
          </div>
        </div>
      </section>

      {/* Share */}
      <div className="w-full mb-10">
        <ShareArticle
          path="/learn/myths-debunked"
          title="10 things people get wrong about CPAP and sleep apnea"
          blurb="If someone you know is dismissing the idea of getting tested or starting CPAP, this might be the article that flips it. Ten of the most common excuses, with the honest counter."
          testIdPrefix="share-myths"
        />
      </div>

      {/* Cross-links */}
      <div className="w-full grid md:grid-cols-3 gap-4 mb-10">
        <Link
          href="/learn/sleep-apnea-quiz"
          className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col group"
        >
          <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center mb-3">
            <Brain className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
            Self-screener
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            STOP-BANG — 8 questions, 2 minutes.
          </p>
        </Link>
        <Link
          href="/learn/health-risks"
          className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col group"
        >
          <div className="h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center mb-3">
            <Heart className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
            Health risks
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Cardio, metabolic, cognitive risks of leaving it untreated.
          </p>
        </Link>
        <Link
          href="/learn/pap-therapy-benefits"
          className="glass-card lift-on-hover rounded-2xl p-6 flex flex-col group"
        >
          <div className="h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center mb-3">
            <Moon className="w-5 h-5" />
          </div>
          <h3 className="font-semibold tracking-tight mb-1 group-hover:text-primary transition-colors">
            What treatment feels like
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            The benefits, on a real week-by-week timeline.
          </p>
        </Link>
      </div>

      <div className="w-full text-center">
        <Badge
          variant="outline"
          className="mb-4 chip-tier-premium border-0 font-medium"
        >
          <Sparkles className="w-3 h-3 mr-1.5" /> The next step
        </Badge>
        <Button
          size="lg"
          className="h-12 px-7 rounded-full btn-primary-glow group"
          onClick={() => navigate("/consent")}
          data-testid="myths-cta-fit"
        >
          Start the mask fitter
          <ArrowRight className="w-4 h-4 ml-1.5 transition-transform group-hover:translate-x-0.5" />
        </Button>
      </div>

      <p className="text-xs text-muted-foreground/80 leading-relaxed mt-12 max-w-2xl mx-auto text-center">
        Educational content only — not medical advice or a diagnosis.
      </p>
    </div>
  );
}
