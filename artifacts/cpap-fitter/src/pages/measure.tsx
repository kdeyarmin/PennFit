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
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

import { FilesetResolver, FaceLandmarker } from "@mediapipe/tasks-vision";
import type { FacialMeasurements } from "@workspace/api-client-react/storefront";
import { track } from "@/lib/track";
import { useDocumentTitle } from "@/hooks/use-document-title";

export function Measure() {
  useDocumentTitle("Analyzing your measurements");
  const [, setLocation] = useLocation();
  const { capturedImage, setMeasurements, setCapturedImage } = useFitterStore();
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(
    "Initializing secure on-device processor…",
  );
  const [error, setError] = useState<string | null>(null);
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

  useEffect(() => {
    if (startedRef.current) return;
    if (!capturedImage) {
      // Cold-load with no image (e.g. user pasted /measure into the URL).
      // The /capture → /measure handoff goes through GuardedMeasure
      // (App.tsx), which already keeps users without a captured image off
      // this route, so this branch is rarely hit in practice.
      setLocation("/capture");
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
                new Error("Image decode timed out. Please retake the photo."),
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
              new Error("Could not load the captured photo. Please retake it."),
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

          if (pxPerMm < 0.1) {
            throw new Error(
              "Could not detect features clearly for calibration. Please ensure good lighting and try again.",
            );
          }

          const mm = (pixels: number) =>
            Math.round((pixels / pxPerMm) * 10) / 10;

          const noseWidthPx = dist(landmarks[129], landmarks[358]);
          const noseHeightPx = dist(landmarks[6], landmarks[4]);
          const noseToChinPx = dist(landmarks[4], landmarks[152]);
          const mouthWidthPx = dist(landmarks[61], landmarks[291]);
          const faceWidthPx = dist(landmarks[234], landmarks[454]);

          const measurements: FacialMeasurements = {
            noseWidth: mm(noseWidthPx),
            noseHeight: mm(noseHeightPx),
            noseToChin: mm(noseToChinPx),
            mouthWidth: mm(mouthWidthPx),
            faceWidthAtCheekbones: mm(faceWidthPx),
            calibrationMethod: "iris",
          };

          if (!isMountedRef.current) return;
          setProgress(100);
          setStatus("Analysis complete.");
          setMeasurements(measurements);
          track("measurements_extracted");

          setTimeout(() => {
            if (!isMountedRef.current) return;
            // Navigate FIRST, then clear the captured image. Doing it the
            // other way around makes GuardedMeasure (App.tsx) see
            // !capturedImage and <Redirect to="/capture" /> before our
            // setLocation lands — bouncing the user back to retake the
            // photo instead of advancing to the questionnaire. The
            // startedRef guard inside this effect doesn't help because
            // the route guard lives one level up and doesn't see it.
            setLocation("/questionnaire");
            // Privacy: discard the captured image from memory now that
            // we've navigated away from /measure. Our UI promises this
            // — keep it true.
            setCapturedImage(null);
          }, 900);
        } else {
          throw new Error(
            "No face detected in the image. Please try the capture again.",
          );
        }
      } catch (err: unknown) {
        console.error("Measurement error:", err);
        const msg = err instanceof Error ? err.message : String(err);
        if (isMountedRef.current)
          setError(msg || "An error occurred during measurement extraction.");
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
      <div className="container max-w-md mx-auto px-4 py-24 text-center animate-shimmer-in">
        <Alert
          variant="destructive"
          className="mb-6 text-left glass-card border-destructive/30"
        >
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <Button
          onClick={() => setLocation("/capture")}
          className="rounded-full btn-primary-glow px-6"
        >
          Return to Camera
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
            Step 2 of 3 · Analyze
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
            <div className="flex items-start gap-2.5 text-xs text-foreground/80 callout-navy px-4 py-3 rounded-xl">
              <BrainCircuit className="h-4 w-4 shrink-0 text-primary mt-0.5" />
              <span className="leading-relaxed">
                Your photo is being processed entirely on this device by
                Google's MediaPipe library. The image is discarded the moment
                your measurements are extracted.
              </span>
            </div>
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
