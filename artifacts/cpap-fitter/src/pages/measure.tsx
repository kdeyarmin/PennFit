import React, { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
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

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";
import { findImplausibleMeasurement } from "@/lib/measure-flow";

// How long the success state ("Measurements Ready" + readout) stays
// visible before auto-advancing to /questionnaire. Long enough for the
// user to register the extracted dimensions, short enough that an
// engaged user doesn't feel stalled. Users can also click "Continue"
// to skip the wait.
const AUTO_ADVANCE_MS = 2600;

// Reason codes attached to extraction failures. Drives the help-text
// card on the error screen and is what we send to analytics so we can
// see, in aggregate, why patients can't get past /measure (vs the old
// world where every failure was just "measurement_error").
type ExtractionFailReason =
  | "no_face"
  | "iris_too_small"
  | "implausible_measurements"
  | "image_decode"
  | "image_decode_timeout"
  | "unknown";

class ExtractionError extends Error {
  reason: ExtractionFailReason;
  constructor(reason: ExtractionFailReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const FAIL_HINTS: Record<ExtractionFailReason, string[]> = {
  no_face: [
    "Center your face inside the oval guide.",
    "Look directly at the camera — not up, down, or to the side.",
    "Make sure your forehead, eyes, nose, and chin are all in frame.",
  ],
  iris_too_small: [
    "Hold the camera closer — about an arm's length from your face.",
    "Use the front (selfie) camera, not the rear camera.",
    "Take off glasses, sunglasses, or anything covering your eyes.",
  ],
  implausible_measurements: [
    "Make sure it's a real face in the frame, not a photo or screen.",
    "Take off glasses and remove anything covering parts of your face.",
    "Even, front-on lighting works best — avoid strong side or back light.",
  ],
  image_decode: [
    "Try retaking the photo — the captured frame couldn't be decoded.",
  ],
  image_decode_timeout: [
    "The captured photo took too long to load. Try again, ideally on Wi-Fi or after closing other camera-using apps.",
  ],
  unknown: [
    "Try retaking the photo with even lighting and your face centered.",
  ],
};

export function Measure() {
  useDocumentTitle("Analyzing your measurements");
  const [, setLocation] = useLocation();
  const { capturedImage, measurements, setMeasurements, setCapturedImage } =
    useFitterStore();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(
    "Initializing secure on-device processor…",
  );
  const [error, setError] = useState<{
    message: string;
    reason: ExtractionFailReason;
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
    // Privacy: discard the captured image from memory now that we've
    // navigated away from /measure. Our UI promises this — keep it true.
    setCapturedImage(null);
  };

  useEffect(() => {
    if (startedRef.current) return;
    if (!capturedImage) {
      // Cold-load with no image (e.g. user pasted /measure into the URL).
      // The /capture → /measure handoff goes through GuardedMeasure
      // (App.tsx), which already keeps users without a captured image off
      // this route, so this branch is rarely hit in practice.
      //
      // `replace` matters (app-review 2026-06-10, P2-8): a PUSH here
      // leaves the image-less /measure entry in history, so pressing
      // Back from /capture re-mounts /measure, which pushes /capture
      // again — the user can never navigate back past this page and is
      // herded toward re-taking the photo.
      setLocation("/capture", { replace: true });
      return;
    }
    startedRef.current = true;

    let faceLandmarker: FaceLandmarker | null = null;

    const processImage = async () => {
      try {
        if (!isMountedRef.current) return;
        setProgress(15);
        setStatus("Loading on-device facial landmark model…");

        // Self-hosted MediaPipe — see scripts/setup-mediapipe.mjs. Loading
        // these from our own origin (instead of jsdelivr/Google Storage)
        // is what backs PennPaps's "100% private" claim end-to-end and
        // also lets the app pass a strict same-origin CSP.
        const base = import.meta.env.BASE_URL; // includes trailing slash
        const vision = await FilesetResolver.forVisionTasks(
          `${base}mediapipe/wasm`,
        );

        if (!isMountedRef.current) return;
        setProgress(40);
        setStatus("Configuring landmark detection…");

        faceLandmarker = await FaceLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath: `${base}mediapipe/models/face_landmarker.task`,
            delegate: "GPU",
          },
          outputFaceBlendshapes: false,
          runningMode: "IMAGE",
          numFaces: 1,
        });

        if (!isMountedRef.current) return;
        setProgress(60);
        setStatus("Analyzing facial structure…");

        // Bounded image-load with explicit error + timeout so a hung decode
        // can't strand the user on this page indefinitely (the stall this
        // page is otherwise prone to). Data URLs decode synchronously in
        // most browsers but mobile Safari has been known to stall.
        const img = new Image();
        img.src = capturedImage;
        await new Promise<void>((resolve, reject) => {
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
            resolve();
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

        if (!isMountedRef.current) return;
        setProgress(75);
        setStatus("Calibrating to your iris and extracting measurements…");

        const result = faceLandmarker.detect(img);

        if (result.faceLandmarks && result.faceLandmarks.length > 0) {
          const landmarks = result.faceLandmarks[0];

          /*
            MediaPipe landmarks are normalized [0, 1].
            We calibrate the millimeter scale using the iris diameter, which is
            remarkably consistent across adults at ~11.7mm horizontally
            (Forrester JV et al, "The Eye: Basic Sciences in Practice", 4th ed).

            Landmarks (normalized coordinates):
            Nose tip: 4
            Nose bridge: 6
            Left nostril: 129, Right nostril: 358
            Left mouth corner: 61, Right mouth corner: 291
            Chin bottom: 152
            Left cheekbone: 234, Right cheekbone: 454
            Left iris boundary (left): 469, Left iris boundary (right): 471
          */

          // MediaPipe normalized landmark — has at least x/y in [0..1].
          // Typing this explicitly (vs `any`) lets the compiler catch
          // typos in the index lookups below and protects us if
          // MediaPipe ever returns null/undefined for a missing point.
          type Landmark = { x: number; y: number; z?: number };
          const dist = (p1: Landmark, p2: Landmark) => {
            const dx = (p1.x - p2.x) * img.width;
            const dy = (p1.y - p2.y) * img.height;
            return Math.sqrt(dx * dx + dy * dy);
          };

          const irisLeftPix = dist(landmarks[469], landmarks[471]);
          const pxPerMm = irisLeftPix / 11.7;

          // pxPerMm < 1 means the iris was less than ~12 pixels across,
          // which is too small for the millimeter math to be trustworthy.
          // Bumped from the prior 0.1 threshold (~1 px) which only caught
          // total no-detect garbage and still let through hopeless
          // "subject is 4 feet from the camera" cases.
          if (pxPerMm < 1) {
            throw new ExtractionError(
              "iris_too_small",
              "Your face is too far from the camera for accurate measurement. Please move closer and try again.",
            );
          }

          const mm = (pixels: number) =>
            Math.round((pixels / pxPerMm) * 10) / 10;

          // Nose alar (nostril span) — outer alar landmarks. This is the
          // nasal-pillow base width (drives small/medium/large pillow fit).
          const noseWidthPx = dist(landmarks[129], landmarks[358]);
          const noseHeightPx = dist(landmarks[6], landmarks[4]);
          const noseToChinPx = dist(landmarks[4], landmarks[152]);
          const mouthWidthPx = dist(landmarks[61], landmarks[291]);
          // Face width at cheekbones drives headgear strap sizing.
          const faceWidthPx = dist(landmarks[234], landmarks[454]);

          const measurements: FacialMeasurements = {
            noseWidth: mm(noseWidthPx),
            noseHeight: mm(noseHeightPx),
            noseToChin: mm(noseToChinPx),
            mouthWidth: mm(mouthWidthPx),
            faceWidthAtCheekbones: mm(faceWidthPx),
            calibrationMethod: "iris",
          };

          const implausibleField = findImplausibleMeasurement(measurements);
          if (implausibleField) {
            throw new ExtractionError(
              "implausible_measurements",
              "We couldn't get a confident reading from this photo. Please retake it.",
            );
          }

          if (!isMountedRef.current) return;
          setProgress(100);
          setStatus("Analysis complete.");
          setMeasurements(measurements);
          track("measurements_extracted");

          // Auto-advance after a short delay so users can register the
          // extracted measurements; the manual "Continue" button below
          // calls the same goToQuestionnaire() handler for users who
          // want to skip the wait.
          setTimeout(goToQuestionnaire, AUTO_ADVANCE_MS);
        } else {
          throw new ExtractionError(
            "no_face",
            "No face detected in the image. Please try the capture again.",
          );
        }
      } catch (err: unknown) {
        console.error("Measurement error:", err);
        const reason: ExtractionFailReason =
          err instanceof ExtractionError ? err.reason : "unknown";
        const msg =
          err instanceof Error
            ? err.message
            : "An error occurred during measurement extraction.";
        track("measurement_error", { reason });
        if (isMountedRef.current) setError({ message: msg, reason });
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
            {FAIL_HINTS[error.reason].map((hint) => (
              <li key={hint}>{hint}</li>
            ))}
          </ul>
        </div>
        <Button
          onClick={() => setLocation("/capture")}
          className="rounded-full btn-primary-glow px-6 gap-2"
          data-testid="measure-retake"
        >
          <RefreshCw className="h-4 w-4" />
          Retake photo
        </Button>
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
