// Renders the output of the clinical fitting assessment
// (POST /api/fit/assess), which is a different thing from the legacy
// ranked list and is rendered differently on purpose.
//
// Three things the legacy card has no room for, and all three matter:
//
//   * A SIZE. The engine matches millimetre bands per size variant, so it
//     recommends "AirFit F30i, Medium cushion", not just a model. That
//     size travels through to the order.
//   * WHY each alternative ranked lower. The spec asks for at least two
//     alternatives each carrying the reason it lost — that is what makes
//     the recommendation reviewable instead of oracular.
//   * PROVENANCE. Formulary name and version, rules-engine version, and
//     whether the answer was produced in degraded mode. A recommendation
//     nobody can trace is a recommendation nobody can defend.
//
// The withheld states live in `FitWithheld` below: when the engine
// declines to name a mask, showing a best guess anyway would undo the
// entire point of confidence gating.

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Info,
  PhoneCall,
  RefreshCcw,
  ShieldAlert,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useCompanyContact } from "@/lib/contact";
import { getMaskImage, formatMaskType } from "@/lib/mask-images";
import type { FitAssessment, FitCandidate } from "@/lib/fit-assess-api";

/**
 * The optional "buy without insurance" CTA for one candidate. Shaped
 * like the legacy results card's `cashPay` so both engines offer the
 * same thing — before this existed, turning `fitter.clinical_assessment`
 * on silently took the cash-pay button away from every patient.
 */
export interface ClinicalCashPay {
  priceLabel: string;
  onAddToCart: () => void;
}

export interface ClinicalResultsProps {
  assessment: FitAssessment;
  onChoose: (candidate: FitCandidate) => void;
  onRetake: () => void;
  /**
   * Resolve the cash-pay offer for a candidate, or undefined when this
   * mask isn't sold in the shop / checkout is off. Undefined by default,
   * which renders exactly what this component rendered before.
   */
  cashPayFor?: (candidate: FitCandidate) => ClinicalCashPay | undefined;
}

export function ClinicalResults({
  assessment,
  onChoose,
  onRetake,
  cashPayFor,
}: ClinicalResultsProps) {
  const primary = assessment.primary;
  if (!primary) return null;

  const confidencePct = Math.round(assessment.recommendationConfidence * 100);
  const needsReview = assessment.outcome === "moderate_confidence";
  // The headline number is scan- and profile-weighted; each candidate's
  // own `confidence` is the raw clinical blend, a systematically HIGHER
  // scale. Shown side by side, every alternative out-scored "your best
  // match" purely by unit mismatch. Re-express the alternatives on the
  // headline's scale so the percentages are actually comparable.
  const confidenceScale =
    primary.confidence > 0
      ? assessment.recommendationConfidence / primary.confidence
      : 1;
  const scaledPct = (c: FitCandidate) =>
    Math.round(Math.min(1, c.confidence * confidenceScale) * 100);

  return (
    <div className="space-y-6">
      {needsReview ? (
        <Alert>
          <Info className="h-4 w-4" />
          <AlertTitle>A clinician will confirm this fit</AlertTitle>
          <AlertDescription>{assessment.guidance}</AlertDescription>
        </Alert>
      ) : null}

      {assessment.safetyFlags.length > 0 ? (
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>Safety screening applied</AlertTitle>
          <AlertDescription>
            Based on your answers we have excluded masks that would not be safe
            for you. The options below already reflect that.
          </AlertDescription>
        </Alert>
      ) : null}

      <CandidateCard
        candidate={primary}
        isPrimary
        confidencePct={confidencePct}
        onChoose={() => onChoose(primary)}
        cashPay={cashPayFor?.(primary)}
      />

      {assessment.alternatives.length > 0 ? (
        <div className="space-y-4">
          <div className="px-2">
            <h2 className="text-xl font-semibold tracking-tight">
              Alternatives
            </h2>
            <p className="text-sm text-muted-foreground mt-1 max-w-2xl">
              Each of these is a clinically appropriate option — they simply
              ranked below your top match, and each says why.
            </p>
          </div>
          {assessment.alternatives.map((c) => (
            <CandidateCard
              key={c.maskSlug}
              candidate={c}
              isPrimary={false}
              confidencePct={scaledPct(c)}
              onChoose={() => onChoose(c)}
              cashPay={cashPayFor?.(c)}
            />
          ))}
        </div>
      ) : null}

      {assessment.excluded.length > 0 ? (
        <Card className="border-0 glass-card rounded-2xl p-5">
          <h3 className="font-semibold text-sm mb-2">
            Masks we ruled out for you
          </h3>
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {assessment.excluded.slice(0, 8).map((e) => (
              <li key={`${e.maskSlug}:${e.code}`}>
                <span className="font-medium text-foreground/80">
                  {e.maskName}
                </span>{" "}
                — {e.patientReason}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Provenance assessment={assessment} />

      <div className="text-center">
        <Button variant="outline" size="sm" onClick={onRetake}>
          <RefreshCcw className="h-4 w-4 mr-2" />
          Retake photo for a sharper measurement
        </Button>
      </div>
    </div>
  );
}

function CandidateCard({
  candidate,
  isPrimary,
  confidencePct,
  onChoose,
  cashPay,
}: {
  candidate: FitCandidate;
  isPrimary: boolean;
  confidencePct: number;
  onChoose: () => void;
  cashPay?: ClinicalCashPay | undefined;
}) {
  const size = candidate.cushion ?? candidate.frame;
  return (
    <Card
      className={`border-0 glass-card rounded-2xl p-5 ${
        isPrimary ? "ring-2 ring-emerald-200/70" : ""
      }`}
      data-testid={isPrimary ? "clinical-primary" : "clinical-alternative"}
    >
      <div className="flex flex-col sm:flex-row gap-5">
        <img
          src={candidate.imageUrl ?? getMaskImage(candidate.interfaceType)}
          alt=""
          className="w-full sm:w-40 h-32 object-contain rounded-xl bg-white/50"
          loading="lazy"
        />
        <div className="flex-1 space-y-2.5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              {isPrimary ? (
                <div className="inline-flex items-center gap-1.5 text-emerald-700 text-xs font-semibold uppercase tracking-wide mb-1">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Your best match
                </div>
              ) : null}
              <h3 className="text-lg font-semibold leading-tight">
                {candidate.name}
              </h3>
              <p className="text-sm text-muted-foreground">
                {candidate.manufacturer} ·{" "}
                {formatMaskType(candidate.interfaceType)}
              </p>
            </div>
            <Badge variant="secondary">{confidencePct}% match</Badge>
          </div>

          {size ? (
            <div className="rounded-xl bg-white/45 px-3 py-2">
              <p className="text-sm">
                <span className="font-semibold">
                  Recommended size: {size.sizeLabel}
                </span>
                {size.component !== "cushion" ? ` (${size.component})` : ""}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {size.rationale}
              </p>
            </div>
          ) : null}

          {candidate.reasons.length > 0 ? (
            <ul className="text-sm space-y-1">
              {candidate.reasons.slice(0, 4).map((r, i) => (
                <li key={i} className="flex gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  <span>{r}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {candidate.cautions.length > 0 ? (
            <ul className="text-sm space-y-1">
              {candidate.cautions.map((c, i) => (
                <li key={i} className="flex gap-2 text-amber-900">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          ) : null}

          {candidate.rankedBelowBecause ? (
            <p className="text-xs text-muted-foreground italic">
              Ranked below your top match because {candidate.rankedBelowBecause}
            </p>
          ) : null}

          {candidate.outsideFormulary ? (
            <p className="text-xs text-amber-900">
              Outside your provider&apos;s usual selection
              {candidate.outsideFormularyReason
                ? ` — ${candidate.outsideFormularyReason}`
                : ""}
              . Your provider will confirm availability.
            </p>
          ) : null}

          {candidate.availability === "out" ||
          candidate.availability === "special_order" ? (
            <p className="text-xs text-muted-foreground">
              {candidate.availability === "out"
                ? "Currently out of stock at your location — your provider will advise on timing."
                : "Available by special order."}
            </p>
          ) : null}

          <div className="pt-1 flex flex-wrap items-center gap-2">
            <Button onClick={onChoose} data-testid="clinical-choose">
              Choose this mask
            </Button>
            {cashPay ? (
              <Button
                variant="outline"
                onClick={cashPay.onAddToCart}
                data-testid="clinical-cashpay"
              >
                Buy without insurance — {cashPay.priceLabel}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

function Provenance({ assessment }: { assessment: FitAssessment }) {
  const p = assessment.provenance;
  return (
    <Card className="border-0 glass-card rounded-2xl p-5">
      <h3 className="font-semibold text-sm mb-2">How this was decided</h3>
      <p className="text-sm text-muted-foreground">{assessment.disclaimer}</p>
      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Formulary</dt>
          <dd className="font-medium">
            {p.formularyName} (v{p.formularyVersion})
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Fitting rules</dt>
          <dd className="font-medium">{p.rulesEngineVersion}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Measurement</dt>
          <dd className="font-medium">Facial measurement, on-device</dd>
        </div>
      </dl>
      {p.degraded ? (
        <p className="mt-3 text-xs text-amber-900">
          Produced in degraded mode — your provider&apos;s live mask catalog was
          unreachable, so a built-in list was used. Your provider will confirm
          the final selection.
        </p>
      ) : null}
    </Card>
  );
}

/**
 * The engine declined to name a mask.
 *
 * `low_confidence`, `contraindicated`, and `outside_validated_range` are
 * distinct outcomes and get distinct copy — but they share one exit: the
 * flow ENDS here, with the DME company named as the hand-off. There is
 * deliberately no "retake photo" loop anymore. A patient who has just
 * fought the capture into a low-confidence photo has already told us the
 * photo path isn't working for them; bouncing them back to the camera
 * for another round is how fittings die in frustration. The DME's team
 * can still send a fresh scan link from the console (rescan-notify) when
 * THEY judge another try worthwhile.
 *
 * The company identity comes from `useCompanyContact()` — the
 * host-resolved tenant, never a typed-out brand — so every tenant's
 * patients are referred to that tenant by name (with the neutral
 * platform identity as the pre-fetch/failure fallback).
 */
export function FitWithheld({ assessment }: { assessment: FitAssessment }) {
  const contact = useCompanyContact();
  // The two non-contraindicated withholds share the ending (stop + named
  // referral) but NOT one explanation: `low_confidence` can come from the
  // photo, a weak match, or a sparse profile, and `outside_validated_range`
  // can be a perfectly good scan of a face outside the sizing data — so
  // neither body may claim "the photo failed" as fact. Each outcome gets
  // copy that is true for every path that produces it.
  const scanLimited =
    assessment.outcome === "low_confidence" ||
    assessment.outcome === "outside_validated_range";
  const title =
    assessment.outcome === "contraindicated"
      ? "This one needs a person, not an algorithm"
      : assessment.outcome === "outside_validated_range"
        ? "Your measurements sit outside our sizing range"
        : "We'd rather not guess";
  const body =
    assessment.outcome === "low_confidence"
      ? `We couldn't reach a confident enough match from your scan and answers, and we'd rather stop than guess. This is where ${contact.name} takes over — a member of the team will fit you personally and make sure the mask is right.`
      : assessment.outcome === "outside_validated_range"
        ? `Your measurements fall outside the range our sizing data covers, so we're not going to guess. This is where ${contact.name} takes over — a member of the team will fit you personally.`
        : assessment.guidance;

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12">
      <div className="glass-card rounded-2xl p-8 space-y-5">
        <div className="flex items-start gap-3">
          <AlertCircle className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <h1 className="text-xl font-semibold">{title}</h1>
            <p
              className="text-sm text-muted-foreground mt-2"
              data-testid="withheld-guidance"
            >
              {body}
            </p>
          </div>
        </div>

        {/* The exclusion list explains a contraindication; under a
            scan-driven stop it reads as "every mask rejected you", which
            is not what happened — the photo was the problem. */}
        {!scanLimited && assessment.excluded.length > 0 ? (
          <div>
            <p className="text-sm font-medium mb-1.5">What we ruled out</p>
            <ul className="space-y-1.5 text-sm text-muted-foreground">
              {assessment.excluded.slice(0, 6).map((e) => (
                <li key={`${e.maskSlug}:${e.code}`}>
                  <span className="font-medium text-foreground/80">
                    {e.maskName}
                  </span>{" "}
                  — {e.patientReason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <p className="text-xs text-muted-foreground">{assessment.disclaimer}</p>

        <div className="flex flex-wrap gap-3 pt-1">
          <Button asChild data-testid="withheld-contact">
            <a href="/contact">Contact {contact.name}</a>
          </Button>
          {contact.phoneE164 ? (
            <Button variant="outline" asChild data-testid="withheld-call">
              <a href={`tel:${contact.phoneE164}`}>
                <PhoneCall className="h-4 w-4 mr-2" />
                Call {contact.phoneDisplay || contact.name}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
