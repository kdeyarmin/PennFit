import React, { useMemo, useState } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDocumentTitle } from "@/hooks/use-document-title";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Heart,
  Info,
  Mail,
  Moon,
  RefreshCw,
  ShieldCheck,
  Stethoscope,
  User,
} from "lucide-react";
import { submitQuizLead } from "@/lib/shop-api";

// Sleep-apnea self-screener.
//
// Implements the STOP-BANG questionnaire (Chung et al., 2008), the
// most-validated bedside screener for obstructive sleep apnea. We
// surface the score AND a strongly-worded "this is not a diagnosis"
// path back to the patient's physician — never an implicit "PennPaps
// will treat your apnea" message, which would be both clinically
// wrong (we don't diagnose) and regulatorily wrong (we're a DME
// supplier, not a sleep clinic).
//
// Risk bands per the published cutoffs:
//   0–2 = low, 3–4 = intermediate, 5–8 = high.
// Sources: stopbang.ca/osa/screening.php, Chung F. et al.,
// Anesthesiology 2008;108:812-21.

type QuestionId =
  | "snore"
  | "tired"
  | "observed"
  | "pressure"
  | "bmi"
  | "age"
  | "neck"
  | "male";

type Section = "sleep" | "health" | "about";

interface Question {
  id: QuestionId;
  /** STOP-BANG letter, shown as a small badge on the card. */
  letter: string;
  prompt: string;
  /** One-liner that disambiguates the question for laypeople. */
  helper: string;
  section: Section;
  Icon: React.ComponentType<{ className?: string }>;
}

const QUESTIONS: Question[] = [
  {
    id: "snore",
    letter: "S",
    prompt: "Do you snore loudly?",
    helper:
      "Loud enough to be heard through a closed door, or loud enough that a bed partner has elbowed you about it.",
    section: "sleep",
    Icon: Moon,
  },
  {
    id: "tired",
    letter: "T",
    prompt: "Do you often feel tired, fatigued, or sleepy during the daytime?",
    helper:
      "Falling asleep watching TV, in meetings, or while driving counts — even if you slept a 'full night.'",
    section: "sleep",
    Icon: Activity,
  },
  {
    id: "observed",
    letter: "O",
    prompt: "Has anyone observed you stop breathing or gasp during sleep?",
    helper:
      "A bed partner, family member, or sleep-study technician noticing pauses, choking, or gasping.",
    section: "sleep",
    Icon: AlertTriangle,
  },
  {
    id: "pressure",
    letter: "P",
    prompt: "Do you have, or are you being treated for, high blood pressure?",
    helper:
      "Including any prescription medication for hypertension, even if your readings are now normal.",
    section: "health",
    Icon: Heart,
  },
  {
    id: "bmi",
    letter: "B",
    prompt: "Is your BMI greater than 35 kg/m²?",
    helper:
      "Roughly: 5'4\" / 205+ lbs, 5'8\" / 230+ lbs, 5'10\" / 245+ lbs, 6'0\" / 260+ lbs.",
    section: "health",
    Icon: ClipboardList,
  },
  {
    id: "age",
    letter: "A",
    prompt: "Are you over 50 years old?",
    helper: "Sleep-apnea prevalence rises steadily with age.",
    section: "about",
    Icon: User,
  },
  {
    id: "neck",
    letter: "N",
    prompt: "Is your neck circumference greater than 16 inches (40 cm)?",
    helper:
      "Measured at the level of the Adam's apple. The collar size of a dress shirt is a fair proxy.",
    section: "about",
    Icon: User,
  },
  {
    id: "male",
    letter: "G",
    prompt: "Were you assigned male at birth?",
    helper:
      "Sleep apnea is roughly 2–3× more common in males, though it's frequently underdiagnosed in females.",
    section: "about",
    Icon: User,
  },
];

const SECTION_META: Record<
  Section,
  { eyebrow: string; title: string; caption: string }
> = {
  sleep: {
    eyebrow: "Your sleep",
    title: "Snoring, tiredness & breathing pauses",
    caption:
      "The three sleep-related signs that bed partners and patients themselves notice most often.",
  },
  health: {
    eyebrow: "Your health",
    title: "Blood pressure & body composition",
    caption:
      "Cardiovascular and weight-related risk factors that strongly track with apnea prevalence.",
  },
  about: {
    eyebrow: "About you",
    title: "Age, neck size & sex",
    caption:
      "Demographic risk factors. None of these alone means you have apnea — they sharpen the screener's accuracy.",
  },
};

type RiskBand = "low" | "intermediate" | "high";

interface RiskCopy {
  band: RiskBand;
  label: string;
  range: string;
  Icon: React.ComponentType<{ className?: string }>;
  toneClass: string;
  /** Halo class on the result card icon. */
  haloClass: string;
  headline: string;
  body: React.ReactNode;
  primaryCta: { label: string; helper: string };
}

const RISK_COPY: Record<RiskBand, RiskCopy> = {
  low: {
    band: "low",
    label: "Lower risk",
    range: "Score 0–2",
    Icon: ShieldCheck,
    toneClass: "bg-emerald-50 text-emerald-900 ring-1 ring-emerald-200",
    haloClass: "icon-halo-navy",
    headline: "Your responses suggest a lower risk on this screener.",
    body: (
      <>
        Most people who score in this range don't have moderate-to-severe sleep
        apnea — but this is a screening tool, not a diagnosis. Snoring, daytime
        fatigue, or witnessed breathing pauses still deserve a conversation at
        your next physician visit, especially if a bed partner has voiced
        concern.
      </>
    ),
    primaryCta: {
      label: "Talk to your physician at your next visit",
      helper:
        "Bring up sleep, snoring, and daytime energy — even a brief mention can prompt a referral if symptoms change.",
    },
  },
  intermediate: {
    band: "intermediate",
    label: "Intermediate risk",
    range: "Score 3–4",
    Icon: Info,
    toneClass: "bg-amber-50 text-amber-900 ring-1 ring-amber-200",
    haloClass: "icon-halo-gold",
    headline:
      "Your responses suggest a moderate risk that's worth discussing with a physician.",
    body: (
      <>
        Patients in this range often have undiagnosed obstructive sleep apnea —
        particularly when the "yes" answers cluster around snoring, observed
        breathing pauses, or daytime sleepiness. We recommend bringing these
        results to your primary care physician or directly to a sleep medicine
        provider. A formal sleep study (often a take-home test) is the only way
        to confirm or rule out apnea.
      </>
    ),
    primaryCta: {
      label: "Schedule a visit with your physician",
      helper:
        "Ask for a referral to a sleep medicine specialist or for an at-home sleep test.",
    },
  },
  high: {
    band: "high",
    label: "High risk",
    range: "Score 5–8",
    Icon: AlertTriangle,
    toneClass: "bg-rose-50 text-rose-900 ring-1 ring-rose-200",
    haloClass: "icon-halo-gold",
    headline: "Your responses suggest a high risk of obstructive sleep apnea.",
    body: (
      <>
        A score in this range is strongly associated with moderate-to-severe
        sleep apnea in the published research. Untreated, sleep apnea is linked
        to high blood pressure, cardiovascular events, type-2 diabetes
        complications, and a meaningful increase in motor-vehicle-accident risk.
        Please contact your physician promptly — both to discuss the symptoms
        above and to ask about a sleep study.
      </>
    ),
    primaryCta: {
      label: "Contact your physician promptly",
      helper:
        "Mention this screener and the specific symptoms you noted. Most providers can order an at-home sleep test the same week.",
    },
  },
};

function bandFor(score: number): RiskBand {
  if (score <= 2) return "low";
  if (score <= 4) return "intermediate";
  return "high";
}

const SECTION_ORDER: Section[] = ["sleep", "health", "about"];

export function SleepApneaQuiz() {
  useDocumentTitle(
    "Sleep Apnea Self-Screener — PennPaps",
    "An 8-question STOP-BANG screener that estimates your risk of obstructive sleep apnea and helps you decide whether to talk to a physician.",
  );

  const [answers, setAnswers] = useState<Partial<Record<QuestionId, boolean>>>(
    {},
  );

  const answeredCount = Object.keys(answers).length;
  const score = useMemo(
    () => Object.values(answers).filter((v) => v === true).length,
    [answers],
  );
  const allAnswered = answeredCount === QUESTIONS.length;
  const progressPct = Math.round((answeredCount / QUESTIONS.length) * 100);

  const setAnswer = (id: QuestionId, value: boolean) =>
    setAnswers((prev) => ({ ...prev, [id]: value }));

  const reset = () => setAnswers({});

  const result = allAnswered ? RISK_COPY[bandFor(score)] : null;

  return (
    <div className="container max-w-4xl mx-auto px-4 py-12 space-y-12 animate-shimmer-in">
      {/* Hero */}
      <header className="text-center space-y-5">
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full glass-panel text-primary text-sm font-medium shadow-sm">
            <ClipboardList className="w-4 h-4" />
            <span>Sleep Apnea Self-Screener</span>
          </div>
        </div>
        <div className="flex justify-center">
          <div className="inline-flex items-center gap-3">
            <div className="h-px w-10 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
            <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
              Learn
            </span>
            <div className="h-px w-10 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
          </div>
        </div>
        <h1 className="text-display text-4xl md:text-5xl lg:text-6xl font-bold tracking-tight text-gradient-brand leading-[1.05]">
          Do You Have Sleep Apnea?
        </h1>
        <p className="text-lg text-muted-foreground max-w-2xl mx-auto leading-relaxed">
          Answer 8 quick yes-or-no questions. The result is an estimate of your
          risk based on the validated <strong>STOP-BANG</strong> screener used
          by sleep clinics — it isn't a diagnosis. We'll help you decide whether
          to bring it up with your physician.
        </p>
      </header>

      {/* Top disclaimer — visible BEFORE the quiz, not just after. */}
      <section
        className="glass-panel rounded-2xl p-5 sm:p-6 flex gap-4"
        data-testid="quiz-disclaimer-top"
      >
        <div className="shrink-0 h-10 w-10 rounded-xl icon-halo-navy flex items-center justify-center">
          <Stethoscope className="w-5 h-5" />
        </div>
        <div className="space-y-1.5 text-sm">
          <p className="font-semibold text-primary">
            This is a screening tool, not a diagnosis.
          </p>
          <p className="text-muted-foreground leading-relaxed">
            Only a qualified physician can diagnose obstructive sleep apnea,
            typically with a take-home or in-lab sleep study. PennPaps fits and
            supplies CPAP equipment once your physician has prescribed it — we
            don't diagnose or prescribe.
          </p>
        </div>
      </section>

      {/* Progress bar — gives the user a sense of how much remains. */}
      <section
        aria-label="Quiz progress"
        className="space-y-2"
        data-testid="quiz-progress"
      >
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium text-[hsl(var(--penn-navy))]">
            {answeredCount} of {QUESTIONS.length} answered
          </span>
          <span className="text-muted-foreground tabular-nums">
            {progressPct}%
          </span>
        </div>
        <div
          className="h-2 w-full rounded-full bg-[hsl(var(--penn-navy))]/10 overflow-hidden"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-[hsl(var(--penn-navy))] to-[hsl(var(--penn-gold))] transition-[width] duration-300"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </section>

      {/* Questions, grouped by section. */}
      {SECTION_ORDER.map((section) => {
        const meta = SECTION_META[section];
        const items = QUESTIONS.filter((q) => q.section === section);
        return (
          <section
            key={section}
            className="space-y-5"
            data-testid={`quiz-section-${section}`}
          >
            <div className="space-y-1">
              <span className="text-xs font-semibold uppercase tracking-[0.28em] text-[hsl(var(--penn-gold))]">
                {meta.eyebrow}
              </span>
              <h2 className="text-display text-2xl font-bold tracking-tight text-primary">
                {meta.title}
              </h2>
              <p className="text-sm text-muted-foreground max-w-2xl leading-relaxed">
                {meta.caption}
              </p>
            </div>
            <div className="space-y-4">
              {items.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  value={answers[q.id]}
                  onChange={(v) => setAnswer(q.id, v)}
                />
              ))}
            </div>
          </section>
        );
      })}

      {/* Result */}
      <section
        aria-live="polite"
        className="space-y-4"
        data-testid="quiz-result"
      >
        {result ? (
          <ResultCard
            score={score}
            copy={result}
            // Symptom labels for the email — we send the question
            // prompts the patient answered "yes" to, so the email
            // recipient can show them to a physician verbatim.
            yesSymptoms={QUESTIONS.filter((q) => answers[q.id] === true).map(
              (q) => q.prompt,
            )}
            onReset={reset}
          />
        ) : (
          <div className="glass-card rounded-2xl p-6 sm:p-8 text-center space-y-2">
            <p className="text-sm text-muted-foreground">
              Answer all {QUESTIONS.length} questions to see your risk band and
              next-step recommendation.
            </p>
            <p className="text-xs text-muted-foreground">
              {QUESTIONS.length - answeredCount} remaining
            </p>
          </div>
        )}
      </section>

      {/* Cross-links back to learn / fitter / shop */}
      <section className="grid sm:grid-cols-2 gap-4">
        <Link
          href="/learn"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="quiz-link-learn"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-navy flex items-center justify-center">
            <BookOpen className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Read the Learn guides
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Plain-English articles on sleep apnea, CPAP basics, mask choice,
              cleaning, and what to expect on therapy.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
        <Link
          href="/consent"
          className="glass-card lift-on-hover rounded-2xl p-6 flex items-start gap-4 group"
          data-testid="quiz-link-fitter"
        >
          <div className="shrink-0 h-11 w-11 rounded-xl icon-halo-gold flex items-center justify-center">
            <CheckCircle2 className="w-5 h-5" />
          </div>
          <div className="space-y-1 flex-1">
            <h3 className="font-semibold tracking-tight group-hover:text-primary transition-colors">
              Already prescribed CPAP? Get fitted
            </h3>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Once your physician has prescribed therapy, our on-device fitter
              matches you to a comfortable mask in a few minutes.
            </p>
          </div>
          <ArrowRight className="w-5 h-5 text-muted-foreground group-hover:text-primary transition-colors mt-1" />
        </Link>
      </section>
    </div>
  );
}

interface QuestionCardProps {
  question: Question;
  value: boolean | undefined;
  onChange: (value: boolean) => void;
}

function QuestionCard({ question, value, onChange }: QuestionCardProps) {
  const { Icon, letter, prompt, helper, id } = question;
  const answered = value !== undefined;
  return (
    <article
      className={`glass-card rounded-2xl p-5 sm:p-6 transition-shadow ${
        answered ? "shadow-sm" : ""
      }`}
      data-testid={`quiz-question-${id}`}
      data-answered={answered ? "true" : "false"}
    >
      <div className="flex items-start gap-4">
        <div className="shrink-0 relative">
          <div className="h-12 w-12 rounded-xl icon-halo-navy flex items-center justify-center">
            <Icon className="w-5 h-5" />
          </div>
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-[hsl(var(--penn-gold))] text-[hsl(var(--penn-navy))] text-[10px] font-bold flex items-center justify-center shadow-sm"
          >
            {letter}
          </span>
        </div>
        <div className="flex-1 min-w-0 space-y-2">
          <p className="text-base font-semibold tracking-tight text-primary leading-snug">
            {prompt}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {helper}
          </p>
          <div
            className="flex flex-wrap gap-2 pt-2"
            role="radiogroup"
            aria-label={prompt}
          >
            <Button
              type="button"
              variant={value === true ? "default" : "outline"}
              size="sm"
              onClick={() => onChange(true)}
              className={`rounded-full px-5 ${
                value === true
                  ? "btn-primary-glow"
                  : "glass-panel border-border/60"
              }`}
              role="radio"
              aria-checked={value === true}
              data-testid={`quiz-${id}-yes`}
            >
              Yes
            </Button>
            <Button
              type="button"
              variant={value === false ? "default" : "outline"}
              size="sm"
              onClick={() => onChange(false)}
              className={`rounded-full px-5 ${
                value === false
                  ? "btn-primary-glow"
                  : "glass-panel border-border/60"
              }`}
              role="radio"
              aria-checked={value === false}
              data-testid={`quiz-${id}-no`}
            >
              No
            </Button>
          </div>
        </div>
      </div>
    </article>
  );
}

interface ResultCardProps {
  score: number;
  copy: RiskCopy;
  /**
   * Question prompts the patient answered "yes" to. Used by the
   * email-me-my-results capture so the email lists symptoms back
   * verbatim — the patient can show them to a physician without
   * having to re-derive from the score.
   */
  yesSymptoms: string[];
  onReset: () => void;
}

function ResultCard({ score, copy, yesSymptoms, onReset }: ResultCardProps) {
  const {
    Icon,
    label,
    range,
    headline,
    body,
    primaryCta,
    toneClass,
    haloClass,
  } = copy;
  return (
    <div
      className="glass-card rounded-2xl relative overflow-hidden"
      data-testid={`quiz-result-${copy.band}`}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background:
            "radial-gradient(ellipse 60% 80% at 100% 0%, hsl(var(--penn-gold) / 0.14), transparent 60%)",
        }}
        aria-hidden="true"
      />
      <div className="p-6 sm:p-8 relative space-y-5">
        <div className="flex items-start gap-4">
          <div
            className={`shrink-0 h-12 w-12 rounded-xl ${haloClass} flex items-center justify-center`}
          >
            <Icon className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold ${toneClass}`}
              >
                {label}
              </span>
              <span className="text-xs text-muted-foreground tabular-nums">
                {range} • Your score: <strong>{score}/8</strong>
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-primary leading-snug">
              {headline}
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {body}
            </p>
          </div>
        </div>

        {/* Always-on physician CTA. Even at "low" risk we direct to a
            physician conversation — never to PennPaps as if we were
            a diagnostic path. */}
        <div className="rounded-xl bg-[hsl(var(--penn-navy))]/[0.04] ring-1 ring-[hsl(var(--penn-navy))]/10 p-4 sm:p-5 space-y-1.5">
          <p className="text-sm font-semibold text-primary flex items-center gap-2">
            <Stethoscope className="w-4 h-4" />
            Recommended next step
          </p>
          <p className="text-sm text-[hsl(var(--penn-navy))]/90 leading-relaxed">
            <strong>{primaryCta.label}.</strong> {primaryCta.helper}
          </p>
        </div>

        {/* What to bring — short, actionable, encouraging. */}
        <div className="rounded-xl glass-panel p-4 sm:p-5 space-y-3">
          <p className="text-sm font-semibold text-primary">
            What to bring up at that visit
          </p>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))] mt-0.5 shrink-0" />
              <span>
                Your STOP-BANG score (<strong>{score}/8</strong>) and which
                specific symptoms you answered "yes" to.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))] mt-0.5 shrink-0" />
              <span>
                Anything a bed partner has noticed — snoring, gasping, pauses,
                restless sleep.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))] mt-0.5 shrink-0" />
              <span>
                A request to discuss <strong>at-home sleep testing</strong> —
                most insurers cover it and it's far less involved than a lab
                study.
              </span>
            </li>
            <li className="flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))] mt-0.5 shrink-0" />
              <span>
                Any history of high blood pressure, type-2 diabetes, atrial
                fibrillation, or recent unexplained weight gain — all relevant
                to apnea risk.
              </span>
            </li>
          </ul>
        </div>

        {/* Optional email capture — patients can email themselves the
            results so they have it in writing to share with a physician.
            Transactional under CAN-SPAM (they're asking for the document),
            so no marketing opt-in checkbox required. */}
        <EmailMyResultsBlock
          score={score}
          band={copy.band}
          yesSymptoms={yesSymptoms}
        />

        <div className="flex flex-col sm:flex-row gap-3 pt-1">
          <Link href="/learn" className="sm:flex-1">
            <Button
              variant="outline"
              size="lg"
              className="w-full h-11 rounded-full glass-panel border-border/60 gap-2"
              data-testid="quiz-result-learn-cta"
            >
              <BookOpen className="w-4 h-4" />
              Read more about sleep apnea
            </Button>
          </Link>
          <Button
            variant="ghost"
            size="lg"
            className="sm:w-auto h-11 rounded-full gap-2"
            onClick={onReset}
            data-testid="quiz-result-reset"
          >
            <RefreshCw className="w-4 h-4" />
            Start over
          </Button>
        </div>
      </div>
    </div>
  );
}

// Lightweight email-shape guard. The server runs canonical validation;
// this guard just stops the patient from typing nonsense and hitting
// Send with an obvious typo.
const QUIZ_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface EmailMyResultsBlockProps {
  score: number;
  band: RiskBand;
  yesSymptoms: string[];
}

function EmailMyResultsBlock({
  score,
  band,
  yesSymptoms,
}: EmailMyResultsBlockProps) {
  const [email, setEmail] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "error">("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const trimmed = email.trim();
  const valid = QUIZ_EMAIL_RE.test(trimmed);
  const canSend = valid && !sending && status !== "sent";

  async function handleSend() {
    if (!canSend) return;
    setSending(true);
    setErrMsg(null);
    try {
      await submitQuizLead({
        email: trimmed.toLowerCase(),
        score,
        band,
        symptoms: yesSymptoms,
        website: "",
      });
      setStatus("sent");
    } catch (err) {
      setStatus("error");
      setErrMsg(
        err instanceof Error && err.message === "rate_limited"
          ? "We just sent one already — please try again in a few minutes."
          : "Something went wrong. Please try again in a moment.",
      );
    } finally {
      setSending(false);
    }
  }

  if (status === "sent") {
    return (
      <div
        className="rounded-xl glass-panel p-4 sm:p-5 space-y-1"
        data-testid="quiz-email-sent"
      >
        <p className="text-sm font-semibold text-primary flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[hsl(var(--penn-gold))]" />
          Sent — check your inbox
        </p>
        <p className="text-sm text-muted-foreground">
          Your STOP-BANG result is on its way. It may take a minute to land.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl glass-panel p-4 sm:p-5 space-y-3">
      <div className="space-y-1">
        <p className="text-sm font-semibold text-primary flex items-center gap-2">
          <Mail className="w-4 h-4" />
          Email me my results
        </p>
        <p className="text-xs text-muted-foreground">
          We&apos;ll email you a one-page summary you can forward to your
          physician. No marketing — just the result.
        </p>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleSend();
        }}
      >
        <div className="flex flex-col sm:flex-row gap-2">
          <Input
            type="email"
            inputMode="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={email.length > 0 && !valid}
            data-testid="quiz-email-input"
            className="sm:flex-1"
          />
          <Button
            type="submit"
            disabled={!canSend}
            size="lg"
            className="rounded-full sm:w-auto"
            data-testid="quiz-email-submit"
          >
            {sending ? "Sending…" : "Send"}
          </Button>
        </div>
      </form>
      {status === "error" && errMsg && (
        <p
          className="text-xs text-destructive"
          data-testid="quiz-email-error"
          role="alert"
        >
          {errMsg}
        </p>
      )}
    </div>
  );
}
