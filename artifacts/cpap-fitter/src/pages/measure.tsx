import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "wouter";
import { useFitterStore } from "@/hooks/use-fitter-store";
import { Progress } from "@/components/ui/progress";
import { Card, CardContent } from "@/components/ui/card";
import {
  BrainCircuit,
  ScanFace,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  RefreshCw,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import type { FaceLandmarker } from "@mediapipe/tasks-vision";
import {
  LandmarkerLoadTimeout,
  loadFaceLandmarker,
} from "@/lib/landmarker-loader";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import { track } from "@/lib/track";
import { BrandName } from "@/components/company-contact";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { failureHints, findImplausibleMeasurement } from "@/lib/measure-flow";
import { payloadFromAggregate } from "@/lib/scan-signals";
import { sampleFrame } from "@/lib/frame-sampling";
import {
  aggregateFrames,
  assessFrameQuality,
  centroidOf,
  estimatePoseFromLandmarks,
  type FrameMeasurement,
  type Point2D,
} from "@/lib/scan-quality";
import {
  ExtractionError,
  extractMeasurementValues,
  type ExtractionFailReason,
} from "@/lib/face-measurements";

// How long the success state ("Measurements Ready" + readout) stays
// visible before auto-advancing to /questionnaire. Long enough for the
// user to register the extracted dimensions, short enough that an
// engaged user doesn't feel stalled. Users can also click "Continue"
// to skip the wait.
const AUTO_ADVANCE_MS = 2600;

/** Whether /measure will render the "taken a little far away" retake
 *  hint for these signals — the same predicate the JSX uses, so the
 *  auto-advance can hold the page while the hint is on screen. */
function showsDistanceHint(
  signals: { quality: { distance?: number } } | null,
): boolean {
  return (
    typeof signals?.quality.distance === "number" &&
    signals.quality.distance < 0.6
  );
}

/** Bounded image decode — a hung decode must never strand the patient. */
function decodeImage(dataUrl: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = dataUrl;
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new ExtractionError(
            "image_decode_timeout",
            "Image decode timed out. Please retake the photo.",
          ),
        ),
      8000,
    );
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(
        new ExtractionError(
          "image_decode",
          "Could not load the captured photo. Please retake it.",
        ),
      );
    };
  });
}

export function Measure() {
  useDocumentTitle("Analyzing your measurements");
  const [, setLocation] = useLocation();
  const {
    capturedImage,
    capturedFrames,
    measurements,
    scanSignals,
    setMeasurements,
    setCapturedImage,
    setCapturedFrames,
    scanFailureCount,
    bumpScanFailureCount,
  } = useFitterStore();
  const [progress, setProgress] = useState(0);
  // Which way the patient would have to move to improve the capture, when
  // the distance check marked it down. Held locally rather than in the
  // store: it is advice about the photo on screen right now, not part of
  // the measurement record, and the wire `scan` payload is a strict set
  // of scalars the server schema will not accept an extra key into.
  const [distanceHint, setDistanceHint] = useState<"closer" | "farther" | null>(
    null,
  );
  const [status, setStatus] = useState(
    "Initializing secure on-device processor…",
  );
  const [error, setError] = useState<{
    message: string;
    reason: ExtractionFailReason;
    /** Advice chosen from what the frames actually scored — see
     *  `failureHints`. Static bullets when there is nothing to read. */
    bullets: string[];
    /** Enough attempts have failed that another one is not the answer. */
    escalate: boolean;
  } | null>(null);
  // Flips once we've kicked off (manual click or auto-advance) the
  // navigation to /questionnaire so subsequent presses / timer fires are
  // no-ops. Plain ref because callers don't need to re-render on flip.
  const navigatedRef = useRef(false);
  // Guard so this effect's MediaPipe pipeline only kicks off once per mount.
  // Without it, any state change that re-runs the effect (e.g. clearing the
  // captured image for privacy) would re-trigger the WASM load + face
  // detection from scratch.
  const startedRef = useRef(false);
  // Ref-based mount guard so the post-analysis navigation setTimeout can
  // tell the difference between "page still mounted" and "user navigated
  // away mid-processing". A local `let isMounted` would be flipped by the
  // effect's cleanup on every dep-driven re-run, not just unmount.
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // Single advancement path used by both the auto-advance timer and the
  // manual "Continue" button. Idempotent so a user clicking the button
  // just before the timer fires (or vice versa) doesn't double-navigate.
  const goToQuestionnaire = () => {
    if (navigatedRef.current) return;
    navigatedRef.current = true;
    if (!isMountedRef.current) return;
    // Navigate FIRST, then clear the captured image. Doing it the other
    // way around makes GuardedMeasure (App.tsx) see !capturedImage and
    // <Redirect to="/capture" /> before our setLocation lands —
    // bouncing the user back to retake the photo. The startedRef guard
    // inside this effect doesn't help because the route guard lives
    // one level up and doesn't see it.
    setLocation("/questionnaire");
    // Privacy: discard the captured image(s) from memory now that we've
    // navigated away from /measure. Our UI promises this — keep it true.
    setCapturedImage(null);
    setCapturedFrames(null);
  };

  useEffect(() => {
    if (startedRef.current) return;
    if (!capturedImage) {
      // Cold-load with no image — two distinct situations land here:
      //
      // 1. Measurements already extracted (a refresh on /measure after
      //    a successful extraction, or during the auto-advance window:
      //    the image is memory-only and lost, but the measurements were
      //    persisted). There is nothing left for this page to do, and
      //    bouncing to /capture forces a redundant photo retake — so
      //    continue FORWARD to the questionnaire with the saved
      //    measurements. This is also what `canStayOnMeasure`
      //    (measure-flow.ts) documents: measurements alone are a valid
      //    reason to be past the capture step.
      //
      // 2. No measurements either (user pasted /measure into the URL).
      //    Send them to /capture to start properly. The /capture →
      //    /measure handoff goes through GuardedMeasure (App.tsx), so
      //    this branch is rarely hit in practice.
      //
      // `replace` matters in both (app-review 2026-06-10, P2-8): a PUSH
      // here leaves the image-less /measure entry in history, so
      // pressing Back re-mounts /measure, which pushes again — the user
      // can never navigate back past this page.
      setLocation(measurements ? "/questionnaire" : "/capture", {
        replace: true,
      });
      return;
    }
    startedRef.current = true;

    let faceLandmarker: FaceLandmarker | null = null;

    const processImage = async () => {
      // Declared outside the try so the failure path can read what the
      // frames scored: the six quality checks ran on every frame that
      // reached the extractor, and answering a lighting failure with
      // "center your face in the oval" is a worse answer than the one
      // already computed.
      let perFrame: FrameMeasurement[] = [];
      try {
        if (!isMountedRef.current) return;
        setProgress(15);
        setStatus("Loading on-device facial landmark model…");

        // Self-hosted MediaPipe — see scripts/setup-mediapipe.mjs.
        // Loading these from our own origin (instead of jsdelivr / Google
        // Storage) is what backs the "100% private" claim end-to-end and
        // also lets the app pass a strict same-origin CSP.
        //
        // The GPU→CPU fallback, the bounded load, and closing a landmarker
        // that arrives after the timeout all live in the shared loader now
        // — the guided capture and the live coach need the identical
        // dance, and the late-arrival close is exactly the detail that
        // gets copied correctly twice and wrongly the third time.
        try {
          faceLandmarker = await loadFaceLandmarker({ runningMode: "IMAGE" });
        } catch (loadErr) {
          if (loadErr instanceof LandmarkerLoadTimeout) {
            throw new ExtractionError(
              "model_load_timeout",
              "The measurement model took too long to load. Please try again.",
            );
          }
          throw loadErr;
        }
        if (isMountedRef.current) {
          setProgress(40);
          setStatus("Configuring landmark detection…");
        }

        if (!isMountedRef.current) return;
        setProgress(60);

        // ── Multi-frame path: the guided multi-angle capture
        //    (fitter.multiframe_capture) AND the default one-tap burst
        //    both land here. Each frame is independently landmark-
        //    detected and iris-calibrated with the SAME math
        //    (extractMeasurementValues); the per-frame values are then
        //    pose-corrected and folded to a median with cross-frame
        //    agreement by aggregateFrames. A failed frame is dropped, not
        //    fatal — fewer frames is an honest degradation the confidence
        //    model already prices in. ──
        if (capturedFrames && capturedFrames.length > 0) {
          // Provenance, not pose inference: a guided run whose turn
          // angles were both skipped is all-front too, and reading it as
          // a burst applied the hold-still motion penalty to two frames
          // taken seconds apart while the flow itself told the patient
          // to move. The distinction drives the status copy and the
          // motion check below.
          const isBurst = capturedFrames.every((f) => f.source === "burst");
          perFrame = [];
          // Motion baseline for bursts: the IMMEDIATELY PRECEDING frame's
          // centroid only. Judging against the worst of ALL prior
          // centroids would let one jolt mid-burst poison every later
          // frame (each compared against the old outlier), defeating
          // exactly the recovery the burst exists for; adjacent drift is
          // the actual "hold still" signal.
          let priorCentroid: Point2D | null = null;
          let lastFailure: ExtractionError | null = null;
          for (let i = 0; i < capturedFrames.length; i += 1) {
            if (!isMountedRef.current) return;
            setProgress(
              60 + Math.round(((i + 1) / capturedFrames.length) * 30),
            );
            setStatus(
              `Analyzing ${isBurst ? "frame" : "angle"} ${i + 1} of ${capturedFrames.length}…`,
            );
            const frame = capturedFrames[i]!;
            try {
              const frameImg = await decodeImage(frame.dataUrl);
              const detection = faceLandmarker.detect(frameImg);
              const landmarks = detection.faceLandmarks?.[0];
              if (!landmarks || landmarks.length === 0) {
                throw new ExtractionError(
                  "no_face",
                  "No face detected in the image. Please try the capture again.",
                );
              }
              const { values, irisPix } = extractMeasurementValues(
                landmarks,
                frameImg,
              );
              // Quality scalars for this frame. sampleFrame never throws
              // (neutral fallback) and the checks are pure math.
              const angles = estimatePoseFromLandmarks(landmarks, frameImg);
              const sample = sampleFrame(frameImg, landmarks);
              const quality = assessFrameQuality({
                pose: frame.pose,
                landmarks,
                irisWidthPx: irisPix,
                frameWidth: frameImg.width,
                frameHeight: frameImg.height,
                faceLuma: sample.faceLuma,
                faceLumaLeft: sample.faceLumaLeft,
                faceLumaRight: sample.faceLumaRight,
                sharpness: sample.sharpness,
                yawDeg: angles.yawDeg,
                pitchDeg: angles.pitchDeg,
                rollDeg: angles.rollDeg,
                // The motion check applies only to same-pose bursts,
                // where drift between frames IS a defect (a shaking
                // hand). Guided angles deliberately skip it: movement
                // between poses is the instruction, not a problem.
                ...(isBurst && priorCentroid
                  ? { previousCentroids: [priorCentroid] }
                  : {}),
              });
              if (isBurst) priorCentroid = centroidOf(landmarks);
              perFrame.push({
                pose: frame.pose,
                quality,
                values,
                yawDeg: angles.yawDeg,
                pitchDeg: angles.pitchDeg,
                // Carried through so the aggregate can tell repeated
                // looks at ONE posture from independent evidence — a
                // burst's frames agree with each other by construction
                // (see BURST_AGREEMENT_CEILING).
                source: frame.source,
              });
            } catch (err) {
              lastFailure =
                err instanceof ExtractionError
                  ? err
                  : new ExtractionError(
                      "unknown",
                      "An error occurred during measurement extraction.",
                    );
            }
          }
          if (perFrame.length === 0) {
            throw (
              lastFailure ??
              new ExtractionError(
                "no_face",
                "No face detected in the captured angles. Please try again.",
              )
            );
          }

          // Drop frames that failed their own quality gates BEFORE
          // aggregating, as long as at least one acceptable frame
          // remains — the burst exists precisely so one blurred or
          // badly-lit frame can be discarded instead of dragging the
          // whole capture's band to `low` (aggregateFrames floors the
          // band when ANY contributing frame was unacceptable). When
          // every frame failed its gates, keep them all: the aggregate
          // then reports `low` honestly rather than pretending the
          // problem frames weren't there.
          const acceptableFrames = perFrame.filter((f) => f.quality.acceptable);
          const usedFrames =
            acceptableFrames.length > 0 ? acceptableFrames : perFrame;

          const aggregate = aggregateFrames(usedFrames);
          const measurements: FacialMeasurements = {
            noseWidth: aggregate.measurements.noseWidth ?? Number.NaN,
            noseHeight: aggregate.measurements.noseHeight ?? Number.NaN,
            noseToChin: aggregate.measurements.noseToChin ?? Number.NaN,
            mouthWidth: aggregate.measurements.mouthWidth ?? Number.NaN,
            faceWidthAtCheekbones:
              aggregate.measurements.faceWidthAtCheekbones ?? Number.NaN,
            calibrationMethod: "iris",
          };
          const implausibleField = findImplausibleMeasurement(measurements);
          if (implausibleField) {
            throw new ExtractionError(
              "implausible_measurements",
              "We couldn't get a confident reading from these photos. Please retake them.",
            );
          }

          if (!isMountedRef.current) return;
          setProgress(100);
          setStatus("Analysis complete.");
          const aggregatePayload = payloadFromAggregate(aggregate, usedFrames);
          // The frames the numbers actually rest on decide the advice: if
          // they agree on a direction, say it; if they disagree (one too
          // close, one too far), there is no single instruction to give.
          const frameHints = new Set(
            usedFrames
              .map((f) => f.quality.distanceHint)
              .filter((h): h is "closer" | "farther" => Boolean(h)),
          );
          setDistanceHint(frameHints.size === 1 ? [...frameHints][0]! : null);
          setMeasurements(measurements, aggregatePayload);
          track("measurements_extracted", {
            frames: usedFrames.length,
            framesCaptured: capturedFrames.length,
            guided: !isBurst,
            burst: isBurst,
          });
          // Hold the page when the distance hint will show (see below) —
          // auto-advancing 2.6s after rendering "you can retake this"
          // takes the choice away right as it's offered.
          if (!showsDistanceHint(aggregatePayload)) {
            setTimeout(goToQuestionnaire, AUTO_ADVANCE_MS);
          }
          return;
        }

        // Unreachable: both capture pages commit `capturedFrames` in the
        // same flushSync as `capturedImage`, and the no-image guard above
        // has already redirected when neither survived. Kept as a throw
        // rather than a silent fall-through, which would strand the
        // patient on the loading status with nothing in flight.
        throw new ExtractionError(
          "no_face",
          "No face detected in the image. Please try the capture again.",
        );
      } catch (err: unknown) {
        console.error("Measurement error:", err);
        const reason: ExtractionFailReason =
          err instanceof ExtractionError ? err.reason : "unknown";
        const msg =
          err instanceof Error
            ? err.message
            : "An error occurred during measurement extraction.";
        track("measurement_error", { reason });
        // Bump BEFORE reading, so this failure counts toward its own
        // escalation — the second failure is the one that should offer a
        // person, not the third.
        bumpScanFailureCount();
        const { bullets, escalate } = failureHints(
          reason,
          perFrame,
          scanFailureCount + 1,
        );
        if (isMountedRef.current) {
          setError({ message: msg, reason, bullets, escalate });
        }
      } finally {
        // Release the WASM-backed landmarker eagerly — both on success
        // (we've already extracted what we need) and on error (so a retry
        // doesn't pile up native handles).
        try {
          faceLandmarker?.close?.();
        } catch {
          /* noop — best-effort cleanup */
        }
        faceLandmarker = null;
      }
    };

    setTimeout(processImage, 100);

    // No effect-local cleanup: mount tracking lives in `isMountedRef` (above),
    // which only flips on actual component unmount. A local cleanup here would
    // run again when `setCapturedImage(null)` triggers a re-render (capturedImage
    // is a dep), prematurely cancelling the post-analysis navigation.
    // setCapturedImage is intentionally omitted — including it would re-run the
    // entire MediaPipe pipeline when we clear the image on success.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedImage, setLocation, setMeasurements]);

  if (error) {
    return (
      <div className="container max-w-md mx-auto px-4 py-24 text-center animate-shimmer-in space-y-6">
        <Alert
          variant="destructive"
          className="text-left glass-card border-destructive/30"
          data-testid="measure-error"
          data-reason={error.reason}
        >
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
        <div className="text-left callout-navy px-4 py-3 rounded-xl space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-[hsl(var(--penn-navy))]/80">
            Tips for the next try
          </p>
          <ul className="text-sm text-foreground/85 space-y-1.5 list-disc pl-5">
            {error.bullets.map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
        {/* After two failed attempts, stop implying the next one will
            work. The advice above is worth following once; a patient on
            their third try has a device, a room or a face the scanner is
            not going to get along with, and the honest move is to offer
            them a person before they conclude the product is broken. */}
        {error.escalate && (
          <div
            className="text-left callout-gold px-4 py-3 rounded-xl space-y-2"
            data-testid="measure-error-escalation"
          >
            <p className="text-sm font-semibold">
              Two tries is plenty — you don&apos;t need a perfect photo.
            </p>
            <p className="text-sm text-foreground/85 leading-relaxed">
              Leave your details instead and the <BrandName /> team will take it
              from here, including fitting you in person if that is easier.
            </p>
          </div>
        )}
        <div className="flex flex-wrap gap-3 justify-center">
          <Button
            // `?simple=1`: a photo that would not measure is exactly when
            // the one-tap page — with the how-tos and the escape hatches —
            // should own the retry, rather than dropping the patient back
            // into a guided flow they may already have escaped once.
            onClick={() => setLocation("/capture?simple=1")}
            className="rounded-full btn-primary-glow px-6 gap-2"
            data-testid="measure-retake"
          >
            <RefreshCw className="h-4 w-4" />
            Retake photo
          </Button>
          {/* An escape hatch, mirroring the camera-error screen. Without
              it a device that can never pass extraction (no WebGL, broken
              runtime) traps the patient in a retake loop with no exit.
              asChild so the Button styling lands on the link itself — a
              <button> inside an <a> is invalid HTML. */}
          <Button
            asChild
            variant="outline"
            className="rounded-full glass-panel border-0 px-6"
            data-testid="measure-error-fallback-shop"
          >
            <Link href="/masks">Skip for now — browse the mask catalog</Link>
          </Button>
          {/* The two exits the camera-error screen has always offered and
              this one did not. A patient whose photo will not measure is
              in exactly the same position as one whose camera was
              refused — and rather more likely to have given up on the
              flow — but their only way off this screen was a retake or
              the catalog. Neither reaches a person. */}
          <Button
            asChild
            variant="outline"
            className="rounded-full glass-panel border-0 px-6"
            data-testid="measure-error-fallback-insurance"
          >
            <Link href="/insurance">Use insurance instead</Link>
          </Button>
          <Button
            asChild
            variant="outline"
            className="rounded-full glass-panel border-0 px-6"
            data-testid="measure-error-fallback-callback"
          >
            <Link href="/fit-request?mode=callback&source=scan">
              Ask us to call you instead
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl mx-auto px-4 py-12 animate-shimmer-in">
      <div className="text-center mb-6">
        <div className="inline-flex items-center justify-center gap-3 mb-3">
          <div className="h-px w-8 bg-gradient-to-r from-transparent to-[hsl(var(--penn-gold))]" />
          <span className="text-xs font-semibold uppercase tracking-[0.32em] text-[hsl(var(--penn-navy))]/75">
            Analyze
          </span>
          <div className="h-px w-8 bg-gradient-to-l from-transparent to-[hsl(var(--penn-gold))]" />
        </div>
      </div>
      <Card className="border-0 glass-card rounded-2xl overflow-hidden">
        <CardContent className="p-0">
          {/* Image with scan line overlay — feels active and "tech" */}
          {capturedImage ? (
            <div className="relative aspect-[3/4] md:aspect-video bg-black overflow-hidden">
              <img
                src={capturedImage}
                alt="Captured for analysis"
                className="w-full h-full object-cover transform -scale-x-100"
              />
              {/* Soft dark overlay */}
              <div className="absolute inset-0 bg-black/20" />
              {/* Animated scan line — sweeps top to bottom */}
              {progress < 100 && (
                <>
                  <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-b from-primary/0 via-primary to-primary/0 shadow-[0_0_20px_4px_rgba(59,130,246,0.6)] scan-line" />
                  {/* Subtle horizontal scan grid */}
                  <div
                    className="absolute inset-0 opacity-30 pointer-events-none"
                    style={{
                      backgroundImage:
                        "repeating-linear-gradient(0deg, rgba(59,130,246,0.05) 0px, rgba(59,130,246,0.05) 1px, transparent 1px, transparent 8px)",
                    }}
                  />
                </>
              )}
              {/* Corner brackets to suggest "scanning frame" */}
              <CornerBrackets />
              {/* Completion badge */}
              {progress === 100 && (
                <div className="absolute inset-0 flex items-center justify-center bg-green-600/30 backdrop-blur-[1px] animate-in fade-in duration-300">
                  <div className="h-20 w-20 bg-white text-green-600 rounded-full flex items-center justify-center shadow-2xl animate-in zoom-in duration-300">
                    <CheckCircle2 className="h-10 w-10" />
                  </div>
                </div>
              )}
            </div>
          ) : (
            // Fallback if image isn't available (shouldn't happen — redirected above)
            <div className="aspect-video bg-muted flex items-center justify-center">
              <ScanFace className="w-16 h-16 text-muted-foreground" />
            </div>
          )}

          <div className="p-8 space-y-5">
            <div className="space-y-2">
              <h2 className="text-display text-2xl font-bold tracking-tight text-gradient-brand">
                {progress === 100
                  ? "Measurements Ready"
                  : "Processing Your Measurements"}
              </h2>
              {/*
                aria-live=polite so screen-reader users hear the changing
                status ("Loading model", "Analyzing", ...) and the final
                completion. role=status has implicit aria-live=polite, but
                we set it explicitly for older screen readers.
              */}
              <p
                className="text-sm text-muted-foreground h-5"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {status}
              </p>
            </div>
            <Progress
              value={progress}
              className="h-2 w-full"
              aria-label="Measurement progress"
              aria-valuenow={progress}
              aria-valuemin={0}
              aria-valuemax={100}
            />
            {progress === 100 &&
            typeof scanSignals?.quality.distance === "number" &&
            scanSignals.quality.distance < 0.6 ? (
              // The photo passed extraction but the distance check scored
              // it poorly — which quietly caps confidence downstream. Say
              // so NOW, while retaking is one tap, instead of letting the
              // fitting end in a vague "we need a better scan".
              //
              // Which WAY to move is named, not implied. This used to read
              // "taken a little far from the camera" whatever the cause,
              // and a patient who was in fact too close was being told to
              // do more of exactly what went wrong.
              <div
                className="flex items-start gap-2.5 text-xs rounded-xl callout-gold p-3"
                data-testid="measure-distance-hint"
                data-hint={distanceHint ?? "range"}
              >
                <AlertCircle className="w-4 h-4 mt-0.5 text-[hsl(var(--penn-navy))] shrink-0" />
                <span className="text-foreground/85 leading-relaxed">
                  {distanceHint === "farther"
                    ? "This photo was taken a little close to the camera."
                    : distanceHint === "closer"
                      ? "This photo was taken a little far from the camera."
                      : "This photo was taken outside the range we measure best at."}{" "}
                  You can continue, but{" "}
                  <button
                    type="button"
                    className="underline font-medium"
                    onClick={() => setLocation("/capture")}
                    data-testid="measure-distance-retake"
                  >
                    retaking it about an arm&apos;s length away
                  </button>{" "}
                  usually gives a more confident match.
                </span>
              </div>
            ) : null}
            {progress === 100 && measurements ? (
              <MeasurementsReadout measurements={measurements} />
            ) : (
              <div className="flex items-start gap-2.5 text-xs text-foreground/80 callout-navy px-4 py-3 rounded-xl">
                <BrainCircuit className="h-4 w-4 shrink-0 text-primary mt-0.5" />
                <span className="leading-relaxed">
                  Your photo is being processed entirely on this device by
                  Google's MediaPipe library. The image is discarded the moment
                  your measurements are extracted.
                </span>
              </div>
            )}
            {progress === 100 && measurements && (
              <Button
                onClick={goToQuestionnaire}
                className="w-full h-12 rounded-full btn-primary-glow text-base"
                data-testid="measure-continue"
                aria-label="Continue to questionnaire"
              >
                Continue
                <ArrowRight className="ml-2 h-5 w-5" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
      {/* CSS animation keyframes for the scan line — container-relative so it
          tracks the image regardless of viewport, and disabled for users with
          a reduced-motion preference. */}
      <style>{`
        @keyframes scanLineMove {
          0%   { top: 0%; opacity: 0.4; }
          10%  { opacity: 1; }
          50%  { top: 100%; opacity: 1; }
          60%  { opacity: 0.4; }
          100% { top: 0%; opacity: 0.4; }
        }
        .scan-line {
          animation: scanLineMove 2.4s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          will-change: top, opacity;
        }
        @media (prefers-reduced-motion: reduce) {
          .scan-line {
            animation: none;
            top: 50%;
            opacity: 0.7;
          }
        }
      `}</style>
    </div>
  );
}

/**
 * Compact post-extraction readout. Surfacing the actual numbers (rather
 * than just a green check) lets users sanity-check the result before
 * advancing — if the iris-calibrated dimensions are wildly off, the
 * questionnaire+results flow downstream of here will silently produce a
 * bad mask recommendation.
 */
function MeasurementsReadout({
  measurements,
}: {
  measurements: FacialMeasurements;
}) {
  // Group the readout by what each measurement is *for* so patients
  // immediately see "this is my headgear size" and "this is my nasal
  // pillow size" instead of a flat list of clinical dimensions.
  const headgearRows = [
    {
      label: "Face width (cheekbones)",
      value: measurements.faceWidthAtCheekbones,
    },
    { label: "Nose to chin", value: measurements.noseToChin },
    { label: "Mouth width", value: measurements.mouthWidth },
  ];
  const nostrilRows = [
    { label: "Nostril span (alar width)", value: measurements.noseWidth },
    { label: "Nose height", value: measurements.noseHeight },
  ];
  return (
    <div
      className="space-y-3"
      data-testid="measure-readout"
      aria-label="Extracted facial measurements"
    >
      <MeasurementGroup
        title="Headgear & mask sizing"
        subtitle="Drives strap fit and full-face / nasal mask cushion size."
        rows={headgearRows}
      />
      <MeasurementGroup
        title="Nasal pillow sizing"
        subtitle="Sets the small / medium / large pillow that seals at your nostrils."
        rows={nostrilRows}
      />
    </div>
  );
}

function MeasurementGroup({
  title,
  subtitle,
  rows,
}: {
  title: string;
  subtitle: string;
  rows: { label: string; value: number }[];
}) {
  return (
    <div className="callout-navy px-4 py-3 rounded-xl">
      <div className="flex items-baseline justify-between gap-3 mb-2">
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[hsl(var(--penn-navy))]/85">
          {title}
        </p>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2 leading-snug">
        {subtitle}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between">
            <dt className="text-foreground/70">{row.label}</dt>
            <dd className="font-mono font-semibold text-foreground tabular-nums">
              {row.value.toFixed(1)} mm
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function CornerBrackets() {
  const cornerClass = "absolute w-6 h-6 border-primary/80";
  return (
    <>
      <div
        className={`${cornerClass} top-3 left-3 border-t-2 border-l-2 rounded-tl-md`}
      />
      <div
        className={`${cornerClass} top-3 right-3 border-t-2 border-r-2 rounded-tr-md`}
      />
      <div
        className={`${cornerClass} bottom-3 left-3 border-b-2 border-l-2 rounded-bl-md`}
      />
      <div
        className={`${cornerClass} bottom-3 right-3 border-b-2 border-r-2 rounded-br-md`}
      />
    </>
  );
}
